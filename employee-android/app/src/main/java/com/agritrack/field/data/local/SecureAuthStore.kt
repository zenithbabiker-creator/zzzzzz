package com.agritrack.field.data.local

import android.content.Context
import android.content.SharedPreferences
import androidx.security.crypto.EncryptedSharedPreferences
import androidx.security.crypto.MasterKey
import java.time.Instant

data class StoredAuthSession(
    val employeeId: String,
    val deviceId: String,
    val accessToken: String,
    val accessExpiresAtMs: Long,
    val refreshToken: String
)

data class ReauthNoticeState(
    val employeeId: String,
    val deviceId: String,
    val reason: String
)

class SecureAuthStore(context: Context) {

    private val masterKey: MasterKey = MasterKey.Builder(context.applicationContext)
        .setKeyScheme(MasterKey.KeyScheme.AES256_GCM)
        .build()

    private val prefs: SharedPreferences = EncryptedSharedPreferences.create(
        context.applicationContext,
        PREFS_NAME,
        masterKey,
        EncryptedSharedPreferences.PrefKeyEncryptionScheme.AES256_SIV,
        EncryptedSharedPreferences.PrefValueEncryptionScheme.AES256_GCM
    )

    fun saveSession(
        employeeId: String,
        deviceId: String,
        accessToken: String,
        expiresAtIso: String,
        refreshToken: String
    ) {
        val expiresMs = runCatching { Instant.parse(expiresAtIso).toEpochMilli() }
            .getOrElse { System.currentTimeMillis() + 3600_000L }

        prefs.edit()
            .putString(KEY_EMPLOYEE_ID, employeeId)
            .putString(KEY_DEVICE_ID, deviceId)
            .putString(KEY_ACCESS_TOKEN, accessToken)
            .putLong(KEY_ACCESS_EXPIRES_MS, expiresMs)
            .putString(KEY_REFRESH_TOKEN, refreshToken)
            .putString(KEY_LAST_EMPLOYEE_ID, employeeId)
            .putString(KEY_LAST_DEVICE_ID, deviceId)
            .remove(KEY_REAUTH_REASON)
            .apply()
    }

    fun getSession(): StoredAuthSession? {
        val empId = prefs.getString(KEY_EMPLOYEE_ID, null) ?: return null
        val devId = prefs.getString(KEY_DEVICE_ID, null) ?: return null
        val access = prefs.getString(KEY_ACCESS_TOKEN, null) ?: return null
        val refresh = prefs.getString(KEY_REFRESH_TOKEN, null) ?: return null
        val exp = prefs.getLong(KEY_ACCESS_EXPIRES_MS, 0L)
        return StoredAuthSession(
            employeeId = empId,
            deviceId = devId,
            accessToken = access,
            accessExpiresAtMs = exp,
            refreshToken = refresh
        )
    }

    /**
     * Called when the 45-day refresh token is expired or revoked after extended offline intervals.
     * Clears only invalid tokens and retains non-secret identity metadata so queued Room records
     * remain intact and immediately resume syncing once the employee re-authenticates.
     */
    fun markReauthRequired(employeeId: String, deviceId: String, reason: String) {
        prefs.edit()
            .remove(KEY_EMPLOYEE_ID)
            .remove(KEY_DEVICE_ID)
            .remove(KEY_ACCESS_TOKEN)
            .remove(KEY_ACCESS_EXPIRES_MS)
            .remove(KEY_REFRESH_TOKEN)
            .putString(KEY_LAST_EMPLOYEE_ID, employeeId)
            .putString(KEY_LAST_DEVICE_ID, deviceId)
            .putString(KEY_REAUTH_REASON, reason)
            .apply()
    }

    fun getReauthNotice(): ReauthNoticeState? {
        val reason = prefs.getString(KEY_REAUTH_REASON, null) ?: return null
        val empId = prefs.getString(KEY_LAST_EMPLOYEE_ID, null) ?: return null
        val devId = prefs.getString(KEY_LAST_DEVICE_ID, null) ?: return null
        return ReauthNoticeState(
            employeeId = empId,
            deviceId = devId,
            reason = reason
        )
    }

    fun clear() {
        prefs.edit().clear().apply()
    }

    companion object {
        private const val PREFS_NAME = "agritrack_secure_auth"
        private const val KEY_EMPLOYEE_ID = "employee_id"
        private const val KEY_DEVICE_ID = "device_id"
        private const val KEY_ACCESS_TOKEN = "access_token"
        private const val KEY_ACCESS_EXPIRES_MS = "access_expires_ms"
        private const val KEY_REFRESH_TOKEN = "refresh_token"
        private const val KEY_LAST_EMPLOYEE_ID = "last_employee_id"
        private const val KEY_LAST_DEVICE_ID = "last_device_id"
        private const val KEY_REAUTH_REASON = "reauth_reason"
    }
}
