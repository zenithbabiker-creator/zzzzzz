package com.agritrack.field.data.local.dao

import androidx.room.Dao
import androidx.room.Insert
import androidx.room.OnConflictStrategy
import androidx.room.Query
import androidx.room.Transaction
import com.agritrack.field.data.local.entity.EmployeeEntity
import com.agritrack.field.data.local.entity.LocationRecordEntity
import com.agritrack.field.data.local.entity.SessionEventOutboxEntity
import com.agritrack.field.data.local.entity.SyncQueueStateEntity
import com.agritrack.field.data.local.entity.SyncStatus
import com.agritrack.field.data.local.entity.TrackingSessionEntity
import kotlinx.coroutines.flow.Flow
import java.time.Instant
import java.util.UUID

@Dao
interface TrackingDao {

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertLocationRecord(record: LocationRecordEntity): Long

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertEmployee(employee: EmployeeEntity)

    @Query("SELECT * FROM employees WHERE employee_id = :employeeId LIMIT 1")
    suspend fun getEmployeeById(employeeId: String): EmployeeEntity?

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun insertSession(session: TrackingSessionEntity)

    @Query("SELECT * FROM tracking_sessions WHERE session_id = :sessionId LIMIT 1")
    suspend fun getSessionById(sessionId: String): TrackingSessionEntity?

    @Query("SELECT * FROM tracking_sessions WHERE status = 'ACTIVE'")
    suspend fun getAllActiveSessions(): List<TrackingSessionEntity>

    @Query("UPDATE tracking_sessions SET status = :newStatus, ended_at_epoch_ms = :endedAt WHERE session_id = :sessionId AND status = 'ACTIVE'")
    suspend fun closeActiveSession(sessionId: String, newStatus: String, endedAt: Long): Int

    @Query("UPDATE employees SET session_status = :status WHERE employee_id = :employeeId")
    suspend fun updateEmployeeSessionStatus(employeeId: String, status: String)

    @Insert(onConflict = OnConflictStrategy.IGNORE)
    suspend fun insertSessionEvent(event: SessionEventOutboxEntity)

    @Query("""
        SELECT * FROM session_events_outbox
        WHERE employee_id = :employeeId
          AND sync_status IN ('PENDING', 'RETRYABLE_FAILED')
        ORDER BY occurred_at_epoch_ms ASC
    """)
    suspend fun getUnsyncedSessionEvents(employeeId: String): List<SessionEventOutboxEntity>

    @Query("""
        UPDATE session_events_outbox
        SET sync_status = 'SYNCED', server_synced_at = :serverSyncedAt, last_error = NULL
        WHERE event_id = :eventId
    """)
    suspend fun markSessionEventSynced(eventId: String, serverSyncedAt: String)

    @Query("""
        UPDATE session_events_outbox
        SET sync_status = 'RETRYABLE_FAILED',
            retry_count = retry_count + 1,
            last_error = :errorMessage
        WHERE event_id = :eventId AND sync_status != 'SYNCED'
    """)
    suspend fun markSessionEventRetryableFailed(eventId: String, errorMessage: String?)

    @Query("""
        UPDATE session_events_outbox
        SET sync_status = 'PERMANENT_FAILED',
            retry_count = retry_count + 1,
            last_error = :errorMessage
        WHERE event_id = :eventId AND sync_status != 'SYNCED'
    """)
    suspend fun markSessionEventPermanentFailed(eventId: String, errorMessage: String?)

    @Query("""
        UPDATE session_events_outbox
        SET sync_status = :blockedStatus,
            last_error = :errorMessage
        WHERE event_id IN (:eventIds) AND sync_status != 'SYNCED'
    """)
    suspend fun markSessionEventsBlocked(eventIds: List<String>, blockedStatus: SyncStatus, errorMessage: String?)

    @Query("""
        UPDATE session_events_outbox
        SET sync_status = 'BLOCKED_AUTH',
            last_error = :errorMessage
        WHERE employee_id = :employeeId AND sync_status IN ('PENDING', 'RETRYABLE_FAILED')
    """)
    suspend fun markUnsyncedSessionEventsBlockedAuth(employeeId: String, errorMessage: String?)

    @Query("""
        UPDATE session_events_outbox
        SET sync_status = 'PENDING'
        WHERE employee_id = :employeeId AND sync_status = :blockedStatus
    """)
    suspend fun unblockSessionEvents(employeeId: String, blockedStatus: SyncStatus)

    @Transaction
    suspend fun startSessionTransaction(session: TrackingSessionEntity) {
        insertSession(session)
        updateEmployeeSessionStatus(session.employeeId, "TRACKING")
        val startedIso = Instant.ofEpochMilli(session.startedAtEpochMs).toString()
        insertSessionEvent(
            SessionEventOutboxEntity(
                eventId = UUID.randomUUID().toString(),
                sessionId = session.sessionId,
                employeeId = session.employeeId,
                deviceId = session.deviceId,
                eventType = "START",
                occurredAtIso = startedIso,
                occurredAtEpochMs = session.startedAtEpochMs,
                sessionStartedAtIso = startedIso,
                syncStatus = SyncStatus.PENDING
            )
        )
    }

    @Transaction
    suspend fun stopSessionTransaction(
        sessionId: String,
        employeeId: String,
        endedAt: Long,
        targetStatus: String = "COMPLETED"
    ) {
        val existing = getSessionById(sessionId)
        val rowsUpdated = closeActiveSession(sessionId, targetStatus, endedAt)
        updateEmployeeSessionStatus(employeeId, "IDLE")

        if (rowsUpdated > 0 && existing != null) {
            val eventType = if (targetStatus == "INTERRUPTED") "INTERRUPTED" else "STOP"
            insertSessionEvent(
                SessionEventOutboxEntity(
                    eventId = UUID.randomUUID().toString(),
                    sessionId = existing.sessionId,
                    employeeId = existing.employeeId,
                    deviceId = existing.deviceId,
                    eventType = eventType,
                    occurredAtIso = Instant.ofEpochMilli(endedAt).toString(),
                    occurredAtEpochMs = endedAt,
                    sessionStartedAtIso = Instant.ofEpochMilli(existing.startedAtEpochMs).toString(),
                    syncStatus = SyncStatus.PENDING
                )
            )
        }
    }

    @Query("SELECT * FROM location_records WHERE employee_id = :employeeId ORDER BY captured_at_epoch_ms DESC")
    fun observeRecordsForEmployee(employeeId: String): Flow<List<LocationRecordEntity>>

    @Query("""
        SELECT * FROM location_records
        WHERE employee_id = :employeeId
          AND sync_status IN ('PENDING', 'RETRYABLE_FAILED')
        ORDER BY captured_at_epoch_ms ASC
        LIMIT :batchSize
    """)
    suspend fun getUnsyncedBatch(employeeId: String, batchSize: Int = 100): List<LocationRecordEntity>

    @Query("""
        UPDATE location_records
        SET sync_status = 'SYNCED', server_synced_at = :serverReceivedAt, last_error = NULL
        WHERE employee_id = :employeeId AND record_id IN (:confirmedIds)
    """)
    suspend fun markBatchSynced(employeeId: String, confirmedIds: List<String>, serverReceivedAt: String)

    @Query("""
        UPDATE location_records
        SET sync_status = 'RETRYABLE_FAILED',
            retry_count = retry_count + 1,
            last_error = :errorMessage
        WHERE employee_id = :employeeId AND record_id IN (:failedIds) AND sync_status != 'SYNCED'
    """)
    suspend fun markBatchRetryableFailed(employeeId: String, failedIds: List<String>, errorMessage: String?)

    @Query("""
        UPDATE location_records
        SET sync_status = 'PERMANENT_FAILED',
            retry_count = retry_count + 1,
            last_error = :errorMessage
        WHERE employee_id = :employeeId AND record_id IN (:failedIds) AND sync_status != 'SYNCED'
    """)
    suspend fun markBatchPermanentFailed(employeeId: String, failedIds: List<String>, errorMessage: String?)

    @Query("""
        UPDATE location_records
        SET sync_status = :blockedStatus,
            last_error = :errorMessage
        WHERE employee_id = :employeeId AND record_id IN (:recordIds) AND sync_status != 'SYNCED'
    """)
    suspend fun markBatchBlocked(employeeId: String, recordIds: List<String>, blockedStatus: SyncStatus, errorMessage: String?)

    @Query("""
        UPDATE location_records
        SET sync_status = 'BLOCKED_AUTH',
            last_error = :errorMessage
        WHERE employee_id = :employeeId AND sync_status IN ('PENDING', 'RETRYABLE_FAILED')
    """)
    suspend fun markUnsyncedRecordsBlockedAuth(employeeId: String, errorMessage: String?)

    @Query("""
        UPDATE location_records
        SET sync_status = 'PENDING'
        WHERE employee_id = :employeeId AND sync_status = :blockedStatus
    """)
    suspend fun unblockLocationRecords(employeeId: String, blockedStatus: SyncStatus)

    @Query("SELECT * FROM sync_queue_state WHERE employee_id = :employeeId LIMIT 1")
    suspend fun getSyncQueueState(employeeId: String): SyncQueueStateEntity?

    @Query("SELECT * FROM sync_queue_state WHERE employee_id = :employeeId LIMIT 1")
    fun observeSyncQueueState(employeeId: String): Flow<SyncQueueStateEntity?>

    @Insert(onConflict = OnConflictStrategy.REPLACE)
    suspend fun upsertSyncQueueState(state: SyncQueueStateEntity)

    @Transaction
    suspend fun pauseQueueForAuth(
        employeeId: String,
        httpStatus: Int,
        errorCode: String,
        reason: String,
        eventIds: List<String> = emptyList(),
        recordIds: List<String> = emptyList(),
        markAllUnsynced: Boolean = false,
        nowMs: Long = System.currentTimeMillis()
    ) {
        if (markAllUnsynced) {
            markUnsyncedSessionEventsBlockedAuth(employeeId, reason)
            markUnsyncedRecordsBlockedAuth(employeeId, reason)
        } else {
            if (eventIds.isNotEmpty()) {
                markSessionEventsBlocked(eventIds, SyncStatus.BLOCKED_AUTH, reason)
            }
            if (recordIds.isNotEmpty()) {
                markBatchBlocked(employeeId, recordIds, SyncStatus.BLOCKED_AUTH, reason)
            }
        }
        upsertSyncQueueState(
            SyncQueueStateEntity(
                employeeId = employeeId,
                pauseType = SyncQueueStateEntity.PAUSE_AUTH,
                httpStatus = httpStatus,
                errorCode = errorCode,
                reason = reason,
                pausedAppVersionCode = null,
                pausedApiBaseUrl = null,
                updatedAtEpochMs = nowMs
            )
        )
    }

    @Transaction
    suspend fun pauseQueueForConfiguration(
        employeeId: String,
        httpStatus: Int,
        errorCode: String,
        reason: String,
        appVersionCode: Int,
        apiBaseUrl: String,
        eventIds: List<String> = emptyList(),
        recordIds: List<String> = emptyList(),
        nowMs: Long = System.currentTimeMillis()
    ) {
        if (eventIds.isNotEmpty()) {
            markSessionEventsBlocked(eventIds, SyncStatus.BLOCKED_CONFIGURATION, reason)
        }
        if (recordIds.isNotEmpty()) {
            markBatchBlocked(employeeId, recordIds, SyncStatus.BLOCKED_CONFIGURATION, reason)
        }
        upsertSyncQueueState(
            SyncQueueStateEntity(
                employeeId = employeeId,
                pauseType = SyncQueueStateEntity.PAUSE_CONFIGURATION,
                httpStatus = httpStatus,
                errorCode = errorCode,
                reason = reason,
                pausedAppVersionCode = appVersionCode,
                pausedApiBaseUrl = apiBaseUrl,
                updatedAtEpochMs = nowMs
            )
        )
    }

    @Transaction
    suspend fun unblockAuthQueue(employeeId: String, nowMs: Long = System.currentTimeMillis()) {
        unblockSessionEvents(employeeId, SyncStatus.BLOCKED_AUTH)
        unblockLocationRecords(employeeId, SyncStatus.BLOCKED_AUTH)
        val current = getSyncQueueState(employeeId)
        if (current != null && current.pauseType == SyncQueueStateEntity.PAUSE_AUTH) {
            upsertSyncQueueState(
                SyncQueueStateEntity(
                    employeeId = employeeId,
                    pauseType = SyncQueueStateEntity.PAUSE_NONE,
                    updatedAtEpochMs = nowMs
                )
            )
        }
    }

    @Transaction
    suspend fun unblockConfigurationQueue(employeeId: String, nowMs: Long = System.currentTimeMillis()) {
        unblockSessionEvents(employeeId, SyncStatus.BLOCKED_CONFIGURATION)
        unblockLocationRecords(employeeId, SyncStatus.BLOCKED_CONFIGURATION)
        val current = getSyncQueueState(employeeId)
        if (current != null && current.pauseType == SyncQueueStateEntity.PAUSE_CONFIGURATION) {
            upsertSyncQueueState(
                SyncQueueStateEntity(
                    employeeId = employeeId,
                    pauseType = SyncQueueStateEntity.PAUSE_NONE,
                    updatedAtEpochMs = nowMs
                )
            )
        }
    }

    @Query("SELECT COUNT(*) FROM location_records WHERE employee_id = :employeeId AND sync_status = :status")
    fun observeCountByStatus(employeeId: String, status: SyncStatus): Flow<Int>

    @Query("SELECT COUNT(*) FROM session_events_outbox WHERE employee_id = :employeeId AND sync_status = 'PERMANENT_FAILED'")
    fun observeOutboxPermanentFailedCount(employeeId: String): Flow<Int>

    @Query("SELECT COUNT(*) FROM session_events_outbox WHERE employee_id = :employeeId AND sync_status IN ('BLOCKED_AUTH', 'BLOCKED_CONFIGURATION')")
    fun observeOutboxBlockedCount(employeeId: String): Flow<Int>

    @Query("""
        SELECT last_error FROM location_records
        WHERE employee_id = :employeeId
          AND sync_status IN ('RETRYABLE_FAILED', 'BLOCKED_AUTH', 'BLOCKED_CONFIGURATION', 'PERMANENT_FAILED')
          AND last_error IS NOT NULL
        ORDER BY captured_at_epoch_ms DESC LIMIT 1
    """)
    fun observeLatestRecordError(employeeId: String): Flow<String?>

    @Query("""
        SELECT last_error FROM session_events_outbox
        WHERE employee_id = :employeeId
          AND sync_status IN ('RETRYABLE_FAILED', 'BLOCKED_AUTH', 'BLOCKED_CONFIGURATION', 'PERMANENT_FAILED')
          AND last_error IS NOT NULL
        ORDER BY occurred_at_epoch_ms DESC LIMIT 1
    """)
    fun observeLatestOutboxError(employeeId: String): Flow<String?>

    @Query("""
        SELECT COUNT(*) FROM location_records
        WHERE employee_id = :employeeId
          AND sync_status IN ('PENDING', 'RETRYABLE_FAILED', 'BLOCKED_AUTH', 'BLOCKED_CONFIGURATION')
    """)
    suspend fun countUnsyncedRecordsOnce(employeeId: String): Int

    @Query("SELECT * FROM tracking_sessions WHERE employee_id = :employeeId AND status = 'ACTIVE' ORDER BY started_at_epoch_ms DESC LIMIT 1")
    fun observeActiveSession(employeeId: String): Flow<TrackingSessionEntity?>

    @Query("UPDATE employees SET session_status = 'IDLE' WHERE session_status = 'TRACKING'")
    suspend fun resetAllTrackingStatusesToIdle()

    @Transaction
    suspend fun recoverInterruptedSessionsOnBoot(endedAt: Long) {
        val orphaned = getAllActiveSessions()
        val endedIso = Instant.ofEpochMilli(endedAt).toString()
        for (sess in orphaned) {
            val closed = closeActiveSession(sess.sessionId, "INTERRUPTED", endedAt)
            if (closed > 0) {
                insertSessionEvent(
                    SessionEventOutboxEntity(
                        eventId = UUID.randomUUID().toString(),
                        sessionId = sess.sessionId,
                        employeeId = sess.employeeId,
                        deviceId = sess.deviceId,
                        eventType = "INTERRUPTED",
                        occurredAtIso = endedIso,
                        occurredAtEpochMs = endedAt,
                        sessionStartedAtIso = Instant.ofEpochMilli(sess.startedAtEpochMs).toString(),
                        syncStatus = SyncStatus.PENDING
                    )
                )
            }
        }
        resetAllTrackingStatusesToIdle()
    }
}
