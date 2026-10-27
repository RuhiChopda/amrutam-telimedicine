import { createHash, generateKeyPairSync } from 'node:crypto';

const b64 = (b: Buffer | string) => Buffer.from(b).toString('base64');
// Keys are derived deterministically so every test file shares one keyring (rows written by one file stay readable and
// verifiable in another). Never do this outside tests.
const det = (label: string) => createHash('sha256').update(`amrutam-test:${label}`).digest();
const { privateKey, publicKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });

Object.assign(process.env, {
  NODE_ENV: 'test',
  LOG_LEVEL: 'silent',
  DATABASE_URL: process.env.TEST_DATABASE_URL ?? 'postgres://postgres:postgres@localhost:5432/amrutam_test',
  JWT_PRIVATE_KEY_B64: b64(privateKey.export({ type: 'pkcs8', format: 'pem' }) as string),
  JWT_PUBLIC_KEY_B64: b64(publicKey.export({ type: 'spki', format: 'pem' }) as string),
  DATA_KEYS_JSON: JSON.stringify({ k1: b64(det('k1')), k2: b64(det('k2')) }),
  DATA_KEY_ACTIVE: 'k1',
  BLIND_INDEX_KEY_B64: b64(det('BLIND_INDEX')),
  AUDIT_HMAC_KEY_B64: b64(det('AUDIT_HMAC')),
  SIGNING_KEY_B64: b64(det('SIGNING')),
  PAYMENT_WEBHOOK_SECRET: 'test-webhook-secret-0123456789',
  ENABLE_DEV_ENDPOINTS: 'true',
  // generous limits so functional tests are not throttled; rate-limit behaviour has its own test
  RATE_LIMIT_GLOBAL_PER_MIN: '100000',
  RATE_LIMIT_AUTH_PER_MIN: '100000',
  RATE_LIMIT_WRITE_PER_MIN: '100000',
  DB_POOL_MAX: '30',
});
