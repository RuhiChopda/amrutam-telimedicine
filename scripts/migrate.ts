import 'dotenv/config';
import { runMigrations } from '../src/shared/migrate';

const url = process.env.DATABASE_MIGRATION_URL ?? process.env.DATABASE_URL;
if (!url) {
  console.error('DATABASE_URL (or DATABASE_MIGRATION_URL) is required');
  process.exit(1);
}
runMigrations(url, undefined, (m) => console.log(m))
  .then((r) => console.log(`migrations: ${r.applied.length} applied, ${r.skipped.length} already up to date`))
  .catch((e) => {
    console.error(e.message);
    process.exit(1);
  });
