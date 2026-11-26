package com.agritrack.field.data.local

import android.content.Context
import androidx.room.Database
import androidx.room.Room
import androidx.room.RoomDatabase
import androidx.room.TypeConverter
import androidx.room.TypeConverters
import androidx.room.migration.Migration
import androidx.sqlite.db.SupportSQLiteDatabase
import com.agritrack.field.data.local.dao.TrackingDao
import com.agritrack.field.data.local.entity.EmployeeEntity
import com.agritrack.field.data.local.entity.LocationRecordEntity
import com.agritrack.field.data.local.entity.SessionEventOutboxEntity
import com.agritrack.field.data.local.entity.SyncQueueStateEntity
import com.agritrack.field.data.local.entity.SyncStatus
import com.agritrack.field.data.local.entity.TrackingSessionEntity

class Converters {
    @TypeConverter
    fun fromSyncStatus(status: SyncStatus): String = status.name

    @TypeConverter
    fun toSyncStatus(raw: String): SyncStatus = when (raw) {
        "FAILED" -> SyncStatus.RETRYABLE_FAILED
        else -> SyncStatus.valueOf(raw)
    }
}

@Database(
    entities = [
        EmployeeEntity::class,
        TrackingSessionEntity::class,
        LocationRecordEntity::class,
        SessionEventOutboxEntity::class,
        SyncQueueStateEntity::class
    ],
    version = 4,
    exportSchema = false
)
@TypeConverters(Converters::class)
abstract class AgriTrackDatabase : RoomDatabase() {
    abstract fun trackingDao(): TrackingDao

    companion object {
        @Volatile
        private var INSTANCE: AgriTrackDatabase? = null

        val MIGRATION_1_2 = object : Migration(1, 2) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `session_events_outbox` (
                        `event_id` TEXT NOT NULL PRIMARY KEY,
                        `session_id` TEXT NOT NULL,
                        `employee_id` TEXT NOT NULL,
                        `device_id` TEXT NOT NULL,
                        `event_type` TEXT NOT NULL,
                        `occurred_at_iso` TEXT NOT NULL,
                        `occurred_at_epoch_ms` INTEGER NOT NULL,
                        `session_started_at_iso` TEXT NOT NULL,
                        `sync_status` TEXT NOT NULL,
                        `server_synced_at` TEXT
                    )
                    """.trimIndent()
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_session_events_outbox_employee_id_sync_status_occurred_at_epoch_ms` ON `session_events_outbox` (`employee_id`, `sync_status`, `occurred_at_epoch_ms`)"
                )
                db.execSQL(
                    "CREATE INDEX IF NOT EXISTS `index_session_events_outbox_session_id` ON `session_events_outbox` (`session_id`)"
                )
            }
        }

        val MIGRATION_2_3 = object : Migration(2, 3) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL("ALTER TABLE `location_records` ADD COLUMN `retry_count` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE `location_records` ADD COLUMN `last_error` TEXT")
                db.execSQL("UPDATE `location_records` SET `sync_status` = 'RETRYABLE_FAILED' WHERE `sync_status` = 'FAILED'")

                db.execSQL("ALTER TABLE `session_events_outbox` ADD COLUMN `retry_count` INTEGER NOT NULL DEFAULT 0")
                db.execSQL("ALTER TABLE `session_events_outbox` ADD COLUMN `last_error` TEXT")
                db.execSQL("UPDATE `session_events_outbox` SET `sync_status` = 'RETRYABLE_FAILED' WHERE `sync_status` = 'FAILED'")
            }
        }

        val MIGRATION_3_4 = object : Migration(3, 4) {
            override fun migrate(db: SupportSQLiteDatabase) {
                db.execSQL(
                    """
                    CREATE TABLE IF NOT EXISTS `sync_queue_state` (
                        `employee_id` TEXT NOT NULL PRIMARY KEY,
                        `pause_type` TEXT NOT NULL,
                        `http_status` INTEGER,
                        `error_code` TEXT,
                        `reason` TEXT,
                        `paused_app_version_code` INTEGER,
                        `paused_api_base_url` TEXT,
                        `updated_at_epoch_ms` INTEGER NOT NULL
                    )
                    """.trimIndent()
                )
            }
        }

        fun getInstance(context: Context): AgriTrackDatabase {
            return INSTANCE ?: synchronized(this) {
                INSTANCE ?: Room.databaseBuilder(
                    context.applicationContext,
                    AgriTrackDatabase::class.java,
                    "agritrack_offline.db"
                )
                    .addMigrations(MIGRATION_1_2, MIGRATION_2_3, MIGRATION_3_4)
                    .build()
                    .also { INSTANCE = it }
            }
        }
    }
}
