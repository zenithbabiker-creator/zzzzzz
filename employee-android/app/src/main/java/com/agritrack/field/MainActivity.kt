package com.agritrack.field

import android.Manifest
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.location.LocationManager
import android.os.Build
import android.os.Bundle
import androidx.activity.ComponentActivity
import androidx.activity.compose.rememberLauncherForActivityResult
import androidx.activity.compose.setContent
import androidx.activity.result.contract.ActivityResultContracts
import androidx.compose.material3.MaterialTheme
import androidx.compose.runtime.LaunchedEffect
import androidx.compose.runtime.collectAsState
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableIntStateOf
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import androidx.lifecycle.lifecycleScope
import com.agritrack.field.data.local.AgriTrackDatabase
import com.agritrack.field.data.local.SecureAuthStore
import com.agritrack.field.data.local.entity.EmployeeEntity
import com.agritrack.field.data.local.entity.SyncQueueStateEntity
import com.agritrack.field.data.local.entity.SyncStatus
import com.agritrack.field.data.local.entity.TrackingSessionEntity
import com.agritrack.field.data.remote.SessionTokenRequestDto
import com.agritrack.field.data.remote.SyncApiService
import com.agritrack.field.service.GpsTrackingForegroundService
import com.agritrack.field.sync.SyncScheduler
import com.agritrack.field.ui.TrackerScreen
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.flow.flowOf
import kotlinx.coroutines.launch
import kotlinx.coroutines.withContext

class MainActivity : ComponentActivity() {

    private val apiService: SyncApiService by lazy {
        SyncApiService.create(BuildConfig.API_BASE_URL)
    }

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)

        val dao = AgriTrackDatabase.getInstance(applicationContext).trackingDao()
        val authStore = SecureAuthStore(applicationContext)

        // Safely transition any orphaned ACTIVE sessions from a prior reboot/crash to INTERRUPTED
        // and enqueue INTERRUPTED outbox events without silently resuming GPS collection.
        lifecycleScope.launch(Dispatchers.IO) {
            if (!GpsTrackingForegroundService.isRunning) {
                dao.recoverInterruptedSessionsOnBoot(System.currentTimeMillis())
            }
        }

        val initialSession = authStore.getSession()
        val initialReauth = authStore.getReauthNotice()

        setContent {
            MaterialTheme {
                var signedInEmployeeId by remember { mutableStateOf(initialSession?.employeeId) }
                var deviceId by remember {
                    mutableStateOf(
                        initialSession?.deviceId
                            ?: initialReauth?.deviceId
                            ?: "AND-DEV-${Build.MODEL.take(6).uppercase()}"
                    )
                }
                var reauthNotice by remember { mutableStateOf(initialReauth) }
                var queuedUnsyncedBeforeLogin by remember { mutableIntStateOf(0) }
                var authError by remember { mutableStateOf<String?>(null) }
                var sessionFeedback by remember { mutableStateOf<String?>(null) }
                var isArabic by remember { mutableStateOf(false) }

                LaunchedEffect(reauthNotice) {
                    val notice = reauthNotice
                    queuedUnsyncedBeforeLogin = if (notice != null) {
                        withContext(Dispatchers.IO) {
                            dao.countUnsyncedRecordsOnce(notice.employeeId)
                        }
                    } else {
                        0
                    }
                }

                val activeEmployee = signedInEmployeeId

                val activeSession by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeActiveSession(activeEmployee)
                    else flowOf(null)
                }.collectAsState(initial = null)

                val pendingCount by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeCountByStatus(activeEmployee, SyncStatus.PENDING)
                    else flowOf(0)
                }.collectAsState(initial = 0)

                val syncedCount by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeCountByStatus(activeEmployee, SyncStatus.SYNCED)
                    else flowOf(0)
                }.collectAsState(initial = 0)

                val retryableFailedCount by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeCountByStatus(activeEmployee, SyncStatus.RETRYABLE_FAILED)
                    else flowOf(0)
                }.collectAsState(initial = 0)

                val permanentFailedCount by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeCountByStatus(activeEmployee, SyncStatus.PERMANENT_FAILED)
                    else flowOf(0)
                }.collectAsState(initial = 0)

                val outboxPermanentFailedCount by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeOutboxPermanentFailedCount(activeEmployee)
                    else flowOf(0)
                }.collectAsState(initial = 0)

                val blockedAuthCount by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeCountByStatus(activeEmployee, SyncStatus.BLOCKED_AUTH)
                    else flowOf(0)
                }.collectAsState(initial = 0)

                val blockedConfigCount by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeCountByStatus(activeEmployee, SyncStatus.BLOCKED_CONFIGURATION)
                    else flowOf(0)
                }.collectAsState(initial = 0)

                val outboxBlockedCount by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeOutboxBlockedCount(activeEmployee)
                    else flowOf(0)
                }.collectAsState(initial = 0)

                val syncQueueState by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeSyncQueueState(activeEmployee)
                    else flowOf(null)
                }.collectAsState(initial = null)

                val latestRecordError by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeLatestRecordError(activeEmployee)
                    else flowOf(null)
                }.collectAsState(initial = null)

                val latestOutboxError by remember(activeEmployee) {
                    if (activeEmployee != null) dao.observeLatestOutboxError(activeEmployee)
                    else flowOf(null)
                }.collectAsState(initial = null)

                LaunchedEffect(syncQueueState) {
                    val notice = authStore.getReauthNotice()
                    if (notice != null && signedInEmployeeId != null && authStore.getSession() == null) {
                        reauthNotice = notice
                        signedInEmployeeId = null
                    }
                }

                val permissionLauncher = rememberLauncherForActivityResult(
                    ActivityResultContracts.RequestMultiplePermissions()
                ) { grants ->
                    val fineGranted = grants[Manifest.permission.ACCESS_FINE_LOCATION] == true
                    val coarseGranted = grants[Manifest.permission.ACCESS_COARSE_LOCATION] == true
                    val empId = signedInEmployeeId
                    if ((fineGranted || coarseGranted) && empId != null) {
                        if (!isDeviceLocationEnabled()) {
                            sessionFeedback = "Turn on device Location (GPS) in Settings before starting."
                        } else {
                            sessionFeedback = null
                            startEmployeeTrackingSession(empId, deviceId)
                        }
                    } else {
                        sessionFeedback = "Location permission is required to start an active tracking session."
                    }
                }

                LaunchedEffect(activeEmployee, deviceId) {
                    if (activeEmployee != null) {
                        SyncScheduler.schedulePeriodicSync(
                            context = applicationContext,
                            employeeId = activeEmployee,
                            deviceId = deviceId
                        )
                    }
                }

                val reauthBannerText = reauthNotice?.let { notice ->
                    if (queuedUnsyncedBeforeLogin > 0) {
                        "${notice.reason} ($queuedUnsyncedBeforeLogin offline records safely queued locally.)"
                    } else {
                        notice.reason
                    }
                }

                val totalBlockedCount = blockedAuthCount + blockedConfigCount + outboxBlockedCount
                val syncPauseBanner = when (syncQueueState?.pauseType) {
                    SyncQueueStateEntity.PAUSE_AUTH -> {
                        val prefix = if (syncQueueState?.httpStatus == 403) {
                            "Sync paused (Authorization Denied — HTTP 403)"
                        } else {
                            "Sync paused (Sign-In Required — HTTP ${syncQueueState?.httpStatus ?: 401})"
                        }
                        "$prefix: ${syncQueueState?.reason ?: "Re-authentication or account approval required."}"
                    }
                    SyncQueueStateEntity.PAUSE_CONFIGURATION -> {
                        "Sync paused (Endpoint / Configuration Update Required — ${syncQueueState?.errorCode ?: "CONFIGURATION"}): ${syncQueueState?.reason ?: "All field records remain safely stored locally."}"
                    }
                    else -> null
                }

                TrackerScreen(
                    signedInEmployeeId = signedInEmployeeId,
                    initialEmployeeId = reauthNotice?.employeeId ?: "",
                    deviceId = deviceId,
                    isTracking = activeSession != null,
                    pendingCount = pendingCount,
                    syncedCount = syncedCount,
                    retryableFailedCount = retryableFailedCount,
                    blockedCount = totalBlockedCount,
                    permanentFailedCount = permanentFailedCount + outboxPermanentFailedCount,
                    syncPauseBanner = syncPauseBanner,
                    latestSyncError = latestRecordError ?: latestOutboxError,
                    reauthBanner = reauthBannerText,
                    authError = authError,
                    sessionFeedback = sessionFeedback,
                    isArabic = isArabic,
                    onToggleLanguage = { isArabic = !isArabic },
                    onSignIn = { empInput, devInput, passcodeInput ->
                        val normalizedEmp = empInput.trim().uppercase()
                        val normalizedDev = devInput.trim().uppercase()
                        if (!Regex("^(EMP|AG)-[A-Z0-9-]{1,32}$").matches(normalizedEmp)) {
                            authError = "Enter a valid Employee ID (e.g. EMP-001)"
                            return@TrackerScreen
                        }
                        if (normalizedDev.isEmpty() || passcodeInput.length < 4) {
                            authError = "Device ID and passcode (4+ chars) are required"
                            return@TrackerScreen
                        }

                        authError = null
                        lifecycleScope.launch {
                            val result = withContext(Dispatchers.IO) {
                                runCatching {
                                    apiService.requestSessionToken(
                                        SessionTokenRequestDto(
                                            employeeId = normalizedEmp,
                                            deviceId = normalizedDev,
                                            passcode = passcodeInput
                                        )
                                    )
                                }
                            }
                            val response = result.getOrNull()
                            val body = response?.body()
                            if (response != null && response.isSuccessful && body != null) {
                                authStore.saveSession(
                                    employeeId = body.employeeId,
                                    deviceId = body.deviceId,
                                    accessToken = body.token,
                                    expiresAtIso = body.expiresAt,
                                    refreshToken = body.refreshToken
                                )
                                withContext(Dispatchers.IO) {
                                    dao.upsertEmployee(
                                        EmployeeEntity(
                                            employeeId = body.employeeId,
                                            fullNameEn = body.fullNameEn ?: body.employeeId,
                                            fullNameAr = body.fullNameAr ?: body.employeeId,
                                            employeeNumber = body.employeeId,
                                            assignedDeviceId = body.deviceId,
                                            accountStatus = "active",
                                            sessionStatus = "IDLE"
                                        )
                                    )
                                    // Resume any records or session outbox events paused in BLOCKED_AUTH
                                    dao.unblockAuthQueue(body.employeeId)
                                }
                                reauthNotice = null
                                deviceId = body.deviceId
                                signedInEmployeeId = body.employeeId
                                SyncScheduler.triggerImmediateSyncOnConnect(
                                    context = applicationContext,
                                    employeeId = body.employeeId,
                                    deviceId = body.deviceId,
                                    forceUserRecovery = true
                                )
                            } else {
                                authError = when (response?.code()) {
                                    401 -> "Invalid employee credentials"
                                    403 -> "Account inactive or device conflict"
                                    429 -> "Too many failed sign-in attempts; wait 15 minutes before retrying"
                                    null -> "Central backend unreachable; check connectivity to sign in"
                                    else -> "Authentication error (${response.code()})"
                                }
                            }
                        }
                    },
                    onSignOut = {
                        if (activeSession == null) {
                            val empId = signedInEmployeeId
                            val currentAuth = authStore.getSession()
                            lifecycleScope.launch(Dispatchers.IO) {
                                if (currentAuth != null) {
                                    runCatching {
                                        apiService.logoutSession("Bearer ${currentAuth.accessToken}")
                                    }
                                }
                            }
                            if (empId != null) {
                                SyncScheduler.cancelSync(applicationContext, empId)
                            }
                            authStore.clear()
                            reauthNotice = null
                            sessionFeedback = null
                            signedInEmployeeId = null
                        }
                    },
                    onStartSession = {
                        val empId = signedInEmployeeId ?: return@TrackerScreen
                        val hasLocation = hasLocationPermission()
                        val hasNotif = Build.VERSION.SDK_INT < Build.VERSION_CODES.TIRAMISU ||
                            ContextCompat.checkSelfPermission(
                                this,
                                Manifest.permission.POST_NOTIFICATIONS
                            ) == PackageManager.PERMISSION_GRANTED

                        if (hasLocation && hasNotif) {
                            if (!isDeviceLocationEnabled()) {
                                sessionFeedback = "Turn on device Location (GPS) in Settings before starting."
                            } else {
                                sessionFeedback = null
                                startEmployeeTrackingSession(empId, deviceId)
                            }
                        } else {
                            val needed = mutableListOf<String>()
                            if (!hasLocation) {
                                needed.add(Manifest.permission.ACCESS_FINE_LOCATION)
                                needed.add(Manifest.permission.ACCESS_COARSE_LOCATION)
                            }
                            if (!hasNotif && Build.VERSION.SDK_INT >= Build.VERSION_CODES.TIRAMISU) {
                                needed.add(Manifest.permission.POST_NOTIFICATIONS)
                            }
                            permissionLauncher.launch(needed.toTypedArray())
                        }
                    },
                    onStopSession = {
                        val empId = signedInEmployeeId ?: return@TrackerScreen
                        val sid = activeSession?.sessionId ?: return@TrackerScreen
                        val endedMs = System.currentTimeMillis()
                        lifecycleScope.launch {
                            withContext(Dispatchers.IO) {
                                dao.stopSessionTransaction(
                                    sessionId = sid,
                                    employeeId = empId,
                                    endedAt = endedMs,
                                    targetStatus = "COMPLETED"
                                )
                            }
                            if (GpsTrackingForegroundService.isRunning) {
                                val stopIntent = Intent(
                                    applicationContext,
                                    GpsTrackingForegroundService::class.java
                                ).apply {
                                    action = GpsTrackingForegroundService.ACTION_STOP
                                    putExtra(GpsTrackingForegroundService.EXTRA_EMPLOYEE_ID, empId)
                                    putExtra(GpsTrackingForegroundService.EXTRA_DEVICE_ID, deviceId)
                                    putExtra(GpsTrackingForegroundService.EXTRA_SESSION_ID, sid)
                                }
                                startService(stopIntent)
                            }
                            SyncScheduler.triggerImmediateSyncOnConnect(
                                context = applicationContext,
                                employeeId = empId,
                                deviceId = deviceId
                            )
                        }
                    },
                    onSyncNow = {
                        val empId = signedInEmployeeId ?: return@TrackerScreen
                        SyncScheduler.triggerImmediateSyncOnConnect(
                            context = applicationContext,
                            employeeId = empId,
                            deviceId = deviceId,
                            forceUserRecovery = true
                        )
                    }
                )
            }
        }
    }

    private fun hasLocationPermission(): Boolean {
        val fine = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_FINE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(
            this,
            Manifest.permission.ACCESS_COARSE_LOCATION
        ) == PackageManager.PERMISSION_GRANTED
        return fine || coarse
    }

    private fun isDeviceLocationEnabled(): Boolean {
        val manager = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false
        return LocationManagerCompat.isLocationEnabled(manager)
    }

    private fun startEmployeeTrackingSession(
        employeeId: String,
        deviceId: String
    ) {
        val dao = AgriTrackDatabase.getInstance(applicationContext).trackingDao()
        lifecycleScope.launch {
            val startedMs = System.currentTimeMillis()
            val session = TrackingSessionEntity(
                employeeId = employeeId,
                deviceId = deviceId,
                startedAtEpochMs = startedMs,
                status = "ACTIVE"
            )
            withContext(Dispatchers.IO) {
                dao.startSessionTransaction(session)
            }
            val intent = Intent(applicationContext, GpsTrackingForegroundService::class.java).apply {
                action = GpsTrackingForegroundService.ACTION_START
                putExtra(GpsTrackingForegroundService.EXTRA_EMPLOYEE_ID, employeeId)
                putExtra(GpsTrackingForegroundService.EXTRA_DEVICE_ID, deviceId)
                putExtra(GpsTrackingForegroundService.EXTRA_SESSION_ID, session.sessionId)
            }
            ContextCompat.startForegroundService(applicationContext, intent)

            // Queue reliable outbox sync (runs immediately when connected, or waits offline automatically)
            SyncScheduler.triggerImmediateSyncOnConnect(
                context = applicationContext,
                employeeId = employeeId,
                deviceId = deviceId
            )
        }
    }
}
