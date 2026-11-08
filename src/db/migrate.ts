import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { Pool } from 'pg';

const __dirname = dirname(fileURLToPath(import.meta.url));
const MIGRATION_LOCK_KEY = 7272743800;

export interface Migration {
  id: number;
  name: string;
  file: string;
}

export const migrations: Migration[] = [{ id: 1, name: 'ads_foundation', file: '001_ads_foundation.sql' }];

export async function runMigrations(pool: Pool, schema = 'ads'): Promise<{ applied: number[] }> {
  if (!/^[a-z_][a-z0-9_]*$/i.test(schema)) throw new Error('invalid database schema name');
  const lock = await pool.connect();
  try {
    await lock.query('SELECT pg_advisory_lock($1)', [MIGRATION_LOCK_KEY]);
    await lock.query(`CREATE SCHEMA IF NOT EXISTS ${schema}`);
    await lock.query(`
      CREATE TABLE IF NOT EXISTS ${schema}.schema_migrations (
        id INTEGER PRIMARY KEY,
        name TEXT NOT NULL,
        applied_at TIMESTAMPTZ NOT NULL DEFAULT now()
      )
    `);
    const appliedRows = await lock.query<{ id: number }>(`SELECT id FROM ${schema}.schema_migrations ORDER BY id`);
    const applied = new Set(appliedRows.rows.map((r) => r.id));
    const pending = migrations.filter((m) => !applied.has(m.id));
    const done: number[] = [];
    for (const migration of pending) {
      const sql = await readFile(join(__dirname, 'migrations', migration.file), 'utf8');
      await lock.query('BEGIN');
      try {
        await lock.query(sql);
        await lock.query(`INSERT INTO ${schema}.schema_migrations (id, name) VALUES ($1, $2)`, [migration.id, migration.name]);
        await lock.query('COMMIT');
        done.push(migration.id);
      } catch (err) {
        await lock.query('ROLLBACK');
        throw err;
      }
    }
    return { applied: done };
  } finally {
    await lock.query('SELECT pg_advisory_unlock($1)', [MIGRATION_LOCK_KEY]).catch(() => undefined);
    lock.release();
  }
}
