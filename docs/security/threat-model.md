# Threat Model

Method: STRIDE per trust boundary, plus OWASP Top 10 (2021) and OWASP API Security Top 10 (2023) mapping. "Where" points at the code or config that implements each control; "Test" at the automated test that proves it. Items marked **(gap)** are not yet implemented.

## 1. Assets and data classification

| Class | Examples | Handling |
|---|---|---|
| **C4 – PHI / secrets** | chief complaint, clinical notes, prescriptions, TOTP secrets, payment client secrets, signing/encryption keys | App-level AES-256-GCM (AAD-bound), never logged, audited on every read, never returned to admins |
| **C3 – PII** | email, full name, phone, date of birth | App-level AES-256-GCM; lookups via HMAC blind index; redacted from logs |
| **C2 – internal** | consultation status/timestamps, payment status, audit metadata (ids and field *names* only) | RBAC-gated, TLS in transit, KMS at rest |
| **C1 – public** | doctor display name, specialties, fee, rating, open slots | Public, cached, rate-limited |

Crown jewels: patient clinical data; integrity of prescriptions; integrity/availability of the booking and payment state; the audit trail; key material.

## 2. Trust boundaries and attack surface

```
Internet ──(1)──> WAF/ALB ──(2)──> API pods ──(3)──> Postgres / Redis      (VPC private subnets)
PSP ─────(1)──────────────────────> API (webhook)       API/Worker ──(4)──> PSP, email/SMS (egress 443)
Operators ──(5)──> kubectl / AWS console / CI            Supply chain ──(6)──> npm, base image, GitHub Actions
```

| # | Surface | Exposure | Primary controls |
|---|---|---|---|
| 1 | Public REST API (45 operations) | Internet | WAF managed rules + IP rate limit, TLS 1.3, strict schema validation (unknown fields rejected), per-IP/per-user rate limits, 256 KB body cap |
| 1b | Payment webhook | Internet (PSP) | HMAC-SHA256 over raw body, 5-min replay window, event-id dedup, no bearer auth |
| 2 | API process | Cluster | non-root, read-only rootfs, dropped capabilities, seccomp, NetworkPolicy default-deny |
| 3 | DB / cache | Private subnet | SG allows only node SG; TLS required (`rds.force_ssl`, Redis TLS + AUTH); least-privilege DB roles (migration owner ≠ runtime role) **(runtime role split is documented, not provisioned by Terraform: gap)** |
| 4 | Outbound calls | Egress 443 | timeout + retry + circuit breaker; allowlisted CIDRs by NetworkPolicy |
| 5 | Operator access | Private EKS endpoint | SSO + MFA at IdP, audit-logged cluster API, break-glass procedure **(process, not code)** |
| 6 | Dependencies / CI | Build time | `npm audit` gate, Dependabot, CodeQL, gitleaks, Trivy (image + IaC), SBOM, pinned base image, OIDC (no long-lived cloud keys) |

## 3. STRIDE analysis

| Threat | Scenario | Mitigation (where) | Test |
|---|---|---|---|
| **S**poofing | Credential stuffing / brute force | Per-IP + per-account lockout (5 fails → 15 min), `auth` rate limit 10/min/IP, scrypt N=2¹⁵, constant-time login incl. unknown users (dummy hash), generic error text (`auth/service.ts`) | `security.test.ts › locks the account…` |
| S | Stolen refresh token | Single-use rotation with **family revocation on reuse**; access tokens 15 min; session revocation list in Redis | `› rotates refresh tokens…` |
| S | Privileged account takeover | **TOTP MFA mandatory** for doctor/admin/auditor (403 `MFA_REQUIRED` until enrolled), replay-protected counters, single-use recovery codes hashed at rest | `› enforces MFA…` |
| S | Forged/foreign JWT | ES256, issuer/audience/`kid` checks, wrong-purpose tokens rejected (MFA challenge ≠ access) | `› rejects forged…` |
| S | Fake PSP webhook | HMAC + timestamp window + dedup | `booking.test.ts › webhook safety`, `unit › webhook signatures` |
| **T**ampering | Edit prescription/consultation data in DB | Per-value AEAD (AAD binds row+column); prescriptions immutable, versioned, **HMAC-signed**, `signatureValid` surfaced | `clinical.test.ts` (tamper → `signatureValid:false`), `unit › crypto` |
| T | Edit audit rows | Append-only triggers (UPDATE/DELETE/TRUNCATE blocked); per-row HMAC with a key **outside the DB**; hash-chained checkpoints; WORM archive | `› append-only… tamper-evident` |
| T | Replay/duplicate writes | `Idempotency-Key` (atomic with effect), webhook dedup, PSP idempotency keys | `booking.test.ts › idempotency` |
| T | Mass assignment / role escalation | Strict zod schemas (`strictObject`); role fixed at registration to patient/doctor; admins only via CLI seed | `› rejects unknown fields` |
| **R**epudiation | "I never cancelled / prescribed that" | Every state change writes an audit row **in the same transaction**; failures of auditing fail the request (fail-closed); PHI reads audited; audit includes actor, role, ip, user-agent, requestId, traceId | `clinical.test.ts` |
| **I**nformation disclosure | IDOR on consultations/prescriptions/payments | Object-level checks in services; non-parties get **404** (no existence oracle); admin has no clinical permission | `› prevents IDOR`, `› admins can manage… never read clinical` |
| I | Data-at-rest exposure (DB dump, backup, replica) | C3/C4 encrypted in app before reaching DB; KMS on volumes/backups/S3 | `booking.test.ts › encrypted at rest` |
| I | Secrets/PII in logs/traces | pino redaction list, no request bodies logged, audit metadata holds ids/field names only, OTel `db.statement` without values | `unit › logging redaction` |
| I | Verbose errors | RFC 7807 with generic 500 text, no stacks | `› never leaks internals` |
| I | Enumeration of users | Generic login error; registration conflict is the only signal **(accepted: needed for UX; rate-limited)** | — |
| **D**oS | Request floods | WAF rate rule, global/auth/write limits (Redis, fail-open to per-pod), body cap, 15 s request timeout, statement/lock timeouts | `› rate limits abusive clients` |
| D | Slot hoarding (hold-and-abandon) | Max 3 pending bookings/patient, 10-min hold expiry, unverified doctors cannot publish | `booking.test.ts` |
| D | Expensive queries | Keyset pagination, limit ≤ 100, 14/31-day range caps, partition pruning, analytics from rollup | — |
| D | PSP outage cascades | Circuit breaker + durable retry; booking path does not call the PSP | `› PSP outage` |
| **E**levation | Horizontal/vertical privilege | Central RBAC matrix + per-route permission; 403s audited (`authz.denied`) | `unit › RBAC`, `security.test.ts` |
| E | SQL injection | 100% parameterised queries; dynamic SQL only for whitelisted column/sort names; user text only reaches tsquery as sanitised tokens in bind params | `› SQL-ish input safely` |
| E | Container breakout | non-root UID, read-only FS, no caps, seccomp RuntimeDefault, restricted PSS namespace, no service-account token | manifests |

## 4. OWASP Top 10 (2021) mapping

| Risk | Status | Evidence |
|---|---|---|
| A01 Broken access control | Mitigated | RBAC matrix, object-level checks, 404-on-foreign, admin ≠ clinical, tests for IDOR |
| A02 Cryptographic failures | Mitigated | AES-256-GCM field encryption, ES256 JWT, scrypt, TLS 1.3, KMS, HMAC webhook; keys only via env/secret manager; key rotation (§6) |
| A03 Injection | Mitigated | parameterised SQL, strict schemas, sanitised FTS tokens, no shell/eval (ESLint bans `eval`/`new Function`) |
| A04 Insecure design | Mitigated | this document; saga/idempotency design; fail-closed auditing; abuse limits |
| A05 Security misconfiguration | Mitigated | config validation refuses unsafe production settings (dev endpoints, mock PSP, `*` CORS, no DB TLS); helmet headers; CSP `default-src 'none'`; metrics on internal port only |
| A06 Vulnerable components | Mitigated (process) | `npm audit` gate, Dependabot, Trivy, SBOM, minimal base image |
| A07 Identification & auth failures | Mitigated | MFA, lockout, rotation/reuse detection, password policy (≥ 12 chars, common/own-name denylist) **(gap: breached-password (HIBP k-anonymity) check; no email verification flow yet)** |
| A08 Software & data integrity | Mitigated | signed prescriptions, tamper-evident audit, CI provenance + SBOM, checksummed migrations |
| A09 Logging & monitoring failures | Mitigated | full audit trail, structured logs, security alerts (login-failure spike, refresh reuse, audit-write failure) |
| A10 SSRF | Low exposure | no user-supplied URLs are fetched; egress limited by NetworkPolicy |

OWASP API Top 10 (2023): API1 BOLA → object checks; API2 broken auth → MFA/lockout; API3 BOPLA → strict response shaping (list views omit clinical text; patients never get doctor notes); API4 resource consumption → limits/timeouts; API5 BFLA → RBAC per route; API6 sensitive business flows → booking caps/holds; API7 SSRF → n/a; API8 misconfiguration → config guards; API9 inventory → OpenAPI drift check in CI; API10 unsafe consumption of APIs → PSP responses validated, webhook schema-checked.

## 5. Encryption summary

| Layer | Mechanism |
|---|---|
| In transit | TLS 1.3 at ALB; TLS to Aurora (`rds.force_ssl`) and Redis (`transit_encryption`); mTLS/service mesh optional |
| At rest (infra) | KMS CMK on Aurora, ElastiCache, S3, backups; separate CMK for secrets; multi-region replica key for DR |
| At rest (application) | AES-256-GCM per field, 96-bit random IV, `kid`-prefixed, AAD `table.column:rowId` |
| Passwords | scrypt (N=32768, r=8, p=1), per-user salt, NFKC-normalised |
| Tokens | Access: ES256 JWT (15 min). Refresh: 256-bit random, only SHA-256 stored |
| Integrity | HMAC-SHA256 for audit rows/checkpoints, prescriptions, webhooks, blind indexes (distinct keys per purpose) |

## 6. Key management and rotation (summary — full procedure in [key-management.md](key-management.md))

* **Data keys** (`DATA_KEYS_JSON`, active id `DATA_KEY_ACTIVE`): add a new key → switch active → the `keys.reencrypt` scheduled job re-encrypts in small `SKIP LOCKED` batches → retire the old key when `remaining = 0`. Zero downtime. Tested (`clinical.test.ts › rotates data keys online`).
* **JWT signing key**: new `kid`; previous public keys stay in `JWT_PREVIOUS_PUBLIC_KEYS_JSON` until their tokens expire (≤ 15 min).
* **Infra keys**: KMS automatic yearly rotation; secrets in Secrets Manager with rotation.
* **Audit / signing / blind-index keys**: change requires a key-id column to keep historical rows verifiable **(gap, documented)**.

## 7. Audit logging

Append-only, partitioned, tamper-evident (row HMAC + checkpoint chain), written transactionally with the action, readable only by `admin`/`auditor` (and the read is itself audited), verifiable on demand (`POST /v1/admin/audit-logs/verify`), archived to S3 Object Lock (7 years). Content rule: identifiers and field *names* only — never PHI/PII values.

## 8. Residual risks and accepted gaps

1. Mock PSP — a real provider integration needs its own review (PCI scope stays with the PSP: card data never touches this service).
2. No breached-password check and no email/phone verification flow yet.
3. HMAC audit key lives in the same secret bundle as app keys; a full compromise of the app tier plus the secret manager could forge future audit rows (past rows are anchored by the WORM archive and checkpoints). Mitigation path: move the audit key into a KMS-backed signer on a separate IAM boundary.
4. DB runtime role separation (migration owner vs app role, RLS as defence in depth) is recommended and described but not provisioned by the Terraform here.
5. Admin MFA reset relies on admin trust; recommend dual control.
6. Not penetration-tested; the checks here are design review plus automated tests.
