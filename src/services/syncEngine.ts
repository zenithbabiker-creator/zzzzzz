import {
  getUnsyncedRecordsForEmployee,
  markRecordsBlockedAuthTransaction,
  markRecordsBlockedConfigurationTransaction,
  markRecordsPermanentFailedTransaction,
  markRecordsRetryableFailedTransaction,
  markRecordsSyncedTransaction,
  unblockEmployeeBlockedRecordsTransaction,
} from '../db/offlineDb';
import { generateUuid } from './gpsCapture';
import type { Employee, LocationRecord, SyncExecutionResult } from '../types/tracking';

export const SYNC_BATCH_SIZE = 100;

interface CachedToken {
  token: string;
  refreshToken?: string;
  expiresAtMs: number;
}

export function parseApiErrorBody(bodyText: string): { code?: string; message: string } {
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
      // Fall back to raw text
    }
  }
  return { message: trimmed || 'Request failed' };
}

export class BatchHttpError extends Error {
  readonly status: number;
  readonly bodyText: string;
  readonly errorCode?: string;

  constructor(status: number, bodyText: string, errorCode?: string) {
    const parsed = parseApiErrorBody(bodyText);
    const resolvedCode = errorCode ?? parsed.code;
    super(`HTTP ${status}${resolvedCode ? ` [${resolvedCode}]` : ''}: ${parsed.message}`);
    this.status = status;
    this.bodyText = bodyText;
    this.errorCode = resolvedCode;
  }
}

// Held strictly in JS memory (never localStorage or IndexedDB) for authenticated sync calls
const tokenCache = new Map<string, CachedToken>();
const inMemoryPasscodeCache = new Map<string, string>();

export function setInMemoryEmployeePasscode(employeeId: string, plainPasscode: string): void {
  inMemoryPasscodeCache.set(employeeId, plainPasscode);
}

export function clearInMemoryEmployeeAuth(employeeId: string): void {
  const cached = tokenCache.get(employeeId);
  if (cached?.token) {
    void fetch('/api/auth/logout', {
      method: 'POST',
      headers: { Authorization: `Bearer ${cached.token}` },
    }).catch(() => undefined);
  }
  tokenCache.delete(employeeId);
  inMemoryPasscodeCache.delete(employeeId);
}

export function calculateExponentialBackoffMs(attempt: number): number {
  const baseMs = 2000;
  const maxMs = 60000;
  const exp = Math.min(maxMs, baseMs * Math.pow(2, Math.max(0, attempt - 1)));
  return exp;
}

export async function obtainEmployeeSyncToken(
  employee: Employee,
  explicitPasscode?: string
): Promise<string> {
  const existing = tokenCache.get(employee.employeeId);
  if (existing && existing.expiresAtMs - Date.now() > 60_000) {
    return existing.token;
  }

  if (existing?.refreshToken) {
    const refreshRes = await fetch('/api/auth/refresh', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        employeeId: employee.employeeId,
        deviceId: employee.assignedDeviceId,
        refreshToken: existing.refreshToken,
      }),
    });
    if (refreshRes.ok) {
      const refreshed = (await refreshRes.json()) as {
        token: string;
        refreshToken: string;
        expiresAt: string;
      };
      tokenCache.set(employee.employeeId, {
        token: refreshed.token,
        refreshToken: refreshed.refreshToken,
        expiresAtMs: new Date(refreshed.expiresAt).getTime(),
      });
      return refreshed.token;
    }
  }

  const passcode = explicitPasscode ?? inMemoryPasscodeCache.get(employee.employeeId);
  if (!passcode) {
    throw new BatchHttpError(401, 'Active session token unavailable; please sign in again.');
  }

  const res = await fetch('/api/auth/session-token', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      employeeId: employee.employeeId,
      deviceId: employee.assignedDeviceId,
      passcode,
    }),
  });

  if (!res.ok) {
    const errText = await res.text();
    throw new BatchHttpError(res.status, errText);
  }

  const data = (await res.json()) as {
    token: string;
    refreshToken?: string;
    expiresAt: string;
  };
  tokenCache.set(employee.employeeId, {
    token: data.token,
    refreshToken: data.refreshToken,
    expiresAtMs: new Date(data.expiresAt).getTime(),
  });
  await unblockEmployeeBlockedRecordsTransaction(employee.employeeId, 'BLOCKED_AUTH');
  return data.token;
}

export interface BatchSyncOptions {
  employee: Employee;
  isOfflineEffective: boolean;
  onBatchProgress?: (currentBatch: number, totalBatches: number) => void;
  interruptAfterBatch?: number;
  simulateServerErrorOnBatch?: number;
  forceConfigRecovery?: boolean;
}

interface ServerBatchResponse {
  batchId: string;
  serverReceivedAt: string;
  acceptedIds: string[];
  duplicateIds: string[];
  totalPersistedForEmployee: number;
}

export async function uploadSingleBatch(params: {
  token: string;
  records: LocationRecord[];
  simulateServerError?: boolean;
}): Promise<ServerBatchResponse> {
  const batchId = generateUuid();
  const headers: Record<string, string> = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${params.token}`,
  };
  if (params.simulateServerError) {
    headers['x-test-simulate-error'] = '503';
  }

  const res = await fetch('/api/sync/batch', {
    method: 'POST',
    headers,
    body: JSON.stringify({
      batchId,
      records: params.records,
    }),
  });

  if (!res.ok) {
    const payload = await res.text();
    throw new BatchHttpError(res.status, payload);
  }

  return (await res.json()) as ServerBatchResponse;
}

async function uploadSliceWithPermanentIsolation(params: {
  employeeId: string;
  token: string;
  records: LocationRecord[];
  simulateServerError?: boolean;
}): Promise<{
  accepted: number;
  duplicates: number;
  serverReceivedAt: string | null;
  permanentErrors: string[];
  partialOmittedCount: number;
  abortError?: {
    retryable: boolean;
    authRequired: boolean;
    blockedAuth?: boolean;
    blockedConfiguration?: boolean;
    message: string;
  };
}> {
  try {
    const serverAck = await uploadSingleBatch({
      token: params.token,
      records: params.records,
      simulateServerError: params.simulateServerError,
    });

    const confirmedIds = [...serverAck.acceptedIds, ...serverAck.duplicateIds];
    if (confirmedIds.length > 0) {
      await markRecordsSyncedTransaction(
        params.employeeId,
        confirmedIds,
        serverAck.serverReceivedAt
      );
    }

    const confirmedSet = new Set(confirmedIds);
    const omittedIds = params.records
      .map((r) => r.recordId)
      .filter((id) => !confirmedSet.has(id));

    if (omittedIds.length > 0) {
      await markRecordsRetryableFailedTransaction(
        params.employeeId,
        omittedIds,
        `Partial ACK: ${omittedIds.length}/${params.records.length} omitted`
      );
      return {
        accepted: serverAck.acceptedIds.length,
        duplicates: serverAck.duplicateIds.length,
        serverReceivedAt: serverAck.serverReceivedAt,
        permanentErrors: [],
        partialOmittedCount: omittedIds.length,
        abortError: {
          retryable: true,
          authRequired: false,
          message: `Server acknowledged ${confirmedIds.length}/${params.records.length} records; ${omittedIds.length} remain queued`,
        },
      };
    }

    return {
      accepted: serverAck.acceptedIds.length,
      duplicates: serverAck.duplicateIds.length,
      serverReceivedAt: serverAck.serverReceivedAt,
      permanentErrors: [],
      partialOmittedCount: 0,
    };
  } catch (err) {
    const status = err instanceof BatchHttpError ? err.status : 0;
    const errorCode = err instanceof BatchHttpError ? err.errorCode : undefined;
    const message = err instanceof Error ? err.message : 'Batch upload failed';
    const recordIds = params.records.map((r) => r.recordId);
    const isAuthError = errorCode === 'AUTH_REQUIRED' || status === 401 || status === 403;

    if (isAuthError) {
      if (status === 401) {
        tokenCache.delete(params.employeeId);
      }
      await markRecordsBlockedAuthTransaction(params.employeeId, recordIds, message);
      return {
        accepted: 0,
        duplicates: 0,
        serverReceivedAt: null,
        permanentErrors: [],
        partialOmittedCount: 0,
        abortError: {
          retryable: false,
          authRequired: true,
          blockedAuth: true,
          message,
        },
      };
    }

    if (status === 400 && errorCode === 'INVALID_RECORD') {
      if (params.records.length === 1) {
        await markRecordsPermanentFailedTransaction(params.employeeId, recordIds, message);
        return {
          accepted: 0,
          duplicates: 0,
          serverReceivedAt: null,
          permanentErrors: [message],
          partialOmittedCount: 0,
        };
      }
      const mid = Math.floor(params.records.length / 2);
      const left = await uploadSliceWithPermanentIsolation({
        employeeId: params.employeeId,
        token: params.token,
        records: params.records.slice(0, mid),
      });
      if (left.abortError) return left;

      const right = await uploadSliceWithPermanentIsolation({
        employeeId: params.employeeId,
        token: params.token,
        records: params.records.slice(mid),
      });
      return {
        accepted: left.accepted + right.accepted,
        duplicates: left.duplicates + right.duplicates,
        serverReceivedAt: right.serverReceivedAt ?? left.serverReceivedAt,
        permanentErrors: [...left.permanentErrors, ...right.permanentErrors],
        partialOmittedCount: left.partialOmittedCount + right.partialOmittedCount,
        abortError: right.abortError,
      };
    }

    if (status === 400 || status === 404 || errorCode === 'INVALID_BATCH' || errorCode === 'UNKNOWN_ENDPOINT') {
      await markRecordsBlockedConfigurationTransaction(params.employeeId, recordIds, message);
      return {
        accepted: 0,
        duplicates: 0,
        serverReceivedAt: null,
        permanentErrors: [],
        partialOmittedCount: 0,
        abortError: {
          retryable: false,
          authRequired: false,
          blockedConfiguration: true,
          message,
        },
      };
    }

    await markRecordsRetryableFailedTransaction(params.employeeId, recordIds, message);
    return {
      accepted: 0,
      duplicates: 0,
      serverReceivedAt: null,
      permanentErrors: [],
      partialOmittedCount: 0,
      abortError: {
        retryable: true,
        authRequired: false,
        message,
      },
    };
  }
}

export async function syncPendingRecordsForEmployee(
  options: BatchSyncOptions
): Promise<SyncExecutionResult> {
  if (options.isOfflineEffective) {
    return {
      ok: false,
      batchesSent: 0,
      totalAccepted: 0,
      totalDuplicates: 0,
      serverReceivedAt: null,
      interrupted: false,
      retryable: true,
      error: 'Device is offline; local records preserved as pending.',
    };
  }

  if (options.forceConfigRecovery) {
    await unblockEmployeeBlockedRecordsTransaction(options.employee.employeeId, 'BLOCKED_CONFIGURATION');
  }

  const unsynced = await getUnsyncedRecordsForEmployee(options.employee.employeeId);
  if (unsynced.length === 0) {
    return {
      ok: true,
      batchesSent: 0,
      totalAccepted: 0,
      totalDuplicates: 0,
      serverReceivedAt: null,
      interrupted: false,
      retryable: false,
    };
  }

  let token: string;
  try {
    token = await obtainEmployeeSyncToken(options.employee);
  } catch (err) {
    const status = err instanceof BatchHttpError ? err.status : 0;
    const errorCode = err instanceof BatchHttpError ? err.errorCode : undefined;
    const isAuthStop = errorCode === 'AUTH_REQUIRED' || status === 401 || status === 403;
    return {
      ok: false,
      batchesSent: 0,
      totalAccepted: 0,
      totalDuplicates: 0,
      serverReceivedAt: null,
      interrupted: false,
      retryable: !isAuthStop,
      authRequired: isAuthStop,
      error: err instanceof Error ? err.message : 'Auth handshake error',
    };
  }

  const chunks: LocationRecord[][] = [];
  for (let i = 0; i < unsynced.length; i += SYNC_BATCH_SIZE) {
    chunks.push(unsynced.slice(i, i + SYNC_BATCH_SIZE));
  }

  let batchesSent = 0;
  let totalAccepted = 0;
  let totalDuplicates = 0;
  let lastServerReceivedAt: string | null = null;
  const permanentErrors: string[] = [];

  for (let idx = 0; idx < chunks.length; idx++) {
    const batchNum = idx + 1;
    options.onBatchProgress?.(batchNum, chunks.length);

    if (options.interruptAfterBatch && idx >= options.interruptAfterBatch) {
      return {
        ok: false,
        batchesSent,
        totalAccepted,
        totalDuplicates,
        serverReceivedAt: lastServerReceivedAt,
        interrupted: true,
        retryable: true,
        error: `Simulated mid-batch interruption after batch ${options.interruptAfterBatch} of ${chunks.length}`,
      };
    }

    const res = await uploadSliceWithPermanentIsolation({
      employeeId: options.employee.employeeId,
      token,
      records: chunks[idx],
      simulateServerError: options.simulateServerErrorOnBatch === batchNum,
    });

    totalAccepted += res.accepted;
    totalDuplicates += res.duplicates;
    if (res.serverReceivedAt) {
      lastServerReceivedAt = res.serverReceivedAt;
    }
    if (res.permanentErrors.length > 0) {
      permanentErrors.push(...res.permanentErrors);
    }

    if (res.abortError) {
      return {
        ok: false,
        batchesSent: batchesSent + (res.accepted > 0 || res.duplicates > 0 ? 1 : 0),
        totalAccepted,
        totalDuplicates,
        serverReceivedAt: lastServerReceivedAt,
        interrupted: false,
        retryable: res.abortError.retryable,
        authRequired: res.abortError.authRequired,
        blockedAuth: res.abortError.blockedAuth,
        blockedConfiguration: res.abortError.blockedConfiguration,
        permanentError: permanentErrors.length > 0,
        error: res.abortError.message,
      };
    }

    batchesSent++;
  }

  if (permanentErrors.length > 0) {
    return {
      ok: false,
      batchesSent,
      totalAccepted,
      totalDuplicates,
      serverReceivedAt: lastServerReceivedAt,
      interrupted: false,
      retryable: false,
      permanentError: true,
      error: `${permanentErrors.length} invalid record(s) quarantined locally (${permanentErrors[0]})`,
    };
  }

  return {
    ok: true,
    batchesSent,
    totalAccepted,
    totalDuplicates,
    serverReceivedAt: lastServerReceivedAt,
    interrupted: false,
    retryable: false,
  };
}

export async function fetchServerRecordsForEmployee(
  token: string,
  targetEmployeeId: string
): Promise<{ status: number; count?: number; totalCount?: number; records?: unknown[] }> {
  const res = await fetch(`/api/sync/records/${encodeURIComponent(targetEmployeeId)}`, {
    headers: { Authorization: `Bearer ${token}` },
  });
  if (!res.ok) {
    return { status: res.status };
  }
  const data = (await res.json()) as { count: number; totalCount?: number; records: unknown[] };
  return {
    status: res.status,
    count: data.count,
    totalCount: data.totalCount ?? data.count,
    records: data.records,
  };
}

export async function verifyEmployeeCannotDeleteHistory(
  employee: Employee
): Promise<number> {
  const token = await obtainEmployeeSyncToken(employee);
  const res = await fetch(`/api/sync/records/${encodeURIComponent(employee.employeeId)}`, {
    method: 'DELETE',
    headers: { Authorization: `Bearer ${token}` },
  });
  return res.status;
}
