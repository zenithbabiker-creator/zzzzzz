import type { PoolClient } from 'pg';
import {
  computeAndroidClientDigest,
  computePwaClientDigest,
  generateRefreshToken,
  hashRefreshToken,
  hashScrypt,
  verifyScrypt,
} from '../auth/cryptoAuth.js';
import { getPool, withTransaction } from '../db/pool.js';

export interface IncomingLocationRecord {
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
}

export interface ServerLocationRecord extends IncomingLocationRecord {
  serverReceivedAt: string;
  batchId: string;
  syncStatus: string;
}

export interface SyncBatchHistoryItem {
  batchId: string;
  employeeId: string;
  acceptedCount: number;
  duplicateCount: number;
  serverReceivedAt: string;
}

interface EmployeeAuthRow {
  employee_code: string;
  employee_number: string;
  full_name_en: string;
  full_name_ar: string;
  passcode_scrypt_hash: string;
  pwa_digest_scrypt_hash: string;
  android_digest_scrypt_hash: string;
  account_status: string;
  assigned_device_id: string | null;
}

interface DeviceRow {
  device_identifier: string;
  employee_code: string | null;
  registration_status: string;
}

export type AuthCheckResult =
  | {
      status: 'ok';
      employeeCode: string;
      deviceId: string;
      fullNameEn: string;
      fullNameAr: string;
    }
  | {
      status: 'not_found' | 'inactive' | 'invalid_credentials' | 'device_conflict' | 'device_suspended';
      message: string;
    };

export async function authenticateEmployeeForSession(params: {
  employeeId: string;
  deviceId: string;
  passcode?: string;
  passcodeHash?: string;
}): Promise<AuthCheckResult> {
  const empCode = params.employeeId.trim().toUpperCase();
  const devId = params.deviceId.trim().toUpperCase();
  const pool = getPool();

  const empRes = await pool.query<EmployeeAuthRow>(
    `
    SELECT employee_code, employee_number, full_name_en, full_name_ar,
           passcode_scrypt_hash, pwa_digest_scrypt_hash, android_digest_scrypt_hash,
           account_status, assigned_device_id
    FROM employees
    WHERE employee_code = $1 OR employee_number = $1
    LIMIT 1
    `,
    [empCode]
  );

  const emp = empRes.rows[0];
  if (!emp) {
    return { status: 'not_found', message: 'Employee account not found' };
  }
  if (emp.account_status !== 'active') {
    return { status: 'inactive', message: 'Employee account is inactive' };
  }

  let credentialValid = false;
  if (params.passcode && params.passcode.trim().length > 0) {
    credentialValid = verifyScrypt(params.passcode.trim(), emp.passcode_scrypt_hash);
  } else if (
    process.env.NODE_ENV !== 'production' &&
    process.env.ALLOW_LEGACY_PWA_DIGEST === 'true' &&
    params.passcodeHash &&
    params.passcodeHash.trim().length >= 8
  ) {
    const candidate = params.passcodeHash.trim().toLowerCase();
    credentialValid = verifyScrypt(candidate, emp.pwa_digest_scrypt_hash);
  }

  if (!credentialValid) {
    return { status: 'invalid_credentials', message: 'Invalid employee passcode' };
  }

  return withTransaction(async (client: PoolClient) => {
    const devRes = await client.query<DeviceRow>(
      `
      SELECT device_identifier, employee_code, registration_status
      FROM devices
      WHERE device_identifier = $1
      FOR UPDATE
      `,
      [devId]
    );

    const existingDev = devRes.rows[0];
    if (existingDev) {
      if (existingDev.registration_status !== 'active') {
        return {
          status: 'device_suspended',
          message: `Device ${devId} is ${existingDev.registration_status}`,
        };
      }
      if (existingDev.employee_code && existingDev.employee_code !== emp.employee_code) {
        return {
          status: 'device_conflict',
          message: `Device ${devId} is currently assigned to another employee`,
        };
      }
      await client.query(
        `UPDATE devices SET employee_code = $1, last_seen_at = NOW() WHERE device_identifier = $2`,
        [emp.employee_code, devId]
      );
    } else {
      await client.query(
        `
        INSERT INTO devices (device_identifier, employee_code, registration_status, last_seen_at)
        VALUES ($1, $2, 'active', NOW())
        `,
        [devId, emp.employee_code]
      );
    }

    if (!emp.assigned_device_id) {
      await client.query(
        `UPDATE employees SET assigned_device_id = $1, updated_at = NOW() WHERE employee_code = $2`,
        [devId, emp.employee_code]
      );
    }

    return {
      status: 'ok' as const,
      employeeCode: emp.employee_code,
      deviceId: devId,
      fullNameEn: emp.full_name_en,
      fullNameAr: emp.full_name_ar,
    };
  });
}

export async function startEmployeeTrackingSession(params: {
  sessionId: string;
  employeeId: string;
  deviceId: string;
  startedAtIso?: string;
}): Promise<{ sessionId: string; status: string; startedAt: string }> {
  const empCode = params.employeeId.trim().toUpperCase();
  const devId = params.deviceId.trim().toUpperCase();
  const startedAt = params.startedAtIso || new Date().toISOString();

  return withTransaction(async (client: PoolClient) => {
    await client.query(
      `
      INSERT INTO devices (device_identifier, employee_code, registration_status, last_seen_at)
      VALUES ($1, $2, 'active', NOW())
      ON CONFLICT (device_identifier) DO UPDATE SET last_seen_at = NOW()
      `,
      [devId, empCode]
    );

    // Never revert an already-completed or interrupted session back to active if a retried START arrives late.
    const res = await client.query<{ session_uuid: string; session_status: string; session_start: Date }>(
      `
      INSERT INTO tracking_sessions (session_uuid, employee_code, device_identifier, session_start, session_status)
      VALUES ($1, $2, $3, $4::timestamptz, 'active')
      ON CONFLICT (session_uuid) DO UPDATE
      SET session_start = LEAST(tracking_sessions.session_start, EXCLUDED.session_start)
      RETURNING session_uuid, session_status, session_start
      `,
      [params.sessionId, empCode, devId, startedAt]
    );
    const row = res.rows[0];
    return {
      sessionId: row.session_uuid,
      status: row.session_status,
      startedAt: row.session_start.toISOString(),
    };
  });
}

export async function stopEmployeeTrackingSession(params: {
  sessionId: string;
  employeeId: string;
  endedAtIso?: string;
  deviceId?: string;
  startedAtIso?: string;
  status?: 'completed' | 'interrupted';
}): Promise<{ found: boolean; sessionId: string; status?: string; endedAt?: string }> {
  const empCode = params.employeeId.trim().toUpperCase();
  const endedAt = params.endedAtIso || new Date().toISOString();
  const targetStatus = params.status === 'interrupted' ? 'interrupted' : 'completed';

  return withTransaction(async (client: PoolClient) => {
    const upd = await client.query<{
      session_uuid: string;
      session_status: string;
      session_end: Date | null;
    }>(
      `
      UPDATE tracking_sessions
      SET session_status = CASE
            WHEN session_status = 'completed' THEN 'completed'
            ELSE $4
          END,
          session_end = COALESCE(session_end, $3::timestamptz)
      WHERE session_uuid = $1 AND employee_code = $2
      RETURNING session_uuid, session_status, session_end
      `,
      [params.sessionId, empCode, endedAt, targetStatus]
    );

    if (upd.rowCount && upd.rowCount > 0) {
      const row = upd.rows[0];
      return {
        found: true,
        sessionId: row.session_uuid,
        status: row.session_status,
        endedAt: row.session_end?.toISOString(),
      };
    }

    // If an offline session stopped before START reached the backend (including 0-GPS sessions),
    // upsert the closed session atomically when deviceId is provided.
    if (params.deviceId && params.deviceId.trim().length > 0) {
      const devId = params.deviceId.trim().toUpperCase();
      const startedAt = params.startedAtIso || endedAt;

      await client.query(
        `
        INSERT INTO devices (device_identifier, employee_code, registration_status, last_seen_at)
        VALUES ($1, $2, 'active', NOW())
        ON CONFLICT (device_identifier) DO UPDATE SET last_seen_at = NOW()
        `,
        [devId, empCode]
      );

      const ins = await client.query<{
        session_uuid: string;
        session_status: string;
        session_end: Date | null;
      }>(
        `
        INSERT INTO tracking_sessions (
          session_uuid, employee_code, device_identifier, session_start, session_end, session_status
        ) VALUES ($1, $2, $3, $4::timestamptz, $5::timestamptz, $6)
        ON CONFLICT (session_uuid) DO UPDATE
        SET session_status = CASE
              WHEN tracking_sessions.session_status = 'completed' THEN 'completed'
              ELSE EXCLUDED.session_status
            END,
            session_end = COALESCE(tracking_sessions.session_end, EXCLUDED.session_end),
            session_start = LEAST(tracking_sessions.session_start, EXCLUDED.session_start)
        RETURNING session_uuid, session_status, session_end
        `,
        [params.sessionId, empCode, devId, startedAt, endedAt, targetStatus]
      );
      const row = ins.rows[0];
      return {
        found: true,
        sessionId: row.session_uuid,
        status: row.session_status,
        endedAt: row.session_end?.toISOString(),
      };
    }

    return { found: false, sessionId: params.sessionId };
  });
}

export async function listEmployeeTrackingSessions(params: {
  employeeId: string;
  sessionId?: string;
}): Promise<
  Array<{
    sessionId: string;
    employeeId: string;
    deviceId: string;
    startedAt: string;
    endedAt: string | null;
    status: string;
    recordCount: number;
  }>
> {
  const empCode = params.employeeId.trim().toUpperCase();
  const values: unknown[] = [empCode];
  let sessionFilter = '';
  if (params.sessionId) {
    sessionFilter = 'AND ts.session_uuid = $2';
    values.push(params.sessionId);
  }
  const res = await getPool().query<{
    session_uuid: string;
    employee_code: string;
    device_identifier: string;
    session_start: Date;
    session_end: Date | null;
    session_status: string;
    record_count: string;
  }>(
    `
    SELECT ts.session_uuid, ts.employee_code, ts.device_identifier,
           ts.session_start, ts.session_end, ts.session_status,
           COUNT(gr.id)::text AS record_count
    FROM tracking_sessions ts
    LEFT JOIN gps_records gr ON gr.session_uuid = ts.session_uuid
    WHERE ts.employee_code = $1 ${sessionFilter}
    GROUP BY ts.id
    ORDER BY ts.session_start DESC
    LIMIT 100
    `,
    values
  );

  return res.rows.map((r) => ({
    sessionId: r.session_uuid,
    employeeId: r.employee_code,
    deviceId: r.device_identifier,
    startedAt: r.session_start.toISOString(),
    endedAt: r.session_end ? r.session_end.toISOString() : null,
    status: r.session_status,
    recordCount: Number(r.record_count),
  }));
}

export async function ingestGpsBatchTransaction(params: {
  authEmployeeId: string;
  authDeviceId: string;
  batchId: string;
  records: IncomingLocationRecord[];
  simulateTxFailure?: boolean;
  partialAckLimit?: number;
}): Promise<{
  batchId: string;
  serverReceivedAt: string;
  acceptedIds: string[];
  duplicateIds: string[];
  totalPersistedForEmployee: number;
}> {
  const empCode = params.authEmployeeId.trim().toUpperCase();
  const fallbackDevId = params.authDeviceId.trim().toUpperCase();

  return withTransaction(async (client: PoolClient) => {
    const serverTimeRes = await client.query<{ now_iso: Date }>('SELECT NOW() AS now_iso');
    const serverReceivedAt = serverTimeRes.rows[0].now_iso.toISOString();

    const acceptedIds: string[] = [];
    const duplicateIds: string[] = [];
    const seenDevices = new Set<string>([fallbackDevId]);
    const seenSessions = new Map<string, { deviceId: string; earliestIso: string }>();

    for (const rec of params.records) {
      const recDevice = (rec.deviceId || fallbackDevId).trim().toUpperCase();
      seenDevices.add(recDevice);
      const existingSess = seenSessions.get(rec.sessionId);
      if (!existingSess || rec.capturedAtIso < existingSess.earliestIso) {
        seenSessions.set(rec.sessionId, { deviceId: recDevice, earliestIso: rec.capturedAtIso });
      }
    }

    for (const devId of seenDevices) {
      const devCheck = await client.query<{ employee_code: string | null; registration_status: string }>(
        `SELECT employee_code, registration_status FROM devices WHERE device_identifier = $1`,
        [devId]
      );
      if (devCheck.rowCount === 0) {
        await client.query(
          `
          INSERT INTO devices (device_identifier, employee_code, registration_status, last_seen_at)
          VALUES ($1, $2, 'active', NOW())
          ON CONFLICT (device_identifier) DO NOTHING
          `,
          [devId, empCode]
        );
      } else {
        await client.query(
          `UPDATE devices SET last_seen_at = NOW() WHERE device_identifier = $1`,
          [devId]
        );
      }
    }

    for (const [sessionId, meta] of seenSessions.entries()) {
      await client.query(
        `
        INSERT INTO tracking_sessions (
          session_uuid, employee_code, device_identifier, session_start, session_status
        ) VALUES ($1, $2, $3, $4::timestamptz, 'active')
        ON CONFLICT (session_uuid) DO NOTHING
        `,
        [sessionId, empCode, meta.deviceId, meta.earliestIso]
      );
    }

    const recordsToPersist =
      params.partialAckLimit !== undefined
        ? params.records.slice(0, params.partialAckLimit)
        : params.records;

    for (const item of recordsToPersist) {
      const recDevice = (item.deviceId || fallbackDevId).trim().toUpperCase();
      const insRes = await client.query<{ record_uuid: string }>(
        `
        INSERT INTO gps_records (
          record_uuid, employee_code, device_identifier, session_uuid,
          latitude, longitude, accuracy_meters, provider, battery_percent,
          captured_at, captured_at_epoch_ms, captured_date,
          captured_hour, captured_minute, captured_second,
          server_received_at, batch_id, sync_status
        ) VALUES (
          $1, $2, $3, $4,
          $5, $6, $7, $8, $9,
          $10::timestamptz, $11, $12::date,
          $13, $14, $15,
          $16::timestamptz, $17, 'SYNCED'
        )
        ON CONFLICT (record_uuid) DO NOTHING
        RETURNING record_uuid
        `,
        [
          item.recordId,
          empCode,
          recDevice,
          item.sessionId,
          item.latitude,
          item.longitude,
          item.accuracyMeters,
          item.provider,
          item.batteryPercent,
          item.capturedAtIso,
          item.capturedAtEpochMs,
          item.dateStr,
          item.hour,
          item.minute,
          item.second,
          serverReceivedAt,
          params.batchId,
        ]
      );

      if (insRes.rowCount && insRes.rowCount > 0) {
        acceptedIds.push(item.recordId);
      } else {
        duplicateIds.push(item.recordId);
      }
    }

    if (params.simulateTxFailure) {
      throw new Error('Simulated database transaction failure before COMMIT');
    }

    await client.query(
      `
      INSERT INTO sync_batches (
        batch_id, employee_code, device_identifier, accepted_count, duplicate_count, server_received_at
      ) VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
      `,
      [params.batchId, empCode, fallbackDevId, acceptedIds.length, duplicateIds.length, serverReceivedAt]
    );

    const totalRes = await client.query<{ cnt: string }>(
      'SELECT COUNT(*)::text AS cnt FROM gps_records WHERE employee_code = $1',
      [empCode]
    );

    return {
      batchId: params.batchId,
      serverReceivedAt,
      acceptedIds,
      duplicateIds,
      totalPersistedForEmployee: Number(totalRes.rows[0]?.cnt ?? '0'),
    };
  });
}

export async function listEmployeeRecords(params: {
  employeeId: string;
  page?: number;
  limit?: number;
  fromDate?: string;
  toDate?: string;
  sessionId?: string;
}): Promise<{
  employeeId: string;
  count: number;
  totalCount: number;
  page: number;
  limit: number;
  records: ServerLocationRecord[];
  recentBatches: SyncBatchHistoryItem[];
}> {
  const empCode = params.employeeId.trim().toUpperCase();
  const pool = getPool();

  const conditions: string[] = ['employee_code = $1'];
  const values: unknown[] = [empCode];
  let idx = 2;

  if (params.fromDate) {
    conditions.push(`captured_date >= $${idx}::date`);
    values.push(params.fromDate);
    idx++;
  }
  if (params.toDate) {
    conditions.push(`captured_date <= $${idx}::date`);
    values.push(params.toDate);
    idx++;
  }
  if (params.sessionId) {
    conditions.push(`session_uuid = $${idx}`);
    values.push(params.sessionId);
    idx++;
  }

  const whereClause = conditions.join(' AND ');
  const countRes = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM gps_records WHERE ${whereClause}`,
    values
  );
  const totalCount = Number(countRes.rows[0]?.cnt ?? '0');

  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(2000, Math.max(1, params.limit ?? 2000));
  const offset = (page - 1) * limit;

  const rowsRes = await pool.query<{
    record_uuid: string;
    session_uuid: string;
    employee_code: string;
    device_identifier: string;
    latitude: number;
    longitude: number;
    captured_at: Date;
    captured_at_epoch_ms: string;
    captured_date: Date | string;
    captured_hour: number;
    captured_minute: number;
    captured_second: number;
    accuracy_meters: number;
    provider: string;
    battery_percent: number | null;
    server_received_at: Date;
    batch_id: string;
    sync_status: string;
  }>(
    `
    SELECT record_uuid, session_uuid, employee_code, device_identifier,
           latitude, longitude, captured_at, captured_at_epoch_ms::text,
           captured_date::text AS captured_date,
           captured_hour, captured_minute, captured_second,
           accuracy_meters, provider, battery_percent,
           server_received_at, batch_id, sync_status
    FROM gps_records
    WHERE ${whereClause}
    ORDER BY captured_at_epoch_ms DESC
    LIMIT $${idx} OFFSET $${idx + 1}
    `,
    [...values, limit, offset]
  );

  const records: ServerLocationRecord[] = rowsRes.rows.map((r) => ({
    recordId: r.record_uuid,
    sessionId: r.session_uuid,
    employeeId: r.employee_code,
    deviceId: r.device_identifier,
    latitude: Number(r.latitude),
    longitude: Number(r.longitude),
    capturedAtIso: r.captured_at.toISOString(),
    capturedAtEpochMs: Number(r.captured_at_epoch_ms),
    dateStr: typeof r.captured_date === 'string' ? r.captured_date.slice(0, 10) : r.captured_date.toISOString().slice(0, 10),
    hour: r.captured_hour,
    minute: r.captured_minute,
    second: r.captured_second,
    accuracyMeters: Number(r.accuracy_meters),
    provider: r.provider,
    batteryPercent: r.battery_percent,
    serverReceivedAt: r.server_received_at.toISOString(),
    batchId: r.batch_id,
    syncStatus: r.sync_status,
  }));

  const batchesRes = await pool.query<{
    batch_id: string;
    employee_code: string;
    accepted_count: number;
    duplicate_count: number;
    server_received_at: Date;
  }>(
    `
    SELECT batch_id, employee_code, accepted_count, duplicate_count, server_received_at
    FROM sync_batches
    WHERE employee_code = $1
    ORDER BY server_received_at DESC
    LIMIT 20
    `,
    [empCode]
  );

  const recentBatches: SyncBatchHistoryItem[] = batchesRes.rows.map((b) => ({
    batchId: b.batch_id,
    employeeId: b.employee_code,
    acceptedCount: b.accepted_count,
    duplicateCount: b.duplicate_count,
    serverReceivedAt: b.server_received_at.toISOString(),
  }));

  return {
    employeeId: empCode,
    count: records.length,
    totalCount,
    page,
    limit,
    records,
    recentBatches,
  };
}

export async function issueEmployeeRefreshToken(params: {
  employeeId: string;
  deviceId: string;
  ttlDays?: number;
}): Promise<{ refreshToken: string; refreshExpiresAt: string }> {
  const empCode = params.employeeId.trim().toUpperCase();
  const devId = params.deviceId.trim().toUpperCase();
  const rawToken = generateRefreshToken();
  const tokenHash = hashRefreshToken(rawToken);
  const ttlDays = Math.max(1, params.ttlDays ?? 45);
  const expiresAt = new Date(Date.now() + ttlDays * 24 * 60 * 60 * 1000);

  await getPool().query(
    `
    INSERT INTO device_refresh_tokens (token_hash_sha256, employee_code, device_identifier, expires_at)
    VALUES ($1, $2, $3, $4::timestamptz)
    `,
    [tokenHash, empCode, devId, expiresAt.toISOString()]
  );

  return {
    refreshToken: rawToken,
    refreshExpiresAt: expiresAt.toISOString(),
  };
}

export async function rotateEmployeeRefreshToken(params: {
  employeeId: string;
  deviceId: string;
  rawRefreshToken: string;
}): Promise<
  | {
      status: 'ok';
      employeeCode: string;
      deviceId: string;
      refreshToken: string;
      refreshExpiresAt: string;
    }
  | { status: 'invalid' | 'inactive' | 'device_suspended'; message: string }
> {
  const empCode = params.employeeId.trim().toUpperCase();
  const devId = params.deviceId.trim().toUpperCase();
  const tokenHash = hashRefreshToken(params.rawRefreshToken);

  return withTransaction(async (client: PoolClient) => {
    const tokRes = await client.query<{
      id: string;
      employee_code: string;
      device_identifier: string;
      expires_at: Date;
      revoked_at: Date | null;
      account_status: string;
      registration_status: string;
    }>(
      `
      SELECT t.id::text, t.employee_code, t.device_identifier, t.expires_at, t.revoked_at,
             e.account_status, d.registration_status
      FROM device_refresh_tokens t
      JOIN employees e ON e.employee_code = t.employee_code
      JOIN devices d ON d.device_identifier = t.device_identifier
      WHERE t.token_hash_sha256 = $1
      FOR UPDATE
      `,
      [tokenHash]
    );

    const row = tokRes.rows[0];
    if (!row || row.employee_code !== empCode || row.device_identifier !== devId) {
      return { status: 'invalid', message: 'Invalid refresh token' };
    }
    if (row.revoked_at || row.expires_at.getTime() <= Date.now()) {
      return { status: 'invalid', message: 'Refresh token expired or revoked' };
    }
    if (row.account_status !== 'active') {
      return { status: 'inactive', message: 'Employee account is inactive' };
    }
    if (row.registration_status !== 'active') {
      return { status: 'device_suspended', message: `Device ${devId} is ${row.registration_status}` };
    }

    // Revoke used token (rotation) and issue a fresh 45-day token
    await client.query(
      'UPDATE device_refresh_tokens SET revoked_at = NOW(), last_used_at = NOW() WHERE id = $1',
      [row.id]
    );

    const newRaw = generateRefreshToken();
    const newHash = hashRefreshToken(newRaw);
    const expiresAt = new Date(Date.now() + 45 * 24 * 60 * 60 * 1000);
    await client.query(
      `
      INSERT INTO device_refresh_tokens (token_hash_sha256, employee_code, device_identifier, expires_at)
      VALUES ($1, $2, $3, $4::timestamptz)
      `,
      [newHash, empCode, devId, expiresAt.toISOString()]
    );
    await client.query(
      'UPDATE devices SET last_seen_at = NOW() WHERE device_identifier = $1',
      [devId]
    );

    return {
      status: 'ok' as const,
      employeeCode: empCode,
      deviceId: devId,
      refreshToken: newRaw,
      refreshExpiresAt: expiresAt.toISOString(),
    };
  });
}

export async function revokeEmployeeRefreshTokens(params: {
  employeeId: string;
  deviceId?: string;
}): Promise<number> {
  const empCode = params.employeeId.trim().toUpperCase();
  if (params.deviceId) {
    const res = await getPool().query(
      `
      UPDATE device_refresh_tokens
      SET revoked_at = NOW()
      WHERE employee_code = $1 AND device_identifier = $2 AND revoked_at IS NULL
      `,
      [empCode, params.deviceId.trim().toUpperCase()]
    );
    return res.rowCount ?? 0;
  }
  const res = await getPool().query(
    `
    UPDATE device_refresh_tokens
    SET revoked_at = NOW()
    WHERE employee_code = $1 AND revoked_at IS NULL
    `,
    [empCode]
  );
  return res.rowCount ?? 0;
}

export async function recordAdminAuditLog(params: {
  actorSubject: string;
  action: string;
  targetEmployeeCode?: string | null;
  details?: Record<string, unknown>;
  ipAddress?: string | null;
}): Promise<void> {
  await getPool().query(
    `
    INSERT INTO admin_audit_logs (actor_subject, action, target_employee_code, details_json, ip_address)
    VALUES ($1, $2, $3, $4::jsonb, $5)
    `,
    [
      params.actorSubject,
      params.action,
      params.targetEmployeeCode ?? null,
      JSON.stringify(params.details ?? {}),
      params.ipAddress ?? null,
    ]
  );
}

export async function listAdminAuditLogs(limit = 50): Promise<
  Array<{
    id: number;
    actorSubject: string;
    action: string;
    targetEmployeeCode: string | null;
    details: Record<string, unknown>;
    ipAddress: string | null;
    createdAt: string;
  }>
> {
  const safeLimit = Math.min(200, Math.max(1, limit));
  const res = await getPool().query<{
    id: string;
    actor_subject: string;
    action: string;
    target_employee_code: string | null;
    details_json: Record<string, unknown>;
    ip_address: string | null;
    created_at: Date;
  }>(
    `
    SELECT id::text, actor_subject, action, target_employee_code, details_json, ip_address, created_at
    FROM admin_audit_logs
    ORDER BY created_at DESC
    LIMIT $1
    `,
    [safeLimit]
  );
  return res.rows.map((r) => ({
    id: Number(r.id),
    actorSubject: r.actor_subject,
    action: r.action,
    targetEmployeeCode: r.target_employee_code,
    details: r.details_json,
    ipAddress: r.ip_address,
    createdAt: r.created_at.toISOString(),
  }));
}

export async function deleteEmployeeRecords(
  employeeId: string,
  audit?: { actorSubject: string; ipAddress?: string | null; reason?: string }
): Promise<number> {
  const empCode = employeeId.trim().toUpperCase();
  return withTransaction(async (client: PoolClient) => {
    const delRecs = await client.query(
      'DELETE FROM gps_records WHERE employee_code = $1',
      [empCode]
    );
    const delBatches = await client.query('DELETE FROM sync_batches WHERE employee_code = $1', [empCode]);
    const delSessions = await client.query('DELETE FROM tracking_sessions WHERE employee_code = $1', [empCode]);
    const removedCount = delRecs.rowCount ?? 0;

    await client.query(
      `
      INSERT INTO admin_audit_logs (actor_subject, action, target_employee_code, details_json, ip_address)
      VALUES ($1, 'ADMIN_PURGE_EMPLOYEE_RECORDS', $2, $3::jsonb, $4)
      `,
      [
        audit?.actorSubject || 'ADMIN',
        empCode,
        JSON.stringify({
          removedGpsRecords: removedCount,
          removedBatches: delBatches.rowCount ?? 0,
          removedSessions: delSessions.rowCount ?? 0,
          reason: audit?.reason || 'administrative_maintenance',
        }),
        audit?.ipAddress ?? null,
      ]
    );

    return removedCount;
  });
}

export async function getHealthMetrics(): Promise<{
  persistedRecords: number;
  totalBatches: number;
  activeEmployees: number;
  registeredDevices: number;
}> {
  const pool = getPool();
  const res = await pool.query<{
    persisted_records: string;
    total_batches: string;
    active_employees: string;
    registered_devices: string;
  }>(`
    SELECT
      (SELECT COUNT(*)::text FROM gps_records) AS persisted_records,
      (SELECT COUNT(*)::text FROM sync_batches) AS total_batches,
      (SELECT COUNT(*)::text FROM employees WHERE account_status = 'active') AS active_employees,
      (SELECT COUNT(*)::text FROM devices WHERE registration_status = 'active') AS registered_devices
  `);
  const row = res.rows[0];
  return {
    persistedRecords: Number(row?.persisted_records ?? '0'),
    totalBatches: Number(row?.total_batches ?? '0'),
    activeEmployees: Number(row?.active_employees ?? '0'),
    registeredDevices: Number(row?.registered_devices ?? '0'),
  };
}

// --- Admin Credentials & Management Queries (for Product 3 API consumers) ---

export async function getAdminAuthStatus(): Promise<{ envConfigured: boolean; claimed: boolean }> {
  const envPass = process.env.ADMIN_PASSCODE?.trim() || '';
  if (envPass.length > 0) {
    return { envConfigured: true, claimed: true };
  }
  const res = await getPool().query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM admin_credentials');
  return {
    envConfigured: false,
    claimed: Number(res.rows[0]?.cnt ?? '0') > 0,
  };
}

export async function claimInitialAdminPasscode(passcode: string): Promise<{ ok: boolean; reason?: string }> {
  const envPass = process.env.ADMIN_PASSCODE?.trim() || '';
  if (envPass.length > 0) {
    return { ok: false, reason: 'ADMIN_PASSCODE environment variable is already configured' };
  }
  const hashed = hashScrypt(passcode);
  const res = await getPool().query(
    `
    INSERT INTO admin_credentials (id, passcode_scrypt_hash)
    VALUES (1, $1)
    ON CONFLICT (id) DO NOTHING
    RETURNING id
    `,
    [hashed]
  );
  if (res.rowCount === 0) {
    return { ok: false, reason: 'Admin credentials already claimed' };
  }
  return { ok: true };
}

export async function verifyAdminPasscode(passcode: string): Promise<boolean> {
  const envPass = process.env.ADMIN_PASSCODE?.trim() || '';
  if (envPass.length > 0) {
    return passcode === envPass;
  }
  const res = await getPool().query<{ passcode_scrypt_hash: string }>(
    'SELECT passcode_scrypt_hash FROM admin_credentials WHERE id = 1 LIMIT 1'
  );
  const stored = res.rows[0]?.passcode_scrypt_hash;
  if (!stored) return false;
  return verifyScrypt(passcode, stored);
}

export async function listAllEmployeesAdmin(): Promise<
  Array<{
    employeeId: string;
    employeeNumber: string;
    fullNameEn: string;
    fullNameAr: string;
    assignedDeviceId: string | null;
    accountStatus: string;
    createdAt: string;
    updatedAt: string;
  }>
> {
  const res = await getPool().query<{
    employee_code: string;
    employee_number: string;
    full_name_en: string;
    full_name_ar: string;
    assigned_device_id: string | null;
    account_status: string;
    created_at: Date;
    updated_at: Date;
  }>(
    `
    SELECT employee_code, employee_number, full_name_en, full_name_ar,
           assigned_device_id, account_status, created_at, updated_at
    FROM employees
    ORDER BY employee_code ASC
    `
  );
  return res.rows.map((r) => ({
    employeeId: r.employee_code,
    employeeNumber: r.employee_number,
    fullNameEn: r.full_name_en,
    fullNameAr: r.full_name_ar,
    assignedDeviceId: r.assigned_device_id,
    accountStatus: r.account_status,
    createdAt: r.created_at.toISOString(),
    updatedAt: r.updated_at.toISOString(),
  }));
}

export async function upsertEmployeeAdmin(params: {
  employeeId: string;
  employeeNumber: string;
  fullNameEn: string;
  fullNameAr: string;
  assignedDeviceId: string;
  accountStatus: 'active' | 'inactive';
  plainPasscode?: string;
}): Promise<{ employeeId: string; accountStatus: string; assignedDeviceId: string }> {
  const empCode = params.employeeId.trim().toUpperCase();
  const empNum = params.employeeNumber.trim().toUpperCase();
  const devId = params.assignedDeviceId.trim().toUpperCase();
  const pass = params.plainPasscode?.trim() || '2026';

  const passcodeScryptHash = hashScrypt(pass);
  const pwaDigestScryptHash = hashScrypt(computePwaClientDigest(pass));
  const androidDigestScryptHash = hashScrypt(computeAndroidClientDigest(pass));

  return withTransaction(async (client: PoolClient) => {
    const existing = await client.query<{ employee_code: string }>(
      'SELECT employee_code FROM employees WHERE employee_code = $1',
      [empCode]
    );

    if (existing.rowCount === 0) {
      await client.query(
        `
        INSERT INTO employees (
          employee_code, employee_number, full_name_en, full_name_ar,
          passcode_scrypt_hash, pwa_digest_scrypt_hash, android_digest_scrypt_hash,
          account_status, assigned_device_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        `,
        [
          empCode,
          empNum,
          params.fullNameEn.trim(),
          params.fullNameAr.trim() || params.fullNameEn.trim(),
          passcodeScryptHash,
          pwaDigestScryptHash,
          androidDigestScryptHash,
          params.accountStatus,
          devId,
        ]
      );
    } else if (params.plainPasscode && params.plainPasscode.trim().length > 0) {
      await client.query(
        `
        UPDATE employees
        SET employee_number = $2,
            full_name_en = $3,
            full_name_ar = $4,
            account_status = $5,
            assigned_device_id = $6,
            passcode_scrypt_hash = $7,
            pwa_digest_scrypt_hash = $8,
            android_digest_scrypt_hash = $9,
            updated_at = NOW()
        WHERE employee_code = $1
        `,
        [
          empCode,
          empNum,
          params.fullNameEn.trim(),
          params.fullNameAr.trim() || params.fullNameEn.trim(),
          params.accountStatus,
          devId,
          passcodeScryptHash,
          pwaDigestScryptHash,
          androidDigestScryptHash,
        ]
      );
    } else {
      await client.query(
        `
        UPDATE employees
        SET employee_number = $2,
            full_name_en = $3,
            full_name_ar = $4,
            account_status = $5,
            assigned_device_id = $6,
            updated_at = NOW()
        WHERE employee_code = $1
        `,
        [
          empCode,
          empNum,
          params.fullNameEn.trim(),
          params.fullNameAr.trim() || params.fullNameEn.trim(),
          params.accountStatus,
          devId,
        ]
      );
    }

    await client.query(
      `
      INSERT INTO devices (device_identifier, employee_code, registration_status)
      VALUES ($1, $2, $3)
      ON CONFLICT (device_identifier) DO UPDATE
      SET employee_code = $2,
          registration_status = $3,
          last_seen_at = NOW()
      `,
      [devId, empCode, params.accountStatus === 'active' ? 'active' : 'suspended']
    );

    return {
      employeeId: empCode,
      accountStatus: params.accountStatus,
      assignedDeviceId: devId,
    };
  });
}

export async function queryAdminRecords(params: {
  employeeId?: string;
  fromDate?: string;
  toDate?: string;
  page?: number;
  limit?: number;
}): Promise<{
  totalCount: number;
  page: number;
  limit: number;
  records: ServerLocationRecord[];
}> {
  const conditions: string[] = [];
  const values: unknown[] = [];
  let idx = 1;

  if (params.employeeId) {
    conditions.push(`employee_code = $${idx}`);
    values.push(params.employeeId.trim().toUpperCase());
    idx++;
  }
  if (params.fromDate) {
    conditions.push(`captured_date >= $${idx}::date`);
    values.push(params.fromDate);
    idx++;
  }
  if (params.toDate) {
    conditions.push(`captured_date <= $${idx}::date`);
    values.push(params.toDate);
    idx++;
  }

  const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';
  const pool = getPool();
  const countRes = await pool.query<{ cnt: string }>(
    `SELECT COUNT(*)::text AS cnt FROM gps_records ${whereClause}`,
    values
  );
  const totalCount = Number(countRes.rows[0]?.cnt ?? '0');

  const page = Math.max(1, params.page ?? 1);
  const limit = Math.min(500, Math.max(1, params.limit ?? 100));
  const offset = (page - 1) * limit;

  const rowsRes = await pool.query<{
    record_uuid: string;
    session_uuid: string;
    employee_code: string;
    device_identifier: string;
    latitude: number;
    longitude: number;
    captured_at: Date;
    captured_at_epoch_ms: string;
    captured_date: Date | string;
    captured_hour: number;
    captured_minute: number;
    captured_second: number;
    accuracy_meters: number;
    provider: string;
    battery_percent: number | null;
    server_received_at: Date;
    batch_id: string;
    sync_status: string;
  }>(
    `
    SELECT record_uuid, session_uuid, employee_code, device_identifier,
           latitude, longitude, captured_at, captured_at_epoch_ms::text,
           captured_date::text AS captured_date,
           captured_hour, captured_minute, captured_second,
           accuracy_meters, provider, battery_percent,
           server_received_at, batch_id, sync_status
    FROM gps_records
    ${whereClause}
    ORDER BY captured_at_epoch_ms DESC
    LIMIT $${idx} OFFSET $${idx + 1}
    `,
    [...values, limit, offset]
  );

  return {
    totalCount,
    page,
    limit,
    records: rowsRes.rows.map((r) => ({
      recordId: r.record_uuid,
      sessionId: r.session_uuid,
      employeeId: r.employee_code,
      deviceId: r.device_identifier,
      latitude: Number(r.latitude),
      longitude: Number(r.longitude),
      capturedAtIso: r.captured_at.toISOString(),
      capturedAtEpochMs: Number(r.captured_at_epoch_ms),
      dateStr: typeof r.captured_date === 'string' ? r.captured_date.slice(0, 10) : r.captured_date.toISOString().slice(0, 10),
      hour: r.captured_hour,
      minute: r.captured_minute,
      second: r.captured_second,
      accuracyMeters: Number(r.accuracy_meters),
      provider: r.provider,
      batteryPercent: r.battery_percent,
      serverReceivedAt: r.server_received_at.toISOString(),
      batchId: r.batch_id,
      syncStatus: r.sync_status,
    })),
  };
}
