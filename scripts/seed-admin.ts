/**
 * Creates the first administrator (admins cannot self-register). Run once per environment:
 *   ADMIN_EMAIL=ops@example.com ADMIN_PASSWORD='...' npm run seed:admin
 * The admin must enrol MFA on first login before any admin endpoint works.
 */
import 'dotenv/config';
import { randomUUID } from 'node:crypto';
import { loadConfig } from '../src/config/env';
import { AAD } from '../src/shared/aad';
import { FieldCrypto, hashPassword } from '../src/shared/crypto';
import { createDb } from '../src/shared/db';
import { createLogger } from '../src/shared/logger';
import { Metrics } from '../src/shared/metrics';
import { checkPasswordPolicy } from '../src/modules/auth/service';

async function main() {
  const email = process.env.ADMIN_EMAIL?.trim().toLowerCase();
  const password = process.env.ADMIN_PASSWORD;
  const role = (process.env.ADMIN_ROLE ?? 'admin') as 'admin' | 'auditor';
  if (!email || !password || password.length < 12) throw new Error('ADMIN_EMAIL and ADMIN_PASSWORD (min 12 chars) are required');
  checkPasswordPolicy(password, email);
  const cfg = loadConfig();
  const crypto = new FieldCrypto(cfg.keys.dataKeys, cfg.keys.activeDataKeyId, cfg.keys.blindIndexKey);
  const db = createDb(cfg, createLogger({ level: 'warn', service: 'seed' }), new Metrics({ defaultMetrics: false }));
  const id = randomUUID();
  await db.tx(async (tx) => {
    const r = await tx.query(
      `INSERT INTO users (id, email_bidx, email_enc, password_hash, role) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (email_bidx) DO NOTHING`,
      [id, crypto.blindIndex(email), crypto.encrypt(email, AAD.userEmail(id)), await hashPassword(password), role],
    );
    if (r.rowCount === 0) {
      console.log('user already exists; nothing to do');
      return;
    }
    await tx.query(`INSERT INTO profiles (user_id, full_name_enc) VALUES ($1,$2)`, [id, crypto.encrypt('Platform Administrator', AAD.profileName(id))]);
    console.log(`created ${role} ${email} (id ${id})`);
  });
  await db.close();
}
main().catch((e) => {
  console.error(e.message);
  process.exit(1);
});
