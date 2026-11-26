package com.agritrack.field.ui

import androidx.compose.foundation.layout.Arrangement
import androidx.compose.foundation.layout.Column
import androidx.compose.foundation.layout.Row
import androidx.compose.foundation.layout.Spacer
import androidx.compose.foundation.layout.fillMaxSize
import androidx.compose.foundation.layout.fillMaxWidth
import androidx.compose.foundation.layout.height
import androidx.compose.foundation.layout.padding
import androidx.compose.material3.Button
import androidx.compose.material3.ButtonDefaults
import androidx.compose.material3.ExperimentalMaterial3Api
import androidx.compose.material3.MaterialTheme
import androidx.compose.material3.OutlinedButton
import androidx.compose.material3.OutlinedCard
import androidx.compose.material3.OutlinedTextField
import androidx.compose.material3.Scaffold
import androidx.compose.material3.Text
import androidx.compose.material3.TextButton
import androidx.compose.material3.TopAppBar
import androidx.compose.runtime.Composable
import androidx.compose.runtime.CompositionLocalProvider
import androidx.compose.runtime.getValue
import androidx.compose.runtime.mutableStateOf
import androidx.compose.runtime.remember
import androidx.compose.runtime.setValue
import androidx.compose.ui.Modifier
import androidx.compose.ui.platform.LocalLayoutDirection
import androidx.compose.ui.res.stringResource
import androidx.compose.ui.text.input.PasswordVisualTransformation
import androidx.compose.ui.unit.LayoutDirection
import androidx.compose.ui.unit.dp
import com.agritrack.field.R

@OptIn(ExperimentalMaterial3Api::class)
@Composable
fun TrackerScreen(
    signedInEmployeeId: String?,
    initialEmployeeId: String,
    deviceId: String,
    isTracking: Boolean,
    pendingCount: Int,
    syncedCount: Int,
    retryableFailedCount: Int,
    blockedCount: Int,
    permanentFailedCount: Int,
    syncPauseBanner: String?,
    latestSyncError: String?,
    reauthBanner: String?,
    authError: String?,
    sessionFeedback: String?,
    isArabic: Boolean,
    onToggleLanguage: () -> Unit,
    onSignIn: (employeeId: String, deviceId: String, passcode: String) -> Unit,
    onSignOut: () -> Unit,
    onStartSession: () -> Unit,
    onStopSession: () -> Unit,
    onSyncNow: () -> Unit
) {
    val direction = if (isArabic) LayoutDirection.Rtl else LayoutDirection.Ltr

    CompositionLocalProvider(LocalLayoutDirection provides direction) {
        Scaffold(
            topBar = {
                TopAppBar(
                    title = { Text(stringResource(R.string.app_name)) },
                    actions = {
                        if (signedInEmployeeId != null && !isTracking) {
                            TextButton(onClick = onSignOut) {
                                Text(stringResource(R.string.sign_out_button))
                            }
                        }
                        TextButton(onClick = onToggleLanguage) {
                            Text(if (isArabic) "English" else "العربية")
                        }
                    }
                )
            }
        ) { padding ->
            Column(
                modifier = Modifier
                    .padding(padding)
                    .padding(16.dp)
                    .fillMaxSize(),
                verticalArrangement = Arrangement.spacedBy(16.dp)
            ) {
                if (signedInEmployeeId == null) {
                    var employeeInput by remember(initialEmployeeId) { mutableStateOf(initialEmployeeId) }
                    var deviceInput by remember(deviceId) { mutableStateOf(deviceId) }
                    var passcodeInput by remember { mutableStateOf("") }

                    Text(
                        text = stringResource(R.string.login_title),
                        style = MaterialTheme.typography.headlineSmall
                    )

                    if (reauthBanner != null) {
                        OutlinedCard(modifier = Modifier.fillMaxWidth()) {
                            Text(
                                text = reauthBanner,
                                modifier = Modifier.padding(12.dp),
                                color = MaterialTheme.colorScheme.error,
                                style = MaterialTheme.typography.bodySmall
                            )
                        }
                    }

                    OutlinedTextField(
                        value = employeeInput,
                        onValueChange = { employeeInput = it.uppercase() },
                        label = { Text(stringResource(R.string.employee_id_label)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )

                    OutlinedTextField(
                        value = deviceInput,
                        onValueChange = { deviceInput = it.uppercase() },
                        label = { Text(stringResource(R.string.device_id_label)) },
                        singleLine = true,
                        modifier = Modifier.fillMaxWidth()
                    )

                    OutlinedTextField(
                        value = passcodeInput,
                        onValueChange = { passcodeInput = it },
                        label = { Text(stringResource(R.string.passcode_label)) },
                        singleLine = true,
                        visualTransformation = PasswordVisualTransformation(),
                        modifier = Modifier.fillMaxWidth()
                    )

                    if (authError != null) {
                        Text(
                            text = authError,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall
                        )
                    }

                    Button(
                        onClick = { onSignIn(employeeInput.trim(), deviceInput.trim(), passcodeInput) },
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(52.dp)
                    ) {
                        Text(text = stringResource(R.string.sign_in_button))
                    }
                } else {
                    OutlinedCard(modifier = Modifier.fillMaxWidth()) {
                        Column(modifier = Modifier.padding(16.dp)) {
                            Row(
                                modifier = Modifier.fillMaxWidth(),
                                horizontalArrangement = Arrangement.SpaceBetween
                            ) {
                                Text(
                                    text = "$signedInEmployeeId · $deviceId",
                                    style = MaterialTheme.typography.titleMedium
                                )
                            }
                            Spacer(Modifier.height(6.dp))
                            Text(
                                text = stringResource(
                                    if (isTracking) R.string.session_active_label else R.string.session_idle_label
                                ),
                                style = MaterialTheme.typography.bodyMedium,
                                color = if (isTracking)
                                    MaterialTheme.colorScheme.primary
                                else
                                    MaterialTheme.colorScheme.onSurfaceVariant
                            )
                            Spacer(Modifier.height(10.dp))
                            Text(
                                text = stringResource(R.string.pending_records_count, pendingCount),
                                style = MaterialTheme.typography.bodyMedium
                            )
                            Text(
                                text = stringResource(R.string.synced_records_count, syncedCount),
                                style = MaterialTheme.typography.bodyMedium
                            )
                            Text(
                                text = stringResource(R.string.failed_records_count, retryableFailedCount),
                                style = MaterialTheme.typography.bodyMedium
                            )
                            if (blockedCount > 0) {
                                Text(
                                    text = stringResource(R.string.blocked_records_count, blockedCount),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.error
                                )
                            }
                            if (permanentFailedCount > 0) {
                                Text(
                                    text = stringResource(R.string.permanent_failed_records_count, permanentFailedCount),
                                    style = MaterialTheme.typography.bodyMedium,
                                    color = MaterialTheme.colorScheme.error
                                )
                            }
                            if (!syncPauseBanner.isNullOrBlank()) {
                                Spacer(Modifier.height(6.dp))
                                Text(
                                    text = syncPauseBanner,
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error
                                )
                            }
                            if (!latestSyncError.isNullOrBlank()) {
                                Spacer(Modifier.height(6.dp))
                                Text(
                                    text = stringResource(R.string.last_sync_error_label, latestSyncError),
                                    style = MaterialTheme.typography.bodySmall,
                                    color = MaterialTheme.colorScheme.error
                                )
                            }
                        }
                    }

                    if (sessionFeedback != null) {
                        Text(
                            text = sessionFeedback,
                            color = MaterialTheme.colorScheme.error,
                            style = MaterialTheme.typography.bodySmall
                        )
                    }

                    Button(
                        onClick = if (isTracking) onStopSession else onStartSession,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(52.dp),
                        colors = ButtonDefaults.buttonColors(
                            containerColor = if (isTracking)
                                MaterialTheme.colorScheme.error
                            else
                                MaterialTheme.colorScheme.primary
                        )
                    ) {
                        Text(
                            text = stringResource(
                                if (isTracking) R.string.stop_session else R.string.start_session
                            )
                        )
                    }

                    OutlinedButton(
                        onClick = onSyncNow,
                        modifier = Modifier
                            .fillMaxWidth()
                            .height(48.dp)
                    ) {
                        Text(text = stringResource(R.string.sync_now))
                    }
                }
            }
        }
    }
}
