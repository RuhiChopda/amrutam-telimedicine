# Security Checklist

Legend: ✅ implemented and covered by an automated test or CI gate · 🟢 implemented (config/IaC, not exercised in this sandbox) · 🟡 partial · ⬜ not done (tracked)

## Identity & access
- ✅ Password hashing: scrypt, per-user salt, timing-equalised login
- ✅ Password policy: ≥ 12 chars, common-password / own-email denylist
- ✅ Account lockout + per-IP auth rate limit
- ✅ TOTP MFA mandatory for doctor / admin / auditor; replay protection; hashed single-use recovery codes
- ✅ Short-lived ES256 access tokens; rotating single-use refresh tokens with reuse → family revocation
- ✅ Immediate revocation on logout / password change / suspension / MFA reset
- ✅ RBAC matrix, least privilege; admins have no clinical access
- ✅ Object-level authorization on every consultation/prescription/payment path (404 for non-parties)
- ✅ Admin accounts cannot self-register; first admin via seed script; no self-suspend / self-MFA-reset
- 🟡 Email / phone verification — ⬜ not implemented
- ⬜ Breached-password (HIBP k-anonymity) check

## Data protection
- ✅ Field-level AES-256-GCM for all C3/C4 data with AAD binding
- ✅ HMAC blind indexes for email/phone lookup
- ✅ Online data-key rotation job
- ✅ No PHI/PII in logs, audit metadata or list views (redaction tested)
- 🟢 KMS encryption for DB, cache, S3, backups; separate CMK for secrets; multi-region replica key
- 🟢 TLS 1.3 at the edge; TLS enforced to DB and Redis
- ✅ Secrets only via environment variables; config validation fails fast; `.env` git-ignored; gitleaks in CI
- ✅ Prescriptions immutable, versioned, signed; integrity flag returned to readers

## Application security
- ✅ Strict input validation (zod `strictObject`), body size cap, content-type enforcement
- ✅ Parameterised SQL only; sanitised FTS tokens
- ✅ Idempotency on resource-creating writes; webhook dedup + HMAC + replay window
- ✅ Rate limiting (global / auth / write) with Redis, fail-open to per-pod memory
- ✅ Security headers (helmet: HSTS, CSP `default-src 'none'`, nosniff, frame-ancestors none), `Cache-Control: no-store`
- ✅ CORS allow-list (wildcard refused in production)
- ✅ Errors as RFC 7807 without internals
- ✅ Production guard rails: dev endpoints, mock PSP, missing DB TLS, `*` CORS all refuse to start
- ✅ Statement / lock / idle-in-transaction timeouts

## Audit & compliance
- ✅ Audit row in the same transaction as every state change (fail-closed)
- ✅ PHI reads and audit reads are themselves audited; authorization denials audited
- ✅ Append-only at DB level; HMAC-sealed rows; hash-chained checkpoints; verify endpoint
- 🟢 WORM archive (S3 Object Lock, 7 y) with cross-region copy
- 🟡 Retention/erasure workflow for DPDP/GDPR-style requests — design: crypto-shredding of per-subject data; ⬜ not built

## Supply chain & CI/CD
- 🟢 `npm audit` (high/critical gate), Dependabot (npm, actions, docker, terraform)
- 🟢 CodeQL SAST, gitleaks, Trivy IaC + image scan, SBOM (CycloneDX), build provenance
- 🟢 OIDC to cloud (no long-lived keys); protected environments for deploy
- ✅ Lockfile + `npm ci`; ESLint bans `eval`/`new Function`
- 🟢 Minimal non-root image (tini, read-only rootfs friendly)

## Infrastructure
- 🟢 Private EKS endpoint, IMDSv2 only, secrets envelope-encrypted with KMS
- 🟢 Pod Security `restricted`, seccomp, no service-account token, default-deny NetworkPolicy
- 🟢 Private subnets for data tier; SGs only from node SG; flow logs on
- 🟢 WAF (managed common + SQLi rules, IP rate limit)
- 🟢 Backup vault lock (immutability), 35-day PITR, cross-region copy
- ⬜ Separate DB roles (migration owner / runtime / read-only) and optional RLS
- ⬜ Penetration test; DR game-day

## Observability for security
- ✅ Metrics for login failures, MFA failures, lockouts, refresh reuse, 429s, authz denials (audit), audit write failures
- 🟢 Alert rules for the above (`infra/observability/alerts.yml`)
