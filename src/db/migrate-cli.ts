import pg from 'pg';
import { loadConfig } from '../config.js';
import { runMigrations } from './migrate.js';

async function main(): Promise<void> {
  const config = loadConfig(process.env);
  if (!config.database.url) {
    throw new Error('DATABASE_URL is required to run migrations');
  }
  const pool = new pg.Pool({ connectionString: config.database.url });
  try {
    const result = await runMigrations(pool, config.database.schema);
    process.stdout.write(`applied migrations: ${result.applied.join(',') || 'none'}\n`);
  } finally {
    await pool.end();
  }
}

main().catch((err) => {
  console.error(err instanceof Error ? err.message : err);
  process.exit(1);
});
