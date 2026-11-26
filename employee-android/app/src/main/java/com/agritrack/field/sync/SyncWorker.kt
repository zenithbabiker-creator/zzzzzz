package com.agritrack.field.sync

import android.content.Context
import androidx.work.CoroutineWorker
import androidx.work.WorkerParameters
import com.agritrack.field.BuildConfig
import com.agritrack.field.data.local.AgriTrackDatabase
import com.agritrack.field.data.local.SecureAuthStore
import com.agritrack.field.data.local.dao.TrackingDao
import com.agritrack.field.data.local.entity.LocationRecordEntity
import com.agritrack.field.data.local.entity.SessionEventOutboxEntity
import com.agritrack.field.data.local.entity.SyncQueueStateEntity
import com.agritrack.field.data.remote.BatchSyncAckDto
import com.agritrack.field.data.remote.BatchSyncPayloadDto
import com.agritrack.field.data.remote.LocationUploadDto
import com.agritrack.field.data.remote.RefreshTokenRequestDto
import com.agritrack.field.data.remote.SessionStartRequestDto
import com.agritrack.field.data.remote.SessionStopRequestDto
import com.agritrack.field.data.remote.SyncApiService
import com.google.gson.JsonParser
import kotlinx.coroutines.CancellationException
import retrofit2.Response
import java.time.Instant
import java.util.UUID

class SyncWorker(
    appContext: Context,
    params: WorkerParameters
) : CoroutineWorker(appContext, params) {

    private val apiService: SyncApiService by lazy {
        SyncApiService.create(BuildConfig.API_BASE_URL)
    }

    private sealed interface RefreshOutcome {
        data class Success(val token: String) : RefreshOutcome
        data object RetryableError : RefreshOutcome
        data object AuthExpired : RefreshOutcome
    }

    private sealed interface OutboxStepOutcome {
        data object Synced : OutboxStepOutcome
        data object PermanentFailureIsolated : OutboxStepOutcome
        data class WorkerAbort(val result: Result) : OutboxStepOutcome
    }

    private sealed interface SliceOutcome {
        data object CompletedOrIsolated : SliceOutcome
        data class WorkerAbort(val result: Result) : SliceOutcome
    }

    private data class ParsedApiError(
        val code: String?,
        val message: String
    )

    private fun parseApiError(httpCode: Int, rawBody: String?): ParsedApiError {
        val trimmed = rawBody?.trim().orEmpty()
        if (trimmed.startsWith("{")) {
            val parsed = runCatching {
                val obj = JsonParser.parseString(trimmed).asJsonObject
                val code = if (obj.has("code") && !obj.get("code").isJsonNull) {
                    obj.get("code").asString.trim().uppercase()
                } else {
                    null
                }
                val message = if (obj.has("error") && !obj.get("error").isJsonNull) {
                    obj.get("error").asString
                } else {
                    trimmed
                }
                ParsedApiError(
                    code = code?.takeIf { it.isNotEmpty() },
                    message = message.take(200).ifBlank { "HTTP $httpCode" }
                )
            }.getOrNull()
            if (parsed != null) {
                return parsed
            }
        }
        return ParsedApiError(
            code = null,
            message = trimmed.take(200).ifBlank { "HTTP $httpCode" }
        )
    }

    override suspend fun doWork(): Result {
        val employeeId = inputData.getString(KEY_EMPLOYEE_ID) ?: return Result.failure()
        val deviceId = inputData.getString(KEY_DEVICE_ID) ?: return Result.failure()
        val forceUserRecovery = inputData.getBoolean(KEY_FORCE_USER_RECOVERY, false)

        val authStore = SecureAuthStore(applicationContext)
        val dao = AgriTrackDatabase.getInstance(applicationContext).trackingDao()

        // Enforce persistent pause gate BEFORE any network call or token refresh so periodic 15-min
        // and automatic connectivity workers never loop on non-transient configuration/auth errors.
        val queueState = dao.getSyncQueueState(employeeId)
        if (queueState != null) {
            when (queueState.pauseType) {
                SyncQueueStateEntity.PAUSE_CONFIGURATION -> {
                    val configChanged =
                        queueState.pausedAppVersionCode != BuildConfig.VERSION_CODE ||
                            queueState.pausedApiBaseUrl != BuildConfig.API_BASE_URL
                    if (configChanged || forceUserRecovery) {
                        dao.unblockConfigurationQueue(employeeId)
                    } else {
                        return Result.failure()
                    }
                }
                SyncQueueStateEntity.PAUSE_AUTH -> {
                    if (forceUserRecovery) {
                        val hasSession = authStore.getSession()?.employeeId == employeeId
                        if (hasSession || queueState.httpStatus == 403) {
                            dao.unblockAuthQueue(employeeId)
                        } else {
                            return Result.failure()
                        }
                    } else {
                        return Result.failure()
                    }
                }
            }
        }

        val stored = authStore.getSession()
        if (stored == null || stored.employeeId != employeeId) {
            dao.pauseQueueForAuth(
                employeeId = employeeId,
                httpStatus = 401,
                errorCode = "AUTH_REQUIRED",
                reason = "Sign in required to resume uploading queued records.",
                markAllUnsynced = true
            )
            return Result.failure()
        }

        var bearerToken = stored.accessToken
        val needsRefresh = stored.accessExpiresAtMs - System.currentTimeMillis() < 60_000L
        if (needsRefresh) {
            when (val refreshed = refreshAccessToken(authStore, employeeId, deviceId, stored.refreshToken)) {
                is RefreshOutcome.Success -> bearerToken = refreshed.token
                RefreshOutcome.RetryableError -> return Result.retry()
                RefreshOutcome.AuthExpired -> {
                    val reason = "Offline session token expired. Sign in again to upload queued records."
                    dao.pauseQueueForAuth(
                        employeeId = employeeId,
                        httpStatus = 401,
                        errorCode = "AUTH_REQUIRED",
                        reason = reason,
                        markAllUnsynced = true
                    )
                    authStore.markReauthRequired(
                        employeeId = employeeId,
                        deviceId = deviceId,
                        reason = reason
                    )
                    return Result.failure()
                }
            }
        }

        var hasPermanentFailure = false

        // Phase 1: Sync START session events first so backend sessions receive true initial timestamps
        val outboxEvents = dao.getUnsyncedSessionEvents(employeeId)
        val startEvents = outboxEvents.filter { it.eventType == "START" }
        for (event in startEvents) {
            when (
                val outcome = syncSessionOutboxEvent(
                    dao = dao,
                    authStore = authStore,
                    employeeId = employeeId,
                    deviceId = deviceId,
                    event = event,
                    currentBearer = bearerToken,
                    onTokenRefreshed = { bearerToken = it }
                )
            ) {
                OutboxStepOutcome.Synced -> Unit
                OutboxStepOutcome.PermanentFailureIsolated -> hasPermanentFailure = true
                is OutboxStepOutcome.WorkerAbort -> return outcome.result
            }
        }

        // Phase 2: Upload pending/retryable GPS location batches in chronological order
        while (true) {
            val batch = dao.getUnsyncedBatch(employeeId = employeeId, batchSize = BATCH_SIZE)
            if (batch.isEmpty()) {
                break
            }

            when (
                val sliceResult = uploadLocationSlice(
                    dao = dao,
                    authStore = authStore,
                    employeeId = employeeId,
                    deviceId = deviceId,
                    slice = batch,
                    getBearer = { bearerToken },
                    onTokenRefreshed = { bearerToken = it },
                    onPermanentFailure = { hasPermanentFailure = true }
                )
            ) {
                SliceOutcome.CompletedOrIsolated -> Unit
                is SliceOutcome.WorkerAbort -> return sliceResult.result
            }
        }

        // Phase 3: Sync STOP and INTERRUPTED outbox events after all GPS batches are uploaded
        val closeEvents = dao.getUnsyncedSessionEvents(employeeId)
            .filter { it.eventType == "STOP" || it.eventType == "INTERRUPTED" }
        for (event in closeEvents) {
            when (
                val outcome = syncSessionOutboxEvent(
                    dao = dao,
                    authStore = authStore,
                    employeeId = employeeId,
                    deviceId = deviceId,
                    event = event,
                    currentBearer = bearerToken,
                    onTokenRefreshed = { bearerToken = it }
                )
            ) {
                OutboxStepOutcome.Synced -> Unit
                OutboxStepOutcome.PermanentFailureIsolated -> hasPermanentFailure = true
                is OutboxStepOutcome.WorkerAbort -> return outcome.result
            }
        }

        return if (hasPermanentFailure) Result.failure() else Result.success()
    }

    private suspend fun uploadLocationSlice(
        dao: TrackingDao,
        authStore: SecureAuthStore,
        employeeId: String,
        deviceId: String,
        slice: List<LocationRecordEntity>,
        getBearer: () -> String,
        onTokenRefreshed: (String) -> Unit,
        onPermanentFailure: () -> Unit
    ): SliceOutcome {
        val sliceIds = slice.map { it.recordId }
        val payload = BatchSyncPayloadDto(
            batchId = UUID.randomUUID().toString(),
            records = slice.map { rec ->
                LocationUploadDto(
                    recordId = rec.recordId,
                    sessionId = rec.sessionId,
                    employeeId = rec.employeeId,
                    deviceId = rec.deviceId,
                    latitude = rec.latitude,
                    longitude = rec.longitude,
                    capturedAtIso = rec.capturedAtIso,
                    capturedAtEpochMs = rec.capturedAtEpochMs,
                    dateStr = rec.dateStr,
                    hour = rec.hour,
                    minute = rec.minute,
                    second = rec.second,
                    accuracyMeters = rec.accuracyMeters,
                    provider = rec.provider,
                    batteryPercent = rec.batteryLevel
                )
            }
        )

        return try {
            var response: Response<BatchSyncAckDto> = apiService.uploadBatch("Bearer ${getBearer()}", payload)
            if (response.code() == 401) {
                val rt = authStore.getSession()?.refreshToken
                if (rt == null) {
                    val reason = "HTTP 401 [AUTH_REQUIRED]: Missing refresh token. Sign in again to resume sync."
                    dao.pauseQueueForAuth(
                        employeeId = employeeId,
                        httpStatus = 401,
                        errorCode = "AUTH_REQUIRED",
                        reason = reason,
                        recordIds = sliceIds
                    )
                    authStore.markReauthRequired(
                        employeeId = employeeId,
                        deviceId = deviceId,
                        reason = reason
                    )
                    return SliceOutcome.WorkerAbort(Result.failure())
                }
                when (val refreshed = refreshAccessToken(authStore, employeeId, deviceId, rt)) {
                    is RefreshOutcome.Success -> {
                        onTokenRefreshed(refreshed.token)
                        response = apiService.uploadBatch("Bearer ${refreshed.token}", payload)
                    }
                    RefreshOutcome.RetryableError -> {
                        dao.markBatchRetryableFailed(employeeId, sliceIds, "Token refresh temporary network/server error")
                        return SliceOutcome.WorkerAbort(Result.retry())
                    }
                    RefreshOutcome.AuthExpired -> {
                        val reason = "Offline session token expired (401). Sign in again to upload queued records."
                        dao.pauseQueueForAuth(
                            employeeId = employeeId,
                            httpStatus = 401,
                            errorCode = "AUTH_REQUIRED",
                            reason = reason,
                            recordIds = sliceIds
                        )
                        authStore.markReauthRequired(
                            employeeId = employeeId,
                            deviceId = deviceId,
                            reason = reason
                        )
                        return SliceOutcome.WorkerAbort(Result.failure())
                    }
                }
            }

            val body = response.body()
            if (response.isSuccessful && body != null) {
                val confirmedIds = (body.acceptedIds + body.duplicateIds).distinct()
                if (confirmedIds.isNotEmpty()) {
                    dao.markBatchSynced(
                        employeeId = employeeId,
                        confirmedIds = confirmedIds,
                        serverReceivedAt = body.serverReceivedAt
                    )
                }
                // Guard against partial server acknowledgements:
                // omitted records are NEVER marked SYNCED; mark RETRYABLE_FAILED and return Result.retry().
                val confirmedSet = confirmedIds.toSet()
                val omittedIds = sliceIds.filterNot { it in confirmedSet }
                if (omittedIds.isNotEmpty()) {
                    dao.markBatchRetryableFailed(
                        employeeId = employeeId,
                        failedIds = omittedIds,
                        errorMessage = "Partial ACK: ${omittedIds.size}/${slice.size} records omitted by server"
                    )
                    return SliceOutcome.WorkerAbort(Result.retry())
                }
                SliceOutcome.CompletedOrIsolated
            } else {
                val code = response.code()
                val rawErrBody = runCatching { response.errorBody()?.string() }.getOrNull()
                val parsedErr = parseApiError(code, rawErrBody)
                val codeTag = parsedErr.code?.let { " [$it]" } ?: ""
                val errLabel = "HTTP $code$codeTag: ${parsedErr.message}"

                when {
                    code == 403 -> {
                        // Authorization denial (403): preserve tokens, pause queue as BLOCKED_AUTH with explicit reason.
                        dao.pauseQueueForAuth(
                            employeeId = employeeId,
                            httpStatus = 403,
                            errorCode = parsedErr.code ?: "AUTH_REQUIRED",
                            reason = "Authorization denied (HTTP 403): ${parsedErr.message}",
                            recordIds = sliceIds
                        )
                        SliceOutcome.WorkerAbort(Result.failure())
                    }
                    parsedErr.code == "AUTH_REQUIRED" || code == 401 -> {
                        val reason = "Authentication required (HTTP $code): ${parsedErr.message}"
                        dao.pauseQueueForAuth(
                            employeeId = employeeId,
                            httpStatus = code,
                            errorCode = parsedErr.code ?: "AUTH_REQUIRED",
                            reason = reason,
                            recordIds = sliceIds
                        )
                        authStore.markReauthRequired(
                            employeeId = employeeId,
                            deviceId = deviceId,
                            reason = reason
                        )
                        SliceOutcome.WorkerAbort(Result.failure())
                    }
                    code == 400 && parsedErr.code == "INVALID_RECORD" -> {
                        // Bisect ONLY when backend explicitly reports record-level validation failure (INVALID_RECORD).
                        if (slice.size == 1) {
                            dao.markBatchPermanentFailed(employeeId, sliceIds, errLabel)
                            onPermanentFailure()
                            SliceOutcome.CompletedOrIsolated
                        } else {
                            val mid = slice.size / 2
                            val left = uploadLocationSlice(
                                dao = dao,
                                authStore = authStore,
                                employeeId = employeeId,
                                deviceId = deviceId,
                                slice = slice.subList(0, mid),
                                getBearer = getBearer,
                                onTokenRefreshed = onTokenRefreshed,
                                onPermanentFailure = onPermanentFailure
                            )
                            if (left is SliceOutcome.WorkerAbort) return left
                            uploadLocationSlice(
                                dao = dao,
                                authStore = authStore,
                                employeeId = employeeId,
                                deviceId = deviceId,
                                slice = slice.subList(mid, slice.size),
                                getBearer = getBearer,
                                onTokenRefreshed = onTokenRefreshed,
                                onPermanentFailure = onPermanentFailure
                            )
                        }
                    }
                    code == 400 || code == 404 || parsedErr.code == "UNKNOWN_ENDPOINT" || parsedErr.code == "INVALID_BATCH" -> {
                        // Batch contract or endpoint mismatch: preserve all records as BLOCKED_CONFIGURATION
                        // and pause periodic/immediate retries until app/endpoint configuration recovers.
                        val resolvedCode = parsedErr.code ?: if (code == 404) "UNKNOWN_ENDPOINT" else "INVALID_BATCH"
                        dao.pauseQueueForConfiguration(
                            employeeId = employeeId,
                            httpStatus = code,
                            errorCode = resolvedCode,
                            reason = errLabel,
                            appVersionCode = BuildConfig.VERSION_CODE,
                            apiBaseUrl = BuildConfig.API_BASE_URL,
                            recordIds = sliceIds
                        )
                        SliceOutcome.WorkerAbort(Result.failure())
                    }
                    else -> {
                        // Transient 5xx / 429: remain RETRYABLE_FAILED and use WorkManager exponential backoff.
                        dao.markBatchRetryableFailed(employeeId, sliceIds, errLabel)
                        SliceOutcome.WorkerAbort(Result.retry())
                    }
                }
            }
        } catch (ce: CancellationException) {
            throw ce
        } catch (ex: Exception) {
            dao.markBatchRetryableFailed(
                employeeId = employeeId,
                failedIds = sliceIds,
                errorMessage = ex.message ?: ex::class.java.simpleName
            )
            SliceOutcome.WorkerAbort(Result.retry())
        }
    }

    private suspend fun syncSessionOutboxEvent(
        dao: TrackingDao,
        authStore: SecureAuthStore,
        employeeId: String,
        deviceId: String,
        event: SessionEventOutboxEntity,
        currentBearer: String,
        onTokenRefreshed: (String) -> Unit
    ): OutboxStepOutcome {
        var bearer = currentBearer
        return try {
            suspend fun dispatch(): Triple<Boolean, Int, String?> {
                return if (event.eventType == "START") {
                    val res = apiService.startSession(
                        "Bearer $bearer",
                        SessionStartRequestDto(
                            sessionId = event.sessionId,
                            deviceId = event.deviceId,
                            startedAtIso = event.occurredAtIso
                        )
                    )
                    val err = if (res.isSuccessful) null else runCatching { res.errorBody()?.string() }.getOrNull()
                    Triple(res.isSuccessful, res.code(), err)
                } else {
                    val status = if (event.eventType == "INTERRUPTED") "interrupted" else "completed"
                    val res = apiService.stopSession(
                        "Bearer $bearer",
                        SessionStopRequestDto(
                            sessionId = event.sessionId,
                            endedAtIso = event.occurredAtIso,
                            deviceId = event.deviceId,
                            startedAtIso = event.sessionStartedAtIso,
                            status = status
                        )
                    )
                    val err = if (res.isSuccessful) null else runCatching { res.errorBody()?.string() }.getOrNull()
                    Triple(res.isSuccessful, res.code(), err)
                }
            }

            var (isSuccessful, code, errBody) = dispatch()

            if (code == 401) {
                val rt = authStore.getSession()?.refreshToken
                if (rt == null) {
                    val reason = "HTTP 401 [AUTH_REQUIRED]: Sign in required to sync queued session events."
                    dao.pauseQueueForAuth(
                        employeeId = employeeId,
                        httpStatus = 401,
                        errorCode = "AUTH_REQUIRED",
                        reason = reason,
                        eventIds = listOf(event.eventId)
                    )
                    authStore.markReauthRequired(employeeId, deviceId, reason)
                    return OutboxStepOutcome.WorkerAbort(Result.failure())
                }
                when (val refreshed = refreshAccessToken(authStore, employeeId, deviceId, rt)) {
                    is RefreshOutcome.Success -> {
                        bearer = refreshed.token
                        onTokenRefreshed(bearer)
                        val second = dispatch()
                        isSuccessful = second.first
                        code = second.second
                        errBody = second.third
                    }
                    RefreshOutcome.RetryableError -> {
                        dao.markSessionEventRetryableFailed(event.eventId, "Token refresh temporary network/server error")
                        return OutboxStepOutcome.WorkerAbort(Result.retry())
                    }
                    RefreshOutcome.AuthExpired -> {
                        val reason = "Offline session token expired (401). Sign in again to upload queued records."
                        dao.pauseQueueForAuth(
                            employeeId = employeeId,
                            httpStatus = 401,
                            errorCode = "AUTH_REQUIRED",
                            reason = reason,
                            eventIds = listOf(event.eventId)
                        )
                        authStore.markReauthRequired(employeeId, deviceId, reason)
                        return OutboxStepOutcome.WorkerAbort(Result.failure())
                    }
                }
            }

            if (isSuccessful) {
                dao.markSessionEventSynced(event.eventId, Instant.now().toString())
                OutboxStepOutcome.Synced
            } else {
                val parsedErr = parseApiError(code, errBody)
                val codeTag = parsedErr.code?.let { " [$it]" } ?: ""
                val errLabel = "HTTP $code$codeTag: ${parsedErr.message}"
                when {
                    code == 403 -> {
                        dao.pauseQueueForAuth(
                            employeeId = employeeId,
                            httpStatus = 403,
                            errorCode = parsedErr.code ?: "AUTH_REQUIRED",
                            reason = "Authorization denied (HTTP 403): ${parsedErr.message}",
                            eventIds = listOf(event.eventId)
                        )
                        OutboxStepOutcome.WorkerAbort(Result.failure())
                    }
                    parsedErr.code == "AUTH_REQUIRED" || code == 401 -> {
                        val reason = "Authentication required (HTTP $code): ${parsedErr.message}"
                        dao.pauseQueueForAuth(
                            employeeId = employeeId,
                            httpStatus = code,
                            errorCode = parsedErr.code ?: "AUTH_REQUIRED",
                            reason = reason,
                            eventIds = listOf(event.eventId)
                        )
                        authStore.markReauthRequired(employeeId, deviceId, reason)
                        OutboxStepOutcome.WorkerAbort(Result.failure())
                    }
                    parsedErr.code == "SESSION_INVALID" -> {
                        // Explicit backend SESSION_INVALID error isolates only this session event (preserved locally).
                        dao.markSessionEventPermanentFailed(event.eventId, errLabel)
                        OutboxStepOutcome.PermanentFailureIsolated
                    }
                    code == 400 || code == 404 || parsedErr.code == "UNKNOWN_ENDPOINT" || parsedErr.code == "INVALID_BATCH" -> {
                        val resolvedCode = parsedErr.code ?: if (code == 404) "UNKNOWN_ENDPOINT" else "INVALID_BATCH"
                        dao.pauseQueueForConfiguration(
                            employeeId = employeeId,
                            httpStatus = code,
                            errorCode = resolvedCode,
                            reason = errLabel,
                            appVersionCode = BuildConfig.VERSION_CODE,
                            apiBaseUrl = BuildConfig.API_BASE_URL,
                            eventIds = listOf(event.eventId)
                        )
                        OutboxStepOutcome.WorkerAbort(Result.failure())
                    }
                    else -> {
                        dao.markSessionEventRetryableFailed(event.eventId, errLabel)
                        OutboxStepOutcome.WorkerAbort(Result.retry())
                    }
                }
            }
        } catch (ce: CancellationException) {
            throw ce
        } catch (ex: Exception) {
            dao.markSessionEventRetryableFailed(event.eventId, ex.message ?: ex::class.java.simpleName)
            OutboxStepOutcome.WorkerAbort(Result.retry())
        }
    }

    private suspend fun refreshAccessToken(
        authStore: SecureAuthStore,
        employeeId: String,
        deviceId: String,
        refreshToken: String
    ): RefreshOutcome {
        return try {
            val res = apiService.refreshSessionToken(
                RefreshTokenRequestDto(
                    employeeId = employeeId,
                    deviceId = deviceId,
                    refreshToken = refreshToken
                )
            )
            val body = res.body()
            if (res.isSuccessful && body != null) {
                authStore.saveSession(
                    employeeId = body.employeeId,
                    deviceId = body.deviceId,
                    accessToken = body.token,
                    expiresAtIso = body.expiresAt,
                    refreshToken = body.refreshToken
                )
                RefreshOutcome.Success(body.token)
            } else if (res.code() in listOf(401, 403)) {
                RefreshOutcome.AuthExpired
            } else {
                RefreshOutcome.RetryableError
            }
        } catch (ce: CancellationException) {
            throw ce
        } catch (_: Exception) {
            RefreshOutcome.RetryableError
        }
    }

    companion object {
        const val KEY_EMPLOYEE_ID = "employee_id"
        const val KEY_DEVICE_ID = "device_id"
        const val KEY_FORCE_USER_RECOVERY = "force_user_recovery"
        const val BATCH_SIZE = 100
    }
}
