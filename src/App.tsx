import { useCallback, useEffect, useRef, useState } from 'react';
import { Database, Globe, Navigation } from 'lucide-react';
import { EmployeeSignInView } from './components/EmployeeSignInView';
import { FieldTrackerView } from './components/FieldTrackerView';
import { LocalRecordsView } from './components/LocalRecordsView';
import {
  authenticateEmployee,
  getActiveSessionForEmployee,
  getAllEmployees,
  getEmployeeSyncStats,
  getLocationRecordsForEmployee,
  initializeDatabaseWith50Employees,
  insertLocationRecordTransaction,
  runOfflinePeriodSimulation,
  startTrackingSession,
  stopTrackingSession,
  verifyEmployeeRecordUniqueness,
} from './db/offlineDb';
import { translations } from './i18n/translations';
import { CAPTURE_INTERVAL_MS, captureCurrentLocation } from './services/gpsCapture';
import { runFullPhase2VerificationSuite } from './services/phase2TestRunner';
import {
  calculateExponentialBackoffMs,
  clearInMemoryEmployeeAuth,
  setInMemoryEmployeePasscode,
  syncPendingRecordsForEmployee,
} from './services/syncEngine';
import type {
  Employee,
  EmployeeSyncStats,
  Language,
  LocationRecord,
  OfflineSimulationReport,
  Phase1Tab,
  SyncProgressState,
  TrackingSession,
} from './types/tracking';

const INITIAL_SYNC_STATS: EmployeeSyncStats = {
  pendingCount: 0,
  syncedCount: 0,
  failedCount: 0,
  blockedCount: 0,
  permanentFailedCount: 0,
  totalCount: 0,
  lastSyncedAt: null,
  lastPermanentError: null,
};

const INITIAL_SYNC_PROGRESS: SyncProgressState = {
  isSyncing: false,
  currentBatch: 0,
  totalBatches: 0,
  retryAttempt: 0,
  nextRetrySeconds: null,
  lastError: null,
};

export default function App() {
  const [language, setLanguage] = useState<Language>('en');
  const [activeTab, setActiveTab] = useState<Phase1Tab>('tracker');
  const [dbReady, setDbReady] = useState(false);

  const [employees, setEmployees] = useState<Employee[]>([]);
  const [currentEmployee, setCurrentEmployee] = useState<Employee | null>(null);
  const [activeSession, setActiveSession] = useState<TrackingSession | null>(null);
  const [employeeRecords, setEmployeeRecords] = useState<LocationRecord[]>([]);
  const [syncStats, setSyncStats] = useState<EmployeeSyncStats>(INITIAL_SYNC_STATS);
  const [syncProgress, setSyncProgress] = useState<SyncProgressState>(INITIAL_SYNC_PROGRESS);

  const [browserOnline, setBrowserOnline] = useState(
    typeof navigator !== 'undefined' ? navigator.onLine : true
  );
  const [simulatedOffline, setSimulatedOffline] = useState(false);

  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  const [countdownSeconds, setCountdownSeconds] = useState(600);
  const [hasCapturedWhileOffline, setHasCapturedWhileOffline] = useState(false);
  const [hasStoppedSessionCleanly, setHasStoppedSessionCleanly] = useState(false);
  const [lastSimReport, setLastSimReport] = useState<OfflineSimulationReport | null>(null);
  const [toastMessage, setToastMessage] = useState<string | null>(null);

  const sequenceRef = useRef(0);
  const lastCaptureAtRef = useRef<number>(Date.now());
  const toastTimerRef = useRef<number | null>(null);
  const retryTimerRef = useRef<number | null>(null);
  const retryCountdownRef = useRef<number | null>(null);
  const syncingRef = useRef(false);
  const wasOfflineRef = useRef(false);

  const t = translations[language];
  const isOfflineEffective = !browserOnline || simulatedOffline;

  const showToast = useCallback((msg: string) => {
    setToastMessage(msg);
    if (toastTimerRef.current) window.clearTimeout(toastTimerRef.current);
    toastTimerRef.current = window.setTimeout(() => setToastMessage(null), 3500);
  }, []);

  const clearBackoffTimers = useCallback(() => {
    if (retryTimerRef.current) {
      window.clearTimeout(retryTimerRef.current);
      retryTimerRef.current = null;
    }
    if (retryCountdownRef.current) {
      window.clearInterval(retryCountdownRef.current);
      retryCountdownRef.current = null;
    }
  }, []);

  useEffect(() => {
    document.documentElement.lang = language;
    document.documentElement.dir = language === 'ar' ? 'rtl' : 'ltr';
  }, [language]);

  useEffect(() => {
    const onOnline = () => setBrowserOnline(true);
    const onOffline = () => setBrowserOnline(false);
    window.addEventListener('online', onOnline);
    window.addEventListener('offline', onOffline);
    return () => {
      window.removeEventListener('online', onOnline);
      window.removeEventListener('offline', onOffline);
    };
  }, []);

  const refreshEmployees = useCallback(async () => {
    const list = await getAllEmployees();
    setEmployees(list);
    return list;
  }, []);

  const refreshEmployeeData = useCallback(async (employeeId: string) => {
    const [session, records, stats] = await Promise.all([
      getActiveSessionForEmployee(employeeId),
      getLocationRecordsForEmployee(employeeId),
      getEmployeeSyncStats(employeeId),
    ]);
    setActiveSession(session);
    setEmployeeRecords(records);
    setSyncStats(stats);
    if (session) {
      lastCaptureAtRef.current = new Date(session.startedAt).getTime();
    }
    return stats;
  }, []);

  useEffect(() => {
    let mounted = true;
    (async () => {
      await initializeDatabaseWith50Employees();
      const list = await getAllEmployees();
      if (!mounted) return;
      setEmployees(list);
      setDbReady(true);
    })();
    return () => {
      mounted = false;
      clearBackoffTimers();
    };
  }, [clearBackoffTimers]);

  const runEmployeeSync = useCallback(
    async (emp: Employee, offlineNow: boolean, attempt = 0, forceConfigRecovery = false) => {
      if (offlineNow || syncingRef.current) return;

      clearBackoffTimers();
      syncingRef.current = true;
      setSyncProgress({
        isSyncing: true,
        currentBatch: 0,
        totalBatches: 0,
        retryAttempt: attempt,
        nextRetrySeconds: null,
        lastError: null,
      });

      try {
        const result = await syncPendingRecordsForEmployee({
          employee: emp,
          isOfflineEffective: offlineNow,
          forceConfigRecovery,
          onBatchProgress: (currentBatch, totalBatches) => {
            setSyncProgress((prev) => ({
              ...prev,
              currentBatch,
              totalBatches,
            }));
          },
        });

        await refreshEmployeeData(emp.employeeId);

        if (result.ok) {
          setSyncProgress(INITIAL_SYNC_PROGRESS);
          if (result.totalAccepted > 0 || result.totalDuplicates > 0) {
            showToast(t.toastSyncSuccess);
          }
        } else if (result.retryable === false) {
          setSyncProgress({
            isSyncing: false,
            currentBatch: 0,
            totalBatches: 0,
            retryAttempt: attempt,
            nextRetrySeconds: null,
            lastError: result.error ?? 'Upload rejected by server',
          });
          showToast(t.toastSyncFailed);
        } else {
          const nextAttempt = attempt + 1;
          const delayMs = calculateExponentialBackoffMs(nextAttempt);
          let remainingSec = Math.ceil(delayMs / 1000);

          setSyncProgress({
            isSyncing: false,
            currentBatch: 0,
            totalBatches: 0,
            retryAttempt: nextAttempt,
            nextRetrySeconds: remainingSec,
            lastError: result.error ?? 'Upload failed',
          });
          showToast(t.toastSyncFailed);

          retryCountdownRef.current = window.setInterval(() => {
            remainingSec = Math.max(0, remainingSec - 1);
            setSyncProgress((prev) => ({
              ...prev,
              nextRetrySeconds: remainingSec > 0 ? remainingSec : null,
            }));
          }, 1000);

          retryTimerRef.current = window.setTimeout(() => {
            clearBackoffTimers();
            void runEmployeeSync(emp, false, nextAttempt);
          }, delayMs);
        }
      } finally {
        syncingRef.current = false;
      }
    },
    [clearBackoffTimers, refreshEmployeeData, showToast, t.toastSyncFailed, t.toastSyncSuccess]
  );

  useEffect(() => {
    if (isOfflineEffective) {
      wasOfflineRef.current = true;
      clearBackoffTimers();
      return;
    }

    if (currentEmployee && (wasOfflineRef.current || syncStats.pendingCount + syncStats.failedCount > 0)) {
      wasOfflineRef.current = false;
      if (syncStats.pendingCount + syncStats.failedCount > 0 && !syncingRef.current) {
        void runEmployeeSync(currentEmployee, false, 0);
      }
    }
  }, [
    isOfflineEffective,
    currentEmployee,
    syncStats.pendingCount,
    syncStats.failedCount,
    runEmployeeSync,
    clearBackoffTimers,
  ]);

  const performCapture = useCallback(
    async (session: TrackingSession, emp: Employee, offlineNow: boolean) => {
      sequenceRef.current += 1;
      const result = await captureCurrentLocation({
        sessionId: session.sessionId,
        employeeId: emp.employeeId,
        deviceId: emp.assignedDeviceId,
        sequenceNumber: sequenceRef.current,
      });

      const { inserted } = await insertLocationRecordTransaction(result.record);
      if (inserted) {
        lastCaptureAtRef.current = Date.now();
        setCountdownSeconds(600);
        if (offlineNow) {
          setHasCapturedWhileOffline(true);
        }
        await refreshEmployeeData(emp.employeeId);
        if (result.usedFallbackSimulator) {
          showToast(t.toastPermissionDeniedFallback);
        } else {
          showToast(t.toastRecordSaved);
        }

        if (!offlineNow) {
          void runEmployeeSync(emp, false, 0);
        }
      }
    },
    [
      refreshEmployeeData,
      runEmployeeSync,
      showToast,
      t.toastPermissionDeniedFallback,
      t.toastRecordSaved,
    ]
  );

  useEffect(() => {
    if (!activeSession || activeSession.status !== 'active' || !currentEmployee) {
      setElapsedSeconds(0);
      setCountdownSeconds(600);
      return;
    }

    const startMs = new Date(activeSession.startedAt).getTime();

    const tick = () => {
      const now = Date.now();
      setElapsedSeconds(Math.max(0, Math.floor((now - startMs) / 1000)));
      const sinceLast = Math.floor((now - lastCaptureAtRef.current) / 1000);
      setCountdownSeconds(Math.max(0, 600 - (sinceLast % 600)));
    };

    tick();
    const secTimer = window.setInterval(tick, 1000);
    const captureTimer = window.setInterval(() => {
      void performCapture(activeSession, currentEmployee, isOfflineEffective);
    }, CAPTURE_INTERVAL_MS);

    return () => {
      window.clearInterval(secTimer);
      window.clearInterval(captureTimer);
    };
  }, [activeSession, currentEmployee, isOfflineEffective, performCapture]);

  const handleSignIn = async (identifier: string, passcode: string) => {
    const auth = await authenticateEmployee(identifier, passcode);
    if (auth.status !== 'ok') {
      if (auth.status === 'not_found') {
        return { ok: false, error: t.employeeNotFoundError };
      }
      if (auth.status === 'inactive') {
        return { ok: false, error: t.accountInactiveError };
      }
      return { ok: false, error: t.invalidCredentialsError };
    }

    setInMemoryEmployeePasscode(auth.employee.employeeId, passcode);
    setCurrentEmployee(auth.employee);
    setSyncProgress(INITIAL_SYNC_PROGRESS);
    const stats = await refreshEmployeeData(auth.employee.employeeId);
    setActiveTab('tracker');

    if (!isOfflineEffective && stats.pendingCount + stats.failedCount > 0) {
      void runEmployeeSync(auth.employee, false, 0);
    }
    return { ok: true };
  };

  const handleSignOut = async () => {
    clearBackoffTimers();
    if (activeSession && currentEmployee) {
      await stopTrackingSession(activeSession.sessionId, currentEmployee.employeeId);
      setHasStoppedSessionCleanly(true);
      await refreshEmployees();
    }
    if (currentEmployee) {
      clearInMemoryEmployeeAuth(currentEmployee.employeeId);
    }
    setCurrentEmployee(null);
    setActiveSession(null);
    setEmployeeRecords([]);
    setSyncStats(INITIAL_SYNC_STATS);
    setSyncProgress(INITIAL_SYNC_PROGRESS);
  };

  const handleRequestStartSession = async () => {
    if (!currentEmployee) return;
    const session = await startTrackingSession(currentEmployee);
    lastCaptureAtRef.current = Date.now();
    setActiveSession(session);
    await refreshEmployees();
    await performCapture(session, currentEmployee, isOfflineEffective);
    showToast(t.toastSessionStarted);
  };

  const handleStopSession = async () => {
    if (!activeSession || !currentEmployee) return;
    await stopTrackingSession(activeSession.sessionId, currentEmployee.employeeId);
    setHasStoppedSessionCleanly(true);
    await refreshEmployees();
    await refreshEmployeeData(currentEmployee.employeeId);
    showToast(t.toastSessionStopped);
  };

  const handleCaptureNow = async () => {
    if (!activeSession || !currentEmployee) return;
    await performCapture(activeSession, currentEmployee, isOfflineEffective);
  };

  const handleSyncNow = async () => {
    if (!currentEmployee) return;
    await runEmployeeSync(currentEmployee, isOfflineEffective, 0, true);
  };

  const handleSimulateOfflineDays = async (days: number) => {
    if (!currentEmployee) {
      throw new Error('No active employee');
    }
    const report = await runOfflinePeriodSimulation(currentEmployee, days);
    setLastSimReport(report);
    if (isOfflineEffective) {
      setHasCapturedWhileOffline(true);
    }
    await refreshEmployeeData(currentEmployee.employeeId);
    showToast(t.toastOfflineSimComplete);
    return report;
  };

  const handleVerifyZeroDuplicates = async () => {
    if (!currentEmployee) return { totalCount: 0, duplicateCount: 0 };
    return verifyEmployeeRecordUniqueness(currentEmployee.employeeId);
  };

  const handleRunPhase2Suite = async () => {
    const suiteRes = await runFullPhase2VerificationSuite();
    if (currentEmployee) {
      await refreshEmployeeData(currentEmployee.employeeId);
    }
    return suiteRes;
  };

  const navItems: { id: Phase1Tab; label: string; icon: typeof Navigation }[] = [
    { id: 'tracker', label: t.navTracker, icon: Navigation },
    { id: 'records', label: t.navRecords, icon: Database },
  ];

  return (
    <div className="min-h-screen bg-[#F6F7F4] text-[#111814] pb-24 md:pb-12">
      <header className="sticky top-0 z-30 border-b border-[#E2E6DF] bg-white/95 backdrop-blur-xs">
        <div className="mx-auto flex h-14 max-w-7xl items-center justify-between gap-8 px-4 sm:px-6">
          <span className="font-display text-lg font-bold tracking-tight text-[#111814] whitespace-nowrap shrink-0">
            {t.brandName}
          </span>

          <nav className="hidden items-center gap-6 md:flex" aria-label="Employee Navigation">
            {currentEmployee &&
              navItems.map((item) => {
                const active = activeTab === item.id;
                return (
                  <button
                    key={item.id}
                    type="button"
                    onClick={() => setActiveTab(item.id)}
                    className={`min-h-[40px] border-b-2 px-1 text-sm font-medium transition-colors whitespace-nowrap shrink-0 ${
                      active
                        ? 'border-[#15803D] text-[#111814]'
                        : 'border-transparent text-[#4B554E] hover:text-[#111814]'
                    }`}
                  >
                    {item.label}
                  </button>
                );
              })}
          </nav>

          <div className="flex items-center shrink-0">
            <button
              type="button"
              onClick={() => setLanguage((prev) => (prev === 'en' ? 'ar' : 'en'))}
              className="inline-flex min-h-[40px] items-center gap-2 rounded-xl border border-[#D4DAD0] bg-[#FAFBF9] px-3.5 py-1.5 text-xs font-semibold text-[#111814] transition-colors hover:bg-[#EEF1EB] whitespace-nowrap shrink-0"
            >
              <Globe className="h-4 w-4 text-[#15803D]" />
              <span>{t.langToggleLabel}</span>
            </button>
          </div>
        </div>
      </header>

      <main className="mx-auto max-w-7xl px-4 py-6 sm:px-6">
        {!dbReady ? (
          <div className="mx-auto max-w-md rounded-2xl border border-[#E2E6DF] bg-white p-8 text-center text-sm text-[#4B554E]">
            Loading local offline storage…
          </div>
        ) : !currentEmployee ? (
          <EmployeeSignInView
            t={t}
            language={language}
            employees={employees}
            onSignIn={handleSignIn}
          />
        ) : activeTab === 'tracker' ? (
          <FieldTrackerView
            t={t}
            language={language}
            employee={currentEmployee}
            activeSession={activeSession}
            latestRecord={employeeRecords[0] ?? null}
            syncStats={syncStats}
            syncProgress={syncProgress}
            elapsedSeconds={elapsedSeconds}
            countdownSeconds={countdownSeconds}
            isOfflineEffective={isOfflineEffective}
            simulatedOffline={simulatedOffline}
            onToggleSimulatedOffline={() => setSimulatedOffline((v) => !v)}
            onRequestStartSession={handleRequestStartSession}
            onStopSession={handleStopSession}
            onCaptureNow={handleCaptureNow}
            onSyncNow={handleSyncNow}
            onSimulateOfflineDays={handleSimulateOfflineDays}
            onVerifyZeroDuplicates={handleVerifyZeroDuplicates}
            onRunPhase2Suite={handleRunPhase2Suite}
            totalEmployeesCount={employees.length}
            hasCapturedWhileOffline={hasCapturedWhileOffline}
            hasStoppedSessionCleanly={hasStoppedSessionCleanly}
            lastSimReport={lastSimReport}
            onSignOut={handleSignOut}
          />
        ) : (
          <LocalRecordsView
            t={t}
            language={language}
            employee={currentEmployee}
            activeSessionId={activeSession?.sessionId ?? null}
            records={employeeRecords}
          />
        )}
      </main>

      {currentEmployee && (
        <nav
          aria-label="Mobile Employee Navigation"
          className="fixed bottom-0 left-0 right-0 z-40 grid h-16 grid-cols-2 border-t border-[#E2E6DF] bg-white/95 backdrop-blur-md md:hidden"
        >
          {navItems.map((item) => {
            const Icon = item.icon;
            const active = activeTab === item.id;
            return (
              <button
                key={item.id}
                type="button"
                onClick={() => setActiveTab(item.id)}
                className={`flex min-h-[44px] flex-col items-center justify-center gap-1 text-[11px] font-medium transition-colors ${
                  active ? 'text-[#15803D]' : 'text-[#4B554E]'
                }`}
              >
                <Icon className="h-5 w-5" />
                <span className="truncate max-w-[120px]">{item.label}</span>
              </button>
            );
          })}
        </nav>
      )}

      {toastMessage && (
        <div
          role="status"
          className="fixed bottom-20 end-4 z-50 max-w-sm rounded-xl border border-[#15803D]/30 bg-[#111814] px-4 py-3 text-xs font-medium text-white shadow-lg md:bottom-6"
        >
          {toastMessage}
        </div>
      )}
    </div>
  );
}
