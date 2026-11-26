import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import type { PoolClient } from 'pg';
import {
  computeAndroidClientDigest,
  computePwaClientDigest,
  hashScrypt,
} from '../auth/cryptoAuth.js';
import { getPool, withTransaction } from './pool.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const MIGRATIONS_DIR = path.resolve(__dirname, '../../migrations');

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

export async function runMigrations(): Promise<{ appliedVersions: string[] }> {
  const pool = getPool();

  await pool.query(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
  `);

  const existingRes = await pool.query<{ version: string }>(
    'SELECT version FROM schema_migrations ORDER BY version ASC'
  );
  const appliedSet = new Set(existingRes.rows.map((r) => r.version));

  const files = fs
    .readdirSync(MIGRATIONS_DIR)
    .filter((f) => f.endsWith('.sql'))
    .sort((a, b) => a.localeCompare(b));

  const newlyApplied: string[] = [];

  for (const file of files) {
    const version = file.split('_')[0] || file;
    if (appliedSet.has(version)) continue;

    const sql = fs.readFileSync(path.join(MIGRATIONS_DIR, file), 'utf8');
    await withTransaction(async (client: PoolClient) => {
      await client.query(sql);
      await client.query(
        'INSERT INTO schema_migrations (version, name) VALUES ($1, $2) ON CONFLICT (version) DO NOTHING',
        [version, file]
      );
    });
    newlyApplied.push(version);
  }

  return { appliedVersions: newlyApplied };
}

export async function seedInitialEmployeesIfEmpty(): Promise<{ seededCount: number }> {
  const pool = getPool();
  const countRes = await pool.query<{ cnt: string }>('SELECT COUNT(*)::text AS cnt FROM employees');
  const existingCount = Number(countRes.rows[0]?.cnt ?? '0');
  if (existingCount > 0) {
    return { seededCount: 0 };
  }

  const defaultPasscode = process.env.DEFAULT_SEED_PASSCODE?.trim() || '2026';
  const passcodeScryptHash = hashScrypt(defaultPasscode);
  const pwaDigestScryptHash = hashScrypt(computePwaClientDigest(defaultPasscode));
  const androidDigestScryptHash = hashScrypt(computeAndroidClientDigest(defaultPasscode));

  await withTransaction(async (client: PoolClient) => {
    for (let i = 1; i <= 50; i++) {
      const padded = String(i).padStart(3, '0');
      const employeeCode = `EMP-${padded}`;
      const employeeNumber = `AG-${1000 + i}`;
      const deviceId = `AND-DEV-${padded}`;
      const firstIdx = (i - 1) % FIRST_NAMES_EN.length;
      const lastIdx = Math.floor((i - 1) / 2) % LAST_NAMES_EN.length;
      const fullNameEn = `${FIRST_NAMES_EN[firstIdx]} ${LAST_NAMES_EN[lastIdx]}`;
      const fullNameAr = `${FIRST_NAMES_AR[firstIdx]} ${LAST_NAMES_AR[lastIdx]}`;
      const accountStatus = i >= 49 ? 'inactive' : 'active';

      await client.query(
        `
        INSERT INTO employees (
          employee_code, employee_number, full_name_en, full_name_ar,
          passcode_scrypt_hash, pwa_digest_scrypt_hash, android_digest_scrypt_hash,
          account_status, assigned_device_id
        ) VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
        ON CONFLICT (employee_code) DO NOTHING
        `,
        [
          employeeCode,
          employeeNumber,
          fullNameEn,
          fullNameAr,
          passcodeScryptHash,
          pwaDigestScryptHash,
          androidDigestScryptHash,
          accountStatus,
          deviceId,
        ]
      );

      await client.query(
        `
        INSERT INTO devices (device_identifier, employee_code, registration_status)
        VALUES ($1, $2, $3)
        ON CONFLICT (device_identifier) DO NOTHING
        `,
        [deviceId, employeeCode, accountStatus === 'active' ? 'active' : 'suspended']
      );
    }
  });

  return { seededCount: 50 };
}
