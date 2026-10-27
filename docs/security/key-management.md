# Key Management

## Inventory

| Secret (env var) | Purpose | Rotation | Compromise impact |
|---|---|---|---|
| `DATA_KEYS_JSON` / `DATA_KEY_ACTIVE` | AES-256-GCM field encryption keyring `{kid: base64(32B)}` | **Online**, see below. Recommended every 12 months | Disclosure of C3/C4 *if* DB is also exfiltrated |
| `JWT_PRIVATE_KEY_B64` / `JWT_PUBLIC_KEY_B64` / `JWT_KEY_ID` | ES256 access-token signing | **Online** via `kid` | Forge any identity until rotated |
| `JWT_PREVIOUS_PUBLIC_KEYS_JSON` | Verify tokens signed by retired keys | Remove after 15 min | none |
| `BLIND_INDEX_KEY_B64` | HMAC for email/phone lookups | Offline re-index | Offline guessing of known emails/phones |
| `AUDIT_HMAC_KEY_B64` | Seals audit rows/checkpoints | Needs key-id column (gap) | Forge new audit rows |
| `SIGNING_KEY_B64` | Signs prescriptions | Needs key-id column (gap) | Forge prescriptions |
| `PAYMENT_WEBHOOK_SECRET` | PSP webhook HMAC | Overlap window (accept 2 secrets) **(gap: single secret today)** | Forge payment events |
| `DATABASE_URL`, `REDIS_URL` | Credentials | Secrets Manager rotation | Data access |

All secrets are injected by External Secrets Operator from AWS Secrets Manager (KMS-encrypted). They are never in git, images, ConfigMaps, logs or Terraform state (Terraform creates only the connection-string secret it owns). Generate fresh values with `npm run gen:env` (development format) or equivalent `openssl rand -base64 32` / `openssl ecparam -genkey -name prime256v1 | openssl pkcs8 -topk8 -nocrypt`.

## Rotating a data-encryption key (zero downtime)

1. Generate `k2` (32 random bytes, base64). Add it to the secret: `DATA_KEYS_JSON={"k1":"…","k2":"…"}`. Deploy — all pods can now *read* both.
2. Set `DATA_KEY_ACTIVE=k2`. Deploy. New writes use `k2`; old rows still decrypt with `k1`.
3. The scheduler task `keys.reencrypt` (every 60 s, any worker) re-encrypts rows still on `k1` in batches of 200 per field using compare-and-swap, so it never overwrites a concurrent user update. Rows that cannot be decrypted are logged with table/column/id (alert on `key rotation: row could not be re-encrypted`).
4. Watch progress: the job's `remaining` count reaches 0 (also verifiable with `SELECT count(*) FROM users WHERE email_enc NOT LIKE 'enc:v1:k2:%'` per column).
5. Remove `k1` from the keyring only after a backup older than the rotation can no longer be a restore target **or** keep `k1` read-only for the backup retention window (35 days).

Emergency (suspected key leak): do steps 1–3 immediately; treat database snapshots taken before the rotation as still protected only by the old key and rotate/delete them per retention policy.

## Rotating the JWT signing key

1. Generate a new ES256 key pair with a new `kid` (`k2`).
2. Put the **old public key** into `JWT_PREVIOUS_PUBLIC_KEYS_JSON={"k1":"<base64 PEM>"}`; set the new private/public/`JWT_KEY_ID=k2`. Deploy.
3. After `ACCESS_TOKEN_TTL_SECONDS` (15 min) remove the previous key. Refresh tokens are opaque and unaffected.

## Known gaps (and the fix)

Audit and prescription signatures embed no key id, so rotating `AUDIT_HMAC_KEY_B64`/`SIGNING_KEY_B64` would make historical rows fail verification. Fix (≈ 1 migration + 20 lines): add `sig_kid` columns, prefix signatures with the key id (as `HmacSigner` already prefixes the algorithm), and keep old keys in a verify-only keyring. Until then treat these two keys as long-lived, store them in a KMS-backed secret with tight IAM, and rotate only with a planned re-sealing job. For the blind-index key, rotation means recomputing `email_bidx`/`phone_bidx` for all rows in one maintenance window (decrypt → re-HMAC).

## Access policy

* Secrets Manager read access only for the workload's IRSA role; humans get no standing access (break-glass with approval and CloudTrail alarms).
* KMS key policies separate *administer* from *use*; the data key is used by Aurora/ElastiCache/S3/Backup service principals only.
