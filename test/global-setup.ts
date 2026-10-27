import { Client } from 'pg';
import { runMigrations } from '../src/shared/migrate';

const ADMIN_URL = process.env.TEST_ADMIN_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/postgres';
export const TEST_DB_URL = process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/amrutam_test';

/** Fresh database per test run: migrations are exercised from scratch every time (CI parity, no state leakage). */
export default async function setup() {
  const name = new URL(TEST_DB_URL).pathname.slice(1);
  if (!/^[a-z0-9_]+_test$/.test(name)) throw new Error(`refusing to drop non-test database "${name}"`);
  const admin = new Client({ connectionString: ADMIN_URL });
  await admin.connect();
  await admin.query(`DROP DATABASE IF EXISTS ${name} WITH (FORCE)`);
  await admin.query(`CREATE DATABASE ${name}`);
  await admin.end();
  await runMigrations(TEST_DB_URL);
}
