package com.agritrack.field.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import java.util.UUID

@Entity(
    tableName = "session_events_outbox",
    indices = [
        Index(value = ["employee_id", "sync_status", "occurred_at_epoch_ms"]),
        Index(value = ["session_id"])
    ]
)
data class SessionEventOutboxEntity(
    @PrimaryKey
    @ColumnInfo(name = "event_id")
    val eventId: String = UUID.randomUUID().toString(),

    @ColumnInfo(name = "session_id")
    val sessionId: String,

    @ColumnInfo(name = "employee_id")
    val employeeId: String,

    @ColumnInfo(name = "device_id")
    val deviceId: String,

    @ColumnInfo(name = "event_type")
    val eventType: String, // START | STOP | INTERRUPTED

    @ColumnInfo(name = "occurred_at_iso")
    val occurredAtIso: String,

    @ColumnInfo(name = "occurred_at_epoch_ms")
    val occurredAtEpochMs: Long,

    @ColumnInfo(name = "session_started_at_iso")
    val sessionStartedAtIso: String,

    @ColumnInfo(name = "sync_status")
    val syncStatus: SyncStatus = SyncStatus.PENDING,

    @ColumnInfo(name = "server_synced_at")
    val serverSyncedAt: String? = null,

    @ColumnInfo(name = "retry_count")
    val retryCount: Int = 0,

    @ColumnInfo(name = "last_error")
    val lastError: String? = null
)
