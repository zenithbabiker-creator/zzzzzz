package com.agritrack.field.data.local.entity

import androidx.room.ColumnInfo
import androidx.room.Entity
import androidx.room.PrimaryKey
import java.util.UUID

@Entity(tableName = "employees")
data class EmployeeEntity(
    @PrimaryKey
    @ColumnInfo(name = "employee_id")
    val employeeId: String,

    @ColumnInfo(name = "full_name_en")
    val fullNameEn: String,

    @ColumnInfo(name = "full_name_ar")
    val fullNameAr: String,

    @ColumnInfo(name = "employee_number")
    val employeeNumber: String,

    @ColumnInfo(name = "assigned_device_id")
    val assignedDeviceId: String,

    @ColumnInfo(name = "account_status")
    val accountStatus: String,

    @ColumnInfo(name = "session_status")
    val sessionStatus: String
)

@Entity(tableName = "tracking_sessions")
data class TrackingSessionEntity(
    @PrimaryKey
    @ColumnInfo(name = "session_id")
    val sessionId: String = UUID.randomUUID().toString(),

    @ColumnInfo(name = "employee_id")
    val employeeId: String,

    @ColumnInfo(name = "device_id")
    val deviceId: String,

    @ColumnInfo(name = "started_at_epoch_ms")
    val startedAtEpochMs: Long,

    @ColumnInfo(name = "ended_at_epoch_ms")
    val endedAtEpochMs: Long? = null,

    @ColumnInfo(name = "status")
    val status: String = "ACTIVE"
)
