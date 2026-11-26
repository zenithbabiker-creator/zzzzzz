package com.agritrack.field.service

import android.Manifest
import android.annotation.SuppressLint
import android.app.Notification
import android.app.NotificationChannel
import android.app.NotificationManager
import android.app.PendingIntent
import android.app.Service
import android.content.Context
import android.content.Intent
import android.content.pm.PackageManager
import android.content.pm.ServiceInfo
import android.location.LocationManager
import android.os.BatteryManager
import android.os.Build
import android.os.IBinder
import androidx.core.app.NotificationCompat
import androidx.core.app.ServiceCompat
import androidx.core.content.ContextCompat
import androidx.core.location.LocationManagerCompat
import com.agritrack.field.MainActivity
import com.agritrack.field.R
import com.agritrack.field.data.local.AgriTrackDatabase
import com.agritrack.field.data.local.entity.LocationRecordEntity
import com.agritrack.field.sync.SyncScheduler
import com.google.android.gms.location.LocationServices
import com.google.android.gms.location.Priority
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.delay
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.coroutines.tasks.await
import java.time.Instant
import java.time.ZoneId
import java.time.format.DateTimeFormatter
import java.util.UUID

class GpsTrackingForegroundService : Service() {

    private val serviceScope = CoroutineScope(SupervisorJob() + Dispatchers.IO)
    private var tickerJob: Job? = null

    override fun onBind(intent: Intent?): IBinder? = null

    override fun onStartCommand(intent: Intent?, flags: Int, startId: Int): Int {
        when (intent?.action) {
            ACTION_START -> {
                val employeeId = intent.getStringExtra(EXTRA_EMPLOYEE_ID) ?: return START_NOT_STICKY
                val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID) ?: return START_NOT_STICKY
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID) ?: return START_NOT_STICKY

                if (!hasLocationPermission()) {
                    serviceScope.launch {
                        AgriTrackDatabase.getInstance(applicationContext)
                            .trackingDao()
                            .stopSessionTransaction(
                                sessionId = sessionId,
                                employeeId = employeeId,
                                endedAt = System.currentTimeMillis(),
                                targetStatus = "INTERRUPTED"
                            )
                    }
                    stopSelf()
                    return START_NOT_STICKY
                }

                ensureNotificationChannel()
                val notification = buildNotification(
                    employeeId = employeeId,
                    sessionId = sessionId,
                    bodyOverride = null
                )
                try {
                    val fgType = if (Build.VERSION.SDK_INT >= Build.VERSION_CODES.Q) {
                        ServiceInfo.FOREGROUND_SERVICE_TYPE_LOCATION
                    } else {
                        0
                    }
                    ServiceCompat.startForeground(this, NOTIFICATION_ID, notification, fgType)
                } catch (_: SecurityException) {
                    serviceScope.launch {
                        AgriTrackDatabase.getInstance(applicationContext)
                            .trackingDao()
                            .stopSessionTransaction(
                                sessionId = sessionId,
                                employeeId = employeeId,
                                endedAt = System.currentTimeMillis(),
                                targetStatus = "INTERRUPTED"
                            )
                    }
                    stopSelf()
                    return START_NOT_STICKY
                }

                isRunning = true
                startPeriodicCapture(employeeId, deviceId, sessionId)
            }
            ACTION_STOP -> {
                val employeeId = intent.getStringExtra(EXTRA_EMPLOYEE_ID)
                val deviceId = intent.getStringExtra(EXTRA_DEVICE_ID)
                val sessionId = intent.getStringExtra(EXTRA_SESSION_ID)
                tickerJob?.cancel()
                isRunning = false
                if (employeeId != null && sessionId != null) {
                    serviceScope.launch {
                        try {
                            val dao = AgriTrackDatabase.getInstance(applicationContext).trackingDao()
                            val sess = dao.getSessionById(sessionId)
                            dao.stopSessionTransaction(
                                sessionId = sessionId,
                                employeeId = employeeId,
                                endedAt = System.currentTimeMillis(),
                                targetStatus = "COMPLETED"
                            )
                            val resolvedDevId = deviceId ?: sess?.deviceId
                            if (resolvedDevId != null) {
                                SyncScheduler.triggerImmediateSyncOnConnect(
                                    context = applicationContext,
                                    employeeId = employeeId,
                                    deviceId = resolvedDevId
                                )
                            }
                        } finally {
                            ServiceCompat.stopForeground(
                                this@GpsTrackingForegroundService,
                                ServiceCompat.STOP_FOREGROUND_REMOVE
                            )
                            stopSelf()
                        }
                    }
                } else {
                    ServiceCompat.stopForeground(this, ServiceCompat.STOP_FOREGROUND_REMOVE)
                    stopSelf()
                }
            }
        }
        return START_NOT_STICKY
    }

    @SuppressLint("MissingPermission")
    private fun startPeriodicCapture(employeeId: String, deviceId: String, sessionId: String) {
        tickerJob?.cancel()
        val fusedClient = LocationServices.getFusedLocationProviderClient(this)
        val dao = AgriTrackDatabase.getInstance(this).trackingDao()
        val notificationManager = getSystemService(NotificationManager::class.java)

        tickerJob = serviceScope.launch {
            while (isActive) {
                if (!hasLocationPermission()) {
                    dao.stopSessionTransaction(
                        sessionId = sessionId,
                        employeeId = employeeId,
                        endedAt = System.currentTimeMillis(),
                        targetStatus = "INTERRUPTED"
                    )
                    SyncScheduler.triggerImmediateSyncOnConnect(
                        context = applicationContext,
                        employeeId = employeeId,
                        deviceId = deviceId
                    )
                    isRunning = false
                    ServiceCompat.stopForeground(
                        this@GpsTrackingForegroundService,
                        ServiceCompat.STOP_FOREGROUND_REMOVE
                    )
                    stopSelf()
                    return@launch
                }

                if (!isDeviceLocationEnabled()) {
                    notificationManager.notify(
                        NOTIFICATION_ID,
                        buildNotification(
                            employeeId = employeeId,
                            sessionId = sessionId,
                            bodyOverride = getString(R.string.notification_gps_disabled)
                        )
                    )
                    delay(TEN_MINUTES_MS)
                    continue
                }

                try {
                    val location = fusedClient
                        .getCurrentLocation(Priority.PRIORITY_HIGH_ACCURACY, null)
                        .await()

                    if (location != null) {
                        val instant = Instant.ofEpochMilli(System.currentTimeMillis())
                        val zoned = instant.atZone(ZoneId.systemDefault())
                        val batteryPct = readBatteryPercent()

                        val record = LocationRecordEntity(
                            recordId = UUID.randomUUID().toString(),
                            sessionId = sessionId,
                            employeeId = employeeId,
                            deviceId = deviceId,
                            latitude = location.latitude,
                            longitude = location.longitude,
                            capturedAtIso = DateTimeFormatter.ISO_INSTANT.format(instant),
                            capturedAtEpochMs = instant.toEpochMilli(),
                            dateStr = zoned.toLocalDate().toString(),
                            hour = zoned.hour,
                            minute = zoned.minute,
                            second = zoned.second,
                            accuracyMeters = location.accuracy,
                            provider = location.provider ?: "fused",
                            batteryLevel = batteryPct
                        )
                        dao.insertLocationRecord(record)
                    }
                    notificationManager.notify(
                        NOTIFICATION_ID,
                        buildNotification(employeeId = employeeId, sessionId = sessionId, bodyOverride = null)
                    )
                } catch (_: SecurityException) {
                    dao.stopSessionTransaction(
                        sessionId = sessionId,
                        employeeId = employeeId,
                        endedAt = System.currentTimeMillis(),
                        targetStatus = "INTERRUPTED"
                    )
                    isRunning = false
                    ServiceCompat.stopForeground(
                        this@GpsTrackingForegroundService,
                        ServiceCompat.STOP_FOREGROUND_REMOVE
                    )
                    stopSelf()
                    return@launch
                } catch (_: Exception) {
                    // Retain pending local state safely; retry next 10-minute cycle
                }
                delay(TEN_MINUTES_MS)
            }
        }
    }

    private fun hasLocationPermission(): Boolean {
        val fine = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_FINE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        val coarse = ContextCompat.checkSelfPermission(this, Manifest.permission.ACCESS_COARSE_LOCATION) ==
            PackageManager.PERMISSION_GRANTED
        return fine || coarse
    }

    private fun isDeviceLocationEnabled(): Boolean {
        val manager = getSystemService(Context.LOCATION_SERVICE) as? LocationManager ?: return false
        return LocationManagerCompat.isLocationEnabled(manager)
    }

    private fun readBatteryPercent(): Int? {
        val manager = getSystemService(Context.BATTERY_SERVICE) as? BatteryManager
        val pct = manager?.getIntProperty(BatteryManager.BATTERY_PROPERTY_CAPACITY)
        return if (pct != null && pct in 0..100) pct else null
    }

    private fun ensureNotificationChannel() {
        val manager = getSystemService(NotificationManager::class.java)
        val channel = NotificationChannel(
            CHANNEL_ID,
            getString(R.string.notification_channel_name),
            NotificationManager.IMPORTANCE_LOW
        )
        manager.createNotificationChannel(channel)
    }

    private fun buildNotification(
        employeeId: String,
        sessionId: String,
        bodyOverride: String?
    ): Notification {
        val openIntent = Intent(this, MainActivity::class.java).apply {
            flags = Intent.FLAG_ACTIVITY_SINGLE_TOP or Intent.FLAG_ACTIVITY_CLEAR_TOP
        }
        val contentPending = PendingIntent.getActivity(
            this,
            1,
            openIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )

        val stopIntent = Intent(this, GpsTrackingForegroundService::class.java).apply {
            action = ACTION_STOP
            putExtra(EXTRA_EMPLOYEE_ID, employeeId)
            putExtra(EXTRA_SESSION_ID, sessionId)
        }
        val stopPending = PendingIntent.getService(
            this,
            0,
            stopIntent,
            PendingIntent.FLAG_UPDATE_CURRENT or PendingIntent.FLAG_IMMUTABLE
        )
        return NotificationCompat.Builder(this, CHANNEL_ID)
            .setContentTitle(getString(R.string.notification_title))
            .setContentText(bodyOverride ?: getString(R.string.notification_body, employeeId))
            .setContentIntent(contentPending)
            .setSmallIcon(android.R.drawable.ic_menu_mylocation)
            .setOngoing(true)
            .addAction(0, getString(R.string.stop_session), stopPending)
            .build()
    }

    override fun onDestroy() {
        isRunning = false
        tickerJob?.cancel()
        serviceScope.cancel()
        super.onDestroy()
    }

    companion object {
        @Volatile
        var isRunning: Boolean = false
            private set

        const val ACTION_START = "com.agritrack.field.ACTION_START"
        const val ACTION_STOP = "com.agritrack.field.ACTION_STOP"
        const val EXTRA_EMPLOYEE_ID = "extra_employee_id"
        const val EXTRA_DEVICE_ID = "extra_device_id"
        const val EXTRA_SESSION_ID = "extra_session_id"
        const val CHANNEL_ID = "agritrack_location_channel"
        const val NOTIFICATION_ID = 1001
        const val TEN_MINUTES_MS = 10L * 60L * 1000L
    }
}
