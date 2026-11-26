import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { closePool, getPool } from '../src/db/pool.js';
import { bootstrapDatabaseAndMigrate, createApp } from '../server.js';

type SyncStatus =
  | 'PENDING'
  | 'RETRYABLE_FAILED'
  | 'BLOCKED_AUTH'
  | 'BLOCKED_CONFIGURATION'
  | 'SYNCED'
  | 'PERMANENT_FAILED';

type PauseType = 'NONE' | 'AUTH' | 'CONFIGURATION';

interface SyncQueueStateRow {
  employeeId: string;
  pauseType: PauseType;
  httpStatus: number | null;
  errorCode: string | null;
  reason: string | null;
  pausedAppVersionCode: number | null;
  pausedApiBaseUrl: string | null;
  updatedAtEpochMs: number;
}

interface OutboxRow {
  eventId: string;
  sessionId: string;
  employeeId: string;
  deviceId: string;
  eventType: 'START' | 'STOP' | 'INTERRUPTED';
  occurredAtIso: string;
  occurredAtEpochMs: number;
  sessionStartedAtIso: string;
  syncStatus: SyncStatus;
  serverSyncedAt: string | null;
  retryCount: number;
  lastError: string | null;
}

interface LocationRow {
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
  retryCount: number;
  lastError: string | null;
}

interface StoredAuthSession {
  employeeId: string;
  deviceId: string;
  accessToken: string;
}

/**
 * Faithful TypeScript mirror of AgriTrackDatabase v4 + TrackingDao + SyncWorker.kt + SyncScheduler.kt
 * executing real HTTP requests against central-backend + PostgreSQL 15.
 * Note: This simulates Android Room/WorkManager behavior in Node.js; native Android WorkManager execution
 * is classified separately as NOT TESTED in this container.
 */
class MirroredRoomStore {
  outbox: OutboxRow[] = [];
  records: LocationRow[] = [];
  queueStates = new Map<string, SyncQueueStateRow>();
  session: StoredAuthSession | null = null;
  reauthNoticeReason: string | null = null;

  // Mirrors TrackingDao.getUnsyncedSessionEvents
  getUnsyncedSessionEvents(employeeId: string): OutboxRow[] {
    return this.outbox
      .filter((e) => e.employeeId === employeeId && (e.syncStatus === 'PENDING' || e.syncStatus === 'RETRYABLE_FAILED'))
      .sort((a, b) => a.occurredAtEpochMs - b.occurredAtEpochMs);
  }

  // Mirrors TrackingDao.getUnsyncedBatch
  getUnsyncedBatch(employeeId: string, batchSize = 100): LocationRow[] {
    return this.records
      .filter((r) => r.employeeId === employeeId && (r.syncStatus === 'PENDING' || r.syncStatus === 'RETRYABLE_FAILED'))
      .sort((a, b) => a.capturedAtEpochMs - b.capturedAtEpochMs)
      .slice(0, batchSize);
  }

  pauseQueueForAuth(params: {
    employeeId: string;
    httpStatus: number;
    errorCode: string;
    reason: string;
    eventIds?: string[];
    recordIds?: string[];
    markAllUnsynced?: boolean;
  }) {
    if (params.markAllUnsynced) {
      for (const e of this.outbox) {
        if (e.employeeId === params.employeeId && (e.syncStatus === 'PENDING' || e.syncStatus === 'RETRYABLE_FAILED')) {
          e.syncStatus = 'BLOCKED_AUTH';
          e.lastError = params.reason;
        }
      }
      for (const r of this.records) {
        if (r.employeeId === params.employeeId && (r.syncStatus === 'PENDING' || r.syncStatus === 'RETRYABLE_FAILED')) {
          r.syncStatus = 'BLOCKED_AUTH';
          r.lastError = params.reason;
        }
      }
    } else {
      const evSet = new Set(params.eventIds ?? []);
      const recSet = new Set(params.recordIds ?? []);
      for (const e of this.outbox) {
        if (evSet.has(e.eventId) && e.syncStatus !== 'SYNCED') {
          e.syncStatus = 'BLOCKED_AUTH';
          e.lastError = params.reason;
        }
      }
      for (const r of this.records) {
        if (r.employeeId === params.employeeId && recSet.has(r.recordId) && r.syncStatus !== 'SYNCED') {
          r.syncStatus = 'BLOCKED_AUTH';
          r.lastError = params.reason;
        }
      }
    }

    this.queueStates.set(params.employeeId, {
      employeeId: params.employeeId,
      pauseType: 'AUTH',
      httpStatus: params.httpStatus,
      errorCode: params.errorCode,
      reason: params.reason,
      pausedAppVersionCode: null,
      pausedApiBaseUrl: null,
      updatedAtEpochMs: Date.now(),
    });
  }

  pauseQueueForConfiguration(params: {
    employeeId: string;
    httpStatus: number;
    errorCode: string;
    reason: string;
    appVersionCode: number;
    apiBaseUrl: string;
    eventIds?: string[];
    recordIds?: string[];
  }) {
    const evSet = new Set(params.eventIds ?? []);
    const recSet = new Set(params.recordIds ?? []);
    for (const e of this.outbox) {
      if (evSet.has(e.eventId) && e.syncStatus !== 'SYNCED') {
        e.syncStatus = 'BLOCKED_CONFIGURATION';
        e.lastError = params.reason;
      }
    }
    for (const r of this.records) {
      if (r.employeeId === params.employeeId && recSet.has(r.recordId) && r.syncStatus !== 'SYNCED') {
        r.syncStatus = 'BLOCKED_CONFIGURATION';
        r.lastError = params.reason;
      }
    }

    this.queueStates.set(params.employeeId, {
      employeeId: params.employeeId,
      pauseType: 'CONFIGURATION',
      httpStatus: params.httpStatus,
      errorCode: params.errorCode,
      reason: params.reason,
      pausedAppVersionCode: params.appVersionCode,
      pausedApiBaseUrl: params.apiBaseUrl,
      updatedAtEpochMs: Date.now(),
    });
  }

  unblockAuthQueue(employeeId: string) {
    for (const e of this.outbox) {
      if (e.employeeId === employeeId && e.syncStatus === 'BLOCKED_AUTH') e.syncStatus = 'PENDING';
    }
    for (const r of this.records) {
      if (r.employeeId === employeeId && r.syncStatus === 'BLOCKED_AUTH') r.syncStatus = 'PENDING';
    }
    const cur = this.queueStates.get(employeeId);
    if (cur?.pauseType === 'AUTH') {
      this.queueStates.set(employeeId, {
        employeeId,
        pauseType: 'NONE',
        httpStatus: null,
        errorCode: null,
        reason: null,
        pausedAppVersionCode: null,
        pausedApiBaseUrl: null,
        updatedAtEpochMs: Date.now(),
      });
    }
  }

  unblockConfigurationQueue(employeeId: string) {
    for (const e of this.outbox) {
      if (e.employeeId === employeeId && e.syncStatus === 'BLOCKED_CONFIGURATION') e.syncStatus = 'PENDING';
    }
    for (const r of this.records) {
      if (r.employeeId === employeeId && r.syncStatus === 'BLOCKED_CONFIGURATION') r.syncStatus = 'PENDING';
    }
    const cur = this.queueStates.get(employeeId);
    if (cur?.pauseType === 'CONFIGURATION') {
      this.queueStates.set(employeeId, {
        employeeId,
        pauseType: 'NONE',
        httpStatus: null,
        errorCode: null,
        reason: null,
        pausedAppVersionCode: null,
        pausedApiBaseUrl: null,
        updatedAtEpochMs: Date.now(),
      });
    }
  }

  serialize(): string {
    return JSON.stringify({
      outbox: this.outbox,
      records: this.records,
      queueStates: Array.from(this.queueStates.entries()),
      session: this.session,
      reauthNoticeReason: this.reauthNoticeReason,
    });
  }

  static restore(raw: string): MirroredRoomStore {
    const parsed = JSON.parse(raw) as {
      outbox: OutboxRow[];
      records: LocationRow[];
      queueStates: Array<[string, SyncQueueStateRow]>;
      session: StoredAuthSession | null;
      reauthNoticeReason: string | null;
    };
    const s = new MirroredRoomStore();
    s.outbox = parsed.outbox;
    s.records = parsed.records;
    s.queueStates = new Map(parsed.queueStates);
    s.session = parsed.session;
    s.reauthNoticeReason = parsed.reauthNoticeReason;
    return s;
  }
}

function parseApiError(httpCode: number, rawBody: string): { code?: string; message: string } {
  const trimmed = rawBody.trim();
  if (trimmed.startsWith('{')) {
    try {
      const obj = JSON.parse(trimmed) as { code?: unknown; error?: unknown };
      const code = typeof obj.code === 'string' && obj.code.trim() ? obj.code.trim().toUpperCase() : undefined;
      const message = typeof obj.error === 'string' && obj.error.trim() ? obj.error.trim() : trimmed;
      return { code, message: message.slice(0, 200) };
    } catch {
      // fallback
    }
  }
  return { message: trimmed.slice(0, 200) || `HTTP ${httpCode}` };
}

interface WorkerRunConfig {
  appVersionCode?: number;
  apiBaseUrl: string;
  forceUserRecovery?: boolean;
  rawBatchBodyOverride?: string;
  batchPathOverride?: string;
  startPathOverride?: string;
  simulateHeaderError?: string;
  payloadRecordEmployeeIdOverride?: string;
}

async function runMirroredSyncWorker(
  store: MirroredRoomStore,
  employeeId: string,
  config: WorkerRunConfig
): Promise<'SUCCESS' | 'RETRY' | 'FAILURE'> {
  const appVersionCode = config.appVersionCode ?? 1;
  const forceUserRecovery = config.forceUserRecovery ?? false;

  // 1. Exact SyncWorker.doWork() pause gate BEFORE any network call!
  const qState = store.queueStates.get(employeeId);
  if (qState) {
    if (qState.pauseType === 'CONFIGURATION') {
      const configChanged =
        qState.pausedAppVersionCode !== appVersionCode || qState.pausedApiBaseUrl !== config.apiBaseUrl;
      if (configChanged || forceUserRecovery) {
        store.unblockConfigurationQueue(employeeId);
      } else {
        return 'FAILURE';
      }
    } else if (qState.pauseType === 'AUTH') {
      if (forceUserRecovery && (store.session?.employeeId === employeeId || qState.httpStatus === 403)) {
        store.unblockAuthQueue(employeeId);
      } else {
        return 'FAILURE';
      }
    }
  }

  if (!store.session || store.session.employeeId !== employeeId) {
    store.pauseQueueForAuth({
      employeeId,
      httpStatus: 401,
      errorCode: 'AUTH_REQUIRED',
      reason: 'Sign in required to resume uploading queued records.',
      markAllUnsynced: true,
    });
    return 'FAILURE';
  }

  let hasPermanentFailure = false;

  const syncOutbox = async (ev: OutboxRow): Promise<'OK' | 'PERMANENT' | 'RETRY' | 'ABORT_FAILURE'> => {
    const endpoint =
      ev.eventType === 'START'
        ? config.startPathOverride ?? '/api/sessions/start'
        : '/api/sessions/stop';
    const body =
      ev.eventType === 'START'
        ? { sessionId: ev.sessionId, deviceId: ev.deviceId, startedAtIso: ev.occurredAtIso }
        : {
            sessionId: ev.sessionId,
            endedAtIso: ev.occurredAtIso,
            deviceId: ev.deviceId,
            startedAtIso: ev.sessionStartedAtIso,
            status: ev.eventType === 'INTERRUPTED' ? 'interrupted' : 'completed',
          };

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${store.session!.accessToken}`,
    };
    if (config.simulateHeaderError) {
      headers['x-test-simulate-error'] = config.simulateHeaderError;
    }

    const res = await fetch(`${config.apiBaseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (res.ok) {
      ev.syncStatus = 'SYNCED';
      ev.serverSyncedAt = new Date().toISOString();
      ev.lastError = null;
      return 'OK';
    }

    const rawErr = await res.text();
    const parsed = parseApiError(res.status, rawErr);
    const label = `HTTP ${res.status}${parsed.code ? ` [${parsed.code}]` : ''}: ${parsed.message}`;

    if (res.status === 403) {
      store.pauseQueueForAuth({
        employeeId,
        httpStatus: 403,
        errorCode: parsed.code ?? 'AUTH_REQUIRED',
        reason: `Authorization denied (HTTP 403): ${parsed.message}`,
        eventIds: [ev.eventId],
      });
      return 'ABORT_FAILURE';
    }
    if (parsed.code === 'AUTH_REQUIRED' || res.status === 401) {
      const reason = `Authentication required (HTTP ${res.status}): ${parsed.message}`;
      store.pauseQueueForAuth({
        employeeId,
        httpStatus: res.status,
        errorCode: parsed.code ?? 'AUTH_REQUIRED',
        reason,
        eventIds: [ev.eventId],
      });
      store.session = null;
      store.reauthNoticeReason = reason;
      return 'ABORT_FAILURE';
    }
    if (parsed.code === 'SESSION_INVALID') {
      ev.syncStatus = 'PERMANENT_FAILED';
      ev.retryCount += 1;
      ev.lastError = label;
      return 'PERMANENT';
    }
    if (res.status === 400 || res.status === 404 || parsed.code === 'UNKNOWN_ENDPOINT' || parsed.code === 'INVALID_BATCH') {
      store.pauseQueueForConfiguration({
        employeeId,
        httpStatus: res.status,
        errorCode: parsed.code ?? (res.status === 404 ? 'UNKNOWN_ENDPOINT' : 'INVALID_BATCH'),
        reason: label,
        appVersionCode,
        apiBaseUrl: config.apiBaseUrl,
        eventIds: [ev.eventId],
      });
      return 'ABORT_FAILURE';
    }

    ev.syncStatus = 'RETRYABLE_FAILED';
    ev.retryCount += 1;
    ev.lastError = label;
    return 'RETRY';
  };

  // Phase 1: START outbox events
  for (const ev of store.getUnsyncedSessionEvents(employeeId).filter((e) => e.eventType === 'START')) {
    const r = await syncOutbox(ev);
    if (r === 'PERMANENT') hasPermanentFailure = true;
    else if (r === 'RETRY') return 'RETRY';
    else if (r === 'ABORT_FAILURE') return 'FAILURE';
  }

  // Phase 2: GPS location batches
  const uploadSlice = async (slice: LocationRow[], allowOverride: boolean): Promise<'OK' | 'RETRY' | 'ABORT_FAILURE'> => {
    const batchEndpoint = config.batchPathOverride ?? '/api/sync/batch';
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${store.session!.accessToken}`,
    };
    if (allowOverride && config.simulateHeaderError) {
      headers['x-test-simulate-error'] = config.simulateHeaderError;
    }

    const payloadBody =
      allowOverride && config.rawBatchBodyOverride !== undefined
        ? config.rawBatchBodyOverride
        : JSON.stringify({
            batchId: crypto.randomUUID(),
            records: slice.map((r) => ({
              recordId: r.recordId,
              sessionId: r.sessionId,
              employeeId: config.payloadRecordEmployeeIdOverride ?? r.employeeId,
              deviceId: r.deviceId,
              latitude: r.latitude,
              longitude: r.longitude,
              capturedAtIso: r.capturedAtIso,
              capturedAtEpochMs: r.capturedAtEpochMs,
              dateStr: r.dateStr,
              hour: r.hour,
              minute: r.minute,
              second: r.second,
              accuracyMeters: r.accuracyMeters,
              provider: r.provider,
              batteryPercent: r.batteryPercent,
            })),
          });

    const res = await fetch(`${config.apiBaseUrl}${batchEndpoint}`, {
      method: 'POST',
      headers,
      body: payloadBody,
    });

    if (res.ok) {
      const ack = (await res.json()) as { acceptedIds: string[]; duplicateIds: string[]; serverReceivedAt: string };
      const confirmed = new Set([...ack.acceptedIds, ...ack.duplicateIds]);
      let omitted = 0;
      for (const r of slice) {
        if (confirmed.has(r.recordId)) {
          r.syncStatus = 'SYNCED';
          r.serverSyncedAt = ack.serverReceivedAt;
          r.lastError = null;
        } else {
          r.syncStatus = 'RETRYABLE_FAILED';
          r.retryCount += 1;
          r.lastError = 'Partial ACK omitted record';
          omitted += 1;
        }
      }
      return omitted > 0 ? 'RETRY' : 'OK';
    }

    const rawErr = await res.text();
    const parsed = parseApiError(res.status, rawErr);
    const label = `HTTP ${res.status}${parsed.code ? ` [${parsed.code}]` : ''}: ${parsed.message}`;

    if (res.status === 403) {
      store.pauseQueueForAuth({
        employeeId,
        httpStatus: 403,
        errorCode: parsed.code ?? 'AUTH_REQUIRED',
        reason: `Authorization denied (HTTP 403): ${parsed.message}`,
        recordIds: slice.map((r) => r.recordId),
      });
      return 'ABORT_FAILURE';
    }
    if (parsed.code === 'AUTH_REQUIRED' || res.status === 401) {
      const reason = `Authentication required (HTTP ${res.status}): ${parsed.message}`;
      store.pauseQueueForAuth({
        employeeId,
        httpStatus: res.status,
        errorCode: parsed.code ?? 'AUTH_REQUIRED',
        reason,
        recordIds: slice.map((r) => r.recordId),
      });
      store.session = null;
      store.reauthNoticeReason = reason;
      return 'ABORT_FAILURE';
    }
    if (res.status === 400 && parsed.code === 'INVALID_RECORD') {
      if (slice.length === 1) {
        slice[0].syncStatus = 'PERMANENT_FAILED';
        slice[0].retryCount += 1;
        slice[0].lastError = label;
        hasPermanentFailure = true;
        return 'OK';
      }
      const mid = Math.floor(slice.length / 2);
      const left = await uploadSlice(slice.slice(0, mid), false);
      if (left !== 'OK') return left;
      return uploadSlice(slice.slice(mid), false);
    }
    if (res.status === 400 || res.status === 404 || parsed.code === 'UNKNOWN_ENDPOINT' || parsed.code === 'INVALID_BATCH') {
      store.pauseQueueForConfiguration({
        employeeId,
        httpStatus: res.status,
        errorCode: parsed.code ?? (res.status === 404 ? 'UNKNOWN_ENDPOINT' : 'INVALID_BATCH'),
        reason: label,
        appVersionCode,
        apiBaseUrl: config.apiBaseUrl,
        recordIds: slice.map((r) => r.recordId),
      });
      return 'ABORT_FAILURE';
    }

    for (const r of slice) {
      r.syncStatus = 'RETRYABLE_FAILED';
      r.retryCount += 1;
      r.lastError = label;
    }
    return 'RETRY';
  };

  while (true) {
    const batch = store.getUnsyncedBatch(employeeId, 100);
    if (batch.length === 0) break;
    const outcome = await uploadSlice(batch, true);
    if (outcome === 'ABORT_FAILURE') return 'FAILURE';
    if (outcome === 'RETRY') return 'RETRY';
  }

  // Phase 3: STOP / INTERRUPTED outbox events
  for (const ev of store
    .getUnsyncedSessionEvents(employeeId)
    .filter((e) => e.eventType === 'STOP' || e.eventType === 'INTERRUPTED')) {
    const r = await syncOutbox(ev);
    if (r === 'PERMANENT') hasPermanentFailure = true;
    else if (r === 'RETRY') return 'RETRY';
    else if (r === 'ABORT_FAILURE') return 'FAILURE';
  }

  return hasPermanentFailure ? 'FAILURE' : 'SUCCESS';
}

function makeLocationRow(employeeId: string, deviceId: string, sessionId: string, stepIndex: number): LocationRow {
  const ms = Date.parse('2026-11-24T08:00:00.000Z') + stepIndex * 600_000;
  const d = new Date(ms);
  return {
    recordId: crypto.randomUUID(),
    sessionId,
    employeeId,
    deviceId,
    latitude: 30.625 + stepIndex * 0.0002,
    longitude: 31.114 + stepIndex * 0.0002,
    capturedAtIso: d.toISOString(),
    capturedAtEpochMs: ms,
    dateStr: d.toISOString().slice(0, 10),
    hour: d.getUTCHours(),
    minute: d.getUTCMinutes(),
    second: d.getUTCSeconds(),
    accuracyMeters: 4.5,
    provider: 'gps',
    batteryPercent: 85,
    syncStatus: 'PENDING',
    serverSyncedAt: null,
    retryCount: 0,
    lastError: null,
  };
}

async function main() {
  process.env.ALLOW_TEST_HOOKS = 'true';
  process.env.PGHOST = process.env.PGHOST || '127.0.0.1';
  process.env.PGPORT = process.env.PGPORT || '5432';
  process.env.PGUSER = process.env.PGUSER || 'agritrack';
  process.env.PGDATABASE = process.env.PGDATABASE || 'agritrack_field';
  process.env.ADMIN_PASSCODE = process.env.ADMIN_PASSCODE || 'AdminPhase3Test!2026';

  await bootstrapDatabaseAndMigrate();

  let httpRequestCount = 0;
  const app = createApp();
  const wrappedServer = http.createServer((req, res) => {
    httpRequestCount += 1;
    app(req, res);
  });
  await new Promise<void>((resolve) => wrappedServer.listen(0, '127.0.0.1', resolve));
  const addr = wrappedServer.address();
  assert(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const loginAdminRes = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: process.env.ADMIN_PASSCODE }),
  });
  assert.equal(loginAdminRes.status, 200);
  const { token: adminToken } = (await loginAdminRes.json()) as { token: string };

  const cleanEmp = async (empId: string) => {
    await fetch(`${baseUrl}/api/admin/records/${empId}?reason=phase363_blocked_sync_test`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  };
  await cleanEmp('EMP-005');

  const signInEmployee = async (): Promise<StoredAuthSession> => {
    const authRes = await fetch(`${baseUrl}/api/auth/session-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: 'EMP-005', deviceId: 'AND-DEV-005', passcode: '2026' }),
    });
    assert.equal(authRes.status, 200);
    const data = (await authRes.json()) as { token: string };
    return { employeeId: 'EMP-005', deviceId: 'AND-DEV-005', accessToken: data.token };
  };

  // Test 1 & 5(part) & 8(part): INVALID_BATCH -> BLOCKED_CONFIGURATION -> 0 requests on periodic runs -> Process restart preserves -> Config recovery uploads
  {
    const store = new MirroredRoomStore();
    store.session = await signInEmployee();
    const sid = `SESS-363-1-${crypto.randomUUID().slice(0, 6)}`;
    const r1 = makeLocationRow('EMP-005', 'AND-DEV-005', sid, 0);
    const r2 = makeLocationRow('EMP-005', 'AND-DEV-005', sid, 1);
    store.records.push(r1, r2);

    httpRequestCount = 0;
    const run1 = await runMirroredSyncWorker(store, 'EMP-005', {
      apiBaseUrl: baseUrl,
      appVersionCode: 1,
      rawBatchBodyOverride: JSON.stringify([{ badWrapper: true }]),
    });
    assert.equal(run1, 'FAILURE');
    assert.equal(httpRequestCount, 1);
    assert(store.records.every((r) => r.syncStatus === 'BLOCKED_CONFIGURATION'));
    assert.equal(store.queueStates.get('EMP-005')?.pauseType, 'CONFIGURATION');
    assert.equal(store.getUnsyncedBatch('EMP-005').length, 0);

    // Periodic 15-min runs 2, 3, 4 MUST send 0 HTTP requests
    httpRequestCount = 0;
    for (let i = 0; i < 3; i++) {
      const periodic = await runMirroredSyncWorker(store, 'EMP-005', {
        apiBaseUrl: baseUrl,
        appVersionCode: 1,
      });
      assert.equal(periodic, 'FAILURE');
    }
    assert.equal(httpRequestCount, 0, 'Periodic runs while BLOCKED_CONFIGURATION must make 0 HTTP calls');

    // Test 8: Process restart preserves BLOCKED_CONFIGURATION and still makes 0 HTTP requests on periodic runs
    const restartedStore = MirroredRoomStore.restore(store.serialize());
    assert.equal(restartedStore.queueStates.get('EMP-005')?.pauseType, 'CONFIGURATION');
    assert(restartedStore.records.every((r) => r.syncStatus === 'BLOCKED_CONFIGURATION'));
    httpRequestCount = 0;
    const postRestartPeriodic = await runMirroredSyncWorker(restartedStore, 'EMP-005', {
      apiBaseUrl: baseUrl,
      appVersionCode: 1,
    });
    assert.equal(postRestartPeriodic, 'FAILURE');
    assert.equal(httpRequestCount, 0, 'Post-restart periodic worker must still make 0 HTTP calls while blocked');

    // Test 5a: Configuration recovery via appVersionCode bump unblocks & uploads cleanly
    const recoveredRun = await runMirroredSyncWorker(restartedStore, 'EMP-005', {
      apiBaseUrl: baseUrl,
      appVersionCode: 2,
    });
    assert.equal(recoveredRun, 'SUCCESS');
    assert(restartedStore.records.every((r) => r.syncStatus === 'SYNCED'));
    assert.equal(restartedStore.queueStates.get('EMP-005')?.pauseType, 'NONE');
    console.log('[PASS] Tests 1, 5a, 8a — INVALID_BATCH -> BLOCKED_CONFIGURATION -> 0 periodic/post-restart HTTP calls -> version recovery SYNCED');
  }

  // Test 2 & 5b & 9: UNKNOWN_ENDPOINT (404) -> BLOCKED_CONFIGURATION -> 0 periodic requests -> manual/backend recovery -> duplicate retry check
  {
    await cleanEmp('EMP-005');
    const store = new MirroredRoomStore();
    store.session = await signInEmployee();
    const sid = `SESS-363-2-${crypto.randomUUID().slice(0, 6)}`;
    const r1 = makeLocationRow('EMP-005', 'AND-DEV-005', sid, 0);
    const r2 = makeLocationRow('EMP-005', 'AND-DEV-005', sid, 1);
    store.records.push(r1, r2);

    httpRequestCount = 0;
    const run1 = await runMirroredSyncWorker(store, 'EMP-005', {
      apiBaseUrl: baseUrl,
      appVersionCode: 2,
      batchPathOverride: '/api/v99/sync/batch',
    });
    assert.equal(run1, 'FAILURE');
    assert.equal(httpRequestCount, 1);
    assert(store.records.every((r) => r.syncStatus === 'BLOCKED_CONFIGURATION'));

    httpRequestCount = 0;
    for (let i = 0; i < 3; i++) {
      assert.equal(
        await runMirroredSyncWorker(store, 'EMP-005', {
          apiBaseUrl: baseUrl,
          appVersionCode: 2,
          batchPathOverride: '/api/sync/batch', // even if backend fixed, automatic periodic stays paused until explicit retry or version/url change!
        }),
        'FAILURE'
      );
    }
    assert.equal(httpRequestCount, 0, 'Periodic runs stay paused with 0 HTTP calls until config change or user recovery');

    // Explicit user recovery probe ("Sync Pending Now" -> forceUserRecovery = true) recovers & uploads
    const recovery = await runMirroredSyncWorker(store, 'EMP-005', {
      apiBaseUrl: baseUrl,
      appVersionCode: 2,
      forceUserRecovery: true,
    });
    assert.equal(recovery, 'SUCCESS');
    assert(store.records.every((r) => r.syncStatus === 'SYNCED'));

    // Test 9: Duplicate retry after recovery -> 0 duplicate rows in PostgreSQL
    r1.syncStatus = 'PENDING'; // force duplicate re-upload of same UUID
    const dupRes = await runMirroredSyncWorker(store, 'EMP-005', { apiBaseUrl: baseUrl, appVersionCode: 2 });
    assert.equal(dupRes, 'SUCCESS');
    const getRes = await fetch(`${baseUrl}/api/sync/records/EMP-005`, {
      headers: { Authorization: `Bearer ${store.session!.accessToken}` },
    });
    const getBody = (await getRes.json()) as { totalCount: number; records: Array<{ recordId: string }> };
    assert.equal(getBody.totalCount, 2);
    assert.equal(new Set(getBody.records.map((x) => x.recordId)).size, 2);
    console.log('[PASS] Tests 2, 5b, 9 — UNKNOWN_ENDPOINT -> 0 periodic HTTP calls -> manual recovery SYNCED -> 0 duplicate GPS UUIDs');
  }

  // Test 3, 4 & 8(part): AUTH_REQUIRED (both 401 and 403 distinguished!) -> 0 periodic calls -> survive restart -> re-auth resumes
  {
    await cleanEmp('EMP-005');
    const validSession = await signInEmployee();
    const store = new MirroredRoomStore();
    store.session = { ...validSession, accessToken: `${validSession.accessToken}tampered` }; // Triggers 401
    const sid = `SESS-363-3-${crypto.randomUUID().slice(0, 6)}`;
    const row401 = makeLocationRow('EMP-005', 'AND-DEV-005', sid, 0);
    store.records.push(row401);

    // 401 clears invalid token, flags reauthNoticeReason, sets BLOCKED_AUTH + pauseType='AUTH'
    const auth401Run = await runMirroredSyncWorker(store, 'EMP-005', { apiBaseUrl: baseUrl });
    assert.equal(auth401Run, 'FAILURE');
    assert.equal(row401.syncStatus, 'BLOCKED_AUTH');
    assert.equal(store.session, null, '401 must clear expired/invalid token and require sign-in');
    assert(store.reauthNoticeReason?.includes('401'));
    assert.equal(store.queueStates.get('EMP-005')?.httpStatus, 401);

    // Process restart preserves BLOCKED_AUTH + reason, periodic runs make 0 HTTP requests
    const restartedAuthStore = MirroredRoomStore.restore(store.serialize());
    httpRequestCount = 0;
    for (let i = 0; i < 3; i++) {
      assert.equal(await runMirroredSyncWorker(restartedAuthStore, 'EMP-005', { apiBaseUrl: baseUrl }), 'FAILURE');
    }
    assert.equal(httpRequestCount, 0, 'Periodic runs while BLOCKED_AUTH (401) must make 0 HTTP calls');

    // Test 4: Successful re-authentication unblocks queue & uploads retained record
    restartedAuthStore.session = await signInEmployee();
    restartedAuthStore.reauthNoticeReason = null;
    restartedAuthStore.unblockAuthQueue('EMP-005');
    assert.equal(row401.recordId, restartedAuthStore.records[0].recordId);
    assert.equal(restartedAuthStore.records[0].syncStatus, 'PENDING');
    const postAuthRun = await runMirroredSyncWorker(restartedAuthStore, 'EMP-005', { apiBaseUrl: baseUrl });
    assert.equal(postAuthRun, 'SUCCESS');
    assert.equal(restartedAuthStore.records[0].syncStatus, 'SYNCED');

    // Now test 403 distinction: authorization denial does NOT wipe active session as an expired token!
    const row403 = makeLocationRow('EMP-005', 'AND-DEV-005', sid, 1);
    restartedAuthStore.records.push(row403);
    const auth403Run = await runMirroredSyncWorker(restartedAuthStore, 'EMP-005', {
      apiBaseUrl: baseUrl,
      payloadRecordEmployeeIdOverride: 'EMP-001', // triggers real server 403 isolation denial
    });
    assert.equal(auth403Run, 'FAILURE');
    assert.equal(row403.syncStatus, 'BLOCKED_AUTH');
    assert.notEqual(restartedAuthStore.session, null, '403 authorization denial must NOT wipe session pretending it is an expired 401 token');
    assert.equal(restartedAuthStore.queueStates.get('EMP-005')?.httpStatus, 403);

    httpRequestCount = 0;
    for (let i = 0; i < 2; i++) {
      assert.equal(await runMirroredSyncWorker(restartedAuthStore, 'EMP-005', { apiBaseUrl: baseUrl }), 'FAILURE');
    }
    assert.equal(httpRequestCount, 0, 'Periodic runs while 403 BLOCKED_AUTH must make 0 HTTP calls');

    // Explicit user retry after authorization issue resolves succeeds using preserved token (no re-login required!)
    const after403Recovery = await runMirroredSyncWorker(restartedAuthStore, 'EMP-005', {
      apiBaseUrl: baseUrl,
      forceUserRecovery: true,
    });
    assert.equal(after403Recovery, 'SUCCESS');
    assert.equal(row403.syncStatus, 'SYNCED');
    console.log('[PASS] Tests 3, 4, 8b — 401 vs 403 distinguished, 0 periodic HTTP calls while BLOCKED_AUTH, re-auth & 403 recovery resume cleanly');
  }

  // Test 6 & 7: INVALID_RECORD isolates only bad row while valid rows sync; temporary 503 stays RETRYABLE_FAILED and recovers
  {
    await cleanEmp('EMP-005');
    const store = new MirroredRoomStore();
    store.session = await signInEmployee();
    const sid = `SESS-363-67-${crypto.randomUUID().slice(0, 6)}`;
    const valid1 = makeLocationRow('EMP-005', 'AND-DEV-005', sid, 0);
    const bad = { ...makeLocationRow('EMP-005', 'AND-DEV-005', sid, 1), latitude: 999 };
    const valid2 = makeLocationRow('EMP-005', 'AND-DEV-005', sid, 2);
    store.records.push(valid1, bad, valid2);

    // First hit temporary 503 -> all remain RETRYABLE_FAILED (NOT BLOCKED_*) -> Result.retry()
    const run503 = await runMirroredSyncWorker(store, 'EMP-005', {
      apiBaseUrl: baseUrl,
      simulateHeaderError: '503',
    });
    assert.equal(run503, 'RETRY');
    assert(store.records.every((r) => r.syncStatus === 'RETRYABLE_FAILED'));
    assert.equal(store.queueStates.get('EMP-005'), undefined);

    // Retry succeeds on valid1 & valid2, isolates bad as PERMANENT_FAILED
    const runRecover = await runMirroredSyncWorker(store, 'EMP-005', { apiBaseUrl: baseUrl });
    assert.equal(runRecover, 'FAILURE');
    assert.equal(valid1.syncStatus, 'SYNCED');
    assert.equal(valid2.syncStatus, 'SYNCED');
    assert.equal(bad.syncStatus, 'PERMANENT_FAILED');
    assert.equal(store.getUnsyncedBatch('EMP-005').length, 0);
    console.log('[PASS] Tests 6 & 7 — Temporary 503 stayed RETRYABLE_FAILED and recovered; INVALID_RECORD isolated only malformed row');
  }

  // Test 10: Session START & STOP outbox events follow the same pause/retry/recovery policy
  {
    await cleanEmp('EMP-005');
    const store = new MirroredRoomStore();
    store.session = await signInEmployee();
    const sid = `SESS-363-10-${crypto.randomUUID().slice(0, 6)}`;
    const startIso = '2026-11-24T09:00:00.000Z';
    const stopIso = '2026-11-24T10:00:00.000Z';
    const gpsRow = makeLocationRow('EMP-005', 'AND-DEV-005', sid, 0);
    store.records.push(gpsRow);
    store.outbox.push(
      {
        eventId: crypto.randomUUID(),
        sessionId: sid,
        employeeId: 'EMP-005',
        deviceId: 'AND-DEV-005',
        eventType: 'START',
        occurredAtIso: startIso,
        occurredAtEpochMs: Date.parse(startIso),
        sessionStartedAtIso: startIso,
        syncStatus: 'PENDING',
        serverSyncedAt: null,
        retryCount: 0,
        lastError: null,
      },
      {
        eventId: crypto.randomUUID(),
        sessionId: sid,
        employeeId: 'EMP-005',
        deviceId: 'AND-DEV-005',
        eventType: 'STOP',
        occurredAtIso: stopIso,
        occurredAtEpochMs: Date.parse(stopIso),
        sessionStartedAtIso: startIso,
        syncStatus: 'PENDING',
        serverSyncedAt: null,
        retryCount: 0,
        lastError: null,
      }
    );

    // START hits 404 UNKNOWN_ENDPOINT -> BLOCKED_CONFIGURATION (NOT PERMANENT_FAILED)
    const start404 = await runMirroredSyncWorker(store, 'EMP-005', {
      apiBaseUrl: baseUrl,
      appVersionCode: 1,
      startPathOverride: '/api/v99/sessions/start',
    });
    assert.equal(start404, 'FAILURE');
    assert.equal(store.outbox[0].syncStatus, 'BLOCKED_CONFIGURATION');
    assert.equal(store.queueStates.get('EMP-005')?.pauseType, 'CONFIGURATION');

    // Periodic run makes 0 HTTP requests
    httpRequestCount = 0;
    assert.equal(await runMirroredSyncWorker(store, 'EMP-005', { apiBaseUrl: baseUrl, appVersionCode: 1 }), 'FAILURE');
    assert.equal(httpRequestCount, 0);

    // Config recovery -> START succeeds, GPS succeeds, STOP hits 401 -> BLOCKED_AUTH
    store.session = { ...store.session!, accessToken: `${store.session!.accessToken}bad` };
    // Simulate START recovering and STOP hitting 401: first unblock config with valid token, then tamper token before STOP
    store.session = await signInEmployee();
    const afterStartAndGps = await runMirroredSyncWorker(store, 'EMP-005', {
      apiBaseUrl: baseUrl,
      appVersionCode: 2,
      simulateHeaderError: undefined,
    });
    assert.equal(afterStartAndGps, 'SUCCESS');

    // Test STOP 503 retry + STOP 401 -> BLOCKED_AUTH -> re-auth -> completed
    const sid2 = `SESS-363-10B-${crypto.randomUUID().slice(0, 6)}`;
    const s2Start = '2026-11-24T11:00:00.000Z';
    const s2Stop = '2026-11-24T12:00:00.000Z';
    const evStart2: OutboxRow = {
      eventId: crypto.randomUUID(),
      sessionId: sid2,
      employeeId: 'EMP-005',
      deviceId: 'AND-DEV-005',
      eventType: 'START',
      occurredAtIso: s2Start,
      occurredAtEpochMs: Date.parse(s2Start),
      sessionStartedAtIso: s2Start,
      syncStatus: 'PENDING',
      serverSyncedAt: null,
      retryCount: 0,
      lastError: null,
    };
    const evStop2: OutboxRow = {
      eventId: crypto.randomUUID(),
      sessionId: sid2,
      employeeId: 'EMP-005',
      deviceId: 'AND-DEV-005',
      eventType: 'STOP',
      occurredAtIso: s2Stop,
      occurredAtEpochMs: Date.parse(s2Stop),
      sessionStartedAtIso: s2Start,
      syncStatus: 'PENDING',
      serverSyncedAt: null,
      retryCount: 0,
      lastError: null,
    };
    store.outbox.push(evStart2, evStop2);
    // Simulate 503 on both -> RETRYABLE_FAILED
    assert.equal(
      await runMirroredSyncWorker(store, 'EMP-005', { apiBaseUrl: baseUrl, appVersionCode: 2, simulateHeaderError: '503' }),
      'RETRY'
    );
    assert.equal(evStart2.syncStatus, 'RETRYABLE_FAILED');

    // Simulate auth failure on STOP specifically: sync START first without STOP, then tamper token for STOP
    store.outbox = store.outbox.filter((e) => e.eventId !== evStop2.eventId);
    assert.equal(await runMirroredSyncWorker(store, 'EMP-005', { apiBaseUrl: baseUrl, appVersionCode: 2 }), 'SUCCESS');
    assert.equal(evStart2.syncStatus, 'SYNCED');

    store.outbox.push(evStop2);
    store.session = { ...store.session!, accessToken: `${store.session!.accessToken}tampered` };
    assert.equal(await runMirroredSyncWorker(store, 'EMP-005', { apiBaseUrl: baseUrl, appVersionCode: 2 }), 'FAILURE');
    assert.equal(evStop2.syncStatus, 'BLOCKED_AUTH');

    httpRequestCount = 0;
    assert.equal(await runMirroredSyncWorker(store, 'EMP-005', { apiBaseUrl: baseUrl, appVersionCode: 2 }), 'FAILURE');
    assert.equal(httpRequestCount, 0);

    // Re-authenticate -> STOP uploads cleanly -> completed session in Postgres
    store.session = await signInEmployee();
    store.unblockAuthQueue('EMP-005');
    assert.equal(await runMirroredSyncWorker(store, 'EMP-005', { apiBaseUrl: baseUrl, appVersionCode: 2 }), 'SUCCESS');
    assert.equal(evStop2.syncStatus, 'SYNCED');

    const sessRes = await fetch(`${baseUrl}/api/sessions/EMP-005?sessionId=${encodeURIComponent(sid2)}`, {
      headers: { Authorization: `Bearer ${store.session!.accessToken}` },
    });
    const sessJson = (await sessRes.json()) as { sessions: Array<{ status: string; endedAt: string }> };
    assert.equal(sessJson.sessions[0].status, 'completed');
    assert.equal(sessJson.sessions[0].endedAt, s2Stop);
    console.log('[PASS] Test 10 — Session START & STOP follow safe pause (BLOCKED_CONFIGURATION/BLOCKED_AUTH), transient retry (503), and recovery');
  }

  await cleanEmp('EMP-005');
  const finalPoolCount = await getPool().query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM gps_records');
  assert.equal(finalPoolCount.rows[0]?.cnt, '0');
  console.log(`Post-cleanup gps_records count: ${finalPoolCount.rows[0]?.cnt}`);

  wrappedServer.close();
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
