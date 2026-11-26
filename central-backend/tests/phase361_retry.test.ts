import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { closePool, getPool } from '../src/db/pool.js';
import { bootstrapDatabaseAndMigrate, createApp } from '../server.js';

type SyncStatus = 'PENDING' | 'RETRYABLE_FAILED' | 'BLOCKED_AUTH' | 'BLOCKED_CONFIGURATION' | 'SYNCED' | 'PERMANENT_FAILED';

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

/**
 * In-memory faithful mirror of TrackingDao (Room v3) + SyncWorker.kt 4-state retry logic
 * exercising real HTTP calls against central-backend + PostgreSQL 15.
 */
class ClientMirrorStore {
  outbox: OutboxRow[] = [];
  records: LocationRow[] = [];
  bearerToken = '';
  refreshToken = '';
  reauthRequiredReason: string | null = null;

  getUnsyncedSessionEvents(employeeId: string): OutboxRow[] {
    return this.outbox
      .filter((e) => e.employeeId === employeeId && (e.syncStatus === 'PENDING' || e.syncStatus === 'RETRYABLE_FAILED'))
      .sort((a, b) => a.occurredAtEpochMs - b.occurredAtEpochMs);
  }

  getUnsyncedBatch(employeeId: string, batchSize = 100): LocationRow[] {
    return this.records
      .filter((r) => r.employeeId === employeeId && (r.syncStatus === 'PENDING' || r.syncStatus === 'RETRYABLE_FAILED'))
      .sort((a, b) => a.capturedAtEpochMs - b.capturedAtEpochMs)
      .slice(0, batchSize);
  }

  markSessionEventSynced(eventId: string, serverSyncedAt: string) {
    const row = this.outbox.find((e) => e.eventId === eventId);
    if (row) {
      row.syncStatus = 'SYNCED';
      row.serverSyncedAt = serverSyncedAt;
      row.lastError = null;
    }
  }

  markSessionEventRetryableFailed(eventId: string, error: string) {
    const row = this.outbox.find((e) => e.eventId === eventId && e.syncStatus !== 'SYNCED');
    if (row) {
      row.syncStatus = 'RETRYABLE_FAILED';
      row.retryCount += 1;
      row.lastError = error;
    }
  }

  markSessionEventPermanentFailed(eventId: string, error: string) {
    const row = this.outbox.find((e) => e.eventId === eventId && e.syncStatus !== 'SYNCED');
    if (row) {
      row.syncStatus = 'PERMANENT_FAILED';
      row.retryCount += 1;
      row.lastError = error;
    }
  }

  markBatchSynced(employeeId: string, confirmedIds: string[], serverReceivedAt: string) {
    const set = new Set(confirmedIds);
    for (const r of this.records) {
      if (r.employeeId === employeeId && set.has(r.recordId)) {
        r.syncStatus = 'SYNCED';
        r.serverSyncedAt = serverReceivedAt;
        r.lastError = null;
      }
    }
  }

  markBatchRetryableFailed(employeeId: string, failedIds: string[], error: string) {
    const set = new Set(failedIds);
    for (const r of this.records) {
      if (r.employeeId === employeeId && set.has(r.recordId) && r.syncStatus !== 'SYNCED') {
        r.syncStatus = 'RETRYABLE_FAILED';
        r.retryCount += 1;
        r.lastError = error;
      }
    }
  }

  markBatchPermanentFailed(employeeId: string, failedIds: string[], error: string) {
    const set = new Set(failedIds);
    for (const r of this.records) {
      if (r.employeeId === employeeId && set.has(r.recordId) && r.syncStatus !== 'SYNCED') {
        r.syncStatus = 'PERMANENT_FAILED';
        r.retryCount += 1;
        r.lastError = error;
      }
    }
  }

  markBatchBlocked(employeeId: string, failedIds: string[], status: 'BLOCKED_AUTH' | 'BLOCKED_CONFIGURATION', error: string) {
    const set = new Set(failedIds);
    for (const r of this.records) {
      if (r.employeeId === employeeId && set.has(r.recordId) && r.syncStatus !== 'SYNCED') {
        r.syncStatus = status;
        r.lastError = error;
      }
    }
  }

  markSessionEventBlocked(eventId: string, status: 'BLOCKED_AUTH' | 'BLOCKED_CONFIGURATION', error: string) {
    const row = this.outbox.find((e) => e.eventId === eventId && e.syncStatus !== 'SYNCED');
    if (row) {
      row.syncStatus = status;
      row.lastError = error;
    }
  }

  unblockQueue(employeeId: string, status: 'BLOCKED_AUTH' | 'BLOCKED_CONFIGURATION') {
    for (const e of this.outbox) {
      if (e.employeeId === employeeId && e.syncStatus === status) e.syncStatus = 'PENDING';
    }
    for (const r of this.records) {
      if (r.employeeId === employeeId && r.syncStatus === status) r.syncStatus = 'PENDING';
    }
  }
}

interface WorkerHookConfig {
  startSimulateError?: string;
  stopSimulateError?: string;
  batchSimulateError?: string;
  batchPartialAck?: number;
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

async function runMirroredSyncWorker(
  baseUrl: string,
  store: ClientMirrorStore,
  employeeId: string,
  hooks: WorkerHookConfig = {}
): Promise<'SUCCESS' | 'RETRY' | 'FAILURE'> {
  let hasPermanentFailure = false;

  const syncOutboxEvent = async (ev: OutboxRow): Promise<'OK' | 'PERMANENT' | 'RETRY' | 'AUTH_FAIL'> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${store.bearerToken}`,
    };
    if (ev.eventType === 'START' && hooks.startSimulateError) {
      headers['x-test-simulate-error'] = hooks.startSimulateError;
    }
    if (ev.eventType !== 'START' && hooks.stopSimulateError) {
      headers['x-test-simulate-error'] = hooks.stopSimulateError;
    }

    const endpoint = ev.eventType === 'START' ? '/api/sessions/start' : '/api/sessions/stop';
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

    const res = await fetch(`${baseUrl}${endpoint}`, {
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    if (res.ok) {
      store.markSessionEventSynced(ev.eventId, new Date().toISOString());
      return 'OK';
    }

    const errText = await res.text();
    const parsed = parseApiError(res.status, errText);
    const label = `HTTP ${res.status}${parsed.code ? ` [${parsed.code}]` : ''}: ${parsed.message}`;
    if (parsed.code === 'AUTH_REQUIRED' || res.status === 401 || res.status === 403) {
      store.markSessionEventBlocked(ev.eventId, 'BLOCKED_AUTH', label);
      store.reauthRequiredReason = `Authorization rejected (${res.status})`;
      return 'AUTH_FAIL';
    }
    if (parsed.code === 'SESSION_INVALID') {
      store.markSessionEventPermanentFailed(ev.eventId, label);
      return 'PERMANENT';
    }
    if (res.status === 400 || res.status === 404 || parsed.code === 'UNKNOWN_ENDPOINT' || parsed.code === 'INVALID_BATCH') {
      store.markSessionEventBlocked(ev.eventId, 'BLOCKED_CONFIGURATION', label);
      return 'AUTH_FAIL';
    }
    store.markSessionEventRetryableFailed(ev.eventId, label);
    return 'RETRY';
  };

  // Phase 1: START outbox events
  const startEvents = store.getUnsyncedSessionEvents(employeeId).filter((e) => e.eventType === 'START');
  for (const ev of startEvents) {
    const r = await syncOutboxEvent(ev);
    if (r === 'PERMANENT') hasPermanentFailure = true;
    else if (r === 'RETRY') return 'RETRY';
    else if (r === 'AUTH_FAIL') return 'FAILURE';
  }

  // Phase 2: GPS batches with bisection on HTTP 400
  const uploadSlice = async (slice: LocationRow[], allowTestHooks: boolean): Promise<'OK' | 'RETRY' | 'AUTH_FAIL'> => {
    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${store.bearerToken}`,
    };
    if (allowTestHooks && hooks.batchSimulateError) {
      headers['x-test-simulate-error'] = hooks.batchSimulateError;
    }
    if (allowTestHooks && hooks.batchPartialAck !== undefined) {
      headers['x-test-partial-ack'] = String(hooks.batchPartialAck);
    }

    const res = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers,
      body: JSON.stringify({
        batchId: crypto.randomUUID(),
        records: slice.map((r) => ({
          recordId: r.recordId,
          sessionId: r.sessionId,
          employeeId: r.employeeId,
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
      }),
    });

    if (res.ok) {
      const ack = (await res.json()) as {
        acceptedIds: string[];
        duplicateIds: string[];
        serverReceivedAt: string;
      };
      const confirmed = Array.from(new Set([...ack.acceptedIds, ...ack.duplicateIds]));
      if (confirmed.length > 0) {
        store.markBatchSynced(employeeId, confirmed, ack.serverReceivedAt);
      }
      const confirmedSet = new Set(confirmed);
      const omittedIds = slice.map((s) => s.recordId).filter((id) => !confirmedSet.has(id));
      if (omittedIds.length > 0) {
        store.markBatchRetryableFailed(
          employeeId,
          omittedIds,
          `Partial ACK: ${omittedIds.length}/${slice.length} omitted`
        );
        return 'RETRY';
      }
      return 'OK';
    }

    const errText = await res.text();
    const parsed = parseApiError(res.status, errText);
    const label = `HTTP ${res.status}${parsed.code ? ` [${parsed.code}]` : ''}: ${parsed.message}`;
    if (parsed.code === 'AUTH_REQUIRED' || res.status === 401 || res.status === 403) {
      store.markBatchBlocked(
        employeeId,
        slice.map((s) => s.recordId),
        'BLOCKED_AUTH',
        label
      );
      store.reauthRequiredReason = `Authorization rejected (${res.status})`;
      return 'AUTH_FAIL';
    }
    if (res.status === 400 && parsed.code === 'INVALID_RECORD') {
      if (slice.length === 1) {
        store.markBatchPermanentFailed(employeeId, [slice[0].recordId], label);
        hasPermanentFailure = true;
        return 'OK';
      }
      const mid = Math.floor(slice.length / 2);
      const left = await uploadSlice(slice.slice(0, mid), false);
      if (left !== 'OK') return left;
      return uploadSlice(slice.slice(mid), false);
    }
    if (res.status === 400 || res.status === 404 || parsed.code === 'UNKNOWN_ENDPOINT' || parsed.code === 'INVALID_BATCH') {
      store.markBatchBlocked(
        employeeId,
        slice.map((s) => s.recordId),
        'BLOCKED_CONFIGURATION',
        label
      );
      return 'AUTH_FAIL';
    }
    store.markBatchRetryableFailed(
      employeeId,
      slice.map((s) => s.recordId),
      label
    );
    return 'RETRY';
  };

  while (true) {
    const batch = store.getUnsyncedBatch(employeeId, 100);
    if (batch.length === 0) break;
    const outcome = await uploadSlice(batch, true);
    if (outcome === 'AUTH_FAIL') return 'FAILURE';
    if (outcome === 'RETRY') return 'RETRY';
  }

  // Phase 3: STOP / INTERRUPTED outbox events
  const closeEvents = store
    .getUnsyncedSessionEvents(employeeId)
    .filter((e) => e.eventType === 'STOP' || e.eventType === 'INTERRUPTED');
  for (const ev of closeEvents) {
    const r = await syncOutboxEvent(ev);
    if (r === 'PERMANENT') hasPermanentFailure = true;
    else if (r === 'RETRY') return 'RETRY';
    else if (r === 'AUTH_FAIL') return 'FAILURE';
  }

  return hasPermanentFailure ? 'FAILURE' : 'SUCCESS';
}

function makeLocationRow(employeeId: string, deviceId: string, sessionId: string, stepIndex: number): LocationRow {
  const ms = Date.parse('2026-11-23T08:00:00.000Z') + stepIndex * 600_000;
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
    batteryPercent: 90,
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

  const app = createApp();
  const server = http.createServer(app);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const addr = server.address();
  assert(addr && typeof addr === 'object');
  const baseUrl = `http://127.0.0.1:${addr.port}`;

  const adminLoginRes = await fetch(`${baseUrl}/api/admin/auth/login`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ passcode: process.env.ADMIN_PASSCODE }),
  });
  assert.equal(adminLoginRes.status, 200);
  const { token: adminToken } = (await adminLoginRes.json()) as { token: string };

  const cleanEmp = async (empId: string) => {
    await fetch(`${baseUrl}/api/admin/records/${empId}?reason=phase361_retry_test`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  };

  await cleanEmp('EMP-003');

  const authRes = await fetch(`${baseUrl}/api/auth/session-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: 'EMP-003', deviceId: 'AND-DEV-003', passcode: '2026' }),
  });
  assert.equal(authRes.status, 200);
  const authData = (await authRes.json()) as { token: string; refreshToken: string };

  // Scenario A: START temporary 503 error -> remains eligible (RETRYABLE_FAILED) -> retry succeeds -> 1 session
  {
    const store = new ClientMirrorStore();
    store.bearerToken = authData.token;
    store.refreshToken = authData.refreshToken;
    const sid = `SESS-361-A-${crypto.randomUUID().slice(0, 8)}`;
    const startIso = '2026-11-23T07:00:00.000Z';
    store.outbox.push({
      eventId: crypto.randomUUID(),
      sessionId: sid,
      employeeId: 'EMP-003',
      deviceId: 'AND-DEV-003',
      eventType: 'START',
      occurredAtIso: startIso,
      occurredAtEpochMs: Date.parse(startIso),
      sessionStartedAtIso: startIso,
      syncStatus: 'PENDING',
      serverSyncedAt: null,
      retryCount: 0,
      lastError: null,
    });

    const first = await runMirroredSyncWorker(baseUrl, store, 'EMP-003', { startSimulateError: '503' });
    assert.equal(first, 'RETRY');
    assert.equal(store.outbox[0].syncStatus, 'RETRYABLE_FAILED');
    assert.equal(store.getUnsyncedSessionEvents('EMP-003').length, 1, 'RETRYABLE_FAILED START must remain eligible');

    const second = await runMirroredSyncWorker(baseUrl, store, 'EMP-003');
    assert.equal(second, 'SUCCESS');
    assert.equal(store.outbox[0].syncStatus, 'SYNCED');

    const sessRes = await fetch(`${baseUrl}/api/sessions/EMP-003?sessionId=${encodeURIComponent(sid)}`, {
      headers: { Authorization: `Bearer ${store.bearerToken}` },
    });
    const sessBody = (await sessRes.json()) as { count: number; sessions: Array<{ sessionId: string; status: string }> };
    assert.equal(sessBody.count, 1);
    assert.equal(sessBody.sessions[0].status, 'active');
    console.log(`[PASS] Scenario A — START 503 -> RETRYABLE_FAILED -> retry SUCCESS -> 1 active session (${sid})`);
  }

  // Scenario B: STOP temporary 503 error -> remains eligible -> retry succeeds -> COMPLETED session
  {
    const store = new ClientMirrorStore();
    store.bearerToken = authData.token;
    const sid = `SESS-361-B-${crypto.randomUUID().slice(0, 8)}`;
    const startIso = '2026-11-23T08:00:00.000Z';
    const stopIso = '2026-11-23T09:00:00.000Z';
    store.outbox.push(
      {
        eventId: crypto.randomUUID(),
        sessionId: sid,
        employeeId: 'EMP-003',
        deviceId: 'AND-DEV-003',
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
        employeeId: 'EMP-003',
        deviceId: 'AND-DEV-003',
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

    const first = await runMirroredSyncWorker(baseUrl, store, 'EMP-003', { stopSimulateError: '503' });
    assert.equal(first, 'RETRY');
    assert.equal(store.outbox[0].syncStatus, 'SYNCED');
    assert.equal(store.outbox[1].syncStatus, 'RETRYABLE_FAILED');
    assert.equal(store.getUnsyncedSessionEvents('EMP-003').length, 1, 'RETRYABLE_FAILED STOP must remain eligible');

    const second = await runMirroredSyncWorker(baseUrl, store, 'EMP-003');
    assert.equal(second, 'SUCCESS');
    assert.equal(store.outbox[1].syncStatus, 'SYNCED');

    const sessRes = await fetch(`${baseUrl}/api/sessions/EMP-003?sessionId=${encodeURIComponent(sid)}`, {
      headers: { Authorization: `Bearer ${store.bearerToken}` },
    });
    const sessBody = (await sessRes.json()) as {
      sessions: Array<{ status: string; startedAt: string; endedAt: string }>;
    };
    assert.equal(sessBody.sessions[0].status, 'completed');
    assert.equal(sessBody.sessions[0].endedAt, stopIso);
    console.log(`[PASS] Scenario B — STOP 503 -> RETRYABLE_FAILED -> retry SUCCESS -> completed session (${sid})`);
  }

  // Scenario C: Partial GPS batch ack (10 sent, 7 acked) -> 3 RETRYABLE_FAILED -> retry -> 10 in Postgres, 0 dupes
  {
    await cleanEmp('EMP-003');
    const store = new ClientMirrorStore();
    store.bearerToken = authData.token;
    const sid = `SESS-361-C-${crypto.randomUUID().slice(0, 8)}`;
    for (let i = 0; i < 10; i++) {
      store.records.push(makeLocationRow('EMP-003', 'AND-DEV-003', sid, i));
    }

    const first = await runMirroredSyncWorker(baseUrl, store, 'EMP-003', { batchPartialAck: 7 });
    assert.equal(first, 'RETRY');
    assert.equal(store.records.filter((r) => r.syncStatus === 'SYNCED').length, 7);
    assert.equal(store.records.filter((r) => r.syncStatus === 'RETRYABLE_FAILED').length, 3);
    assert.equal(store.getUnsyncedBatch('EMP-003').length, 3);

    const second = await runMirroredSyncWorker(baseUrl, store, 'EMP-003');
    assert.equal(second, 'SUCCESS');
    assert.equal(store.records.filter((r) => r.syncStatus === 'SYNCED').length, 10);
    assert.equal(store.getUnsyncedBatch('EMP-003').length, 0);

    const getRes = await fetch(`${baseUrl}/api/sync/records/EMP-003`, {
      headers: { Authorization: `Bearer ${store.bearerToken}` },
    });
    const getBody = (await getRes.json()) as { totalCount: number; records: Array<{ recordId: string }> };
    assert.equal(getBody.totalCount, 10);
    assert.equal(new Set(getBody.records.map((r) => r.recordId)).size, 10);
    console.log('[PASS] Scenario C — Partial batch ACK (7/10) -> 3 RETRYABLE_FAILED -> retry uploaded 3 -> 10 unique rows in PostgreSQL');
  }

  // Scenario D: Process interruption after temporary failure + serialized local store resume -> nothing stranded
  {
    await cleanEmp('EMP-003');
    const storeBeforeKill = new ClientMirrorStore();
    storeBeforeKill.bearerToken = authData.token;
    const sid = `SESS-361-D-${crypto.randomUUID().slice(0, 8)}`;
    const startIso = '2026-11-23T10:00:00.000Z';
    const stopIso = '2026-11-23T10:30:00.000Z';

    storeBeforeKill.outbox.push(
      {
        eventId: crypto.randomUUID(),
        sessionId: sid,
        employeeId: 'EMP-003',
        deviceId: 'AND-DEV-003',
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
        employeeId: 'EMP-003',
        deviceId: 'AND-DEV-003',
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
    for (let i = 0; i < 4; i++) {
      storeBeforeKill.records.push(makeLocationRow('EMP-003', 'AND-DEV-003', sid, i));
    }

    // Batch upload fails with 503 after START succeeded; then process dies (serialize/rehydrate DB)
    const preCrashResult = await runMirroredSyncWorker(baseUrl, storeBeforeKill, 'EMP-003', {
      batchSimulateError: '503',
    });
    assert.equal(preCrashResult, 'RETRY');
    const serializedDb = JSON.stringify({
      outbox: storeBeforeKill.outbox,
      records: storeBeforeKill.records,
      bearerToken: storeBeforeKill.bearerToken,
    });

    // Simulate brand-new app/WorkManager process restoring persisted SQLite state
    const snapshot = JSON.parse(serializedDb) as {
      outbox: OutboxRow[];
      records: LocationRow[];
      bearerToken: string;
    };
    const storeAfterRestart = new ClientMirrorStore();
    storeAfterRestart.outbox = snapshot.outbox;
    storeAfterRestart.records = snapshot.records;
    storeAfterRestart.bearerToken = snapshot.bearerToken;

    const postRestartResult = await runMirroredSyncWorker(baseUrl, storeAfterRestart, 'EMP-003');
    assert.equal(postRestartResult, 'SUCCESS');
    assert.equal(storeAfterRestart.getUnsyncedSessionEvents('EMP-003').length, 0);
    assert.equal(storeAfterRestart.getUnsyncedBatch('EMP-003').length, 0);

    const getRes = await fetch(`${baseUrl}/api/sync/records/EMP-003`, {
      headers: { Authorization: `Bearer ${storeAfterRestart.bearerToken}` },
    });
    const getBody = (await getRes.json()) as { totalCount: number };
    assert.equal(getBody.totalCount, 4);

    const sessRes = await fetch(`${baseUrl}/api/sessions/EMP-003?sessionId=${encodeURIComponent(sid)}`, {
      headers: { Authorization: `Bearer ${storeAfterRestart.bearerToken}` },
    });
    const sessBody = (await sessRes.json()) as { sessions: Array<{ status: string }> };
    assert.equal(sessBody.sessions[0].status, 'completed');
    console.log('[PASS] Scenario D — Process crash/restart recovery -> 0 stranded outbox/GPS rows, session COMPLETED');
  }

  // Scenario E: Permanent errors (HTTP 400 malformed record + HTTP 401/403 auth rejection)
  {
    await cleanEmp('EMP-003');
    const store = new ClientMirrorStore();
    store.bearerToken = authData.token;
    const sid = `SESS-361-E-${crypto.randomUUID().slice(0, 8)}`;

    const good1 = makeLocationRow('EMP-003', 'AND-DEV-003', sid, 0);
    const malformed = { ...makeLocationRow('EMP-003', 'AND-DEV-003', sid, 1), latitude: 999.0 }; // HTTP 400
    const good2 = makeLocationRow('EMP-003', 'AND-DEV-003', sid, 2);
    store.records.push(good1, malformed, good2);

    // 1) Mixed batch with HTTP 400: bisection isolates malformed row to PERMANENT_FAILED, syncs good1 & good2
    const first = await runMirroredSyncWorker(baseUrl, store, 'EMP-003');
    assert.equal(first, 'FAILURE');
    assert.equal(good1.syncStatus, 'SYNCED');
    assert.equal(good2.syncStatus, 'SYNCED');
    assert.equal(malformed.syncStatus, 'PERMANENT_FAILED');
    assert(malformed.lastError?.includes('HTTP 400'), 'Clear HTTP 400 error reason exposed on local record');
    assert.equal(store.records.length, 3, 'PERMANENT_FAILED record must NEVER be deleted');
    assert.equal(store.getUnsyncedBatch('EMP-003').length, 0, 'PERMANENT_FAILED must NOT be reselected for retries');

    // Subsequent sync run must finish cleanly with 0 retry attempts against bad row
    const second = await runMirroredSyncWorker(baseUrl, store, 'EMP-003');
    assert.equal(second, 'SUCCESS');

    // 2) Auth error (401 tampered token): moves valid queued item into BLOCKED_AUTH (NOT PERMANENT_FAILED)
    //    and halts background spinning via FAILURE until user re-authenticates
    const authBlockedRow = makeLocationRow('EMP-003', 'AND-DEV-003', sid, 3);
    store.records.push(authBlockedRow);
    store.bearerToken = `${authData.token}tampered`;
    const authFailRun = await runMirroredSyncWorker(baseUrl, store, 'EMP-003');
    assert.equal(authFailRun, 'FAILURE');
    assert.equal(authBlockedRow.syncStatus, 'BLOCKED_AUTH');
    assert(store.reauthRequiredReason?.includes('401'));

    // After re-login, unblockQueue moves BLOCKED_AUTH -> PENDING and row uploads cleanly
    store.bearerToken = authData.token;
    store.reauthRequiredReason = null;
    store.unblockQueue('EMP-003', 'BLOCKED_AUTH');
    const postReauthRun = await runMirroredSyncWorker(baseUrl, store, 'EMP-003');
    assert.equal(postReauthRun, 'SUCCESS');
    assert.equal(authBlockedRow.syncStatus, 'SYNCED');

    const getRes = await fetch(`${baseUrl}/api/sync/records/EMP-003`, {
      headers: { Authorization: `Bearer ${store.bearerToken}` },
    });
    const getBody = (await getRes.json()) as { totalCount: number };
    assert.equal(getBody.totalCount, 3); // good1, good2, authBlockedRow
    console.log('[PASS] Scenario E — HTTP 400 INVALID_RECORD quarantined as PERMANENT_FAILED; 401 paused as BLOCKED_AUTH and resumed after re-auth');
  }

  await cleanEmp('EMP-003');
  const finalPoolCount = await getPool().query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM gps_records');
  assert.equal(finalPoolCount.rows[0]?.cnt, '0');
  console.log(`Post-cleanup gps_records count: ${finalPoolCount.rows[0]?.cnt}`);

  server.close();
  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
