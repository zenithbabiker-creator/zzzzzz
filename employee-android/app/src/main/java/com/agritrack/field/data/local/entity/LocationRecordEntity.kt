package com.agritrack.field.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.Index
import androidx.room.PrimaryKey
import java.util.UUID

enum class SyncStatus {
    PENDING,
    RETRYABLE_FAILED,
    BLOCKED_AUTH,
    BLOCKED_CONFIGURATION,
    SYNCED,
    PERMANENT_FAILED
}

@Entity(
    tableName = "location_records",
    indices = [
        Index(value = ["employee_id"]),
        Index(value = ["session_id"]),
        Index(value = ["sync_status"])
    ]
)
data class LocationRecordEntity(
    @PrimaryKey
    @ColumnInfo(name = "record_id")
    val recordId: String = UUID.randomUUID().toString(),

    @ColumnInfo(name = "session_id")
    val sessionId: String,

    @ColumnInfo(name = "employee_id")
    val employeeId: String,

    @ColumnInfo(name = "device_id")
    val deviceId: String,

    @ColumnInfo(name = "latitude")
    val latitude: Double,

    @ColumnInfo(name = "longitude")
    val longitude: Double,

    @ColumnInfo(name = "captured_at_iso")
    val capturedAtIso: String,

    @ColumnInfo(name = "captured_at_epoch_ms")
    val capturedAtEpochMs: Long,

    @ColumnInfo(name = "date_str")
    val dateStr: String,

    @ColumnInfo(name = "hour")
    val hour: Int,

    @ColumnInfo(name = "minute")
    val minute: Int,

    @ColumnInfo(name = "second")
    val second: Int,

    @ColumnInfo(name = "accuracy_meters")
    val accuracyMeters: Float,

    @ColumnInfo(name = "provider")
    val provider: String,

    @ColumnInfo(name = "battery_level")
    val batteryLevel: Int?,

    @ColumnInfo(name = "sync_status")
    val syncStatus: SyncStatus = SyncStatus.PENDING,

    @ColumnInfo(name = "server_synced_at")
    val serverSyncedAt: String? = null,

    @ColumnInfo(name = "retry_count")
    val retryCount: Int = 0,

    @ColumnInfo(name = "last_error")
    val lastError: String? = null
)
