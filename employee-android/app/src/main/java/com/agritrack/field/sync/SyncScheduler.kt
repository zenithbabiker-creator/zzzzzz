package com.agritrack.field.sync

import android.content.Context
import androidx.work.BackoffPolicy
import androidx.work.Constraints
import androidx.work.ExistingPeriodicWorkPolicy
import androidx.work.ExistingWorkPolicy
import androidx.work.NetworkType
import androidx.work.OneTimeWorkRequestBuilder
import androidx.work.PeriodicWorkRequestBuilder
import androidx.work.WorkManager
import androidx.work.WorkRequest
import androidx.work.workDataOf
import java.util.concurrent.TimeUnit

object SyncScheduler {

    private val connectedConstraints = Constraints.Builder()
        .setRequiredNetworkType(NetworkType.CONNECTED)
        .build()

    fun schedulePeriodicSync(
        context: Context,
        employeeId: String,
        deviceId: String
    ) {
        val request = PeriodicWorkRequestBuilder<SyncWorker>(15, TimeUnit.MINUTES)
            .setConstraints(connectedConstraints)
            .setInputData(
                workDataOf(
                    SyncWorker.KEY_EMPLOYEE_ID to employeeId,
                    SyncWorker.KEY_DEVICE_ID to deviceId
                )
            )
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS
            )
            .build()

        WorkManager.getInstance(context).enqueueUniquePeriodicWork(
            periodicWorkName(employeeId),
            ExistingPeriodicWorkPolicy.KEEP,
            request
        )
    }

    fun triggerImmediateSyncOnConnect(
        context: Context,
        employeeId: String,
        deviceId: String,
        forceUserRecovery: Boolean = false
    ) {
        val request = OneTimeWorkRequestBuilder<SyncWorker>()
            .setConstraints(connectedConstraints)
            .setInputData(
                workDataOf(
                    SyncWorker.KEY_EMPLOYEE_ID to employeeId,
                    SyncWorker.KEY_DEVICE_ID to deviceId,
                    SyncWorker.KEY_FORCE_USER_RECOVERY to forceUserRecovery
                )
            )
            .setBackoffCriteria(
                BackoffPolicy.EXPONENTIAL,
                WorkRequest.MIN_BACKOFF_MILLIS,
                TimeUnit.MILLISECONDS
            )
            .build()

        WorkManager.getInstance(context).enqueueUniqueWork(
            immediateWorkName(employeeId),
            if (forceUserRecovery) ExistingWorkPolicy.REPLACE else ExistingWorkPolicy.APPEND_OR_REPLACE,
            request
        )
    }

    fun cancelSync(context: Context, employeeId: String) {
        val wm = WorkManager.getInstance(context)
        wm.cancelUniqueWork(periodicWorkName(employeeId))
        wm.cancelUniqueWork(immediateWorkName(employeeId))
    }

    private fun periodicWorkName(employeeId: String) = "agritrack_periodic_sync_$employeeId"
    private fun immediateWorkName(employeeId: String) = "agritrack_immediate_sync_$employeeId"
}
