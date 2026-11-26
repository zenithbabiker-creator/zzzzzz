import 'dotenv/config';
import { runMigrations, seedInitialEmployeesIfEmpty } from './migrator.js';
import { closePool } from './pool.js';

async function main() {
  const { appliedVersions } = await runMigrations();
  const { seededCount } = await seedInitialEmployeesIfEmpty();
  console.log(
    JSON.stringify({
      ok: true,
      appliedVersions,
      seededEmployees: seededCount,
    })
  );
  await closePool();
}

main().catch(async (err) => {
  console.error('[central-backend] Migration failed:', err);
  await closePool();
  process.exit(1);
});
