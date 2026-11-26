# Product 1: AgriTrack Employee Android Application

Standalone native Kotlin + Jetpack Compose + Room SQLite + WorkManager Android application for agricultural field employees.

## Verified Architecture & Integration
- **Employee Sign-In & Hardware-Backed Token Storage**: `MainActivity` + `TrackerScreen` authenticate over `POST /api/auth/session-token` using the employee's real passcode (verified server-side with `scrypt`, no client SHA-256 substitution). Short-lived (24h) access tokens and 45-day revocable single-use refresh tokens are stored exclusively in Android Keystore `EncryptedSharedPreferences` (`SecureAuthStore`). If a refresh token expires after >45 days offline, `SecureAuthStore` flags re-authentication required without deleting any queued Room records or session events.
- **Session-Gated 10-Minute GPS Capture & API 35 Compliance**: `GpsTrackingForegroundService` (`START_NOT_STICKY`, `foregroundServiceType="location"` via `ServiceCompat.startForeground`) runs only during an explicit `ACTIVE` `TrackingSessionEntity` after runtime location & `POST_NOTIFICATIONS` checks, recording coordinates every `10L * 60L * 1000L` ms (`TEN_MINUTES_MS`), checking device Location toggle state, and transitioning cleanly to `INTERRUPTED` if permission is revoked mid-session.
- **Persistent Session Outbox & Safe Reboot Recovery**: Room v3 (`MIGRATION_1_2`, `MIGRATION_2_3`) stores `session_events_outbox` (`START`, `STOP`, `INTERRUPTED`) atomically alongside `TrackingSessionEntity` transitions (`startSessionTransaction`, `stopSessionTransaction`, notification Stop action, and `recoverInterruptedSessionsOnBoot`).
- **4-State Retry & Poison-Queue Protection**: `SyncStatus` distinguishes `PENDING`, `RETRYABLE_FAILED` (temporary network/`5xx`/partial-ACK/re-auth pending), `SYNCED`, and `PERMANENT_FAILED` (`HTTP 400` validation rejections). `SyncWorker` bisects multi-record batches on `HTTP 400` so a single malformed row is isolated to `PERMANENT_FAILED` (preserved locally with `last_error`) without blocking valid queued records.
- **Transport & Logging Security**: Release builds require a real HTTPS URL (`-PAGRITRACK_PROD_API_URL=https://.../`), `res/xml/network_security_config.xml` blocks cleartext outside emulator/loopback dev hosts (`10.0.2.2`, `127.0.0.1`, `localhost`), and OkHttp disables payload logging in release builds with `Authorization` header redaction.

## Out of Scope (Strictly Excluded)
- No administrative dashboard, no employee roster management, no central analytics, and no management maps.

## Build Requirements & Exact Compilation Commands
This Node.js sandbox does not include JDK 17, Android SDK, or Gradle, so APK compilation must be run on a workstation or CI runner with:
- **JDK**: 17 (`JAVA_HOME` configured)
- **Android SDK**: Platform `android-35`, Build-Tools `35.0.0` (`ANDROID_HOME` configured)
- **Gradle**: `8.10.2` (matches `gradle/wrapper/gradle-wrapper.properties` and AGP `8.7.2`)

### Linux / macOS
```bash
cd employee-android
gradle wrapper --gradle-version 8.10.2
./gradlew :app:assembleDebug

# For physical device over USB + adb reverse:
adb reverse tcp:3001 tcp:3001
./gradlew :app:assembleDebug -PAGRITRACK_DEBUG_API_URL=http://127.0.0.1:3001/
adb install -r app/build/outputs/apk/debug/app-debug.apk

# Release APK (requires real HTTPS backend URL):
./gradlew :app:assembleRelease -PAGRITRACK_PROD_API_URL=https://api.yourdomain.com/
```

### Windows (PowerShell)
```powershell
cd employee-android
gradle wrapper --gradle-version 8.10.2
.\gradlew.bat :app:assembleDebug

# Physical device over USB + adb reverse:
adb reverse tcp:3001 tcp:3001
.\gradlew.bat :app:assembleDebug "-PAGRITRACK_DEBUG_API_URL=http://127.0.0.1:3001/"
adb install -r app\build\outputs\apk\debug\app-debug.apk
```
