import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import http from 'node:http';
import { closePool, getPool } from '../src/db/pool.js';
import { areTestHooksEnabled, bootstrapDatabaseAndMigrate, createApp } from '../server.js';

function parseApiErrorBody(bodyText: string): { code?: string; message: string } {
  const trimmed = bodyText.trim();
  if (trimmed.startsWith('{')) {
    try {
      const parsed = JSON.parse(trimmed) as { code?: unknown; error?: unknown };
      const code =
        typeof parsed.code === 'string' && parsed.code.trim().length > 0
          ? parsed.code.trim().toUpperCase()
          : undefined;
      const message =
        typeof parsed.error === 'string' && parsed.error.trim().length > 0
          ? parsed.error.trim()
          : trimmed;
      return { code, message };
    } catch {
      // Fallback to raw text
    }
  }
  return { message: trimmed || 'Request failed' };
}

function classifyOutboxErrorStatus(status: number, code?: string): SyncStatus {
  if (code === 'AUTH_REQUIRED' || status === 401 || status === 403) return 'RETRYABLE_FAILED';
  if (code === 'SESSION_INVALID') return 'PERMANENT_FAILED';
  if (status === 404 || code === 'UNKNOWN_ENDPOINT') return 'RETRYABLE_FAILED';
  return 'RETRYABLE_FAILED';
}

type SyncStatus = 'PENDING' | 'RETRYABLE_FAILED' | 'SYNCED' | 'PERMANENT_FAILED';

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
  retryCount: number;
  lastError: string | null;
}

interface OutboxRow {
  eventId: string;
  sessionId: string;
  employeeId: string;
  deviceId: string;
  eventType: 'START' | 'STOP';
  occurredAtIso: string;
  syncStatus: SyncStatus;
  retryCount: number;
  lastError: string | null;
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
    accuracyMeters: 5.0,
    provider: 'gps',
    batteryPercent: 88,
    syncStatus: 'PENDING',
    retryCount: 0,
    lastError: null,
  };
}

/**
 * Mirrors SyncWorker.kt uploadLocationSlice + parseApiError rules exactly,
 * counting HTTP POST calls to prove binary bisection runs ONLY on INVALID_RECORD.
 */
async function executeClassifiedBatchSlice(params: {
  url: string;
  token: string;
  slice: LocationRow[];
  rawBodyOverride?: string;
  counters: { postCalls: number };
  onReauthRequired: (reason: string) => void;
}): Promise<'SUCCESS' | 'RETRY' | 'FAILURE' | 'ISOLATED_PERMANENT'> {
  const { url, token, slice, rawBodyOverride, counters, onReauthRequired } = params;
  counters.postCalls += 1;

  const bodyStr =
    rawBodyOverride ??
    JSON.stringify({
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
    });

  const res = await fetch(url, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${token}`,
    },
    body: bodyStr,
  });

  if (res.ok) {
    const ack = (await res.json()) as { acceptedIds: string[]; duplicateIds: string[] };
    const confirmed = new Set([...ack.acceptedIds, ...ack.duplicateIds]);
    for (const r of slice) {
      if (confirmed.has(r.recordId)) {
        r.syncStatus = 'SYNCED';
        r.lastError = null;
      } else {
        r.syncStatus = 'RETRYABLE_FAILED';
        r.retryCount += 1;
        r.lastError = 'Partial ACK';
      }
    }
    return slice.every((r) => r.syncStatus === 'SYNCED') ? 'SUCCESS' : 'RETRY';
  }

  const rawText = await res.text();
  const parsed = parseApiErrorBody(rawText);
  const label = `HTTP ${res.status}${parsed.code ? ` [${parsed.code}]` : ''}: ${parsed.message}`;

  if (parsed.code === 'AUTH_REQUIRED' || res.status === 401 || res.status === 403) {
    for (const r of slice) {
      r.syncStatus = 'RETRYABLE_FAILED';
      r.retryCount += 1;
      r.lastError = label;
    }
    onReauthRequired(label);
    return 'FAILURE';
  }

  if (res.status === 400 && parsed.code === 'INVALID_RECORD') {
    if (slice.length === 1) {
      slice[0].syncStatus = 'PERMANENT_FAILED';
      slice[0].retryCount += 1;
      slice[0].lastError = label;
      return 'ISOLATED_PERMANENT';
    }
    const mid = Math.floor(slice.length / 2);
    const left = await executeClassifiedBatchSlice({
      url,
      token,
      slice: slice.slice(0, mid),
      counters,
      onReauthRequired,
    });
    if (left === 'RETRY' || left === 'FAILURE') return left;
    const right = await executeClassifiedBatchSlice({
      url,
      token,
      slice: slice.slice(mid),
      counters,
      onReauthRequired,
    });
    if (right === 'RETRY' || right === 'FAILURE') return right;
    return left === 'ISOLATED_PERMANENT' || right === 'ISOLATED_PERMANENT'
      ? 'ISOLATED_PERMANENT'
      : 'SUCCESS';
  }

  if (res.status === 400) {
    // INVALID_BATCH or non-record contract error: NO bisection, preserve records as RETRYABLE_FAILED
    for (const r of slice) {
      r.syncStatus = 'RETRYABLE_FAILED';
      r.retryCount += 1;
      r.lastError = label;
    }
    return 'FAILURE';
  }

  if (res.status === 404 || parsed.code === 'UNKNOWN_ENDPOINT') {
    for (const r of slice) {
      r.syncStatus = 'RETRYABLE_FAILED';
      r.retryCount += 1;
      r.lastError = `UNKNOWN_ENDPOINT (HTTP ${res.status}): ${parsed.message}`;
    }
    return 'RETRY';
  }

  for (const r of slice) {
    r.syncStatus = 'RETRYABLE_FAILED';
    r.retryCount += 1;
    r.lastError = label;
  }
  return 'RETRY';
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
    await fetch(`${baseUrl}/api/admin/records/${empId}?reason=phase362_classification_safety_test`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
  };
  await cleanEmp('EMP-004');

  const authRes = await fetch(`${baseUrl}/api/auth/session-token`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ employeeId: 'EMP-004', deviceId: 'AND-DEV-004', passcode: '2026' }),
  });
  assert.equal(authRes.status, 200);
  const { token: empToken } = (await authRes.json()) as { token: string };

  // 1. Explicit backend error codes verification
  {
    const unknownRes = await fetch(`${baseUrl}/api/v99/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empToken}` },
      body: JSON.stringify({ batchId: 'b1', records: [] }),
    });
    assert.equal(unknownRes.status, 404);
    const unknownJson = (await unknownRes.json()) as { code: string };
    assert.equal(unknownJson.code, 'UNKNOWN_ENDPOINT');

    const invalidBatchRes = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empToken}` },
      body: JSON.stringify({ batchId: 'b2', records: [] }),
    });
    assert.equal(invalidBatchRes.status, 400);
    const invalidBatchJson = (await invalidBatchRes.json()) as { code: string };
    assert.equal(invalidBatchJson.code, 'INVALID_BATCH');

    const malformedJsonRes = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empToken}` },
      body: '{"batchId": "bad-json", "records": [',
    });
    assert.equal(malformedJsonRes.status, 400);
    const malformedJsonBody = (await malformedJsonRes.json()) as { code: string };
    assert.equal(malformedJsonBody.code, 'INVALID_BATCH');

    const invalidRecordRow = { ...makeLocationRow('EMP-004', 'AND-DEV-004', 'SESS-362-CODE', 0), latitude: 999 };
    const invalidRecordRes = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empToken}` },
      body: JSON.stringify({ batchId: 'b3', records: [invalidRecordRow] }),
    });
    assert.equal(invalidRecordRes.status, 400);
    const invalidRecordJson = (await invalidRecordRes.json()) as { code: string; recordId: string };
    assert.equal(invalidRecordJson.code, 'INVALID_RECORD');
    assert.equal(invalidRecordJson.recordId, invalidRecordRow.recordId);

    const sessionInvalidRes = await fetch(`${baseUrl}/api/sessions/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empToken}` },
      body: JSON.stringify({ sessionId: 'SESS-DOES-NOT-EXIST' }),
    });
    assert.equal(sessionInvalidRes.status, 404);
    const sessionInvalidJson = (await sessionInvalidRes.json()) as { code: string };
    assert.equal(sessionInvalidJson.code, 'SESSION_INVALID');

    const authReqRes = await fetch(`${baseUrl}/api/sync/records/EMP-004`);
    assert.equal(authReqRes.status, 401);
    const authReqJson = (await authReqRes.json()) as { code: string };
    assert.equal(authReqJson.code, 'AUTH_REQUIRED');

    console.log('[PASS] 1. Explicit error codes verified: UNKNOWN_ENDPOINT, INVALID_BATCH, INVALID_RECORD, SESSION_INVALID, AUTH_REQUIRED');
  }

  // 2. Binary bisection runs ONLY on INVALID_RECORD (and isolates bad record while syncing good siblings)
  {
    await cleanEmp('EMP-004');
    const sid = `SESS-362-REC-${crypto.randomUUID().slice(0, 8)}`;
    const goodA = makeLocationRow('EMP-004', 'AND-DEV-004', sid, 0);
    const bad = { ...makeLocationRow('EMP-004', 'AND-DEV-004', sid, 1), longitude: -999 };
    const goodB = makeLocationRow('EMP-004', 'AND-DEV-004', sid, 2);
    const counters = { postCalls: 0 };

    const outcome = await executeClassifiedBatchSlice({
      url: `${baseUrl}/api/sync/batch`,
      token: empToken,
      slice: [goodA, bad, goodB],
      counters,
      onReauthRequired: () => assert.fail('Unexpected reauth'),
    });
    assert.equal(outcome, 'ISOLATED_PERMANENT');
    assert(counters.postCalls > 1, 'Expected binary bisection on INVALID_RECORD');
    assert.equal(goodA.syncStatus, 'SYNCED');
    assert.equal(goodB.syncStatus, 'SYNCED');
    assert.equal(bad.syncStatus, 'PERMANENT_FAILED');
    assert(bad.lastError?.includes('INVALID_RECORD'));
    console.log(`[PASS] 2. INVALID_RECORD triggers bisection (${counters.postCalls} POST calls); bad row isolated as PERMANENT_FAILED, 2 valid rows SYNCED`);
  }

  // 3. INVALID_BATCH (400 without INVALID_RECORD) MUST NOT bisect or mark records PERMANENT_FAILED
  {
    const sid = `SESS-362-BATCH-${crypto.randomUUID().slice(0, 8)}`;
    const validRows = [
      makeLocationRow('EMP-004', 'AND-DEV-004', sid, 0),
      makeLocationRow('EMP-004', 'AND-DEV-004', sid, 1),
      makeLocationRow('EMP-004', 'AND-DEV-004', sid, 2),
      makeLocationRow('EMP-004', 'AND-DEV-004', sid, 3),
    ];
    const counters = { postCalls: 0 };

    // Raw payload simulates an invalid batch wrapper (array instead of object wrapper) -> HTTP 400 INVALID_BATCH
    const outcome = await executeClassifiedBatchSlice({
      url: `${baseUrl}/api/sync/batch`,
      token: empToken,
      slice: validRows,
      rawBodyOverride: JSON.stringify([{ unexpected: 'array_wrapper' }]),
      counters,
      onReauthRequired: () => assert.fail('Unexpected reauth'),
    });
    assert.equal(outcome, 'FAILURE');
    assert.equal(counters.postCalls, 1, 'INVALID_BATCH must NEVER trigger binary bisection');
    assert(validRows.every((r) => r.syncStatus === 'RETRYABLE_FAILED'), 'All valid records must remain RETRYABLE_FAILED');
    assert(validRows.every((r) => r.lastError?.includes('INVALID_BATCH')));
    console.log('[PASS] 3. INVALID_BATCH (400) did NOT bisect (1 POST call) and preserved all 4 valid GPS rows as RETRYABLE_FAILED');
  }

  // 4. UNKNOWN_ENDPOINT (404) MUST NOT bisect or mark GPS records or outbox events PERMANENT_FAILED
  {
    const sid = `SESS-362-404-${crypto.randomUUID().slice(0, 8)}`;
    const validRows = [
      makeLocationRow('EMP-004', 'AND-DEV-004', sid, 0),
      makeLocationRow('EMP-004', 'AND-DEV-004', sid, 1),
    ];
    const counters = { postCalls: 0 };

    const batchOutcome = await executeClassifiedBatchSlice({
      url: `${baseUrl}/api/v99/sync/batch`,
      token: empToken,
      slice: validRows,
      counters,
      onReauthRequired: () => assert.fail('Unexpected reauth'),
    });
    assert.equal(batchOutcome, 'RETRY');
    assert.equal(counters.postCalls, 1, 'UNKNOWN_ENDPOINT 404 must NEVER bisect');
    assert(validRows.every((r) => r.syncStatus === 'RETRYABLE_FAILED'), '404 UNKNOWN_ENDPOINT must NOT mark GPS records PERMANENT_FAILED');
    assert(validRows.every((r) => r.lastError?.includes('UNKNOWN_ENDPOINT')));

    // Also test session outbox against 404 UNKNOWN_ENDPOINT vs explicit 404 SESSION_INVALID
    const outboxEvent: OutboxRow = {
      eventId: crypto.randomUUID(),
      sessionId: sid,
      employeeId: 'EMP-004',
      deviceId: 'AND-DEV-004',
      eventType: 'START',
      occurredAtIso: '2026-11-24T08:00:00.000Z',
      syncStatus: 'PENDING',
      retryCount: 0,
      lastError: null,
    };
    const unknownStartRes = await fetch(`${baseUrl}/api/v99/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empToken}` },
      body: JSON.stringify({
        sessionId: outboxEvent.sessionId,
        deviceId: outboxEvent.deviceId,
        startedAtIso: outboxEvent.occurredAtIso,
      }),
    });
    assert.equal(unknownStartRes.status, 404);
    const parsedOutbox404 = parseApiErrorBody(await unknownStartRes.text());
    assert.equal(parsedOutbox404.code, 'UNKNOWN_ENDPOINT');
    outboxEvent.syncStatus = classifyOutboxErrorStatus(unknownStartRes.status, parsedOutbox404.code);
    assert.equal(outboxEvent.syncStatus, 'RETRYABLE_FAILED');

    // Explicit SESSION_INVALID on /api/sessions/stop DOES isolate only that outbox event
    const stopRes = await fetch(`${baseUrl}/api/sessions/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${empToken}` },
      body: JSON.stringify({ sessionId: 'SESS-UNKNOWN-ONLY' }),
    });
    assert.equal(stopRes.status, 404);
    const parsedStop404 = parseApiErrorBody(await stopRes.text());
    assert.equal(parsedStop404.code, 'SESSION_INVALID');
    const badOutboxEvent: OutboxRow = {
      eventId: crypto.randomUUID(),
      sessionId: 'SESS-UNKNOWN-ONLY',
      employeeId: 'EMP-004',
      deviceId: 'AND-DEV-004',
      eventType: 'STOP',
      occurredAtIso: '2026-11-24T09:00:00.000Z',
      syncStatus: classifyOutboxErrorStatus(stopRes.status, parsedStop404.code),
      retryCount: 1,
      lastError: parsedStop404.message,
    };
    assert.equal(badOutboxEvent.syncStatus, 'PERMANENT_FAILED');
    console.log('[PASS] 4. UNKNOWN_ENDPOINT (404) kept GPS + outbox events RETRYABLE_FAILED (no permanent discard); explicit SESSION_INVALID isolated only session event');
  }

  // 5. AUTH_REQUIRED preserves records and sets reauth flag without bisection
  {
    const sid = `SESS-362-AUTH-${crypto.randomUUID().slice(0, 8)}`;
    const rows = [
      { ...makeLocationRow('EMP-004', 'AND-DEV-004', sid, 0), employeeId: 'EMP-001' }, // employee isolation mismatch -> 403 AUTH_REQUIRED
      { ...makeLocationRow('EMP-004', 'AND-DEV-004', sid, 1), employeeId: 'EMP-001' },
    ];
    const counters = { postCalls: 0 };
    let reauthReason = '';
    const outcome = await executeClassifiedBatchSlice({
      url: `${baseUrl}/api/sync/batch`,
      token: empToken,
      slice: rows,
      counters,
      onReauthRequired: (reason) => {
        reauthReason = reason;
      },
    });
    assert.equal(outcome, 'FAILURE');
    assert.equal(counters.postCalls, 1);
    assert(reauthReason.includes('AUTH_REQUIRED'));
    assert(rows.every((r) => r.syncStatus === 'RETRYABLE_FAILED'));
    console.log('[PASS] 5. AUTH_REQUIRED (403 isolation mismatch) preserved rows as RETRYABLE_FAILED and triggered reauth without bisection');
  }

  await cleanEmp('EMP-004');
  server.close();

  // 6. PRODUCTION TEST-HOOK FAIL-CLOSED PROOF (Even if ALLOW_TEST_HOOKS=true!)
  {
    const prevNodeEnv = process.env.NODE_ENV;
    const prevAllowHooks = process.env.ALLOW_TEST_HOOKS;
    const prevSessionSecret = process.env.SESSION_SECRET;
    let prodServer: http.Server | null = null;

    try {
      process.env.NODE_ENV = 'production';
      process.env.ALLOW_TEST_HOOKS = 'true';
      process.env.SESSION_SECRET = crypto.randomBytes(32).toString('hex');

      assert.equal(
        areTestHooksEnabled(),
        false,
        'CRITICAL: areTestHooksEnabled() MUST return false when NODE_ENV=production even if ALLOW_TEST_HOOKS=true'
      );

      const prodApp = createApp();
      prodServer = http.createServer(prodApp);
      await new Promise<void>((resolve) => prodServer!.listen(0, '127.0.0.1', resolve));
      const pAddr = prodServer.address();
      assert(pAddr && typeof pAddr === 'object');
      const prodBaseUrl = `http://127.0.0.1:${pAddr.port}`;

      const prodAuthRes = await fetch(`${prodBaseUrl}/api/auth/session-token`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ employeeId: 'EMP-004', deviceId: 'AND-DEV-004', passcode: '2026' }),
      });
      assert.equal(prodAuthRes.status, 200);
      const { token: prodEmpToken } = (await prodAuthRes.json()) as { token: string };

      const prodSid = `SESS-PROD-SAFE-${crypto.randomUUID().slice(0, 8)}`;

      // Attempt x-test-simulate-error: 503 on /api/sessions/start -> MUST be ignored (returns 201!)
      const startRes = await fetch(`${prodBaseUrl}/api/sessions/start`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${prodEmpToken}`,
          'x-test-simulate-error': '503',
        },
        body: JSON.stringify({
          sessionId: prodSid,
          deviceId: 'AND-DEV-004',
          startedAtIso: '2026-11-24T10:00:00.000Z',
        }),
      });
      assert.equal(startRes.status, 201, 'Production must ignore x-test-simulate-error on /api/sessions/start');

      // Attempt ALL batch test hooks simultaneously in production -> MUST be ignored (all 3 rows persisted!)
      const prodRows = [
        makeLocationRow('EMP-004', 'AND-DEV-004', prodSid, 0),
        makeLocationRow('EMP-004', 'AND-DEV-004', prodSid, 1),
        makeLocationRow('EMP-004', 'AND-DEV-004', prodSid, 2),
      ];
      const batchRes = await fetch(`${prodBaseUrl}/api/sync/batch`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${prodEmpToken}`,
          'x-test-simulate-error': '503',
          'x-test-simulate-tx-failure': '1',
          'x-test-partial-ack': '1',
        },
        body: JSON.stringify({
          batchId: crypto.randomUUID(),
          records: prodRows,
        }),
      });
      assert.equal(batchRes.status, 200, 'Production must ignore x-test-simulate-error & x-test-simulate-tx-failure on /api/sync/batch');
      const batchAck = (await batchRes.json()) as { acceptedIds: string[]; duplicateIds: string[] };
      assert.equal(
        batchAck.acceptedIds.length,
        3,
        'Production must ignore x-test-partial-ack=1 and acknowledge all 3 persisted rows'
      );

      // Attempt x-test-simulate-error: 500 on /api/sessions/stop -> MUST be ignored (returns 200 completed!)
      const stopRes = await fetch(`${prodBaseUrl}/api/sessions/stop`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${prodEmpToken}`,
          'x-test-simulate-error': '500',
        },
        body: JSON.stringify({
          sessionId: prodSid,
          deviceId: 'AND-DEV-004',
          endedAtIso: '2026-11-24T10:30:00.000Z',
          status: 'completed',
        }),
      });
      assert.equal(stopRes.status, 200, 'Production must ignore x-test-simulate-error on /api/sessions/stop');
      const stopJson = (await stopRes.json()) as { found: boolean; status: string };
      assert.equal(stopJson.found, true);
      assert.equal(stopJson.status, 'completed');

      // Clean production test rows using admin endpoint on prodServer
      const prodAdminLogin = await fetch(`${prodBaseUrl}/api/admin/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ passcode: process.env.ADMIN_PASSCODE }),
      });
      assert.equal(prodAdminLogin.status, 200);
      const { token: prodAdminToken } = (await prodAdminLogin.json()) as { token: string };
      await fetch(`${prodBaseUrl}/api/admin/records/EMP-004?reason=phase362_prod_hook_cleanup`, {
        method: 'DELETE',
        headers: { Authorization: `Bearer ${prodAdminToken}` },
      });

      console.log('[PASS] 6. Production Fail-Closed Proof — With NODE_ENV=production & ALLOW_TEST_HOOKS=true, areTestHooksEnabled()=false and all x-test-* headers ignored');
    } finally {
      if (prodServer) {
        prodServer.close();
      }
      if (prevNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = prevNodeEnv;
      if (prevAllowHooks === undefined) delete process.env.ALLOW_TEST_HOOKS;
      else process.env.ALLOW_TEST_HOOKS = prevAllowHooks;
      if (prevSessionSecret === undefined) delete process.env.SESSION_SECRET;
      else process.env.SESSION_SECRET = prevSessionSecret;
    }
  }

  const finalPoolCount = await getPool().query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM gps_records');
  assert.equal(finalPoolCount.rows[0]?.cnt, '0');
  console.log(`Post-cleanup gps_records count: ${finalPoolCount.rows[0]?.cnt}`);

  await closePool();
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
