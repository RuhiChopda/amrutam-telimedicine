import { z } from 'zod';

const bool = z
  .enum(['true', 'false', '1', '0'])
  .transform((v) => v === 'true' || v === '1');

const b64 = (minBytes: number) =>
  z
    .string()
    .min(1)
    .refine((v) => Buffer.from(v, 'base64').length >= minBytes, `must be base64 of at least ${minBytes} bytes`);

const raw = z.object({
  NODE_ENV: z.enum(['development', 'test', 'production']).default('development'),
  SERVICE_NAME: z.string().default('amrutam-api'),
  PORT: z.coerce.number().int().min(1).max(65535).default(3000),
  METRICS_PORT: z.coerce.number().int().min(0).max(65535).default(9464),
  LOG_LEVEL: z.enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent']).default('info'),
  TRUST_PROXY: bool.default(false),
  CORS_ORIGINS: z.string().default(''),

  DATABASE_URL: z.string().min(1),
  DATABASE_READ_URL: z.string().optional(),
  DATABASE_SSL: bool.default(false),
  DB_POOL_MAX: z.coerce.number().int().min(1).max(200).default(20),
  DB_STATEMENT_TIMEOUT_MS: z.coerce.number().int().min(100).default(5000),

  REDIS_URL: z.string().optional(),
  REDIS_PREFIX: z.string().default('amr:'),

  JWT_PRIVATE_KEY_B64: b64(32),
  JWT_PUBLIC_KEY_B64: b64(32),
  JWT_KEY_ID: z.string().min(1).default('k1'),
  JWT_PREVIOUS_PUBLIC_KEYS_JSON: z.string().optional(),
  JWT_ISSUER: z.string().default('amrutam'),
  JWT_AUDIENCE: z.string().default('amrutam-api'),
  ACCESS_TOKEN_TTL_SECONDS: z.coerce.number().int().min(60).max(3600).default(900),
  REFRESH_TOKEN_TTL_DAYS: z.coerce.number().int().min(1).max(90).default(14),
  AUTH_LOCKOUT_THRESHOLD: z.coerce.number().int().min(3).default(5),
  AUTH_LOCKOUT_MINUTES: z.coerce.number().int().min(1).default(15),

  DATA_KEYS_JSON: z.string().min(2),
  DATA_KEY_ACTIVE: z.string().min(1),
  BLIND_INDEX_KEY_B64: b64(32),
  AUDIT_HMAC_KEY_B64: b64(32),
  SIGNING_KEY_B64: b64(32),

  PAYMENT_PROVIDER: z.enum(['mock']).default('mock'),
  ALLOW_MOCK_PAYMENTS: bool.default(false),
  PAYMENT_WEBHOOK_SECRET: z.string().min(16),
  MOCK_GATEWAY_FAILURE_RATE: z.coerce.number().min(0).max(1).default(0),

  BOOKING_HOLD_SECONDS: z.coerce.number().int().min(30).default(600),
  MIN_BOOKING_LEAD_MINUTES: z.coerce.number().int().min(0).default(15),
  MAX_BOOKING_HORIZON_DAYS: z.coerce.number().int().min(1).default(90),
  MAX_PENDING_BOOKINGS_PER_PATIENT: z.coerce.number().int().min(1).default(3),
  CANCEL_FULL_REFUND_HOURS: z.coerce.number().min(0).default(4),
  NO_SHOW_GRACE_MINUTES: z.coerce.number().int().min(1).default(15),

  RATE_LIMIT_GLOBAL_PER_MIN: z.coerce.number().int().min(1).default(600),
  RATE_LIMIT_AUTH_PER_MIN: z.coerce.number().int().min(1).default(10),
  RATE_LIMIT_WRITE_PER_MIN: z.coerce.number().int().min(1).default(60),

  ENABLE_DEV_ENDPOINTS: bool.default(false),
  WORKER_CONCURRENCY: z.coerce.number().int().min(1).max(100).default(10),
  WORKER_POLL_MS: z.coerce.number().int().min(50).default(500),
  OTEL_EXPORTER_OTLP_ENDPOINT: z.string().optional(),
});

export interface Config {
  env: 'development' | 'test' | 'production';
  isProd: boolean;
  serviceName: string;
  port: number;
  metricsPort: number;
  logLevel: string;
  trustProxy: boolean;
  corsOrigins: string[];
  db: { url: string; readUrl?: string; ssl: boolean; poolMax: number; statementTimeoutMs: number };
  redis: { url?: string; prefix: string };
  jwt: {
    privateKeyPem: string;
    publicKeyPem: string;
    keyId: string;
    previousPublicKeys: Record<string, string>;
    issuer: string;
    audience: string;
    accessTtlSeconds: number;
    refreshTtlDays: number;
  };
  auth: { lockoutThreshold: number; lockoutMinutes: number };
  keys: {
    dataKeys: Record<string, Buffer>;
    activeDataKeyId: string;
    blindIndexKey: Buffer;
    auditHmacKey: Buffer;
    signingKey: Buffer;
  };
  payments: { provider: 'mock'; webhookSecret: string; mockFailureRate: number };
  booking: {
    holdSeconds: number;
    minLeadMinutes: number;
    horizonDays: number;
    maxPendingPerPatient: number;
    fullRefundHours: number;
    noShowGraceMinutes: number;
  };
  rateLimit: { globalPerMin: number; authPerMin: number; writePerMin: number };
  devEndpoints: boolean;
  worker: { concurrency: number; pollMs: number };
  otlpEndpoint?: string;
}

const pem = (b64v: string) => Buffer.from(b64v, 'base64').toString('utf8');

export function loadConfig(env: NodeJS.ProcessEnv = process.env): Config {
  const parsed = raw.safeParse(env);
  if (!parsed.success) {
    const msg = parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ');
    throw new Error(`Invalid configuration: ${msg}`);
  }
  const e = parsed.data;

  let dataKeysRaw: Record<string, string>;
  try {
    dataKeysRaw = z.record(z.string(), z.string()).parse(JSON.parse(e.DATA_KEYS_JSON));
  } catch {
    throw new Error('Invalid configuration: DATA_KEYS_JSON must be a JSON object of {keyId: base64Key}');
  }
  const dataKeys: Record<string, Buffer> = {};
  for (const [id, v] of Object.entries(dataKeysRaw)) {
    const buf = Buffer.from(v, 'base64');
    if (buf.length !== 32) throw new Error(`Invalid configuration: data key "${id}" must be exactly 32 bytes (AES-256)`);
    dataKeys[id] = buf;
  }
  if (!dataKeys[e.DATA_KEY_ACTIVE]) {
    throw new Error(`Invalid configuration: DATA_KEY_ACTIVE "${e.DATA_KEY_ACTIVE}" not present in DATA_KEYS_JSON`);
  }

  let previousPublicKeys: Record<string, string> = {};
  if (e.JWT_PREVIOUS_PUBLIC_KEYS_JSON) {
    try {
      const prev = z.record(z.string(), z.string()).parse(JSON.parse(e.JWT_PREVIOUS_PUBLIC_KEYS_JSON));
      previousPublicKeys = Object.fromEntries(Object.entries(prev).map(([k, v]) => [k, pem(v)]));
    } catch {
      throw new Error('Invalid configuration: JWT_PREVIOUS_PUBLIC_KEYS_JSON must be {kid: base64Pem}');
    }
  }

  const isProd = e.NODE_ENV === 'production';
  if (isProd) {
    const problems: string[] = [];
    if (e.ENABLE_DEV_ENDPOINTS) problems.push('ENABLE_DEV_ENDPOINTS must be false in production');
    if (!e.REDIS_URL) problems.push('REDIS_URL is required in production (rate limiting, cache)');
    if (!e.DATABASE_SSL) problems.push('DATABASE_SSL must be true in production');
    if (!e.ALLOW_MOCK_PAYMENTS && e.PAYMENT_PROVIDER === 'mock') {
      problems.push('mock payment provider requires ALLOW_MOCK_PAYMENTS=true (staging/demo only)');
    }
    if (e.CORS_ORIGINS.includes('*')) problems.push('CORS_ORIGINS must not contain "*" in production');
    if (problems.length) throw new Error(`Invalid production configuration: ${problems.join('; ')}`);
  }

  return {
    env: e.NODE_ENV,
    isProd,
    serviceName: e.SERVICE_NAME,
    port: e.PORT,
    metricsPort: e.METRICS_PORT,
    logLevel: e.LOG_LEVEL,
    trustProxy: e.TRUST_PROXY,
    corsOrigins: e.CORS_ORIGINS.split(',').map((s) => s.trim()).filter(Boolean),
    db: {
      url: e.DATABASE_URL,
      readUrl: e.DATABASE_READ_URL,
      ssl: e.DATABASE_SSL,
      poolMax: e.DB_POOL_MAX,
      statementTimeoutMs: e.DB_STATEMENT_TIMEOUT_MS,
    },
    redis: { url: e.REDIS_URL, prefix: e.REDIS_PREFIX },
    jwt: {
      privateKeyPem: pem(e.JWT_PRIVATE_KEY_B64),
      publicKeyPem: pem(e.JWT_PUBLIC_KEY_B64),
      keyId: e.JWT_KEY_ID,
      previousPublicKeys,
      issuer: e.JWT_ISSUER,
      audience: e.JWT_AUDIENCE,
      accessTtlSeconds: e.ACCESS_TOKEN_TTL_SECONDS,
      refreshTtlDays: e.REFRESH_TOKEN_TTL_DAYS,
    },
    auth: { lockoutThreshold: e.AUTH_LOCKOUT_THRESHOLD, lockoutMinutes: e.AUTH_LOCKOUT_MINUTES },
    keys: {
      dataKeys,
      activeDataKeyId: e.DATA_KEY_ACTIVE,
      blindIndexKey: Buffer.from(e.BLIND_INDEX_KEY_B64, 'base64'),
      auditHmacKey: Buffer.from(e.AUDIT_HMAC_KEY_B64, 'base64'),
      signingKey: Buffer.from(e.SIGNING_KEY_B64, 'base64'),
    },
    payments: {
      provider: e.PAYMENT_PROVIDER,
      webhookSecret: e.PAYMENT_WEBHOOK_SECRET,
      mockFailureRate: e.MOCK_GATEWAY_FAILURE_RATE,
    },
    booking: {
      holdSeconds: e.BOOKING_HOLD_SECONDS,
      minLeadMinutes: e.MIN_BOOKING_LEAD_MINUTES,
      horizonDays: e.MAX_BOOKING_HORIZON_DAYS,
      maxPendingPerPatient: e.MAX_PENDING_BOOKINGS_PER_PATIENT,
      fullRefundHours: e.CANCEL_FULL_REFUND_HOURS,
      noShowGraceMinutes: e.NO_SHOW_GRACE_MINUTES,
    },
    rateLimit: {
      globalPerMin: e.RATE_LIMIT_GLOBAL_PER_MIN,
      authPerMin: e.RATE_LIMIT_AUTH_PER_MIN,
      writePerMin: e.RATE_LIMIT_WRITE_PER_MIN,
    },
    devEndpoints: e.ENABLE_DEV_ENDPOINTS,
    worker: { concurrency: e.WORKER_CONCURRENCY, pollMs: e.WORKER_POLL_MS },
    otlpEndpoint: e.OTEL_EXPORTER_OTLP_ENDPOINT,
  };
}
