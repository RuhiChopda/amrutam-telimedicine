import { createHash } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { Pool } from 'pg';

export interface MigrationResult {
  applied: string[];
  skipped: string[];
}

/**
 * Minimal forward-only migration runner.
 *  - Each file runs in its own transaction.
 *  - A session-level advisory lock serialises concurrent deployers (rolling deploys / multiple tasks).
 *  - Checksums detect edits to already-applied migrations.
 */
export async function runMigrations(
  databaseUrl: string,
  dir = join(__dirname, '..', '..', 'migrations'),
  log: (msg: string) => void = () => undefined,
): Promise<MigrationResult> {
  const pool = new Pool({ connectionString: databaseUrl, max: 1 });
  const client = await pool.connect();
  const result: MigrationResult = { applied: [], skipped: [] };
  try {
    await client.query('SELECT pg_advisory_lock(727274)');
    await client.query(`CREATE TABLE IF NOT EXISTS schema_migrations (
      name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`);
    const done = new Map<string, string>(
      (await client.query<{ name: string; checksum: string }>('SELECT name, checksum FROM schema_migrations')).rows.map(
        (r) => [r.name, r.checksum],
      ),
    );
    const files = readdirSync(dir)
      .filter((f) => f.endsWith('.sql'))
      .sort();
    for (const file of files) {
      const sql = readFileSync(join(dir, file), 'utf8');
      const checksum = createHash('sha256').update(sql).digest('hex');
      const existing = done.get(file);
      if (existing) {
        if (existing !== checksum) throw new Error(`Migration ${file} was modified after being applied`);
        result.skipped.push(file);
        continue;
      }
      try {
        await client.query('BEGIN');
        await client.query(sql);
        await client.query('INSERT INTO schema_migrations (name, checksum) VALUES ($1, $2)', [file, checksum]);
        await client.query('COMMIT');
      } catch (err) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw new Error(`Migration ${file} failed: ${(err as Error).message}`, { cause: err });
      }
      log(`applied ${file}`);
      result.applied.push(file);
    }
    return result;
  } finally {
    await client.query('SELECT pg_advisory_unlock(727274)').catch(() => undefined);
    client.release();
    await pool.end();
  }
}
