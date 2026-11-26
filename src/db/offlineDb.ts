import { decomposeTimestamp, generateUuid } from '../services/gpsCapture';
import type {
  AccountStatus,
  Employee,
  EmployeeSyncStats,
  LocationRecord,
  OfflineSimulationReport,
  TrackingSession,
} from '../types/tracking';

const DB_NAME = 'agritrack_phase1_db';
const DB_VERSION = 2;

const STORE_EMPLOYEES = 'employees';
const STORE_SESSIONS = 'tracking_sessions';
const STORE_RECORDS = 'location_records';
const STORE_SYNC_META = 'sync_metadata';

const PASSCODE_SALT = 'agritrack_field_phase1_salt_2026';

interface SyncMetadataRecord {
  employeeId: string;
  lastSyncedAt: string | null;
}

export async function hashPasscode(plain: string): Promise<string> {
  const input = `${PASSCODE_SALT}:${plain.trim()}`;
  if (typeof crypto !== 'undefined' && crypto.subtle) {
    const encoded = new TextEncoder().encode(input);
    const digest = await crypto.subtle.digest('SHA-256', encoded);
    return Array.from(new Uint8Array(digest))
      .map((b) => b.toString(16).padStart(2, '0'))
      .join('');
  }
  let hash = 2166136261;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 16777619);
  }
  return `fnv_${(hash >>> 0).toString(16)}`;
}

const FIRST_NAMES_EN = [
  'Tariq', 'Hassan', 'Ibrahim', 'Kareem', 'Nabil', 'Mahmoud', 'Youssef', 'Adel', 'Samir', 'Rami',
  'Salma', 'Nadia', 'Huda', 'Amina', 'Laila', 'Omar', 'Faisal', 'Ziad', 'Bilal', 'Mazen',
  'Wael', 'Sherif', 'Mustafa', 'Khaled', 'Tamer',
];

const LAST_NAMES_EN = [
  'Al-Mansoor', 'Farouk', 'El-Sayed', 'Darwish', 'Qureshi', 'Zaki', 'Nasser', 'Haddad', 'Barakat', 'Sabri',
  'Khoury', 'Rashid', 'Suleiman', 'Ghanem', 'Al-Harbi', 'Salim', 'Badr', 'Hamdan', 'Awad', 'Sharif',
];

const FIRST_NAMES_AR = [
  'طارق', 'حسن', 'إبراهيم', 'كريم', 'نبيل', 'محمود', 'يوسف', 'عادل', 'سمير', 'رامي',
  'سلمى', 'نادية', 'هدى', 'أمينة', 'ليلى', 'عمر', 'فيصل', 'زياد', 'بلال', 'مازن',
  'وائل', 'شريف', 'مصطفى', 'خالد', 'تامر',
];

const LAST_NAMES_AR = [
  'المنصور', 'فاروق', 'السيد', 'درويش', 'قريشي', 'زكي', 'ناصر', 'حداد', 'بركات', 'صبري',
  'خوري', 'راشد', 'سليمان', 'غانم', 'الحربي', 'سالم', 'بدر', 'حمدان', 'عوض', 'شريف',
];

function openDb(): Promise<IDBDatabase> {
  return new Promise((resolve, reject) => {
    const request = indexedDB.open(DB_NAME, DB_VERSION);

    request.onupgradeneeded = () => {
      const db = request.result;
      if (!db.objectStoreNames.contains(STORE_EMPLOYEES)) {
        const empStore = db.createObjectStore(STORE_EMPLOYEES, { keyPath: 'employeeId' });
        empStore.createIndex('by_number', 'employeeNumber', { unique: true });
      }
      if (!db.objectStoreNames.contains(STORE_SESSIONS)) {
        const sessionStore = db.createObjectStore(STORE_SESSIONS, { keyPath: 'sessionId' });
        sessionStore.createIndex('by_employee', 'employeeId', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_RECORDS)) {
        const recordStore = db.createObjectStore(STORE_RECORDS, { keyPath: 'recordId' });
        recordStore.createIndex('by_employee', 'employeeId', { unique: false });
        recordStore.createIndex('by_session', 'sessionId', { unique: false });
        recordStore.createIndex('by_sync_status', 'syncStatus', { unique: false });
      }
      if (!db.objectStoreNames.contains(STORE_SYNC_META)) {
        db.createObjectStore(STORE_SYNC_META, { keyPath: 'employeeId' });
      }
    };

    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
}

function requestToPromise<T>(req: IDBRequest<T>): Promise<T> {
  return new Promise((resolve, reject) => {
    req.onsuccess = () => resolve(req.result);
    req.onerror = () => reject(req.error);
  });
}

function transactionDone(tx: IDBTransaction): Promise<void> {
  return new Promise((resolve, reject) => {
    tx.oncomplete = () => resolve();
    tx.onerror = () => reject(tx.error);
    tx.onabort = () => reject(tx.error);
  });
}

export async function initializeDatabaseWith50Employees(): Promise<void> {
  const db = await openDb();
  const countTx = db.transaction(STORE_EMPLOYEES, 'readonly');
  const existingCount = await requestToPromise(countTx.objectStore(STORE_EMPLOYEES).count());
  if (existingCount > 0) {
    db.close();
    return;
  }

  const defaultHash = await hashPasscode('2026');
  const nowIso = new Date().toISOString();

  const tx = db.transaction(STORE_EMPLOYEES, 'readwrite');
  const store = tx.objectStore(STORE_EMPLOYEES);

  for (let i = 1; i <= 50; i++) {
    const padded = String(i).padStart(3, '0');
    const firstIdx = (i - 1) % FIRST_NAMES_EN.length;
    const lastIdx = Math.floor((i - 1) / 2) % LAST_NAMES_EN.length;

    const employee: Employee = {
      employeeId: `EMP-${padded}`,
      fullNameEn: `${FIRST_NAMES_EN[firstIdx]} ${LAST_NAMES_EN[lastIdx]}`,
      fullNameAr: `${FIRST_NAMES_AR[firstIdx]} ${LAST_NAMES_AR[lastIdx]}`,
      employeeNumber: `AG-${1000 + i}`,
      assignedDeviceId: `AND-DEV-${padded}`,
      accountStatus: i >= 49 ? 'inactive' : 'active',
      sessionStatus: 'idle',
      passcodeHash: defaultHash,
      createdAt: nowIso,
    };
    store.put(employee);
  }

  await transactionDone(tx);
  db.close();
}

export async function getAllEmployees(): Promise<Employee[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_EMPLOYEES, 'readonly');
  const list = await requestToPromise(tx.objectStore(STORE_EMPLOYEES).getAll());
  db.close();
  return (list as Employee[]).sort((a, b) => a.employeeId.localeCompare(b.employeeId));
}

export async function getEmployeeByIdentifier(identifier: string): Promise<Employee | null> {
  const normalized = identifier.trim().toUpperCase();
  const all = await getAllEmployees();
  return (
    all.find(
      (e) =>
        e.employeeId.toUpperCase() === normalized ||
        e.employeeNumber.toUpperCase() === normalized
    ) ?? null
  );
}

export async function authenticateEmployee(
  identifier: string,
  plainPasscode: string
): Promise<{ status: 'ok'; employee: Employee } | { status: 'not_found' | 'inactive' | 'invalid_passcode' }> {
  const emp = await getEmployeeByIdentifier(identifier);
  if (!emp) return { status: 'not_found' };
  if (emp.accountStatus !== 'active') return { status: 'inactive' };
  const candidateHash = await hashPasscode(plainPasscode);
  if (candidateHash !== emp.passcodeHash) return { status: 'invalid_passcode' };
  return { status: 'ok', employee: emp };
}

export async function upsertEmployee(params: {
  employeeId: string;
  fullNameEn: string;
  fullNameAr: string;
  employeeNumber: string;
  assignedDeviceId: string;
  accountStatus: AccountStatus;
  plainPasscode?: string;
}): Promise<Employee> {
  const db = await openDb();
  const readTx = db.transaction(STORE_EMPLOYEES, 'readonly');
  const existing = (await requestToPromise(
    readTx.objectStore(STORE_EMPLOYEES).get(params.employeeId)
  )) as Employee | undefined;

  let passcodeHash = existing?.passcodeHash;
  if (params.plainPasscode && params.plainPasscode.trim().length > 0) {
    passcodeHash = await hashPasscode(params.plainPasscode);
  } else if (!passcodeHash) {
    passcodeHash = await hashPasscode('2026');
  }

  const saved: Employee = {
    employeeId: params.employeeId.trim().toUpperCase(),
    fullNameEn: params.fullNameEn.trim(),
    fullNameAr: params.fullNameAr.trim() || params.fullNameEn.trim(),
    employeeNumber: params.employeeNumber.trim().toUpperCase(),
    assignedDeviceId: params.assignedDeviceId.trim().toUpperCase(),
    accountStatus: params.accountStatus,
    sessionStatus: existing?.sessionStatus ?? 'idle',
    passcodeHash,
    createdAt: existing?.createdAt ?? new Date().toISOString(),
  };

  const writeTx = db.transaction(STORE_EMPLOYEES, 'readwrite');
  writeTx.objectStore(STORE_EMPLOYEES).put(saved);
  await transactionDone(writeTx);
  db.close();
  return saved;
}

export async function toggleEmployeeAccountStatus(employeeId: string): Promise<Employee | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_EMPLOYEES, 'readwrite');
  const store = tx.objectStore(STORE_EMPLOYEES);
  const existing = (await requestToPromise(store.get(employeeId))) as Employee | undefined;
  if (!existing) {
    db.close();
    return null;
  }
  const updated: Employee = {
    ...existing,
    accountStatus: existing.accountStatus === 'active' ? 'inactive' : 'active',
    sessionStatus: existing.accountStatus === 'active' ? 'idle' : existing.sessionStatus,
  };
  store.put(updated);
  await transactionDone(tx);
  db.close();
  return updated;
}

export async function getActiveSessionForEmployee(employeeId: string): Promise<TrackingSession | null> {
  const db = await openDb();
  const tx = db.transaction(STORE_SESSIONS, 'readonly');
  const index = tx.objectStore(STORE_SESSIONS).index('by_employee');
  const sessions = (await requestToPromise(index.getAll(employeeId))) as TrackingSession[];
  db.close();
  return sessions.find((s) => s.status === 'active') ?? null;
}

export async function startTrackingSession(employee: Employee): Promise<TrackingSession> {
  const db = await openDb();
  const tx = db.transaction([STORE_SESSIONS, STORE_EMPLOYEES], 'readwrite');
  const sessionStore = tx.objectStore(STORE_SESSIONS);
  const empStore = tx.objectStore(STORE_EMPLOYEES);

  const index = sessionStore.index('by_employee');
  const existing = (await requestToPromise(index.getAll(employee.employeeId))) as TrackingSession[];
  const nowIso = new Date().toISOString();
  for (const s of existing) {
    if (s.status === 'active') {
      sessionStore.put({ ...s, status: 'completed', endedAt: nowIso });
    }
  }

  const newSession: TrackingSession = {
    sessionId: generateUuid(),
    employeeId: employee.employeeId,
    deviceId: employee.assignedDeviceId,
    startedAt: nowIso,
    endedAt: null,
    status: 'active',
    capturedCount: 0,
  };

  sessionStore.put(newSession);
  empStore.put({ ...employee, sessionStatus: 'tracking' });

  await transactionDone(tx);
  db.close();
  return newSession;
}

export async function stopTrackingSession(sessionId: string, employeeId: string): Promise<TrackingSession | null> {
  const db = await openDb();
  const tx = db.transaction([STORE_SESSIONS, STORE_EMPLOYEES], 'readwrite');
  const sessionStore = tx.objectStore(STORE_SESSIONS);
  const empStore = tx.objectStore(STORE_EMPLOYEES);

  const session = (await requestToPromise(sessionStore.get(sessionId))) as TrackingSession | undefined;
  const employee = (await requestToPromise(empStore.get(employeeId))) as Employee | undefined;

  let updatedSession: TrackingSession | null = null;
  if (session && session.employeeId === employeeId) {
    updatedSession = {
      ...session,
      status: 'completed',
      endedAt: new Date().toISOString(),
    };
    sessionStore.put(updatedSession);
  }
  if (employee) {
    empStore.put({ ...employee, sessionStatus: 'idle' });
  }

  await transactionDone(tx);
  db.close();
  return updatedSession;
}

export async function insertLocationRecordTransaction(record: LocationRecord): Promise<{ inserted: boolean }> {
  const db = await openDb();
  const tx = db.transaction([STORE_RECORDS, STORE_SESSIONS], 'readwrite');
  const recordStore = tx.objectStore(STORE_RECORDS);
  const sessionStore = tx.objectStore(STORE_SESSIONS);

  const existing = await requestToPromise(recordStore.get(record.recordId));
  if (existing) {
    await transactionDone(tx);
    db.close();
    return { inserted: false };
  }

  recordStore.add(record);

  const session = (await requestToPromise(sessionStore.get(record.sessionId))) as TrackingSession | undefined;
  if (session) {
    sessionStore.put({
      ...session,
      capturedCount: session.capturedCount + 1,
    });
  }

  await transactionDone(tx);
  db.close();
  return { inserted: true };
}

export async function getLocationRecordsForEmployee(employeeId: string): Promise<LocationRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readonly');
  const index = tx.objectStore(STORE_RECORDS).index('by_employee');
  const rows = (await requestToPromise(index.getAll(employeeId))) as LocationRecord[];
  db.close();
  return rows.sort((a, b) => b.capturedAtEpochMs - a.capturedAtEpochMs);
}

// Phase 2 / 3.6.1: Query unsynchronized (PENDING or RETRYABLE_FAILED, plus legacy FAILED) records chronologically.
// PERMANENT_FAILED records are preserved locally and excluded from automatic retry loops.
export async function getUnsyncedRecordsForEmployee(employeeId: string): Promise<LocationRecord[]> {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readonly');
  const index = tx.objectStore(STORE_RECORDS).index('by_employee');
  const rows = (await requestToPromise(index.getAll(employeeId))) as LocationRecord[];
  db.close();
  return rows
    .filter((r) => {
      const status = r.syncStatus as string;
      return status === 'PENDING' || status === 'RETRYABLE_FAILED' || status === 'FAILED';
    })
    .sort((a, b) => a.capturedAtEpochMs - b.capturedAtEpochMs);
}

// Phase 2: Mark records as SYNCED only after explicit server receipt confirmation (never deletes locally)
export async function markRecordsSyncedTransaction(
  employeeId: string,
  confirmedRecordIds: string[],
  serverReceivedAt: string
): Promise<number> {
  if (confirmedRecordIds.length === 0) return 0;

  const db = await openDb();
  const tx = db.transaction([STORE_RECORDS, STORE_SYNC_META], 'readwrite');
  const recordStore = tx.objectStore(STORE_RECORDS);
  const metaStore = tx.objectStore(STORE_SYNC_META);

  let updatedCount = 0;
  for (const id of confirmedRecordIds) {
    const existing = (await requestToPromise(recordStore.get(id))) as LocationRecord | undefined;
    if (existing && existing.employeeId === employeeId) {
      recordStore.put({
        ...existing,
        syncStatus: 'SYNCED',
        serverSyncedAt: serverReceivedAt,
        lastError: null,
      });
      updatedCount++;
    }
  }

  metaStore.put({
    employeeId,
    lastSyncedAt: serverReceivedAt,
  } satisfies SyncMetadataRecord);

  await transactionDone(tx);
  db.close();
  return updatedCount;
}

// Mark transient/network/5xx/partial-ack failed records as RETRYABLE_FAILED while preserving them locally
export async function markRecordsRetryableFailedTransaction(
  employeeId: string,
  failedRecordIds: string[],
  errorMessage?: string
): Promise<number> {
  if (failedRecordIds.length === 0) return 0;

  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readwrite');
  const recordStore = tx.objectStore(STORE_RECORDS);

  let updatedCount = 0;
  for (const id of failedRecordIds) {
    const existing = (await requestToPromise(recordStore.get(id))) as LocationRecord | undefined;
    if (existing && existing.employeeId === employeeId && existing.syncStatus !== 'SYNCED') {
      recordStore.put({
        ...existing,
        syncStatus: 'RETRYABLE_FAILED',
        retryCount: (existing.retryCount ?? 0) + 1,
        lastError: errorMessage ?? existing.lastError ?? null,
      });
      updatedCount++;
    }
  }

  await transactionDone(tx);
  db.close();
  return updatedCount;
}

// Mark permanently invalid (HTTP 400) records as PERMANENT_FAILED (excluded from retries, never deleted)
export async function markRecordsPermanentFailedTransaction(
  employeeId: string,
  failedRecordIds: string[],
  errorMessage: string
): Promise<number> {
  if (failedRecordIds.length === 0) return 0;

  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readwrite');
  const recordStore = tx.objectStore(STORE_RECORDS);

  let updatedCount = 0;
  for (const id of failedRecordIds) {
    const existing = (await requestToPromise(recordStore.get(id))) as LocationRecord | undefined;
    if (existing && existing.employeeId === employeeId && existing.syncStatus !== 'SYNCED') {
      recordStore.put({
        ...existing,
        syncStatus: 'PERMANENT_FAILED',
        retryCount: (existing.retryCount ?? 0) + 1,
        lastError: errorMessage,
      });
      updatedCount++;
    }
  }

  await transactionDone(tx);
  db.close();
  return updatedCount;
}

// Mark auth/authorization blocked (401/403) records as BLOCKED_AUTH (excluded from automatic retries until re-auth/recovery)
export async function markRecordsBlockedAuthTransaction(
  employeeId: string,
  blockedRecordIds: string[],
  errorMessage: string
): Promise<number> {
  if (blockedRecordIds.length === 0) return 0;

  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readwrite');
  const recordStore = tx.objectStore(STORE_RECORDS);

  let updatedCount = 0;
  for (const id of blockedRecordIds) {
    const existing = (await requestToPromise(recordStore.get(id))) as LocationRecord | undefined;
    if (existing && existing.employeeId === employeeId && existing.syncStatus !== 'SYNCED') {
      recordStore.put({
        ...existing,
        syncStatus: 'BLOCKED_AUTH',
        lastError: errorMessage,
      });
      updatedCount++;
    }
  }

  await transactionDone(tx);
  db.close();
  return updatedCount;
}

// Mark batch-contract or endpoint mismatch (INVALID_BATCH / UNKNOWN_ENDPOINT) records as BLOCKED_CONFIGURATION
export async function markRecordsBlockedConfigurationTransaction(
  employeeId: string,
  blockedRecordIds: string[],
  errorMessage: string
): Promise<number> {
  if (blockedRecordIds.length === 0) return 0;

  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readwrite');
  const recordStore = tx.objectStore(STORE_RECORDS);

  let updatedCount = 0;
  for (const id of blockedRecordIds) {
    const existing = (await requestToPromise(recordStore.get(id))) as LocationRecord | undefined;
    if (existing && existing.employeeId === employeeId && existing.syncStatus !== 'SYNCED') {
      recordStore.put({
        ...existing,
        syncStatus: 'BLOCKED_CONFIGURATION',
        lastError: errorMessage,
      });
      updatedCount++;
    }
  }

  await transactionDone(tx);
  db.close();
  return updatedCount;
}

export async function unblockEmployeeBlockedRecordsTransaction(
  employeeId: string,
  blockedStatus: 'BLOCKED_AUTH' | 'BLOCKED_CONFIGURATION'
): Promise<number> {
  const db = await openDb();
  const tx = db.transaction(STORE_RECORDS, 'readwrite');
  const recordStore = tx.objectStore(STORE_RECORDS);
  const rows = (await requestToPromise(
    recordStore.index('by_employee').getAll(employeeId)
  )) as LocationRecord[];

  let unblocked = 0;
  for (const row of rows) {
    if (row.syncStatus === blockedStatus) {
      recordStore.put({
        ...row,
        syncStatus: 'PENDING',
      });
      unblocked++;
    }
  }

  await transactionDone(tx);
  db.close();
  return unblocked;
}

export async function markRecordsFailedTransaction(
  employeeId: string,
  failedRecordIds: string[],
  errorMessage?: string
): Promise<number> {
  return markRecordsRetryableFailedTransaction(employeeId, failedRecordIds, errorMessage);
}

export async function getEmployeeSyncStats(employeeId: string): Promise<EmployeeSyncStats> {
  const db = await openDb();
  const tx = db.transaction([STORE_RECORDS, STORE_SYNC_META], 'readonly');
  const index = tx.objectStore(STORE_RECORDS).index('by_employee');
  const rows = (await requestToPromise(index.getAll(employeeId))) as LocationRecord[];
  const meta = (await requestToPromise(
    tx.objectStore(STORE_SYNC_META).get(employeeId)
  )) as SyncMetadataRecord | undefined;
  db.close();

  let pendingCount = 0;
  let syncedCount = 0;
  let failedCount = 0;
  let blockedCount = 0;
  let permanentFailedCount = 0;
  let lastPermanentError: string | null = null;

  for (const r of rows) {
    const st = r.syncStatus as string;
    if (st === 'SYNCED') syncedCount++;
    else if (st === 'PERMANENT_FAILED') {
      permanentFailedCount++;
      if (!lastPermanentError && r.lastError) lastPermanentError = r.lastError;
    } else if (st === 'BLOCKED_AUTH' || st === 'BLOCKED_CONFIGURATION') {
      blockedCount++;
    } else if (st === 'RETRYABLE_FAILED' || st === 'FAILED') {
      failedCount++;
    } else {
      pendingCount++;
    }
  }

  return {
    pendingCount,
    syncedCount,
    failedCount,
    blockedCount,
    permanentFailedCount,
    totalCount: rows.length,
    lastSyncedAt: meta?.lastSyncedAt ?? null,
    lastPermanentError,
  };
}

export async function clearEmployeeRecordsForTest(employeeId: string): Promise<void> {
  const db = await openDb();
  const tx = db.transaction([STORE_RECORDS, STORE_SESSIONS, STORE_SYNC_META], 'readwrite');
  const recordStore = tx.objectStore(STORE_RECORDS);
  const sessionStore = tx.objectStore(STORE_SESSIONS);
  const metaStore = tx.objectStore(STORE_SYNC_META);

  const records = (await requestToPromise(
    recordStore.index('by_employee').getAll(employeeId)
  )) as LocationRecord[];
  for (const r of records) {
    recordStore.delete(r.recordId);
  }

  const sessions = (await requestToPromise(
    sessionStore.index('by_employee').getAll(employeeId)
  )) as TrackingSession[];
  for (const s of sessions) {
    sessionStore.delete(s.sessionId);
  }

  metaStore.delete(employeeId);
  await transactionDone(tx);
  db.close();
}

export async function verifyEmployeeRecordUniqueness(employeeId: string): Promise<{
  totalCount: number;
  uniqueCount: number;
  duplicateCount: number;
}> {
  const records = await getLocationRecordsForEmployee(employeeId);
  const seen = new Set<string>();
  for (const r of records) {
    seen.add(r.recordId);
  }
  return {
    totalCount: records.length,
    uniqueCount: seen.size,
    duplicateCount: records.length - seen.size,
  };
}

export async function runOfflinePeriodSimulation(
  employee: Employee,
  days: number
): Promise<OfflineSimulationReport> {
  const startPerf = performance.now();
  const intervalsPerDay = 48; // 8-hour shift @ 10-minute intervals = 48 captures/day
  const totalRecords = days * intervalsPerDay;

  const db = await openDb();
  const tx = db.transaction([STORE_SESSIONS, STORE_RECORDS], 'readwrite');
  const sessionStore = tx.objectStore(STORE_SESSIONS);
  const recordStore = tx.objectStore(STORE_RECORDS);

  const simSessionId = `SIM-${days}D-${generateUuid()}`;
  const nowMs = Date.now();
  const periodMs = days * 24 * 60 * 60 * 1000;
  const baseMs = nowMs - periodMs;

  const numPart = parseInt(employee.employeeId.replace(/\D/g, ''), 10) || 1;
  const baseLat = 30.624 + (numPart % 10) * 0.008;
  const baseLng = 31.112 + Math.floor(numPart / 10) * 0.009;

  sessionStore.put({
    sessionId: simSessionId,
    employeeId: employee.employeeId,
    deviceId: employee.assignedDeviceId,
    startedAt: new Date(baseMs).toISOString(),
    endedAt: new Date(nowMs).toISOString(),
    status: 'completed',
    capturedCount: totalRecords,
  } satisfies TrackingSession);

  let insertedCount = 0;
  for (let day = 0; day < days; day++) {
    const dayStartMs = baseMs + day * 24 * 60 * 60 * 1000 + 7 * 60 * 60 * 1000;
    for (let step = 0; step < intervalsPerDay; step++) {
      const captureDate = new Date(dayStartMs + step * 10 * 60 * 1000);
      const ts = decomposeTimestamp(captureDate);
      const angle = day * 0.35 + step * 0.14;
      const radius = 0.001 + (step % 7) * 0.00035;

      const record: LocationRecord = {
        recordId: generateUuid(),
        sessionId: simSessionId,
        employeeId: employee.employeeId,
        deviceId: employee.assignedDeviceId,
        latitude: Number((baseLat + Math.sin(angle) * radius).toFixed(6)),
        longitude: Number((baseLng + Math.cos(angle) * radius).toFixed(6)),
        ...ts,
        accuracyMeters: Number((4.5 + ((day + step) % 5) * 1.2).toFixed(1)),
        provider: 'gps',
        batteryPercent: Math.max(18, 98 - Math.floor((step / intervalsPerDay) * 65)),
        syncStatus: 'PENDING',
        serverSyncedAt: null,
      };
      recordStore.add(record);
      insertedCount++;
    }
  }

  await transactionDone(tx);
  db.close();

  const uniqueness = await verifyEmployeeRecordUniqueness(employee.employeeId);
  const durationMs = Math.round(performance.now() - startPerf);

  return {
    daysSimulated: days,
    recordsAttempted: totalRecords,
    recordsInserted: insertedCount,
    duplicateCount: uniqueness.duplicateCount,
    durationMs,
    completedAt: new Date().toISOString(),
  };
}

export async function run30DayOfflineSimulation(employee: Employee): Promise<OfflineSimulationReport> {
  return runOfflinePeriodSimulation(employee, 30);
}
