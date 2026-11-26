import 'dotenv/config';
import fs from 'node:fs';
import path from 'node:path';
import type { PoolClient } from 'pg';
import {
  computeAndroidClientDigest,
  computePwaClientDigest,
  hashScrypt,
} from '../auth/cryptoAuth.js';
import { runMigrations, seedInitialEmployeesIfEmpty } from './migrator.js';
import { closePool, getPool, withTransaction } from './pool.js';

interface LegacyJsonRecord {
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
  serverReceivedAt: string;
  batchId: string;
}

interface LegacyJsonBatch {
  batchId: string;
  employeeId: string;
  acceptedCount: number;
  duplicateCount: number;
  serverReceivedAt: string;
}

interface LegacyJsonStoreShape {
  records?: LegacyJsonRecord[];
  batches?: LegacyJsonBatch[];
}

export interface JsonMigrationReport {
  found: boolean;
  sourcePath: string;
  backupPath: string | null;
  sourceRecordCount: number;
  importedRecordCount: number;
  duplicateSkippedCount: number;
  totalDatabaseRecordsAfter: number;
}

export async function migrateJsonStoreToPostgres(
  sourceFilePath?: string,
  options: { force?: boolean } = {}
): Promise<JsonMigrationReport> {
  const defaultDataDir = process.env.SYNC_DATA_DIR
    ? path.resolve(process.env.SYNC_DATA_DIR)
    : path.resolve(process.cwd(), '.data');
  const resolvedSource = sourceFilePath
    ? path.resolve(sourceFilePath)
    : path.join(defaultDataDir, 'phase2_sync_store.json');
  const markerPath = `${resolvedSource}.migrated`;

  if (!fs.existsSync(resolvedSource) || (!options.force && !sourceFilePath && fs.existsSync(markerPath))) {
    const countRes = await getPool().query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM gps_records');
    return {
      found: false,
      sourcePath: resolvedSource,
      backupPath: null,
      sourceRecordCount: 0,
      importedRecordCount: 0,
      duplicateSkippedCount: 0,
      totalDatabaseRecordsAfter: Number(countRes.rows[0]?.cnt ?? '0'),
    };
  }

  const rawJson = fs.readFileSync(resolvedSource, 'utf8');
  const parsed = JSON.parse(rawJson) as LegacyJsonStoreShape;
  const records = Array.isArray(parsed.records) ? parsed.records : [];
  const batches = Array.isArray(parsed.batches) ? parsed.batches : [];

  // Preserve an immutable timestamped backup before importing; never delete backup
  const stamp = new Date().toISOString().replace(/[:.]/g, '-');
  const backupPath = `${resolvedSource}.bak-${stamp}`;
  fs.copyFileSync(resolvedSource, backupPath);

  const fallbackPass = process.env.DEFAULT_SEED_PASSCODE?.trim() || '2026';
  const fallbackPassHash = hashScrypt(fallbackPass);
  const fallbackPwaHash = hashScrypt(computePwaClientDigest(fallbackPass));
  const fallbackAndHash = hashScrypt(computeAndroidClientDigest(fallbackPass));

  let importedRecordCount = 0;
  let duplicateSkippedCount = 0;

  await withTransaction(async (client: PoolClient) => {
    for (const rec of records) {
      const empCode = String(rec.employeeId).trim().toUpperCase();
      const devId = String(rec.deviceId).trim().toUpperCase();

      await client.query(
        `
        INSERT INTO employees (
          employee_code, employee_number, full_name_en, full_name_ar,
          passcode_scrypt_hash, pwa_digest_scrypt_hash, android_digest_scrypt_hash,
          account_status, assigned_device_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, 'active', $8)
        ON CONFLICT (employee_code) DO NOTHING
        `,
        [
          empCode,
          `MIG-${empCode}`,
          `Migrated ${empCode}`,
          `موظف مرحّل ${empCode}`,
          fallbackPassHash,
          fallbackPwaHash,
          fallbackAndHash,
          devId,
        ]
      );

      await client.query(
        `
        INSERT INTO devices (device_identifier, employee_code, registration_status)
        VALUES ($1, $2, 'active')
        ON CONFLICT (device_identifier) DO NOTHING
        `,
        [devId, empCode]
      );

      await client.query(
        `
        INSERT INTO tracking_sessions (session_uuid, employee_code, device_identifier, session_start, session_status)
        VALUES ($1, $2, $3, $4::timestamptz, 'completed')
        ON CONFLICT (session_uuid) DO NOTHING
        `,
        [rec.sessionId, empCode, devId, rec.capturedAtIso]
      );

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
          rec.recordId,
          empCode,
          devId,
          rec.sessionId,
          rec.latitude,
          rec.longitude,
          rec.accuracyMeters,
          rec.provider,
          rec.batteryPercent,
          rec.capturedAtIso,
          rec.capturedAtEpochMs,
          rec.dateStr,
          rec.hour,
          rec.minute,
          rec.second,
          rec.serverReceivedAt || new Date().toISOString(),
          rec.batchId || 'legacy-json-import',
        ]
      );

      if (insRes.rowCount && insRes.rowCount > 0) {
        importedRecordCount++;
      } else {
        duplicateSkippedCount++;
      }
    }

    for (const batch of batches) {
      const empCode = String(batch.employeeId).trim().toUpperCase();
      await client.query(
        `
        INSERT INTO sync_batches (batch_id, employee_code, device_identifier, accepted_count, duplicate_count, server_received_at)
        VALUES ($1, $2, $3, $4, $5, $6::timestamptz)
        `,
        [
          batch.batchId,
          empCode,
          'MIGRATED-JSON',
          batch.acceptedCount ?? 0,
          batch.duplicateCount ?? 0,
          batch.serverReceivedAt || new Date().toISOString(),
        ]
      );
    }
  });

  const afterRes = await getPool().query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM gps_records');
  if (!sourceFilePath) {
    fs.writeFileSync(
      markerPath,
      JSON.stringify({ migratedAt: new Date().toISOString(), backupPath, sourceRecordCount: records.length }),
      'utf8'
    );
  }
  return {
    found: true,
    sourcePath: resolvedSource,
    backupPath,
    sourceRecordCount: records.length,
    importedRecordCount,
    duplicateSkippedCount,
    totalDatabaseRecordsAfter: Number(afterRes.rows[0]?.cnt ?? '0'),
  };
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPathHelper())) {
  (async () => {
    const srcArgIdx = process.argv.indexOf('--source');
    const sourcePath = srcArgIdx >= 0 ? process.argv[srcArgIdx + 1] : undefined;
    await runMigrations();
    await seedInitialEmployeesIfEmpty();
    const report = await migrateJsonStoreToPostgres(sourcePath);
    console.log(JSON.stringify(report, null, 2));
    await closePool();
  })().catch(async (err) => {
    console.error('[central-backend] JSON migration failed:', err);
    await closePool();
    process.exit(1);
  });
}

function fileURLToPathHelper(): string {
  return decodeURIComponent(new URL(import.meta.url).pathname);
}
