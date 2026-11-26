import {
  clearEmployeeRecordsForTest,
  getAllEmployees,
  getEmployeeSyncStats,
  getLocationRecordsForEmployee,
  insertLocationRecordTransaction,
  runOfflinePeriodSimulation,
  verifyEmployeeRecordUniqueness,
} from '../db/offlineDb';
import {
  calculateExponentialBackoffMs,
  fetchServerRecordsForEmployee,
  obtainEmployeeSyncToken,
  syncPendingRecordsForEmployee,
  uploadSingleBatch,
  verifyEmployeeCannotDeleteHistory,
} from './syncEngine';
import type { Phase2TestCaseResult } from '../types/tracking';

export async function runFullPhase2VerificationSuite(): Promise<Phase2TestCaseResult[]> {
  const results: Phase2TestCaseResult[] = [];
  const employees = await getAllEmployees();
  const testEmp = employees.find((e) => e.employeeId === 'EMP-048') ?? employees[employees.length - 1];
  const otherEmpId = testEmp.employeeId === 'EMP-001' ? 'EMP-002' : 'EMP-001';

  const getServerTotal = async () => {
    const token = await obtainEmployeeSyncToken(testEmp, '2026');
    const check = await fetchServerRecordsForEmployee(token, testEmp.employeeId);
    return check.totalCount ?? check.count ?? 0;
  };

  // Test 1: 1-Day Offline Sync (48 records)
  {
    const t0 = performance.now();
    await clearEmployeeRecordsForTest(testEmp.employeeId);
    const serverBefore = await getServerTotal();
    await runOfflinePeriodSimulation(testEmp, 1);
    const offlineBlocked = await syncPendingRecordsForEmployee({
      employee: testEmp,
      isOfflineEffective: true,
    });
    const synced = await syncPendingRecordsForEmployee({
      employee: testEmp,
      isOfflineEffective: false,
    });
    const stats = await getEmployeeSyncStats(testEmp.employeeId);
    const uniq = await verifyEmployeeRecordUniqueness(testEmp.employeeId);
    const serverAfter = await getServerTotal();

    const passed =
      !offlineBlocked.ok &&
      synced.ok &&
      synced.totalAccepted === 48 &&
      stats.syncedCount === 48 &&
      stats.pendingCount === 0 &&
      uniq.duplicateCount === 0 &&
      serverAfter === serverBefore + 48;

    results.push({
      id: '1-day',
      name: '1-Day Offline Capture & Auto-Sync (48 records)',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: `Accepted: ${synced.totalAccepted}, Local Synced: ${stats.syncedCount}, Server Delta: +${serverAfter - serverBefore}, Duplicates: ${uniq.duplicateCount}`,
    });
  }

  // Test 2: 7-Day Offline Sync (336 records)
  {
    const t0 = performance.now();
    await clearEmployeeRecordsForTest(testEmp.employeeId);
    const serverBefore = await getServerTotal();
    await runOfflinePeriodSimulation(testEmp, 7);
    const synced = await syncPendingRecordsForEmployee({
      employee: testEmp,
      isOfflineEffective: false,
    });
    const stats = await getEmployeeSyncStats(testEmp.employeeId);
    const uniq = await verifyEmployeeRecordUniqueness(testEmp.employeeId);
    const serverAfter = await getServerTotal();

    const passed =
      synced.ok &&
      synced.batchesSent === 4 &&
      synced.totalAccepted === 336 &&
      stats.syncedCount === 336 &&
      uniq.duplicateCount === 0 &&
      serverAfter === serverBefore + 336;

    results.push({
      id: '7-day',
      name: '7-Day Offline Batch Sync (336 records / 4 batches)',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: `Batches: ${synced.batchesSent}, Synced: ${stats.syncedCount}, Server Delta: +${serverAfter - serverBefore}, Duplicates: ${uniq.duplicateCount}`,
    });
  }

  // Test 3: 30-Day Offline Sync (1,440 records)
  {
    const t0 = performance.now();
    await clearEmployeeRecordsForTest(testEmp.employeeId);
    const serverBefore = await getServerTotal();
    await runOfflinePeriodSimulation(testEmp, 30);
    const synced = await syncPendingRecordsForEmployee({
      employee: testEmp,
      isOfflineEffective: false,
    });
    const stats = await getEmployeeSyncStats(testEmp.employeeId);
    const uniq = await verifyEmployeeRecordUniqueness(testEmp.employeeId);
    const serverAfter = await getServerTotal();

    const passed =
      synced.ok &&
      synced.batchesSent === 15 &&
      synced.totalAccepted === 1440 &&
      stats.syncedCount === 1440 &&
      stats.pendingCount === 0 &&
      uniq.duplicateCount === 0 &&
      serverAfter === serverBefore + 1440;

    results.push({
      id: '30-day',
      name: '30-Day Offline Batch Sync (1,440 records / 15 batches)',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: `Batches: ${synced.batchesSent}, Synced: ${stats.syncedCount}, Server Delta: +${serverAfter - serverBefore}, Duplicates: ${uniq.duplicateCount}`,
    });
  }

  // Test 4: Interrupted Mid-Batch Upload + Resume (240 records)
  {
    const t0 = performance.now();
    await clearEmployeeRecordsForTest(testEmp.employeeId);
    const serverBefore = await getServerTotal();
    await runOfflinePeriodSimulation(testEmp, 5); // 240 records
    const interrupted = await syncPendingRecordsForEmployee({
      employee: testEmp,
      isOfflineEffective: false,
      interruptAfterBatch: 1,
    });
    const midStats = await getEmployeeSyncStats(testEmp.employeeId);
    const resumed = await syncPendingRecordsForEmployee({
      employee: testEmp,
      isOfflineEffective: false,
    });
    const endStats = await getEmployeeSyncStats(testEmp.employeeId);
    const serverAfter = await getServerTotal();

    const passed =
      !interrupted.ok &&
      interrupted.interrupted &&
      midStats.syncedCount === 100 &&
      midStats.pendingCount === 140 &&
      resumed.ok &&
      endStats.syncedCount === 240 &&
      endStats.pendingCount === 0 &&
      serverAfter === serverBefore + 240;

    results.push({
      id: 'interrupted',
      name: 'Interrupted Mid-Batch Upload & Clean Resume (240 records)',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: `Mid-interrupt: ${midStats.syncedCount} synced / ${midStats.pendingCount} pending -> Resumed: ${endStats.syncedCount} synced, Server Delta: +${serverAfter - serverBefore}`,
    });
  }

  // Test 5: Idempotent Duplicate Submission Check
  {
    const t0 = performance.now();
    const serverBefore = await getServerTotal();
    const localRows = await getLocationRecordsForEmployee(testEmp.employeeId);
    const sampleBatch = localRows.slice(0, 10);
    const token = await obtainEmployeeSyncToken(testEmp, '2026');
    const dupResponse = await uploadSingleBatch({
      token,
      records: sampleBatch,
    });
    const serverAfter = await getServerTotal();

    const passed =
      dupResponse.acceptedIds.length === 0 &&
      dupResponse.duplicateIds.length === sampleBatch.length &&
      serverAfter === serverBefore;

    results.push({
      id: 'idempotency',
      name: 'Idempotent Duplicate Submission Prevention',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: `Re-submitted ${sampleBatch.length} UUIDs -> Accepted: ${dupResponse.acceptedIds.length}, Duplicates ignored: ${dupResponse.duplicateIds.length}, Total on server: ${serverAfter}`,
    });
  }

  // Test 6: Server 503 Failure & Exponential Backoff Recovery
  {
    const t0 = performance.now();
    await clearEmployeeRecordsForTest(testEmp.employeeId);
    await runOfflinePeriodSimulation(testEmp, 1); // 48 records
    const failRun = await syncPendingRecordsForEmployee({
      employee: testEmp,
      isOfflineEffective: false,
      simulateServerErrorOnBatch: 1,
    });
    const failedStats = await getEmployeeSyncStats(testEmp.employeeId);
    const backoffSeq = [1, 2, 3, 4].map((a) => calculateExponentialBackoffMs(a));
    const retryRun = await syncPendingRecordsForEmployee({
      employee: testEmp,
      isOfflineEffective: false,
    });
    const recoveredStats = await getEmployeeSyncStats(testEmp.employeeId);

    const passed =
      !failRun.ok &&
      failRun.retryable === true &&
      failedStats.syncedCount === 0 &&
      failedStats.failedCount === 48 &&
      backoffSeq.join(',') === '2000,4000,8000,16000' &&
      retryRun.ok &&
      recoveredStats.syncedCount === 48 &&
      recoveredStats.failedCount === 0;

    results.push({
      id: 'server-error-backoff',
      name: 'Server HTTP 503 Handling & RETRYABLE_FAILED Exponential Backoff Recovery',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: `After 503: ${failedStats.failedCount} RETRYABLE_FAILED (0 deleted). Backoff: [${backoffSeq.join(', ')}]ms -> Retry: ${recoveredStats.syncedCount} synced`,
    });
  }

  // Test 7: Employee-ID Isolation & History Deletion Prohibition (HTTP 403)
  {
    const t0 = performance.now();
    const token = await obtainEmployeeSyncToken(testEmp, '2026');
    const crossRead = await fetchServerRecordsForEmployee(token, otherEmpId);
    const selfDeleteStatus = await verifyEmployeeCannotDeleteHistory(testEmp);

    const localRows = await getLocationRecordsForEmployee(testEmp.employeeId);
    const forgedRecord = { ...localRows[0], employeeId: otherEmpId };
    let crossWriteStatus = 0;
    try {
      const res = await fetch('/api/sync/batch', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${token}`,
        },
        body: JSON.stringify({ batchId: 'test-forged', records: [forgedRecord] }),
      });
      crossWriteStatus = res.status;
    } catch {
      crossWriteStatus = 0;
    }

    const passed = crossRead.status === 403 && crossWriteStatus === 403 && selfDeleteStatus === 403;
    results.push({
      id: 'isolation',
      name: `Employee-ID Isolation & Deletion Lock (${testEmp.employeeId} vs ${otherEmpId})`,
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: `Cross-read HTTP ${crossRead.status}, Cross-upload HTTP ${crossWriteStatus}, Employee DELETE HTTP ${selfDeleteStatus}`,
    });
  }

  // Test 8: Timestamp Preservation (Device Capture + Server Receipt) & Persistence
  {
    const t0 = performance.now();
    const token = await obtainEmployeeSyncToken(testEmp, '2026');
    const serverCheck = await fetchServerRecordsForEmployee(token, testEmp.employeeId);
    const localRows = await getLocationRecordsForEmployee(testEmp.employeeId);
    const sampleLocal = localRows[0];
    const sampleServer = (
      serverCheck.records as Array<{
        recordId?: string;
        capturedAtIso?: string;
        dateStr?: string;
        hour?: number;
        minute?: number;
        second?: number;
        serverReceivedAt?: string;
      }> | undefined
    )?.find((r) => r.recordId === sampleLocal?.recordId) ?? null;

    const passed =
      Boolean(sampleLocal?.serverSyncedAt) &&
      Boolean(sampleServer?.serverReceivedAt) &&
      sampleServer?.dateStr === sampleLocal?.dateStr &&
      sampleServer?.hour === sampleLocal?.hour &&
      sampleServer?.minute === sampleLocal?.minute &&
      sampleServer?.second === sampleLocal?.second;

    results.push({
      id: 'timestamps-persistence',
      name: 'Capture & Server Receipt Timestamp Preservation',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: `Device: ${sampleServer?.dateStr} ${String(sampleServer?.hour ?? 0).padStart(2, '0')}:${String(sampleServer?.minute ?? 0).padStart(2, '0')}:${String(sampleServer?.second ?? 0).padStart(2, '0')} | Server: ${sampleServer?.serverReceivedAt?.slice(0, 19) ?? 'none'}`,
    });
  }

  // Test 9: Permanent HTTP 400 Isolation (quarantines malformed record without deleting or blocking valid rows)
  {
    const t0 = performance.now();
    await clearEmployeeRecordsForTest(testEmp.employeeId);
    const serverBefore = await getServerTotal();
    const badId = crypto.randomUUID();
    const goodId = crypto.randomUUID();
    const nowIso = new Date().toISOString();
    await insertLocationRecordTransaction({
      recordId: badId,
      sessionId: `SESS-PERM-${badId.slice(0, 8)}`,
      employeeId: testEmp.employeeId,
      deviceId: testEmp.assignedDeviceId,
      latitude: 999.0, // invalid latitude -> HTTP 400
      longitude: 31.12,
      capturedAtIso: nowIso,
      capturedAtEpochMs: Date.now() - 1000,
      dateStr: nowIso.slice(0, 10),
      hour: 10,
      minute: 0,
      second: 0,
      accuracyMeters: 5.0,
      provider: 'gps',
      batteryPercent: 80,
      syncStatus: 'PENDING',
      serverSyncedAt: null,
    });
    await insertLocationRecordTransaction({
      recordId: goodId,
      sessionId: `SESS-PERM-${badId.slice(0, 8)}`,
      employeeId: testEmp.employeeId,
      deviceId: testEmp.assignedDeviceId,
      latitude: 30.625,
      longitude: 31.114,
      capturedAtIso: nowIso,
      capturedAtEpochMs: Date.now(),
      dateStr: nowIso.slice(0, 10),
      hour: 10,
      minute: 10,
      second: 0,
      accuracyMeters: 5.0,
      provider: 'gps',
      batteryPercent: 80,
      syncStatus: 'PENDING',
      serverSyncedAt: null,
    });

    const firstRun = await syncPendingRecordsForEmployee({
      employee: testEmp,
      isOfflineEffective: false,
    });
    const afterStats = await getEmployeeSyncStats(testEmp.employeeId);
    const secondRun = await syncPendingRecordsForEmployee({
      employee: testEmp,
      isOfflineEffective: false,
    });
    const serverAfter = await getServerTotal();

    const passed =
      !firstRun.ok &&
      firstRun.retryable === false &&
      firstRun.permanentError === true &&
      afterStats.permanentFailedCount === 1 &&
      afterStats.syncedCount === 1 &&
      afterStats.pendingCount === 0 &&
      afterStats.totalCount === 2 &&
      secondRun.ok &&
      secondRun.batchesSent === 0 &&
      serverAfter === serverBefore + 1;

    results.push({
      id: 'permanent-400-quarantine',
      name: 'Permanent HTTP 400 Isolation & Queue-Poison Prevention',
      passed,
      durationMs: Math.round(performance.now() - t0),
      details: `Bad record preserved as PERMANENT_FAILED (${afterStats.permanentFailedCount}), valid record synced (${afterStats.syncedCount}), subsequent sync batchesSent=${secondRun.batchesSent}`,
    });
  }

  // Clean up local browser IndexedDB harness data
  await clearEmployeeRecordsForTest(testEmp.employeeId);

  return results;
}
