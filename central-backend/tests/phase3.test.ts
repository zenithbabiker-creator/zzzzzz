import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assertValidSessionSecretConfig } from '../src/auth/cryptoAuth.js';
import { migrateJsonStoreToPostgres } from '../src/db/migrateJsonStore.js';
import { closePool, getPool } from '../src/db/pool.js';
import { bootstrapDatabaseAndMigrate, createApp } from '../server.js';

interface TestResult {
  name: string;
  passed: boolean;
  details: string;
}

const results: TestResult[] = [];

async function runCase(name: string, fn: () => Promise<string>): Promise<void> {
  try {
    const details = await fn();
    results.push({ name, passed: true, details });
    console.log(`[PASS] ${name} — ${details}`);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    results.push({ name, passed: false, details: msg });
    console.error(`[FAIL] ${name} — ${msg}`);
  }
}

function makeSampleRecord(overrides: Partial<Record<string, unknown>> = {}) {
  const now = new Date();
  return {
    recordId: crypto.randomUUID(),
    sessionId: `SESS-${crypto.randomUUID().slice(0, 8)}`,
    employeeId: 'EMP-001',
    deviceId: 'AND-DEV-001',
    latitude: 30.625123,
    longitude: 31.114567,
    capturedAtIso: now.toISOString(),
    capturedAtEpochMs: now.getTime(),
    dateStr: now.toISOString().slice(0, 10),
    hour: now.getUTCHours(),
    minute: now.getUTCMinutes(),
    second: now.getUTCSeconds(),
    accuracyMeters: 4.8,
    provider: 'gps',
    batteryPercent: 86,
    ...overrides,
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
  const address = server.address();
  assert(address && typeof address === 'object');
  const baseUrl = `http://127.0.0.1:${address.port}`;

  async function loginAdmin() {
    const res = await fetch(`${baseUrl}/api/admin/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ passcode: process.env.ADMIN_PASSCODE }),
    });
    assert.equal(res.status, 200);
    const data = (await res.json()) as { token: string };
    return data.token;
  }

  async function loginEmployee(employeeId: string, deviceId: string, passcode = '2026') {
    const res = await fetch(`${baseUrl}/api/auth/session-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId, deviceId, passcode }),
    });
    return { status: res.status, data: (await res.json()) as Record<string, unknown> };
  }

  const adminToken = await loginAdmin();

  // Admin maintenance clean before test suite
  await fetch(`${baseUrl}/api/admin/records/EMP-001?reason=test_suite_preclean`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });
  await fetch(`${baseUrl}/api/admin/records/EMP-002?reason=test_suite_preclean`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${adminToken}` },
  });

  const emp1Auth = await loginEmployee('EMP-001', 'AND-DEV-001', '2026');
  assert.equal(emp1Auth.status, 200, `EMP-001 scrypt login expected 200, got ${emp1Auth.status}`);
  let emp1Token = String(emp1Auth.data.token);
  let emp1Refresh = String(emp1Auth.data.refreshToken);
  assert(emp1Refresh.startsWith('agr_rt_'), 'Refresh token expected');

  const emp2Auth = await loginEmployee('EMP-002', 'AND-DEV-002', '2026');
  assert.equal(emp2Auth.status, 200, `EMP-002 scrypt login expected 200, got ${emp2Auth.status}`);

  const fixedUuid = crypto.randomUUID();
  const capturedPastIso = '2026-11-10T08:15:30.000Z';

  // 1. Production SESSION_SECRET enforcement + Client SHA-256 digest rejection
  await runCase('1. Auth hardening (production SESSION_SECRET guard & reject client SHA-256 passcodeHash)', async () => {
    const prevEnv = process.env.NODE_ENV;
    const prevSec = process.env.SESSION_SECRET;
    let threwOnMissingProdSecret = false;
    try {
      process.env.NODE_ENV = 'production';
      delete process.env.SESSION_SECRET;
      assertValidSessionSecretConfig();
    } catch {
      threwOnMissingProdSecret = true;
    } finally {
      process.env.NODE_ENV = prevEnv;
      if (prevSec !== undefined) process.env.SESSION_SECRET = prevSec;
      else delete process.env.SESSION_SECRET;
    }
    assert(threwOnMissingProdSecret, 'Expected fatal error when SESSION_SECRET missing in production');

    const digestAttempt = await fetch(`${baseUrl}/api/auth/session-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeId: 'EMP-001',
        deviceId: 'AND-DEV-001',
        passcodeHash: crypto.createHash('sha256').update('2026').digest('hex'),
      }),
    });
    assert.equal(digestAttempt.status, 400);
    return `Production secret enforced=${threwOnMissingProdSecret}, client SHA-256 digest login rejected=HTTP ${digestAttempt.status}`;
  });

  // 2. New employee GPS record insertion + timestamp preservation
  await runCase('2. New employee GPS record insertion & timestamp preservation', async () => {
    const rec = makeSampleRecord({
      recordId: fixedUuid,
      capturedAtIso: capturedPastIso,
      capturedAtEpochMs: Date.parse(capturedPastIso),
      dateStr: '2026-11-10',
      hour: 8,
      minute: 15,
      second: 30,
      accuracyMeters: 6.2,
      batteryPercent: 79,
    });
    const res = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
      body: JSON.stringify({ batchId: 'b-insert-1', records: [rec] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      acceptedIds: string[];
      duplicateIds: string[];
      serverReceivedAt: string;
    };
    assert.deepEqual(body.acceptedIds, [fixedUuid]);
    assert.deepEqual(body.duplicateIds, []);

    const getRes = await fetch(`${baseUrl}/api/sync/records/EMP-001`, {
      headers: { Authorization: `Bearer ${emp1Token}` },
    });
    const getBody = (await getRes.json()) as { records: Array<Record<string, unknown>> };
    const stored = getBody.records.find((r) => r.recordId === fixedUuid);
    assert(stored, 'Inserted record not found in PostgreSQL');
    assert.equal(stored.capturedAtIso, capturedPastIso);
    assert.equal(stored.dateStr, '2026-11-10');
    assert.equal(stored.hour, 8);
    assert.equal(stored.minute, 15);
    assert.equal(stored.second, 30);
    assert(typeof stored.serverReceivedAt === 'string' && stored.serverReceivedAt !== capturedPastIso);
    return `Inserted UUID=${fixedUuid}, device captured_at=${stored.capturedAtIso}, server_received_at=${stored.serverReceivedAt}`;
  });

  // 3. Duplicate UUID upload
  await runCase('3. Duplicate UUID upload prevention (idempotency)', async () => {
    const dupRec = makeSampleRecord({
      recordId: fixedUuid,
      capturedAtIso: capturedPastIso,
      capturedAtEpochMs: Date.parse(capturedPastIso),
      dateStr: '2026-11-10',
      hour: 8,
      minute: 15,
      second: 30,
    });
    const res = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
      body: JSON.stringify({ batchId: 'b-dup-1', records: [dupRec] }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as {
      acceptedIds: string[];
      duplicateIds: string[];
      totalPersistedForEmployee: number;
    };
    assert.equal(body.acceptedIds.length, 0);
    assert.deepEqual(body.duplicateIds, [fixedUuid]);
    assert.equal(body.totalPersistedForEmployee, 1);
    return `Duplicate UUID rejected silently as duplicateIds=[${fixedUuid}], totalPersistedForEmployee=1`;
  });

  // 4. Batch upload containing multiple records
  await runCase('4. Multi-record batch upload (25 records across dates)', async () => {
    const sessionId = `SESS-BATCH-${crypto.randomUUID().slice(0, 6)}`;
    const batchRecords = Array.from({ length: 25 }, (_, i) => {
      const dateStr = i < 10 ? '2026-12-01' : '2026-12-02';
      const iso = `${dateStr}T${String(8 + Math.floor(i / 6)).padStart(2, '0')}:${String((i * 10) % 60).padStart(2, '0')}:00.000Z`;
      return makeSampleRecord({
        sessionId,
        capturedAtIso: iso,
        capturedAtEpochMs: Date.parse(iso),
        dateStr,
        hour: 8 + Math.floor(i / 6),
        minute: (i * 10) % 60,
        second: 0,
      });
    });
    const res = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
      body: JSON.stringify({ batchId: 'b-multi-25', records: batchRecords }),
    });
    assert.equal(res.status, 200);
    const body = (await res.json()) as { acceptedIds: string[]; totalPersistedForEmployee: number };
    assert.equal(body.acceptedIds.length, 25);
    assert.equal(body.totalPersistedForEmployee, 26);
    return `Accepted ${body.acceptedIds.length} records atomically; totalPersistedForEmployee=${body.totalPersistedForEmployee}`;
  });

  // 5. Simulated 30-day offline scenario: session start -> token refresh -> 1,440 batch sync -> session stop
  await runCase('5. 30-day offline simulation: session start -> refresh token -> 1,440 records batch sync -> stop', async () => {
    const sessionId = `SESS-30D-${crypto.randomUUID().slice(0, 8)}`;
    const startRes = await fetch(`${baseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
      body: JSON.stringify({ sessionId, deviceId: 'AND-DEV-001', startedAtIso: '2026-10-20T07:00:00.000Z' }),
    });
    assert.equal(startRes.status, 201);

    // Generate 1,440 offline records spanning 30 days (48/day @ 10-min intervals)
    const offlineBuffer = Array.from({ length: 1440 }, (_, idx) => {
      const day = Math.floor(idx / 48);
      const step = idx % 48;
      const ms = Date.parse('2026-10-20T07:00:00.000Z') + day * 86_400_000 + step * 600_000;
      const d = new Date(ms);
      return makeSampleRecord({
        sessionId,
        capturedAtIso: d.toISOString(),
        capturedAtEpochMs: ms,
        dateStr: d.toISOString().slice(0, 10),
        hour: d.getUTCHours(),
        minute: d.getUTCMinutes(),
        second: d.getUTCSeconds(),
      });
    });

    // After 30 days offline, device refreshes short-lived access token with EncryptedSharedPreferences refreshToken
    const refreshRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeId: 'EMP-001',
        deviceId: 'AND-DEV-001',
        refreshToken: emp1Refresh,
      }),
    });
    assert.equal(refreshRes.status, 200);
    const refreshData = (await refreshRes.json()) as { token: string; refreshToken: string };
    assert.notEqual(refreshData.refreshToken, emp1Refresh, 'Refresh token must rotate');

    // Old refresh token reuse must fail
    const replayRes = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeId: 'EMP-001',
        deviceId: 'AND-DEV-001',
        refreshToken: emp1Refresh,
      }),
    });
    assert.equal(replayRes.status, 401);

    emp1Token = refreshData.token;
    emp1Refresh = refreshData.refreshToken;

    let totalAccepted = 0;
    for (let i = 0; i < offlineBuffer.length; i += 100) {
      const chunk = offlineBuffer.slice(i, i + 100);
      const syncRes = await fetch(`${baseUrl}/api/sync/batch`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
        body: JSON.stringify({ batchId: `b-30d-${i / 100}`, records: chunk }),
      });
      assert.equal(syncRes.status, 200);
      const ack = (await syncRes.json()) as { acceptedIds: string[]; duplicateIds: string[] };
      totalAccepted += ack.acceptedIds.length;
    }
    assert.equal(totalAccepted, 1440);

    const stopRes = await fetch(`${baseUrl}/api/sessions/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
      body: JSON.stringify({ sessionId }),
    });
    assert.equal(stopRes.status, 200);

    return `Token rotated (old rejected 401), 15 batches accepted=${totalAccepted}/1440 records, session completed`;
  });

  // 6. Database restart & persistence
  await runCase('6. PostgreSQL database restart & data persistence', async () => {
    const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
    const pgDataDir = path.join(repoRoot, '.pgdata');
    const pgRunDir = path.join(repoRoot, '.pgrun');
    assert(fs.existsSync(pgDataDir), `.pgdata cluster directory required at ${pgDataDir}`);
    await closePool();

    execFileSync(
      'su',
      [
        '-s',
        '/bin/sh',
        'appuser',
        '-c',
        `/usr/lib/postgresql/15/bin/pg_ctl -D ${pgDataDir} -l ${pgRunDir}/postgres.log -o "-k ${pgRunDir} -p 5432 -h 127.0.0.1" restart`,
      ],
      { stdio: 'pipe' }
    );

    const healthRes = await fetch(`${baseUrl}/api/health`);
    assert.equal(healthRes.status, 200);
    const getRes = await fetch(`${baseUrl}/api/sync/records/EMP-001`, {
      headers: { Authorization: `Bearer ${emp1Token}` },
    });
    assert.equal(getRes.status, 200);
    const getBody = (await getRes.json()) as { totalCount: number };
    assert.equal(getBody.totalCount, 1466);
    return `pg_ctl restart completed; verified ${getBody.totalCount} records persisted across restart`;
  });

  // 7. Employee isolation & forbidden employee history deletion
  await runCase('7. Employee isolation (403), history deletion lock (403), & inactive employee block (403)', async () => {
    const crossGet = await fetch(`${baseUrl}/api/sync/records/EMP-002`, {
      headers: { Authorization: `Bearer ${emp1Token}` },
    });
    assert.equal(crossGet.status, 403);

    const crossPost = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
      body: JSON.stringify({ records: [makeSampleRecord({ employeeId: 'EMP-002' })] }),
    });
    assert.equal(crossPost.status, 403);

    const empSelfDelete = await fetch(`${baseUrl}/api/sync/records/EMP-001`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${emp1Token}` },
    });
    assert.equal(empSelfDelete.status, 403, 'Employees must NOT be able to delete GPS history');

    const empOnAdmin = await fetch(`${baseUrl}/api/admin/employees`, {
      headers: { Authorization: `Bearer ${emp1Token}` },
    });
    assert.equal(empOnAdmin.status, 403);

    const inactiveAuth = await loginEmployee('EMP-049', 'AND-DEV-049', '2026');
    assert.equal(inactiveAuth.status, 403);

    return `Cross-GET=${crossGet.status}, Cross-POST=${crossPost.status}, EmpSelfDelete=${empSelfDelete.status}, EmpOnAdmin=${empOnAdmin.status}, InactiveEMP049=${inactiveAuth.status}`;
  });

  // 8. Unauthorized access
  await runCase('8. Unauthorized access rejection (401)', async () => {
    const missingToken = await fetch(`${baseUrl}/api/sync/records/EMP-001`);
    assert.equal(missingToken.status, 401);

    const tamperedToken = await fetch(`${baseUrl}/api/sync/records/EMP-001`, {
      headers: { Authorization: `Bearer ${emp1Token}tampered` },
    });
    assert.equal(tamperedToken.status, 401);

    const badPass = await loginEmployee('EMP-001', 'AND-DEV-001', '9999');
    assert.equal(badPass.status, 401);

    return `MissingToken=${missingToken.status}, TamperedToken=${tamperedToken.status}, WrongPass=${badPass.status}`;
  });

  // 9. Invalid GPS payload rejection
  await runCase('9. Invalid GPS payload validation (400)', async () => {
    const badLat = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
      body: JSON.stringify({ records: [makeSampleRecord({ latitude: 95.12 })] }),
    });
    assert.equal(badLat.status, 400);

    const badBattery = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
      body: JSON.stringify({ records: [makeSampleRecord({ batteryPercent: 140 })] }),
    });
    assert.equal(badBattery.status, 400);

    const emptyBatch = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp1Token}` },
      body: JSON.stringify({ records: [] }),
    });
    assert.equal(emptyBatch.status, 400);

    return `Out-of-range lat=${badLat.status}, battery>100=${badBattery.status}, emptyBatch=${emptyBatch.status}`;
  });

  // 10. Database transaction failure & rollback (no false ack)
  await runCase('10. Database transaction failure rollback & no false acknowledgement', async () => {
    const rollbackUuid = crypto.randomUUID();
    const res = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${emp1Token}`,
        'x-test-simulate-tx-failure': '1',
      },
      body: JSON.stringify({ records: [makeSampleRecord({ recordId: rollbackUuid })] }),
    });
    assert.equal(res.status, 500);

    const getRes = await fetch(`${baseUrl}/api/sync/records/EMP-001`, {
      headers: { Authorization: `Bearer ${emp1Token}` },
    });
    const getBody = (await getRes.json()) as { totalCount: number; records: Array<{ recordId: string }> };
    assert.equal(getBody.totalCount, 1466);
    assert.equal(getBody.records.some((r) => r.recordId === rollbackUuid), false);
    return `Simulated TX failure returned HTTP ${res.status}; record ${rollbackUuid} cleanly rolled back (count stayed ${getBody.totalCount})`;
  });

  // 11. Historical retrieval with pagination & date filtering
  await runCase('11. Historical GPS retrieval with pagination & date filtering', async () => {
    const filtered = await fetch(
      `${baseUrl}/api/sync/records/EMP-001?fromDate=2026-12-01&toDate=2026-12-01&page=1&limit=4`,
      { headers: { Authorization: `Bearer ${emp1Token}` } }
    );
    assert.equal(filtered.status, 200);
    const body = (await filtered.json()) as {
      count: number;
      totalCount: number;
      page: number;
      records: Array<{ dateStr: string }>;
    };
    assert.equal(body.totalCount, 10);
    assert.equal(body.count, 4);
    assert(body.records.every((r) => r.dateStr === '2026-12-01'));

    const p3 = await fetch(
      `${baseUrl}/api/sync/records/EMP-001?fromDate=2026-12-01&toDate=2026-12-01&page=3&limit=4`,
      { headers: { Authorization: `Bearer ${emp1Token}` } }
    );
    const p3Body = (await p3.json()) as { count: number; totalCount: number };
    assert.equal(p3Body.count, 2);

    return `Date filter 2026-12-01 totalCount=${body.totalCount}; page1=${body.count}, page3=${p3Body.count}`;
  });

  // 12. Logout revocation + Admin audited maintenance deletion + audit logs
  await runCase('12. Logout token revocation & audited admin maintenance purge', async () => {
    const logoutRes = await fetch(`${baseUrl}/api/auth/logout`, {
      method: 'POST',
      headers: { Authorization: `Bearer ${emp1Token}` },
    });
    assert.equal(logoutRes.status, 200);

    const postLogoutRefresh = await fetch(`${baseUrl}/api/auth/refresh`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeId: 'EMP-001',
        deviceId: 'AND-DEV-001',
        refreshToken: emp1Refresh,
      }),
    });
    assert.equal(postLogoutRefresh.status, 401);

    const adminDel = await fetch(`${baseUrl}/api/admin/records/EMP-001?reason=phase35_audit_test`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(adminDel.status, 200);
    const delBody = (await adminDel.json()) as { removed: number };
    assert.equal(delBody.removed, 1466);

    const auditRes = await fetch(`${baseUrl}/api/admin/audit-logs?limit=10`, {
      headers: { Authorization: `Bearer ${adminToken}` },
    });
    assert.equal(auditRes.status, 200);
    const auditBody = (await auditRes.json()) as { logs: Array<{ action: string; targetEmployeeCode: string }> };
    assert(
      auditBody.logs.some(
        (l) => l.action === 'ADMIN_PURGE_EMPLOYEE_RECORDS' && l.targetEmployeeCode === 'EMP-001'
      ),
      'Expected audit log entry for admin record purge'
    );

    return `Logout revoked refresh (401), admin purge removed=${delBody.removed}, audit log recorded`;
  });

  // 13. Safe JSON store migration + backup preservation
  await runCase('13. Safe JSON store migration + backup preservation', async () => {
    const tmpJson = path.resolve(process.cwd(), '.data/test_migration_fixture.json');
    fs.mkdirSync(path.dirname(tmpJson), { recursive: true });
    const migUuid = crypto.randomUUID();
    const fixture = {
      records: [
        makeSampleRecord({
          recordId: migUuid,
          employeeId: 'EMP-002',
          deviceId: 'AND-DEV-002',
          serverReceivedAt: '2026-11-01T10:00:00.000Z',
          batchId: 'legacy-batch-1',
        }),
      ],
      batches: [
        {
          batchId: 'legacy-batch-1',
          employeeId: 'EMP-002',
          acceptedCount: 1,
          duplicateCount: 0,
          serverReceivedAt: '2026-11-01T10:00:00.000Z',
        },
      ],
    };
    fs.writeFileSync(tmpJson, JSON.stringify(fixture), 'utf8');

    const rep1 = await migrateJsonStoreToPostgres(tmpJson);
    assert.equal(rep1.found, true);
    assert.equal(rep1.importedRecordCount, 1);
    assert(rep1.backupPath && fs.existsSync(rep1.backupPath), 'JSON backup file must exist after migration');

    const rep2 = await migrateJsonStoreToPostgres(tmpJson);
    assert.equal(rep2.importedRecordCount, 0);
    assert.equal(rep2.duplicateSkippedCount, 1);

    fs.rmSync(tmpJson, { force: true });
    if (rep1.backupPath) fs.rmSync(rep1.backupPath, { force: true });
    if (rep2.backupPath) fs.rmSync(rep2.backupPath, { force: true });

    await fetch(`${baseUrl}/api/admin/records/EMP-002?reason=test_suite_cleanup`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    return `Imported=${rep1.importedRecordCount}, backup preserved, idempotent re-run skipped=${rep2.duplicateSkippedCount}`;
  });

  // 14. Offline session lifecycle: out-of-order batch -> start -> stop -> late start retry + 0-GPS offline session
  await runCase('14. Offline session lifecycle: out-of-order batch/start/stop & 0-GPS offline session', async () => {
    const emp2Token = String(emp2Auth.data.token);
    const sid1 = `SESS-OFFLINE-ORDER-${crypto.randomUUID().slice(0, 8)}`;
    const trueStartIso = '2026-11-22T06:00:00.000Z';
    const recIso = '2026-11-22T06:10:00.000Z';
    const stopIso = '2026-11-22T07:05:00.000Z';

    // GPS batch arrives BEFORE explicit session/start
    const batchRes = await fetch(`${baseUrl}/api/sync/batch`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp2Token}` },
      body: JSON.stringify({
        batchId: `b-order-${crypto.randomUUID().slice(0, 6)}`,
        records: [
          makeSampleRecord({
            sessionId: sid1,
            employeeId: 'EMP-002',
            deviceId: 'AND-DEV-002',
            capturedAtIso: recIso,
            capturedAtEpochMs: Date.parse(recIso),
            dateStr: '2026-11-22',
            hour: 6,
            minute: 10,
            second: 0,
          }),
        ],
      }),
    });
    assert.equal(batchRes.status, 200);

    // Offline STOP arrives next
    const stopRes = await fetch(`${baseUrl}/api/sessions/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp2Token}` },
      body: JSON.stringify({
        sessionId: sid1,
        deviceId: 'AND-DEV-002',
        startedAtIso: trueStartIso,
        endedAtIso: stopIso,
        status: 'completed',
      }),
    });
    assert.equal(stopRes.status, 200);

    // Delayed retried START arrives AFTER STOP — must refine start time without flipping completed -> active
    const lateStartRes = await fetch(`${baseUrl}/api/sessions/start`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp2Token}` },
      body: JSON.stringify({
        sessionId: sid1,
        deviceId: 'AND-DEV-002',
        startedAtIso: trueStartIso,
      }),
    });
    assert.equal(lateStartRes.status, 201);

    // Zero-GPS-record offline session synced via STOP with deviceId + startedAtIso
    const sidZeroGps = `SESS-ZERO-GPS-${crypto.randomUUID().slice(0, 8)}`;
    const zeroStopRes = await fetch(`${baseUrl}/api/sessions/stop`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${emp2Token}` },
      body: JSON.stringify({
        sessionId: sidZeroGps,
        deviceId: 'AND-DEV-002',
        startedAtIso: '2026-11-22T08:00:00.000Z',
        endedAtIso: '2026-11-22T08:03:00.000Z',
        status: 'completed',
      }),
    });
    assert.equal(zeroStopRes.status, 200);

    const sessionsRes = await fetch(`${baseUrl}/api/sessions/EMP-002`, {
      headers: { Authorization: `Bearer ${emp2Token}` },
    });
    assert.equal(sessionsRes.status, 200);
    const sessionsData = (await sessionsRes.json()) as {
      sessions: Array<{ sessionId: string; status: string; startedAt: string; endedAt: string | null; recordCount: number }>;
    };
    const s1 = sessionsData.sessions.find((s) => s.sessionId === sid1);
    const sZero = sessionsData.sessions.find((s) => s.sessionId === sidZeroGps);
    assert(s1 && s1.status === 'completed' && s1.startedAt === trueStartIso && s1.endedAt === stopIso && s1.recordCount === 1);
    assert(sZero && sZero.status === 'completed' && sZero.recordCount === 0);

    await fetch(`${baseUrl}/api/admin/records/EMP-002?reason=test_suite_cleanup`, {
      method: 'DELETE',
      headers: { Authorization: `Bearer ${adminToken}` },
    });

    return `Out-of-order session preserved start=${s1.startedAt}, status=${s1.status}, 0-GPS session persisted as ${sZero.status}`;
  });

  // 15. Brute-force passcode lockout protection (HTTP 429 + Retry-After)
  await runCase('15. Brute-force passcode lockout protection (HTTP 429)', async () => {
    for (let attempt = 1; attempt <= 5; attempt++) {
      const failRes = await loginEmployee('EMP-047', 'AND-DEV-047', '0000');
      assert.equal(failRes.status, 401, `Expected 401 on bad attempt ${attempt}`);
    }
    const lockedRes = await fetch(`${baseUrl}/api/auth/session-token`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ employeeId: 'EMP-047', deviceId: 'AND-DEV-047', passcode: '2026' }),
    });
    assert.equal(lockedRes.status, 429);
    const retryAfter = lockedRes.headers.get('retry-after');
    assert(retryAfter && Number(retryAfter) > 0, 'Expected positive Retry-After header');
    return `Locked out after 5 consecutive failures -> HTTP ${lockedRes.status} (Retry-After=${retryAfter}s)`;
  });

  // Verify clean 0 records left
  const finalPoolCount = await getPool().query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM gps_records');
  console.log(`Post-cleanup gps_records count: ${finalPoolCount.rows[0]?.cnt}`);

  server.close();
  await closePool();

  const failed = results.filter((r) => !r.passed);
  console.log(`\nSummary: ${results.length - failed.length}/${results.length} tests passed.`);
  if (failed.length > 0) {
    process.exit(1);
  }
}

main().catch(async (err) => {
  console.error(err);
  await closePool();
  process.exit(1);
});
