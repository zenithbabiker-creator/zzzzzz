package com.agritrack.field.data.remote

import com.agritrack.field.BuildConfig
import okhttp3.OkHttpClient
import okhttp3.logging.HttpLoggingInterceptor
import retrofit2.Response
import retrofit2.Retrofit
import retrofit2.converter.gson.GsonConverterFactory
import retrofit2.http.Body
import retrofit2.http.Header
import retrofit2.http.POST
import java.util.concurrent.TimeUnit

data class SessionTokenRequestDto(
    val employeeId: String,
    val deviceId: String,
    val passcode: String
)

data class RefreshTokenRequestDto(
    val employeeId: String,
    val deviceId: String,
    val refreshToken: String
)

data class SessionTokenResponseDto(
    val token: String,
    val refreshToken: String,
    val employeeId: String,
    val deviceId: String,
    val fullNameEn: String? = null,
    val fullNameAr: String? = null,
    val expiresAt: String,
    val refreshExpiresAt: String? = null
)

data class LogoutResponseDto(
    val ok: Boolean,
    val revoked: Int
)

data class SessionStartRequestDto(
    val sessionId: String,
    val deviceId: String,
    val startedAtIso: String
)

data class SessionStartResponseDto(
    val sessionId: String,
    val status: String,
    val startedAt: String
)

data class SessionStopRequestDto(
    val sessionId: String,
    val endedAtIso: String,
    val deviceId: String? = null,
    val startedAtIso: String? = null,
    val status: String = "completed"
)

data class SessionStopResponseDto(
    val found: Boolean,
    val sessionId: String,
    val status: String?,
    val endedAt: String? = null
)

data class BatchSyncPayloadDto(
    val batchId: String,
    val records: List<LocationUploadDto>
)

data class LocationUploadDto(
    val recordId: String,
    val sessionId: String,
    val employeeId: String,
    val deviceId: String,
    val latitude: Double,
    val longitude: Double,
    val capturedAtIso: String,
    val capturedAtEpochMs: Long,
    val dateStr: String,
    val hour: Int,
    val minute: Int,
    val second: Int,
    val accuracyMeters: Float,
    val provider: String,
    val batteryPercent: Int?
)

data class BatchSyncAckDto(
    val batchId: String,
    val serverReceivedAt: String,
    val acceptedIds: List<String>,
    val duplicateIds: List<String>,
    val totalPersistedForEmployee: Int
)

interface SyncApiService {
    @POST("api/auth/session-token")
    suspend fun requestSessionToken(
        @Body payload: SessionTokenRequestDto
    ): Response<SessionTokenResponseDto>

    @POST("api/auth/refresh")
    suspend fun refreshSessionToken(
        @Body payload: RefreshTokenRequestDto
    ): Response<SessionTokenResponseDto>

    @POST("api/auth/logout")
    suspend fun logoutSession(
        @Header("Authorization") bearerToken: String
    ): Response<LogoutResponseDto>

    @POST("api/sessions/start")
    suspend fun startSession(
        @Header("Authorization") bearerToken: String,
        @Body payload: SessionStartRequestDto
    ): Response<SessionStartResponseDto>

    @POST("api/sessions/stop")
    suspend fun stopSession(
        @Header("Authorization") bearerToken: String,
        @Body payload: SessionStopRequestDto
    ): Response<SessionStopResponseDto>

    @POST("api/sync/batch")
    suspend fun uploadBatch(
        @Header("Authorization") bearerToken: String,
        @Body payload: BatchSyncPayloadDto
    ): Response<BatchSyncAckDto>

    companion object {
        fun create(baseUrl: String): SyncApiService {
            val logging = HttpLoggingInterceptor().apply {
                level = if (BuildConfig.DEBUG) {
                    HttpLoggingInterceptor.Level.BASIC
                } else {
                    HttpLoggingInterceptor.Level.NONE
                }
                redactHeader("Authorization")
            }

            val client = OkHttpClient.Builder()
                .connectTimeout(15, TimeUnit.SECONDS)
                .readTimeout(30, TimeUnit.SECONDS)
                .writeTimeout(30, TimeUnit.SECONDS)
                .addInterceptor(logging)
                .build()

            return Retrofit.Builder()
                .baseUrl(baseUrl)
                .client(client)
                .addConverterFactory(GsonConverterFactory.create())
                .build()
                .create(SyncApiService::class.java)
        }
    }
}
