import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';

const rootDir = process.cwd();
const backendDir = path.join(rootDir, 'central-backend');
const pgDataDir = path.join(rootDir, '.pgdata');
const pgRunDir = path.join(rootDir, '.pgrun');
const pgBinDir = '/usr/lib/postgresql/15/bin';

function ensureLocalPostgresRunning() {
  if (process.env.DATABASE_URL || process.env.SKIP_LOCAL_PG_BOOTSTRAP === 'true') {
    return;
  }
  if (!fs.existsSync(pgDataDir) || !fs.existsSync(path.join(pgBinDir, 'pg_isready'))) {
    return;
  }
  try {
    execFileSync(path.join(pgBinDir, 'pg_isready'), ['-h', '127.0.0.1', '-p', '5432'], {
      stdio: 'ignore',
    });
  } catch {
    try {
      fs.mkdirSync(pgRunDir, { recursive: true });
      execFileSync(
        'su',
        [
          '-s',
          '/bin/sh',
          'appuser',
          '-c',
          `${pgBinDir}/pg_ctl -D ${pgDataDir} -l ${pgRunDir}/postgres.log -o "-k ${pgRunDir} -p 5432 -h 127.0.0.1" start`,
        ],
        { stdio: 'inherit' }
      );
    } catch (err) {
      console.error('[dev-runner] Could not auto-start local PostgreSQL:', err);
    }
  }
}

ensureLocalPostgresRunning();

const backendEnv = {
  ...process.env,
  BACKEND_PORT: process.env.BACKEND_PORT || '3001',
  SYNC_DATA_DIR: path.join(rootDir, '.data'),
  PGHOST: process.env.PGHOST || '127.0.0.1',
  PGPORT: process.env.PGPORT || '5432',
  PGUSER: process.env.PGUSER || 'agritrack',
  PGDATABASE: process.env.PGDATABASE || 'agritrack_field',
  ALLOW_TEST_HOOKS: process.env.NODE_ENV === 'production' ? 'false' : (process.env.ALLOW_TEST_HOOKS ?? 'true'),
};

const backend = spawn('npx', ['tsx', 'server.ts'], {
  cwd: backendDir,
  env: backendEnv,
  stdio: 'inherit',
});

const frontend = spawn('npx', ['vite', '--port=3000', '--host=0.0.0.0'], {
  cwd: rootDir,
  env: process.env,
  stdio: 'inherit',
});

function shutdown(signal) {
  backend.kill(signal);
  frontend.kill(signal);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

backend.on('exit', (code) => {
  if (code && code !== 0) {
    console.error(`[dev-runner] central-backend exited with code ${code}`);
  }
});

frontend.on('exit', (code) => {
  backend.kill('SIGTERM');
  process.exit(code ?? 0);
});
