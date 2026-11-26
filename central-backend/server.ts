import 'dotenv/config';
import crypto from 'node:crypto';
import express from 'express';
import type { NextFunction, Request, Response } from 'express';
import {
  type AuthClaims,
  assertValidSessionSecretConfig,
  signAuthToken,
  verifyAuthToken,
} from './src/auth/cryptoAuth.js';
import { AuthBruteForceProtector } from './src/auth/rateLimiter.js';
import { migrateJsonStoreToPostgres } from './src/db/migrateJsonStore.js';
import { runMigrations, seedInitialEmployeesIfEmpty } from './src/db/migrator.js';
import { getPool } from './src/db/pool.js';
import {
  type IncomingLocationRecord,
  authenticateEmployeeForSession,
  claimInitialAdminPasscode,
  deleteEmployeeRecords,
  getAdminAuthStatus,
  getHealthMetrics,
  ingestGpsBatchTransaction,
  issueEmployeeRefreshToken,
  listAdminAuditLogs,
  listAllEmployeesAdmin,
  listEmployeeRecords,
  listEmployeeTrackingSessions,
  queryAdminRecords,
  recordAdminAuditLog,
  revokeEmployeeRefreshTokens,
  rotateEmployeeRefreshToken,
  startEmployeeTrackingSession,
  stopEmployeeTrackingSession,
  upsertEmployeeAdmin,
  verifyAdminPasscode,
} from './src/repositories/trackingRepository.js';

const PORT = Number(process.env.BACKEND_PORT || process.env.PORT || 3001);

interface AuthenticatedRequest extends Request {
  auth?: AuthClaims;
}

export function areTestHooksEnabled(): boolean {
  // Production MUST fail closed regardless of ALLOW_TEST_HOOKS or request headers.
  const nodeEnv = (process.env.NODE_ENV || '').trim().toLowerCase();
  if (nodeEnv === 'production') {
    return false;
  }
  return process.env.ALLOW_TEST_HOOKS === 'true';
}

function requireAuth(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Missing Bearer authentication token', code: 'AUTH_REQUIRED' });
    return;
  }
  const token = header.slice('Bearer '.length).trim();
  const claims = verifyAuthToken(token);
  if (!claims) {
    res.status(401).json({ error: 'Invalid or expired authentication token', code: 'AUTH_REQUIRED' });
    return;
  }
  req.auth = claims;
  next();
}

function requireEmployeeRole(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.auth?.role !== 'employee' || !req.auth.employeeId) {
      res.status(403).json({ error: 'Employee authorization role required', code: 'AUTH_REQUIRED' });
      return;
    }
    next();
  });
}

function requireAdminRole(req: AuthenticatedRequest, res: Response, next: NextFunction): void {
  requireAuth(req, res, () => {
    if (req.auth?.role !== 'admin') {
      res.status(403).json({ error: 'Administrator authorization role required', code: 'AUTH_REQUIRED' });
      return;
    }
    next();
  });
}

function isValidIsoDate(str: string): boolean {
  return /^\d{4}-\d{2}-\d{2}$/.test(str);
}

function isValidRecord(r: unknown): r is IncomingLocationRecord {
  if (!r || typeof r !== 'object') return false;
  const rec = r as Record<string, unknown>;
  if (
    typeof rec.recordId !== 'string' ||
    rec.recordId.length < 8 ||
    rec.recordId.length > 128 ||
    typeof rec.sessionId !== 'string' ||
    rec.sessionId.trim().length === 0 ||
    typeof rec.employeeId !== 'string' ||
    rec.employeeId.trim().length === 0 ||
    typeof rec.deviceId !== 'string' ||
    rec.deviceId.trim().length === 0
  ) {
    return false;
  }
  if (
    typeof rec.latitude !== 'number' ||
    !Number.isFinite(rec.latitude) ||
    rec.latitude < -90 ||
    rec.latitude > 90
  ) {
    return false;
  }
  if (
    typeof rec.longitude !== 'number' ||
    !Number.isFinite(rec.longitude) ||
    rec.longitude < -180 ||
    rec.longitude > 180
  ) {
    return false;
  }
  if (
    typeof rec.capturedAtIso !== 'string' ||
    Number.isNaN(Date.parse(rec.capturedAtIso)) ||
    typeof rec.capturedAtEpochMs !== 'number' ||
    !Number.isFinite(rec.capturedAtEpochMs) ||
    typeof rec.dateStr !== 'string' ||
    !isValidIsoDate(rec.dateStr)
  ) {
    return false;
  }
  if (
    typeof rec.hour !== 'number' ||
    !Number.isInteger(rec.hour) ||
    rec.hour < 0 ||
    rec.hour > 23 ||
    typeof rec.minute !== 'number' ||
    !Number.isInteger(rec.minute) ||
    rec.minute < 0 ||
    rec.minute > 59 ||
    typeof rec.second !== 'number' ||
    !Number.isInteger(rec.second) ||
    rec.second < 0 ||
    rec.second > 59
  ) {
    return false;
  }
  if (
    typeof rec.accuracyMeters !== 'number' ||
    !Number.isFinite(rec.accuracyMeters) ||
    rec.accuracyMeters < 0 ||
    typeof rec.provider !== 'string' ||
    rec.provider.trim().length === 0
  ) {
    return false;
  }
  if (
    rec.batteryPercent !== null &&
    rec.batteryPercent !== undefined &&
    (typeof rec.batteryPercent !== 'number' ||
      !Number.isFinite(rec.batteryPercent) ||
      rec.batteryPercent < 0 ||
      rec.batteryPercent > 100)
  ) {
    return false;
  }
  return true;
}

export function createApp(): express.Express {
  const app = express();
  app.use(express.json({ limit: '4mb' }));

  const authProtector = new AuthBruteForceProtector({
    ipWindowMs: 15 * 60 * 1000,
    maxIpRequests: 100,
    maxAccountFailures: 5,
    lockoutMs: 15 * 60 * 1000,
  });

  app.get('/api/health', async (_req: Request, res: Response) => {
    try {
      await getPool().query('SELECT 1');
      const metrics = await getHealthMetrics();
      res.json({
        ok: true,
        service: 'agritrack-central-backend',
        phase: 3,
        database: 'postgresql',
        ...metrics,
      });
    } catch (err) {
      res.status(503).json({
        ok: false,
        service: 'agritrack-central-backend',
        phase: 3,
        database: 'postgresql',
        error: err instanceof Error ? err.message : 'Database health check failed',
      });
    }
  });

  // Employee Authentication & Device Verification
  app.post('/api/auth/session-token', async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const ipCheck = authProtector.checkIpRateLimit('emp_login', clientIp);
    if (!ipCheck.allowed) {
      res.setHeader('Retry-After', String(ipCheck.retryAfterSeconds));
      res.status(429).json({ error: ipCheck.reason });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const employeeId = typeof body?.employeeId === 'string' ? body.employeeId.trim().toUpperCase() : '';
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim().toUpperCase() : '';
    const passcodeHash = typeof body?.passcodeHash === 'string' ? body.passcodeHash.trim() : '';
    const passcode = typeof body?.passcode === 'string' ? body.passcode.trim() : '';

    const legacyDigestAllowed =
      process.env.NODE_ENV !== 'production' && process.env.ALLOW_LEGACY_PWA_DIGEST === 'true';

    if (passcode.length === 0 && passcodeHash.length > 0 && !legacyDigestAllowed) {
      res.status(400).json({
        error: 'Plaintext passcode over TLS is required; client SHA-256 digests are not accepted as credentials',
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    if (
      !/^(EMP|AG)-[A-Z0-9-]{1,32}$/.test(employeeId) ||
      !deviceId ||
      (passcode.length < 4 && !(legacyDigestAllowed && passcodeHash.length >= 8))
    ) {
      res.status(400).json({ error: 'Invalid employee authentication payload', code: 'AUTH_REQUIRED' });
      return;
    }

    const lockoutKey = `emp:${employeeId}`;
    const lockCheck = authProtector.checkAccountLockout(lockoutKey);
    if (!lockCheck.allowed) {
      res.setHeader('Retry-After', String(lockCheck.retryAfterSeconds));
      res.status(429).json({ error: lockCheck.reason, retryAfterSeconds: lockCheck.retryAfterSeconds });
      return;
    }

    try {
      const check = await authenticateEmployeeForSession({
        employeeId,
        deviceId,
        passcode: passcode || undefined,
        passcodeHash: legacyDigestAllowed ? passcodeHash || undefined : undefined,
      });

      if (check.status !== 'ok') {
        if (check.status === 'invalid_credentials' || check.status === 'not_found') {
          authProtector.recordFailure(lockoutKey);
        }
        const statusCode =
          check.status === 'invalid_credentials'
            ? 401
            : check.status === 'not_found'
              ? 401
              : 403;
        res.status(statusCode).json({ error: check.message, reason: check.status, code: 'AUTH_REQUIRED' });
        return;
      }

      authProtector.clearFailures(lockoutKey);

      const now = Date.now();
      const exp = now + 24 * 60 * 60 * 1000;
      const token = signAuthToken({
        role: 'employee',
        employeeId: check.employeeCode,
        deviceId: check.deviceId,
        subject: check.employeeCode,
        iat: now,
        exp,
      });

      const { refreshToken, refreshExpiresAt } = await issueEmployeeRefreshToken({
        employeeId: check.employeeCode,
        deviceId: check.deviceId,
        ttlDays: 45,
      });

      res.json({
        token,
        refreshToken,
        employeeId: check.employeeCode,
        deviceId: check.deviceId,
        fullNameEn: check.fullNameEn,
        fullNameAr: check.fullNameAr,
        expiresAt: new Date(exp).toISOString(),
        refreshExpiresAt,
      });
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Authentication database error',
      });
    }
  });

  // Rotate long-lived encrypted device refresh token after offline intervals (e.g. 30-day offline sync)
  app.post('/api/auth/refresh', async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const ipCheck = authProtector.checkIpRateLimit('emp_refresh', clientIp);
    if (!ipCheck.allowed) {
      res.setHeader('Retry-After', String(ipCheck.retryAfterSeconds));
      res.status(429).json({ error: ipCheck.reason });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const employeeId = typeof body?.employeeId === 'string' ? body.employeeId.trim().toUpperCase() : '';
    const deviceId = typeof body?.deviceId === 'string' ? body.deviceId.trim().toUpperCase() : '';
    const refreshToken = typeof body?.refreshToken === 'string' ? body.refreshToken.trim() : '';

    if (!employeeId || !deviceId || refreshToken.length < 16) {
      res.status(400).json({ error: 'employeeId, deviceId, and refreshToken are required', code: 'AUTH_REQUIRED' });
      return;
    }

    try {
      const rotated = await rotateEmployeeRefreshToken({
        employeeId,
        deviceId,
        rawRefreshToken: refreshToken,
      });
      if (rotated.status !== 'ok') {
        const statusCode = rotated.status === 'invalid' ? 401 : 403;
        res.status(statusCode).json({ error: rotated.message, reason: rotated.status, code: 'AUTH_REQUIRED' });
        return;
      }

      const now = Date.now();
      const exp = now + 24 * 60 * 60 * 1000;
      const token = signAuthToken({
        role: 'employee',
        employeeId: rotated.employeeCode,
        deviceId: rotated.deviceId,
        subject: rotated.employeeCode,
        iat: now,
        exp,
      });

      res.json({
        token,
        refreshToken: rotated.refreshToken,
        employeeId: rotated.employeeCode,
        deviceId: rotated.deviceId,
        expiresAt: new Date(exp).toISOString(),
        refreshExpiresAt: rotated.refreshExpiresAt,
      });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Token refresh failed' });
    }
  });

  app.post('/api/auth/logout', requireEmployeeRole, async (req: AuthenticatedRequest, res: Response) => {
    try {
      const revoked = await revokeEmployeeRefreshTokens({
        employeeId: req.auth!.employeeId!,
        deviceId: req.auth!.deviceId,
      });
      res.json({ ok: true, revoked });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Logout failed' });
    }
  });

  // Explicit work-session lifecycle tracking
  app.post('/api/sessions/start', requireEmployeeRole, async (req: AuthenticatedRequest, res: Response) => {
    const testHooksAllowed = areTestHooksEnabled();
    const simulatedStatusHeader = req.headers['x-test-simulate-error'];
    if (testHooksAllowed && (simulatedStatusHeader === '503' || simulatedStatusHeader === '500')) {
      const code = Number(simulatedStatusHeader);
      res.status(code).json({ error: `Simulated session start error (${code}) for retry verification` });
      return;
    }

    const body = req.body as Record<string, unknown>;
    if (body?.sessionId !== undefined && (typeof body.sessionId !== 'string' || body.sessionId.trim().length > 128)) {
      res.status(400).json({ error: 'Invalid sessionId format', code: 'SESSION_INVALID' });
      return;
    }
    if (body?.startedAtIso !== undefined && (typeof body.startedAtIso !== 'string' || Number.isNaN(Date.parse(body.startedAtIso)))) {
      res.status(400).json({ error: 'Invalid startedAtIso timestamp', code: 'SESSION_INVALID' });
      return;
    }

    const sessionId =
      typeof body?.sessionId === 'string' && body.sessionId.trim().length > 0
        ? body.sessionId.trim()
        : crypto.randomUUID();
    const deviceId =
      typeof body?.deviceId === 'string' && body.deviceId.trim().length > 0
        ? body.deviceId.trim().toUpperCase()
        : req.auth!.deviceId || 'UNKNOWN-DEV';

    try {
      const started = await startEmployeeTrackingSession({
        sessionId,
        employeeId: req.auth!.employeeId!,
        deviceId,
        startedAtIso: typeof body?.startedAtIso === 'string' ? body.startedAtIso : undefined,
      });
      res.status(201).json(started);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to start session' });
    }
  });

  app.post('/api/sessions/stop', requireEmployeeRole, async (req: AuthenticatedRequest, res: Response) => {
    const testHooksAllowed = areTestHooksEnabled();
    const simulatedStatusHeader = req.headers['x-test-simulate-error'];
    if (testHooksAllowed && (simulatedStatusHeader === '503' || simulatedStatusHeader === '500')) {
      const code = Number(simulatedStatusHeader);
      res.status(code).json({ error: `Simulated session stop error (${code}) for retry verification` });
      return;
    }

    const body = req.body as Record<string, unknown>;
    const sessionId = typeof body?.sessionId === 'string' ? body.sessionId.trim() : '';
    if (!sessionId || sessionId.length > 128) {
      res.status(400).json({ error: 'sessionId is required', code: 'SESSION_INVALID' });
      return;
    }
    if (body?.endedAtIso !== undefined && (typeof body.endedAtIso !== 'string' || Number.isNaN(Date.parse(body.endedAtIso)))) {
      res.status(400).json({ error: 'Invalid endedAtIso timestamp', code: 'SESSION_INVALID' });
      return;
    }
    if (body?.startedAtIso !== undefined && (typeof body.startedAtIso !== 'string' || Number.isNaN(Date.parse(body.startedAtIso)))) {
      res.status(400).json({ error: 'Invalid startedAtIso timestamp', code: 'SESSION_INVALID' });
      return;
    }
    const statusParam = body?.status === 'interrupted' ? 'interrupted' : 'completed';
    const deviceId =
      typeof body?.deviceId === 'string' && body.deviceId.trim().length > 0
        ? body.deviceId.trim().toUpperCase()
        : undefined;
    const startedAtIso = typeof body?.startedAtIso === 'string' ? body.startedAtIso : undefined;

    try {
      const result = await stopEmployeeTrackingSession({
        sessionId,
        employeeId: req.auth!.employeeId!,
        endedAtIso: typeof body?.endedAtIso === 'string' ? body.endedAtIso : undefined,
        deviceId,
        startedAtIso,
        status: statusParam,
      });
      if (!result.found) {
        res.status(404).json({ error: 'Tracking session not found for employee', code: 'SESSION_INVALID' });
        return;
      }
      res.json(result);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to stop session' });
    }
  });

  app.get('/api/sessions/:employeeId', requireEmployeeRole, async (req: AuthenticatedRequest, res: Response) => {
    const requestedEmployeeId = String(req.params.employeeId || '').trim().toUpperCase();
    if (requestedEmployeeId !== req.auth!.employeeId) {
      res.status(403).json({
        error: `Employee isolation violation: ${req.auth!.employeeId} cannot access sessions for ${requestedEmployeeId}`,
        code: 'AUTH_REQUIRED',
      });
      return;
    }
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : undefined;
    try {
      const sessions = await listEmployeeTrackingSessions({
        employeeId: requestedEmployeeId,
        sessionId,
      });
      res.json({ employeeId: requestedEmployeeId, count: sessions.length, sessions });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load sessions' });
    }
  });

  // Idempotent Transactional Batch GPS Sync (Preserves Phase 2 contract)
  app.post('/api/sync/batch', requireEmployeeRole, async (req: AuthenticatedRequest, res: Response) => {
    const testHooksAllowed = areTestHooksEnabled();
    const simulatedStatusHeader = req.headers['x-test-simulate-error'];
    if (testHooksAllowed && (simulatedStatusHeader === '503' || simulatedStatusHeader === '500')) {
      const code = Number(simulatedStatusHeader);
      res.status(code).json({
        error: `Simulated server error (${code}) for backoff retry verification`,
      });
      return;
    }

    const body = req.body as Record<string, unknown>;
    if (!body || typeof body !== 'object' || Array.isArray(body)) {
      res.status(400).json({ error: 'Invalid JSON request body for batch sync', code: 'INVALID_BATCH' });
      return;
    }
    const batchId =
      typeof body.batchId === 'string' && body.batchId.trim().length > 0
        ? body.batchId.trim()
        : crypto.randomUUID();
    const records = body.records;

    if (!Array.isArray(records) || records.length === 0 || records.length > 500) {
      res.status(400).json({
        error: 'Batch must contain between 1 and 500 GPS records',
        code: 'INVALID_BATCH',
      });
      return;
    }

    const authEmployeeId = req.auth!.employeeId!;
    for (let idx = 0; idx < records.length; idx++) {
      const item = records[idx];
      if (!isValidRecord(item)) {
        const maybeRecordId =
          item && typeof item === 'object' && typeof (item as Record<string, unknown>).recordId === 'string'
            ? ((item as Record<string, unknown>).recordId as string)
            : null;
        res.status(400).json({
          error: `Malformed GPS location record in batch at index ${idx}`,
          code: 'INVALID_RECORD',
          recordIndex: idx,
          recordId: maybeRecordId,
        });
        return;
      }
      if (item.employeeId.trim().toUpperCase() !== authEmployeeId) {
        res.status(403).json({
          error: `Employee isolation violation: token for ${authEmployeeId} cannot upload records for ${item.employeeId}`,
          code: 'AUTH_REQUIRED',
        });
        return;
      }
    }

    const simulateTxFailure =
      testHooksAllowed && req.headers['x-test-simulate-tx-failure'] === '1';

    const partialAckRaw =
      testHooksAllowed ? Number(req.headers['x-test-partial-ack']) : NaN;
    const partialAckLimit =
      Number.isInteger(partialAckRaw) && partialAckRaw > 0 && partialAckRaw < records.length
        ? partialAckRaw
        : undefined;

    try {
      const result = await ingestGpsBatchTransaction({
        authEmployeeId,
        authDeviceId: req.auth!.deviceId || 'UNKNOWN-DEV',
        batchId,
        records: records as IncomingLocationRecord[],
        simulateTxFailure,
        partialAckLimit,
      });
      res.json(result);
    } catch (err) {
      res.status(500).json({
        error: err instanceof Error ? err.message : 'Database transaction failed',
      });
    }
  });

  // Historical Employee Record Retrieval (Strict Employee Isolation + Pagination & Date Filtering)
  app.get('/api/sync/records/:employeeId', requireEmployeeRole, async (req: AuthenticatedRequest, res: Response) => {
    const requestedEmployeeId = String(req.params.employeeId || '').trim().toUpperCase();
    if (requestedEmployeeId !== req.auth!.employeeId) {
      res.status(403).json({
        error: `Employee isolation violation: ${req.auth!.employeeId} cannot access records for ${requestedEmployeeId}`,
        code: 'AUTH_REQUIRED',
      });
      return;
    }

    const pageParam = req.query.page ? Number(req.query.page) : undefined;
    const limitParam = req.query.limit ? Number(req.query.limit) : undefined;
    const fromDate = typeof req.query.fromDate === 'string' ? req.query.fromDate.trim() : undefined;
    const toDate = typeof req.query.toDate === 'string' ? req.query.toDate.trim() : undefined;
    const sessionId = typeof req.query.sessionId === 'string' ? req.query.sessionId.trim() : undefined;

    if ((fromDate && !isValidIsoDate(fromDate)) || (toDate && !isValidIsoDate(toDate))) {
      res.status(400).json({ error: 'fromDate and toDate must use YYYY-MM-DD format' });
      return;
    }

    try {
      const data = await listEmployeeRecords({
        employeeId: requestedEmployeeId,
        page: Number.isFinite(pageParam) ? pageParam : undefined,
        limit: Number.isFinite(limitParam) ? limitParam : undefined,
        fromDate,
        toDate,
        sessionId,
      });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load employee records' });
    }
  });

  // Restricted strictly to authorized administrative maintenance (employees cannot delete GPS history)
  app.delete('/api/sync/records/:employeeId', requireAdminRole, async (req: AuthenticatedRequest, res: Response) => {
    const requestedEmployeeId = String(req.params.employeeId || '').trim().toUpperCase();
    try {
      const removed = await deleteEmployeeRecords(requestedEmployeeId, {
        actorSubject: req.auth!.subject,
        ipAddress: req.ip || null,
        reason: typeof req.query.reason === 'string' ? req.query.reason : 'admin_maintenance_purge',
      });
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to clear employee records' });
    }
  });

  app.delete('/api/admin/records/:employeeId', requireAdminRole, async (req: AuthenticatedRequest, res: Response) => {
    const requestedEmployeeId = String(req.params.employeeId || '').trim().toUpperCase();
    try {
      const removed = await deleteEmployeeRecords(requestedEmployeeId, {
        actorSubject: req.auth!.subject,
        ipAddress: req.ip || null,
        reason: typeof req.query.reason === 'string' ? req.query.reason : 'admin_maintenance_purge',
      });
      res.json({ ok: true, removed });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to clear employee records' });
    }
  });

  // --- Administrative Role Endpoints (For Product 3 Dashboard API Consumers) ---
  app.get('/api/admin/auth/status', async (_req: Request, res: Response) => {
    try {
      res.json(await getAdminAuthStatus());
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Status check failed' });
    }
  });

  app.post('/api/admin/auth/claim', async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const ipCheck = authProtector.checkIpRateLimit('admin_claim', clientIp);
    if (!ipCheck.allowed) {
      res.setHeader('Retry-After', String(ipCheck.retryAfterSeconds));
      res.status(429).json({ error: ipCheck.reason });
      return;
    }

    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    if (passcode.length < 8) {
      res.status(400).json({ error: 'Admin passcode must be at least 8 characters' });
      return;
    }
    try {
      const result = await claimInitialAdminPasscode(passcode);
      if (!result.ok) {
        res.status(409).json({ error: result.reason || 'Admin passcode already configured' });
        return;
      }
      await recordAdminAuditLog({
        actorSubject: 'ADMIN_BOOTSTRAP',
        action: 'ADMIN_CLAIM_PASSCODE',
        ipAddress: req.ip || null,
      });
      res.status(201).json({ ok: true });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Claim failed' });
    }
  });

  app.post('/api/admin/auth/login', async (req: Request, res: Response) => {
    const clientIp = req.ip || req.socket.remoteAddress || 'unknown';
    const ipCheck = authProtector.checkIpRateLimit('admin_login', clientIp);
    if (!ipCheck.allowed) {
      res.setHeader('Retry-After', String(ipCheck.retryAfterSeconds));
      res.status(429).json({ error: ipCheck.reason });
      return;
    }

    const adminLockKey = `admin:${clientIp}`;
    const lockCheck = authProtector.checkAccountLockout(adminLockKey);
    if (!lockCheck.allowed) {
      res.setHeader('Retry-After', String(lockCheck.retryAfterSeconds));
      res.status(429).json({ error: lockCheck.reason, retryAfterSeconds: lockCheck.retryAfterSeconds });
      return;
    }

    const passcode = typeof req.body?.passcode === 'string' ? req.body.passcode.trim() : '';
    if (!passcode) {
      res.status(400).json({ error: 'Admin passcode is required' });
      return;
    }
    try {
      const valid = await verifyAdminPasscode(passcode);
      if (!valid) {
        authProtector.recordFailure(adminLockKey);
        res.status(401).json({ error: 'Invalid administrator credentials' });
        return;
      }
      authProtector.clearFailures(adminLockKey);
      const now = Date.now();
      const exp = now + 8 * 60 * 60 * 1000;
      const token = signAuthToken({
        role: 'admin',
        subject: 'ADMIN',
        iat: now,
        exp,
      });
      res.json({ token, role: 'admin', expiresAt: new Date(exp).toISOString() });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Admin login failed' });
    }
  });

  app.get('/api/admin/employees', requireAdminRole, async (_req: AuthenticatedRequest, res: Response) => {
    try {
      const employees = await listAllEmployeesAdmin();
      res.json({ count: employees.length, employees });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to list employees' });
    }
  });

  app.post('/api/admin/employees', requireAdminRole, async (req: AuthenticatedRequest, res: Response) => {
    const body = req.body as Record<string, unknown>;
    const employeeId = typeof body?.employeeId === 'string' ? body.employeeId.trim().toUpperCase() : '';
    const employeeNumber = typeof body?.employeeNumber === 'string' ? body.employeeNumber.trim().toUpperCase() : '';
    const fullNameEn = typeof body?.fullNameEn === 'string' ? body.fullNameEn.trim() : '';
    const fullNameAr = typeof body?.fullNameAr === 'string' ? body.fullNameAr.trim() : '';
    const assignedDeviceId = typeof body?.assignedDeviceId === 'string' ? body.assignedDeviceId.trim().toUpperCase() : '';
    const accountStatus = body?.accountStatus === 'inactive' ? 'inactive' : 'active';
    const plainPasscode = typeof body?.plainPasscode === 'string' ? body.plainPasscode.trim() : undefined;

    if (!/^EMP-[A-Z0-9-]{1,32}$/.test(employeeId) || !employeeNumber || !fullNameEn || !assignedDeviceId) {
      res.status(400).json({ error: 'employeeId, employeeNumber, fullNameEn, and assignedDeviceId are required' });
      return;
    }

    try {
      const saved = await upsertEmployeeAdmin({
        employeeId,
        employeeNumber,
        fullNameEn,
        fullNameAr,
        assignedDeviceId,
        accountStatus,
        plainPasscode,
      });
      await recordAdminAuditLog({
        actorSubject: req.auth!.subject,
        action: 'ADMIN_UPSERT_EMPLOYEE',
        targetEmployeeCode: saved.employeeId,
        details: { accountStatus: saved.accountStatus, assignedDeviceId: saved.assignedDeviceId },
        ipAddress: req.ip || null,
      });
      res.json(saved);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to save employee' });
    }
  });

  app.get('/api/admin/records', requireAdminRole, async (req: AuthenticatedRequest, res: Response) => {
    const employeeId = typeof req.query.employeeId === 'string' ? req.query.employeeId.trim() : undefined;
    const fromDate = typeof req.query.fromDate === 'string' ? req.query.fromDate.trim() : undefined;
    const toDate = typeof req.query.toDate === 'string' ? req.query.toDate.trim() : undefined;
    const page = req.query.page ? Number(req.query.page) : undefined;
    const limit = req.query.limit ? Number(req.query.limit) : undefined;

    if ((fromDate && !isValidIsoDate(fromDate)) || (toDate && !isValidIsoDate(toDate))) {
      res.status(400).json({ error: 'fromDate and toDate must use YYYY-MM-DD format' });
      return;
    }

    try {
      const data = await queryAdminRecords({
        employeeId,
        fromDate,
        toDate,
        page: Number.isFinite(page) ? page : undefined,
        limit: Number.isFinite(limit) ? limit : undefined,
      });
      res.json(data);
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to query records' });
    }
  });

  app.get('/api/admin/audit-logs', requireAdminRole, async (req: AuthenticatedRequest, res: Response) => {
    const limit = req.query.limit ? Number(req.query.limit) : 50;
    try {
      const logs = await listAdminAuditLogs(Number.isFinite(limit) ? limit : 50);
      res.json({ count: logs.length, logs });
    } catch (err) {
      res.status(500).json({ error: err instanceof Error ? err.message : 'Failed to load audit logs' });
    }
  });

  app.use((req: Request, res: Response) => {
    res.status(404).json({
      error: `Unknown API endpoint: ${req.method} ${req.originalUrl}`,
      code: 'UNKNOWN_ENDPOINT',
    });
  });

  app.use((err: unknown, _req: Request, res: Response, next: NextFunction) => {
    if (
      err &&
      typeof err === 'object' &&
      (('type' in err && (err as { type?: unknown }).type === 'entity.parse.failed') ||
        ('status' in err && (err as { status?: unknown }).status === 400 && err instanceof SyntaxError))
    ) {
      res.status(400).json({
        error: 'Malformed JSON request payload',
        code: 'INVALID_BATCH',
      });
      return;
    }
    next(err);
  });

  return app;
}

export async function bootstrapDatabaseAndMigrate(): Promise<void> {
  assertValidSessionSecretConfig();
  await runMigrations();
  await seedInitialEmployeesIfEmpty();
  if (process.env.SKIP_STARTUP_JSON_MIGRATION !== 'true') {
    const report = await migrateJsonStoreToPostgres();
    if (report.found) {
      console.log('[central-backend] Legacy JSON store migrated cleanly:', JSON.stringify(report));
    }
  }
}

const isMainEntry =
  process.argv[1] &&
  decodeURIComponent(new URL(import.meta.url).pathname) === pathResolveHelper(process.argv[1]);

if (isMainEntry) {
  (async () => {
    await bootstrapDatabaseAndMigrate();
    const app = createApp();
    app.listen(PORT, '0.0.0.0', () => {
      console.log(`AgriTrack Central Backend API (PostgreSQL Phase 3) listening on http://0.0.0.0:${PORT}`);
    });
  })().catch((err) => {
    console.error('[central-backend] Startup failure:', err);
    process.exit(1);
  });
}

function pathResolveHelper(p: string): string {
  return p.startsWith('/') ? p : `${process.cwd()}/${p}`;
}
