export type Language = 'en' | 'ar';

export type AccountStatus = 'active' | 'inactive';

export type SessionStatus = 'idle' | 'tracking';

export type SyncStatus =
  | 'PENDING'
  | 'RETRYABLE_FAILED'
  | 'BLOCKED_AUTH'
  | 'BLOCKED_CONFIGURATION'
  | 'SYNCED'
  | 'PERMANENT_FAILED';

export type Phase1Tab = 'tracker' | 'records';

export interface Employee {
  employeeId: string;
  fullNameEn: string;
  fullNameAr: string;
  employeeNumber: string;
  assignedDeviceId: string;
  accountStatus: AccountStatus;
  sessionStatus: SessionStatus;
  passcodeHash: string;
  createdAt: string;
}

export interface TrackingSession {
  sessionId: string;
  employeeId: string;
  deviceId: string;
  startedAt: string;
  endedAt: string | null;
  status: 'active' | 'completed';
  capturedCount: number;
}

export interface LocationRecord {
  recordId: string;
  sessionId: string;
  employeeId: string;
  deviceId: string;
  latitude: number;
  longitude: number;
  capturedAtIso: string;
  capturedAtEpochMs: number;
  dateStr: string;
  hour: number;
  minute: number;
  second: number;
  accuracyMeters: number;
  provider: string;
  batteryPercent: number | null;
  syncStatus: SyncStatus;
  serverSyncedAt: string | null;
  retryCount?: number;
  lastError?: string | null;
}

export interface OfflineSimulationReport {
  daysSimulated: number;
  recordsAttempted: number;
  recordsInserted: number;
  duplicateCount: number;
  durationMs: number;
  completedAt: string;
}

export interface EmployeeSyncStats {
  pendingCount: number;
  syncedCount: number;
  failedCount: number;
  blockedCount?: number;
  permanentFailedCount: number;
  totalCount: number;
  lastSyncedAt: string | null;
  lastPermanentError?: string | null;
}

export interface SyncProgressState {
  isSyncing: boolean;
  currentBatch: number;
  totalBatches: number;
  retryAttempt: number;
  nextRetrySeconds: number | null;
  lastError: string | null;
}

export interface SyncExecutionResult {
  ok: boolean;
  batchesSent: number;
  totalAccepted: number;
  totalDuplicates: number;
  serverReceivedAt: string | null;
  interrupted: boolean;
  retryable?: boolean;
  permanentError?: boolean;
  authRequired?: boolean;
  blockedAuth?: boolean;
  blockedConfiguration?: boolean;
  error?: string;
}

export interface Phase2TestCaseResult {
  id: string;
  name: string;
  passed: boolean;
  durationMs: number;
  details: string;
}
