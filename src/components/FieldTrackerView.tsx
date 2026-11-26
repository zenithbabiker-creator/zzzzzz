import React, { useState } from 'react';
import {
  AlertTriangle,
  BatteryCharging,
  CheckCircle2,
  Clock,
  CloudUpload,
  Compass,
  Database,
  Navigation,
  Play,
  RefreshCw,
  ShieldAlert,
  Square,
  Wifi,
  WifiOff,
} from 'lucide-react';
import type { TranslationDictionary } from '../i18n/translations';
import type {
  Employee,
  EmployeeSyncStats,
  Language,
  LocationRecord,
  OfflineSimulationReport,
  Phase2TestCaseResult,
  SyncProgressState,
  TrackingSession,
} from '../types/tracking';
import { PWAInstallButton } from './PWAInstallButton';

interface FieldTrackerViewProps {
  t: TranslationDictionary;
  language: Language;
  employee: Employee;
  activeSession: TrackingSession | null;
  latestRecord: LocationRecord | null;
  syncStats: EmployeeSyncStats;
  syncProgress: SyncProgressState;
  elapsedSeconds: number;
  countdownSeconds: number;
  isOfflineEffective: boolean;
  simulatedOffline: boolean;
  onToggleSimulatedOffline: () => void;
  onRequestStartSession: () => Promise<void>;
  onStopSession: () => Promise<void>;
  onCaptureNow: () => Promise<void>;
  onSyncNow: () => Promise<void>;
  onSimulateOfflineDays: (days: number) => Promise<OfflineSimulationReport>;
  onVerifyZeroDuplicates: () => Promise<{ totalCount: number; duplicateCount: number }>;
  onRunPhase2Suite: () => Promise<Phase2TestCaseResult[]>;
  totalEmployeesCount: number;
  hasCapturedWhileOffline: boolean;
  hasStoppedSessionCleanly: boolean;
  lastSimReport: OfflineSimulationReport | null;
  onSignOut: () => void;
}

function formatDuration(seconds: number): string {
  const hrs = Math.floor(seconds / 3600);
  const mins = Math.floor((seconds % 3600) / 60);
  const secs = seconds % 60;
  return `${String(hrs).padStart(2, '0')}:${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

function formatCountdown(seconds: number): string {
  const mins = Math.floor(seconds / 60);
  const secs = seconds % 60;
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`;
}

export const FieldTrackerView: React.FC<FieldTrackerViewProps> = ({
  t,
  language,
  employee,
  activeSession,
  latestRecord,
  syncStats,
  syncProgress,
  elapsedSeconds,
  countdownSeconds,
  isOfflineEffective,
  simulatedOffline,
  onToggleSimulatedOffline,
  onRequestStartSession,
  onStopSession,
  onCaptureNow,
  onSyncNow,
  onSimulateOfflineDays,
  onVerifyZeroDuplicates,
  onRunPhase2Suite,
  totalEmployeesCount,
  hasCapturedWhileOffline,
  hasStoppedSessionCleanly,
  lastSimReport,
  onSignOut,
}) => {
  const [showPermissionModal, setShowPermissionModal] = useState(false);
  const [busyAction, setBusyAction] = useState(false);
  const [simRunning, setSimRunning] = useState(false);
  const [suiteRunning, setSuiteRunning] = useState(false);
  const [suiteResults, setSuiteResults] = useState<Phase2TestCaseResult[] | null>(null);
  const [dupeCheckResult, setDupeCheckResult] = useState<{
    totalCount: number;
    duplicateCount: number;
  } | null>(null);

  const isTracking = activeSession?.status === 'active';
  const employeeName = language === 'ar' ? employee.fullNameAr : employee.fullNameEn;

  const radius = 26;
  const circumference = 2 * Math.PI * radius;
  const progressRatio = isTracking ? Math.max(0, Math.min(1, (600 - countdownSeconds) / 600)) : 0;
  const strokeOffset = circumference * (1 - progressRatio);

  const handleConfirmPermissionAndStart = async () => {
    setBusyAction(true);
    try {
      setShowPermissionModal(false);
      await onRequestStartSession();
    } finally {
      setBusyAction(false);
    }
  };

  const handleManualCapture = async () => {
    setBusyAction(true);
    try {
      await onCaptureNow();
    } finally {
      setBusyAction(false);
    }
  };

  const handleSimulateDays = async (days: number) => {
    setSimRunning(true);
    try {
      await onSimulateOfflineDays(days);
    } finally {
      setSimRunning(false);
    }
  };

  const handleCheckDuplicates = async () => {
    const res = await onVerifyZeroDuplicates();
    setDupeCheckResult(res);
  };

  const handleRunSuite = async () => {
    setSuiteRunning(true);
    try {
      const results = await onRunPhase2Suite();
      setSuiteResults(results);
    } finally {
      setSuiteRunning(false);
    }
  };

  const acceptanceChecks = [
    { label: t.accept1, verified: isTracking || activeSession !== null || syncStats.totalCount > 0 },
    { label: t.accept2, verified: latestRecord !== null },
    { label: t.accept3, verified: simulatedOffline || isOfflineEffective },
    { label: t.accept4, verified: hasCapturedWhileOffline },
    {
      label: t.accept5,
      verified:
        (lastSimReport !== null && lastSimReport.duplicateCount === 0) ||
        syncStats.syncedCount >= 1440,
    },
    { label: t.accept10, verified: hasStoppedSessionCleanly },
    { label: t.accept11, verified: totalEmployeesCount >= 50 },
  ];

  const lastSyncedDisplay = syncStats.lastSyncedAt
    ? syncStats.lastSyncedAt.replace('T', ' ').slice(0, 19)
    : t.neverSynced;

  return (
    <div className="space-y-6">
      {isTracking && (
        <div
          role="status"
          className="flex flex-col gap-3 rounded-2xl border border-[#15803D]/35 bg-[#DCFCE7]/60 px-5 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="flex items-start gap-3">
            <Navigation className="mt-0.5 h-5 w-5 shrink-0 text-[#15803D]" />
            <div>
              <p className="text-sm font-semibold text-[#14532D]">{t.foregroundBannerTitle}</p>
              <p className="mt-0.5 text-xs text-[#166534]">{t.foregroundBannerDesc}</p>
            </div>
          </div>
          <div className="flex items-center gap-3 font-mono text-xs font-semibold text-[#14532D]" dir="ltr">
            <span>{formatDuration(elapsedSeconds)}</span>
            <span aria-hidden="true">·</span>
            <span>
              {t.nextCaptureIn}: {formatCountdown(countdownSeconds)}
            </span>
          </div>
        </div>
      )}

      <div className="grid grid-cols-1 items-start gap-6 lg:grid-cols-12">
        {/* Left Column: Employee Handset Session Controller */}
        <section className="space-y-5 rounded-2xl border border-[#E2E6DF] bg-white p-5 sm:p-6 lg:col-span-5">
          <div className="flex items-start justify-between gap-4 border-b border-[#EEF1EB] pb-4">
            <div className="min-w-0">
              <p className="text-xs font-medium text-[#6B756E]">{t.fieldHandsetTitle}</p>
              <h2 className="mt-1 truncate text-xl font-bold text-[#111814]">{employeeName}</h2>
              <p className="mt-1 font-mono text-xs text-[#4B554E]" dir="ltr">
                {employee.employeeId} · {employee.employeeNumber} · {employee.assignedDeviceId}
              </p>
            </div>

            <button
              type="button"
              onClick={onSignOut}
              className="min-h-[40px] rounded-xl border border-[#D4DAD0] px-3 py-1.5 text-xs font-semibold text-[#4B554E] transition-colors hover:bg-[#F6F7F4] whitespace-nowrap shrink-0"
            >
              {t.signOut}
            </button>
          </div>

          <div className="flex flex-wrap items-center justify-between gap-3 rounded-xl border border-[#E2E6DF] bg-[#FAFBF9] px-4 py-3">
            <div className="flex items-center gap-2.5 text-xs font-semibold">
              {isOfflineEffective ? (
                <>
                  <WifiOff className="h-4 w-4 shrink-0 text-[#D97706]" />
                  <span className="text-[#B45309]">{t.offlineMode}</span>
                </>
              ) : (
                <>
                  <Wifi className="h-4 w-4 shrink-0 text-[#15803D]" />
                  <span className="text-[#15803D]">{t.onlineMode}</span>
                </>
              )}
            </div>

            <button
              type="button"
              onClick={onToggleSimulatedOffline}
              className={`min-h-[38px] rounded-lg px-3 py-1.5 text-xs font-semibold transition-colors whitespace-nowrap shrink-0 ${
                simulatedOffline
                  ? 'bg-[#D97706] text-white hover:bg-[#B45309]'
                  : 'border border-[#D4DAD0] bg-white text-[#111814] hover:bg-[#F1F3EE]'
              }`}
            >
              {simulatedOffline ? t.simOfflineActive : t.simOfflineToggle}
            </button>
          </div>

          <div className="grid grid-cols-2 gap-4">
            <div className="rounded-xl border border-[#EEF1EB] bg-[#FAFBF9] p-4">
              <p className="text-xs text-[#6B756E]">{t.sessionDuration}</p>
              <p className="mt-1.5 font-mono text-2xl font-bold text-[#111814]" dir="ltr">
                {formatDuration(elapsedSeconds)}
              </p>
              <p className="mt-1 text-xs font-medium text-[#4B554E]">
                {isTracking ? t.sessionTracking : t.sessionIdle}
              </p>
            </div>

            <div className="flex items-center justify-between rounded-xl border border-[#EEF1EB] bg-[#FAFBF9] p-4">
              <div>
                <p className="text-xs text-[#6B756E]">{t.nextCaptureIn}</p>
                <p className="mt-1.5 font-mono text-2xl font-bold text-[#111814]" dir="ltr">
                  {isTracking ? formatCountdown(countdownSeconds) : '10:00'}
                </p>
                <p className="mt-1 text-xs text-[#4B554E]">{t.intervalValue}</p>
              </div>
              <svg className="h-14 w-14 -rotate-90 shrink-0" viewBox="0 0 64 64" aria-hidden="true">
                <circle
                  cx="32"
                  cy="32"
                  r={radius}
                  fill="none"
                  stroke="#E2E6DF"
                  strokeWidth="5"
                />
                <circle
                  cx="32"
                  cy="32"
                  r={radius}
                  fill="none"
                  stroke="#15803D"
                  strokeWidth="5"
                  strokeLinecap="round"
                  strokeDasharray={circumference}
                  strokeDashoffset={strokeOffset}
                />
              </svg>
            </div>

            <div className="rounded-xl border border-[#EEF1EB] bg-[#FAFBF9] p-4">
              <p className="text-xs text-[#6B756E]">{t.recordsThisSession}</p>
              <p className="mt-1 font-mono text-2xl font-bold text-[#111814]" dir="ltr">
                {activeSession?.capturedCount ?? 0}
              </p>
            </div>

            <div className="rounded-xl border border-[#EEF1EB] bg-[#FAFBF9] p-4">
              <p className="text-xs text-[#6B756E]">{t.totalLocalPending}</p>
              <p className="mt-1 font-mono text-2xl font-bold text-[#B45309]" dir="ltr">
                {syncStats.pendingCount}
              </p>
            </div>
          </div>

          <div className="space-y-3 pt-1">
            {!isTracking ? (
              <button
                type="button"
                disabled={busyAction}
                onClick={() => setShowPermissionModal(true)}
                className="flex w-full min-h-[52px] items-center justify-center gap-2.5 rounded-xl bg-[#15803D] px-6 py-3.5 text-base font-semibold text-white transition-transform active:scale-[0.99] hover:bg-[#166534] disabled:opacity-60"
              >
                <Play className="h-5 w-5 fill-current" />
                <span>{t.startSession}</span>
              </button>
            ) : (
              <>
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={handleManualCapture}
                  className="flex w-full min-h-[48px] items-center justify-center gap-2 rounded-xl border border-[#15803D] bg-[#15803D]/10 px-5 py-3 text-sm font-semibold text-[#15803D] transition-colors hover:bg-[#15803D]/15 disabled:opacity-60"
                >
                  <Compass className="h-4 w-4" />
                  <span>{t.captureNow}</span>
                </button>
                <button
                  type="button"
                  disabled={busyAction}
                  onClick={onStopSession}
                  className="flex w-full min-h-[52px] items-center justify-center gap-2.5 rounded-xl bg-[#DC2626] px-6 py-3.5 text-base font-semibold text-white transition-transform active:scale-[0.99] hover:bg-[#B91C1C] disabled:opacity-60"
                >
                  <Square className="h-4 w-4 fill-current" />
                  <span>{t.stopSession}</span>
                </button>
              </>
            )}

            <div className="flex justify-center pt-1">
              <PWAInstallButton t={t} />
            </div>
          </div>
        </section>

        {/* Right Column: Phase 2 Sync Status, Latest Fix, & Resilience Verification Suite */}
        <div className="space-y-6 lg:col-span-7">
          {/* Phase 2 Automatic Synchronization Status Card (Requirement #12) */}
          <section className="rounded-2xl border border-[#E2E6DF] bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-3 border-b border-[#EEF1EB] pb-4 sm:flex-row sm:items-center sm:justify-between">
              <div>
                <h3 className="text-base font-bold text-[#111814]">{t.syncEngineTitle}</h3>
                <p className="mt-1 text-xs leading-relaxed text-[#4B554E]">
                  {t.syncEngineSubtitle}
                </p>
              </div>
              <button
                type="button"
                disabled={
                  syncProgress.isSyncing ||
                  isOfflineEffective ||
                  syncStats.pendingCount + syncStats.failedCount === 0
                }
                onClick={onSyncNow}
                className="inline-flex min-h-[44px] items-center gap-2 rounded-xl bg-[#15803D] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#166534] disabled:opacity-50 whitespace-nowrap shrink-0"
              >
                <CloudUpload className="h-4 w-4" />
                <span>{syncProgress.isSyncing ? t.syncingLabel : t.syncNowButton}</span>
              </button>
            </div>

            <div className="mt-4 grid grid-cols-2 gap-3 sm:grid-cols-4">
              <div className="rounded-xl border border-[#EEF1EB] bg-[#FAFBF9] p-3.5">
                <p className="text-xs text-[#6B756E]">{t.totalLocalPending}</p>
                <p className="mt-1 font-mono text-xl font-bold text-[#B45309]" dir="ltr">
                  {syncStats.pendingCount}
                </p>
              </div>
              <div className="rounded-xl border border-[#EEF1EB] bg-[#FAFBF9] p-3.5">
                <p className="text-xs text-[#6B756E]">{t.syncedCountLabel}</p>
                <p className="mt-1 font-mono text-xl font-bold text-[#15803D]" dir="ltr">
                  {syncStats.syncedCount}
                </p>
              </div>
              <div className="rounded-xl border border-[#EEF1EB] bg-[#FAFBF9] p-3.5">
                <p className="text-xs text-[#6B756E]">{t.failedCountLabel}</p>
                <p className="mt-1 font-mono text-xl font-bold text-[#DC2626]" dir="ltr">
                  {syncStats.failedCount}
                </p>
              </div>
              <div className="rounded-xl border border-[#EEF1EB] bg-[#FAFBF9] p-3.5">
                <p className="text-xs text-[#6B756E]">{t.lastSyncedAtLabel}</p>
                <p className="mt-1.5 font-mono text-xs font-semibold text-[#111814]" dir="ltr">
                  {lastSyncedDisplay}
                </p>
              </div>
            </div>

            {syncProgress.isSyncing && syncProgress.totalBatches > 0 && (
              <div className="mt-4 space-y-1.5">
                <div className="flex items-center justify-between text-xs font-medium text-[#15803D]">
                  <span>
                    {t.syncBatchProgress} {syncProgress.currentBatch} / {syncProgress.totalBatches}
                  </span>
                  <span className="font-mono" dir="ltr">
                    {Math.round((syncProgress.currentBatch / syncProgress.totalBatches) * 100)}%
                  </span>
                </div>
                <div className="h-2 w-full overflow-hidden rounded-full bg-[#EEF1EB]">
                  <div
                    className="h-full bg-[#15803D] transition-all"
                    style={{
                      width: `${Math.round(
                        (syncProgress.currentBatch / syncProgress.totalBatches) * 100
                      )}%`,
                    }}
                  />
                </div>
              </div>
            )}

            {syncProgress.nextRetrySeconds !== null && (
              <div className="mt-4 flex items-center gap-2 rounded-xl border border-[#D97706]/30 bg-[#FEF3C7]/60 px-4 py-2.5 text-xs font-medium text-[#92400E]">
                <RefreshCw className="h-4 w-4 shrink-0" />
                <span>
                  {t.retryScheduledNote}{' '}
                  <span className="font-mono font-bold" dir="ltr">
                    {syncProgress.nextRetrySeconds}s
                  </span>{' '}
                  (attempt #{syncProgress.retryAttempt})
                </span>
              </div>
            )}

            {syncStats.permanentFailedCount > 0 && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#DC2626]/25 bg-[#FEF2F2] px-4 py-2.5 text-xs text-[#991B1B]">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong>
                    {syncStats.permanentFailedCount} {t.permanentFailedCountLabel}
                  </strong>
                  {syncStats.lastPermanentError ? `: ${syncStats.lastPermanentError}` : ''}
                </span>
              </div>
            )}

            {syncProgress.lastError && (
              <div className="mt-3 flex items-start gap-2 rounded-xl border border-[#DC2626]/25 bg-[#FEF2F2] px-4 py-2.5 text-xs text-[#991B1B]">
                <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0" />
                <span>
                  <strong>{t.syncErrorLabel}:</strong> {syncProgress.lastError}
                </span>
              </div>
            )}

            <p className="mt-3 text-xs text-[#6B756E]">{t.autoSyncEnabledNote}</p>
          </section>

          {/* Latest Locally Saved Coordinate Card */}
          <section className="rounded-2xl border border-[#E2E6DF] bg-white p-5 sm:p-6">
            <div className="flex items-center justify-between gap-4 border-b border-[#EEF1EB] pb-4">
              <h3 className="text-base font-bold text-[#111814]">{t.latestFixTitle}</h3>
              <span
                className={`font-mono text-xs font-medium ${
                  latestRecord?.syncStatus === 'SYNCED'
                    ? 'text-[#15803D]'
                    : latestRecord?.syncStatus === 'PERMANENT_FAILED' ||
                        latestRecord?.syncStatus === 'BLOCKED_AUTH' ||
                        latestRecord?.syncStatus === 'BLOCKED_CONFIGURATION'
                    ? 'text-[#DC2626]'
                    : latestRecord?.syncStatus === 'RETRYABLE_FAILED'
                    ? 'text-[#D97706]'
                    : 'text-[#B45309]'
                }`}
              >
                {latestRecord?.syncStatus === 'SYNCED'
                  ? t.syncedSyncValue
                  : latestRecord?.syncStatus === 'PERMANENT_FAILED'
                  ? t.permanentFailedSyncValue
                  : latestRecord?.syncStatus === 'BLOCKED_AUTH'
                  ? 'Paused (Auth)'
                  : latestRecord?.syncStatus === 'BLOCKED_CONFIGURATION'
                  ? 'Paused (Config)'
                  : latestRecord?.syncStatus === 'RETRYABLE_FAILED'
                  ? t.failedSyncValue
                  : t.pendingSyncValue}
              </span>
            </div>

            {!latestRecord ? (
              <div className="py-6 text-center text-sm text-[#4B554E]">{t.noFixYet}</div>
            ) : (
              <div className="mt-4 grid grid-cols-2 gap-4 sm:grid-cols-3">
                <div>
                  <p className="text-xs text-[#6B756E]">{t.latitudeLabel}</p>
                  <p className="mt-1 font-mono text-base font-semibold text-[#111814]" dir="ltr">
                    {latestRecord.latitude.toFixed(6)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#6B756E]">{t.longitudeLabel}</p>
                  <p className="mt-1 font-mono text-base font-semibold text-[#111814]" dir="ltr">
                    {latestRecord.longitude.toFixed(6)}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#6B756E]">{t.accuracyLabel}</p>
                  <p className="mt-1 font-mono text-base font-semibold text-[#111814]" dir="ltr">
                    ±{latestRecord.accuracyMeters.toFixed(1)} m
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#6B756E]">{t.providerLabel}</p>
                  <p className="mt-1 font-mono text-sm font-medium text-[#111814]" dir="ltr">
                    {latestRecord.provider}
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#6B756E]">{t.batteryLabel}</p>
                  <p className="mt-1 flex items-center gap-1.5 font-mono text-sm font-medium text-[#111814]" dir="ltr">
                    <BatteryCharging className="h-4 w-4 text-[#15803D]" />
                    <span>
                      {latestRecord.batteryPercent !== null
                        ? `${latestRecord.batteryPercent}%`
                        : '—'}
                    </span>
                  </p>
                </div>
                <div>
                  <p className="text-xs text-[#6B756E]">{t.capturedTimeLabel}</p>
                  <p className="mt-1 flex items-center gap-1.5 font-mono text-xs font-medium text-[#111814]" dir="ltr">
                    <Clock className="h-3.5 w-3.5 text-[#4B554E]" />
                    <span>
                      {latestRecord.dateStr}{' '}
                      {String(latestRecord.hour).padStart(2, '0')}:
                      {String(latestRecord.minute).padStart(2, '0')}:
                      {String(latestRecord.second).padStart(2, '0')}
                    </span>
                  </p>
                </div>
              </div>
            )}
          </section>

          {/* Phase 2 Offline Simulation & Automated Verification Suite */}
          <section className="rounded-2xl border border-[#E2E6DF] bg-white p-5 sm:p-6">
            <div className="flex flex-col gap-3 border-b border-[#EEF1EB] pb-4 sm:flex-row sm:items-start sm:justify-between">
              <div>
                <h3 className="text-base font-bold text-[#111814]">{t.phase2SuiteTitle}</h3>
                <p className="mt-1 text-xs leading-relaxed text-[#4B554E]">
                  {t.phase2SuiteSubtitle}
                </p>
              </div>
              <Database className="hidden h-5 w-5 shrink-0 text-[#15803D] sm:block" />
            </div>

            <div className="mt-4 flex flex-wrap items-center gap-2.5">
              <button
                type="button"
                disabled={suiteRunning}
                onClick={handleRunSuite}
                className="min-h-[44px] rounded-xl bg-[#111814] px-4 py-2 text-xs font-semibold text-white transition-colors hover:bg-[#232D26] disabled:opacity-60 whitespace-nowrap"
              >
                {suiteRunning ? t.runningPhase2Suite : t.runPhase2SuiteButton}
              </button>

              <button
                type="button"
                disabled={simRunning}
                onClick={() => handleSimulateDays(1)}
                className="min-h-[44px] rounded-xl border border-[#D4DAD0] bg-white px-3 py-2 text-xs font-semibold text-[#111814] transition-colors hover:bg-[#F6F7F4] disabled:opacity-60 whitespace-nowrap"
              >
                {t.sim1DayButton}
              </button>

              <button
                type="button"
                disabled={simRunning}
                onClick={() => handleSimulateDays(7)}
                className="min-h-[44px] rounded-xl border border-[#D4DAD0] bg-white px-3 py-2 text-xs font-semibold text-[#111814] transition-colors hover:bg-[#F6F7F4] disabled:opacity-60 whitespace-nowrap"
              >
                {t.sim7DaysButton}
              </button>

              <button
                type="button"
                disabled={simRunning}
                onClick={() => handleSimulateDays(30)}
                className="min-h-[44px] rounded-xl border border-[#D4DAD0] bg-white px-3 py-2 text-xs font-semibold text-[#111814] transition-colors hover:bg-[#F6F7F4] disabled:opacity-60 whitespace-nowrap"
              >
                {simRunning ? t.simRunning : t.sim30DaysButton}
              </button>

              <button
                type="button"
                onClick={handleCheckDuplicates}
                className="min-h-[44px] rounded-xl border border-[#D4DAD0] bg-white px-3 py-2 text-xs font-semibold text-[#111814] transition-colors hover:bg-[#F6F7F4] whitespace-nowrap"
              >
                {t.verifyZeroDupes}
              </button>
            </div>

            {(lastSimReport || dupeCheckResult) && (
              <div className="mt-4 grid grid-cols-2 gap-3 rounded-xl border border-[#EEF1EB] bg-[#FAFBF9] p-3.5 text-xs sm:grid-cols-3">
                {lastSimReport && (
                  <div>
                    <span className="text-[#6B756E]">{t.simResultLabel}</span>
                    <p className="mt-0.5 font-mono font-semibold text-[#111814]" dir="ltr">
                      {lastSimReport.recordsInserted} fixes / {lastSimReport.daysSimulated}d (
                      {lastSimReport.durationMs}ms)
                    </p>
                  </div>
                )}
                <div>
                  <span className="text-[#6B756E]">{t.duplicatesLabel}</span>
                  <p className="mt-0.5 font-mono font-semibold text-[#15803D]" dir="ltr">
                    {dupeCheckResult?.duplicateCount ?? lastSimReport?.duplicateCount ?? 0}
                  </p>
                </div>
                {dupeCheckResult && (
                  <div>
                    <span className="text-[#6B756E]">{t.totalLocalPending}</span>
                    <p className="mt-0.5 font-mono font-semibold text-[#111814]" dir="ltr">
                      {dupeCheckResult.totalCount}
                    </p>
                  </div>
                )}
              </div>
            )}

            {suiteResults && (
              <div className="mt-4 rounded-xl border border-[#E2E6DF] bg-[#FAFBF9] p-4">
                <p
                  className={`text-xs font-bold ${
                    suiteResults.every((r) => r.passed) ? 'text-[#15803D]' : 'text-[#DC2626]'
                  }`}
                >
                  {suiteResults.every((r) => r.passed)
                    ? t.suiteSummaryPassed
                    : t.suiteSummaryFailed}{' '}
                  ({suiteResults.filter((r) => r.passed).length}/{suiteResults.length})
                </p>
                <ul className="mt-3 divide-y divide-[#E2E6DF]">
                  {suiteResults.map((res) => (
                    <li key={res.id} className="py-2.5 text-xs">
                      <div className="flex items-center justify-between gap-3">
                        <span className="font-semibold text-[#111814]">{res.name}</span>
                        <span
                          className={`font-mono font-semibold whitespace-nowrap shrink-0 ${
                            res.passed ? 'text-[#15803D]' : 'text-[#DC2626]'
                          }`}
                          dir="ltr"
                        >
                          {res.passed ? 'PASS' : 'FAIL'} · {res.durationMs}ms
                        </span>
                      </div>
                      <p className="mt-1 font-mono text-[11px] text-[#4B554E]" dir="ltr">
                        {res.details}
                      </p>
                    </li>
                  ))}
                </ul>
              </div>
            )}

            <div className="mt-5">
              <p className="text-xs font-semibold text-[#4B554E]">{t.acceptanceTitle}</p>
              <ul className="mt-2.5 divide-y divide-[#EEF1EB]">
                {acceptanceChecks.map((item, idx) => (
                  <li key={idx} className="flex items-center justify-between gap-4 py-2.5 text-xs">
                    <span className="text-[#111814]">{item.label}</span>
                    <span
                      className={`inline-flex items-center gap-1 font-semibold whitespace-nowrap shrink-0 ${
                        item.verified ? 'text-[#15803D]' : 'text-[#6B756E]'
                      }`}
                    >
                      {item.verified && <CheckCircle2 className="h-3.5 w-3.5" />}
                      <span>{item.verified ? t.passedText : t.readyText}</span>
                    </span>
                  </li>
                ))}
              </ul>
            </div>
          </section>
        </div>
      </div>

      {showPermissionModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/50 p-4 backdrop-blur-xs">
          <div className="w-full max-w-md rounded-2xl border border-[#E2E6DF] bg-white p-6">
            <div className="flex items-center gap-3">
              <ShieldAlert className="h-6 w-6 shrink-0 text-[#15803D]" />
              <h3 className="text-lg font-bold text-[#111814]">{t.permModalTitle}</h3>
            </div>
            <p className="mt-3 text-sm leading-relaxed text-[#4B554E]">{t.permModalBody}</p>
            <p className="mt-3 rounded-xl border border-[#EEF1EB] bg-[#FAFBF9] p-3 text-xs font-medium text-[#111814]">
              {t.permModalPrivacy}
            </p>
            <div className="mt-6 flex items-center justify-end gap-3">
              <button
                type="button"
                onClick={() => setShowPermissionModal(false)}
                className="min-h-[44px] rounded-xl border border-[#D4DAD0] px-4 py-2 text-sm font-medium text-[#4B554E] hover:bg-[#F6F7F4]"
              >
                {t.permCancelButton}
              </button>
              <button
                type="button"
                onClick={handleConfirmPermissionAndStart}
                className="min-h-[44px] rounded-xl bg-[#15803D] px-5 py-2 text-sm font-semibold text-white hover:bg-[#166534]"
              >
                {t.permGrantButton}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};
