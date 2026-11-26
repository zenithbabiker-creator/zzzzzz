package com.agritrack.field.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey

@Entity(tableName = "sync_queue_state")
data class SyncQueueStateEntity(
    @PrimaryKey
    @ColumnInfo(name = "employee_id")
    val employeeId: String,

    @ColumnInfo(name = "pause_type")
    val pauseType: String = PAUSE_NONE, // NONE | AUTH | CONFIGURATION

    @ColumnInfo(name = "http_status")
    val httpStatus: Int? = null,

    @ColumnInfo(name = "error_code")
    val errorCode: String? = null,

    @ColumnInfo(name = "reason")
    val reason: String? = null,

    @ColumnInfo(name = "paused_app_version_code")
    val pausedAppVersionCode: Int? = null,

    @ColumnInfo(name = "paused_api_base_url")
    val pausedApiBaseUrl: String? = null,

    @ColumnInfo(name = "updated_at_epoch_ms")
    val updatedAtEpochMs: Long = 0L
) {
    companion object {
        const val PAUSE_NONE = "NONE"
        const val PAUSE_AUTH = "AUTH"
        const val PAUSE_CONFIGURATION = "CONFIGURATION"
    }
}
