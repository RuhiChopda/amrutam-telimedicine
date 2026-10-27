# Amrutam Telemedicine Backend

Production-grade backend for a telemedicine platform: user lifecycle (auth, roles, MFA), doctor availability and booking, consultation lifecycle and prescriptions, search, compliance audit trail, admin analytics.

Node 22 · TypeScript · Fastify 5 · PostgreSQL 16 · Redis 7 · OpenTelemetry/Prometheus/Grafana · Docker · Kubernetes · Terraform (AWS)

Modular monolith, two process types from one image: **API** pods and **worker** pods (durable Postgres job queue + transactional outbox + leader-less scheduler).

## Quickstart (local)

Requirements: Node 22+, PostgreSQL 16 (with `btree_gist`, `pg_trgm`, `pgcrypto`), Redis 7 (optional, fails open).

```bash
npm ci
npm run gen:env            # writes .env with fresh dev secrets (git-ignored)
# set DATABASE_URL / REDIS_URL in .env to your local services
npm run migrate            # checksummed, advisory-locked migrations
npm run dev                # API on :3000, metrics on :9464
npm run dev:worker         # worker (set METRICS_PORT=9465 if on the same host)
npm run demo               # narrated end-to-end walkthrough (10 steps)
```

## Quickstart (Docker Compose, full stack)

```bash
npm run gen:env
docker compose -f infra/docker/docker-compose.yml up --build
```

| Service | URL |
|---|---|
| API | http://localhost:3000 (`/healthz`, `/readyz`) |
| Prometheus | http://localhost:9090 |
| Grafana | http://localhost:3001 (dashboard "Amrutam Overview") |
| Jaeger (traces) | http://localhost:16686 |

Create the first admin (admins cannot self-register): `npx tsx scripts/seed-admin.ts`. Generate a TOTP code for MFA-protected accounts: `npx tsx scripts/totp.ts <secret>`.

## Configuration

All config is via environment variables, validated with zod at boot (the process refuses to start on unsafe production settings). See `.env.example`.

| Variable | Purpose |
|---|---|
| `NODE_ENV`, `PORT`, `METRICS_PORT` | runtime / listeners (metrics on a separate internal port) |
| `DATABASE_URL`, `DATABASE_SSL` | Postgres (TLS required in production) |
| `REDIS_URL` | cache + rate limiter (required in production; fail-open at runtime) |
| `DATA_KEYS_JSON`, `DATA_KEY_ACTIVE` | AES-256-GCM field-encryption keyring + active key id |
| `BLIND_INDEX_KEY_B64`, `AUDIT_HMAC_KEY_B64`, `SIGNING_KEY_B64` | HMAC keys (lookups, audit seal, prescription signature) |
| `JWT_PRIVATE_KEY_B64`, `JWT_PUBLIC_KEY_B64`, `JWT_KEY_ID`, `JWT_PREVIOUS_PUBLIC_KEYS_JSON` | ES256 tokens + rotation |
| `PAYMENT_WEBHOOK_SECRET`, `PSP_PROVIDER` | PSP webhook HMAC; `mock` needs `ALLOW_MOCK_PAYMENTS=true` in production |
| `CORS_ORIGINS` | allow-list (`*` refused in production) |
| `OTEL_EXPORTER_OTLP_ENDPOINT` | enables tracing |

Secrets are never committed. `.env` is git-ignored; production secrets come from a secret manager (External Secrets → env vars).

## Commands

| Command | What it does |
|---|---|
| `npm test` | unit + integration tests against a real Postgres/Redis (creates `amrutam_test`) with coverage gates |
| `npm run lint` / `npm run typecheck` | ESLint / `tsc --noEmit` |
| `npm run build` | compile to `dist/` |
| `npm run openapi:check` | validates `docs/openapi.yaml` and fails on drift from implemented routes |
| `npm run demo` | scripted end-to-end flow used for the demo video |
| `npm run bench` | read + booking-write load test (see `docs/performance.md`) |

## API quick tour

```bash
B=http://localhost:3000/v1
curl -sX POST $B/auth/register -H 'content-type: application/json' \
  -d '{"email":"p@example.com","password":"correct-horse-battery-9","fullName":"Pat Ient","role":"patient"}'
TOKEN=$(curl -sX POST $B/auth/login -H 'content-type: application/json' \
  -d '{"email":"p@example.com","password":"correct-horse-battery-9"}' | jq -r .accessToken)
curl -s "$B/doctors?specialty=cardiology&limit=10"
curl -sX POST $B/consultations -H "authorization: Bearer $TOKEN" \
  -H 'content-type: application/json' -H "Idempotency-Key: $(uuidgen)" \
  -d '{"slotId":"<slot-uuid>","chiefComplaint":"chest pain"}'
```

Full contract: [`docs/openapi.yaml`](docs/openapi.yaml) (45 operations). Errors are RFC 7807. Resource-creating writes require `Idempotency-Key`.

## Documentation

| Deliverable | Where |
|---|---|
| Architecture (data flow, saga, ER, partitioning, caching, DR) | [`docs/architecture.md`](docs/architecture.md), diagrams in [`docs/diagrams/`](docs/diagrams) |
| API schema | [`docs/openapi.yaml`](docs/openapi.yaml) |
| Threat model, OWASP mapping | [`docs/security/threat-model.md`](docs/security/threat-model.md) |
| Security checklist | [`docs/security/security-checklist.md`](docs/security/security-checklist.md) |
| Key management & rotation | [`docs/security/key-management.md`](docs/security/key-management.md) |
| Disaster recovery runbook | [`docs/runbooks/disaster-recovery.md`](docs/runbooks/disaster-recovery.md) |
| Performance / benchmark | [`docs/performance.md`](docs/performance.md) |
| 5-minute demo script | [`docs/DEMO.md`](docs/DEMO.md) |

## Repository layout

```
src/
  config/        validated env config
  shared/        db (tx, retry), crypto, cache, rate limiter, retry/circuit breaker, logging, metrics, tracing
  modules/       auth, users, doctors, consultations (booking saga, lifecycle), payments, jobs, audit,
                 idempotency, admin, notifications, keys
  http/          Fastify app, guards, routes
  container.ts   composition root (constructor DI)
migrations/      001–006 SQL (partitioned tables, constraints, immutability triggers)
test/            unit + integration (real Postgres/Redis)
scripts/         migrate, seed-admin, demo, bench, openapi build/check
infra/           docker (compose), observability (Prometheus/Grafana/OTel/Loki), k8s (Kustomize), terraform (AWS)
.github/         CI (lint, typecheck, tests, security scans, image, deploy) + Dependabot
docs/
```

## Key design points

- **Booking without 2PC**: slot `OPEN→HELD` via atomic CAS, consultation `PENDING_PAYMENT`, outbox job; webhook confirms; compensations for payment failure, hold expiry, late payment (auto-refund), cancellation. DB guarantees: GiST exclusion on overlapping slots, partial unique index (one live consultation per slot).
- **Idempotency**: `Idempotency-Key` stored in the same transaction as the effect (request-hash checked), webhook event-id dedup, PSP idempotency keys.
- **Security**: ES256 JWT + rotating refresh tokens with reuse detection, mandatory TOTP MFA for doctor/admin/auditor, RBAC (admins have no clinical access), object-level 404s, AES-256-GCM field encryption with AAD and online key rotation, signed immutable prescriptions, append-only HMAC-sealed audit log with hash-chained checkpoints.
- **Scale**: stateless API, Postgres partitioning (consultations, audit logs), keyset pagination, single-flight cache with jittered TTL, analytics from rollups, SKIP LOCKED workers.
- **Observability**: Prometheus metrics, structured logs with request/trace ids and PII redaction, OTel traces, Grafana dashboard, SLO burn-rate alerts.

## Known limitations (honest list)

- PSP is a mock gateway and notifications are a log sink; real providers need integration and review.
- Terraform, Kubernetes manifests, the CI workflow and the Docker image were authored but **not applied/run** in the build environment (no cloud account, no Docker daemon).
- Benchmarks ran single-process on a shared 2-vCPU box; they show headroom, not a 100k/day capacity proof (see `docs/performance.md`).
- Gaps tracked in the security docs: email/phone verification, breached-password check, key-id on audit/signing keys, DB role split, pen-test, DR game-day.
- The demo video itself is not included; `docs/DEMO.md` + `npm run demo` reproduce it.
