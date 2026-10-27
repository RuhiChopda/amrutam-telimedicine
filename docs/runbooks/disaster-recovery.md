# Backup & Disaster Recovery Runbook

> Design targets, implemented in `infra/terraform/backup_dr.tf` and `database.tf`. They have **not** been exercised against a live AWS account from the authoring environment — the first game-day should validate every number below.

## Objectives

| Scenario | Detection | RPO | RTO | Mechanism |
|---|---|---|---|---|
| Pod / node loss | readiness probe, HPA | 0 | seconds | Replicated stateless pods, PDB, durable job leases |
| AZ loss | ALB health, CloudWatch | 0 | < 1 min | 3-AZ spread, Aurora failover to reader in another AZ, ElastiCache Multi-AZ |
| Aurora writer failure | `AuroraReplicaLag`, connection errors | 0 | ≈ 30 s | Automatic failover (promotion tier 0/1); app pools reconnect |
| Redis loss | `circuit_breaker_state{name="redis-cache"}` | n/a (ephemeral) | 0 (degraded) | Fail-open cache + per-pod rate limiting; revocation list lost ⇒ tokens live ≤ 15 min |
| PSP outage | `PaymentGatewayCircuitOpen` | 0 | n/a | Bookings keep working; jobs retry; holds may expire → compensated automatically |
| Bad deploy | burn-rate alert, smoke test | 0 | 5 min | `kubectl rollout undo`; migrations are expand/contract so the previous version still runs |
| Bad migration / data corruption / operator error | integrity checks, customer reports | ≈ 5 min | 30–60 min | Aurora PITR clone (35-day window), then selective copy-back or cut-over |
| Ransomware / malicious deletion | CloudTrail, backup alarms | ≤ 24 h | 2–4 h | Vault-locked, cross-region backups cannot be deleted before retention ends |
| Region loss | multi-signal, declared by incident commander | ≤ 24 h (≈ seconds with Aurora Global DB) | ≈ 2 h | Restore latest cross-region snapshot in DR region with the KMS replica key; `terraform apply` the stack with `region=dr_region`; repoint DNS |

## Backups in place

* Aurora continuous backup, retention 35 days (PITR to any second).
* AWS Backup: daily snapshot (21:00 UTC) → 35 days, copied to the DR region vault; monthly snapshot kept 1 year; vault lock (min retention 7 days) prevents early deletion.
* Audit log partitions older than 12 months are detached and exported to S3 Object Lock (compliance mode, 7 years).
* Secrets: Secrets Manager (multi-region replication recommended); **key material is part of DR** — without `DATA_KEYS_JSON` the encrypted fields in any restored database are unreadable. Escrow procedure: sealed, dual-controlled offline copy of the keyring.

## Procedure: point-in-time restore after corruption

1. Declare an incident; **stop writers** if corruption is ongoing (`kubectl scale deploy/amrutam-api deploy/amrutam-worker --replicas=0`). Note the last-known-good timestamp `T`.
2. `aws rds restore-db-cluster-to-point-in-time --source-db-cluster-identifier amrutam-prod --restore-to-time T --db-cluster-identifier amrutam-prod-restore --use-latest-restorable-time false --kms-key-id <data key>` and create instances.
3. Verify: `npm run migrate` reports up to date; run `POST /v1/admin/audit-logs/verify` for the affected window against the restored DB (a mismatch proves tampering vs. mere corruption); spot-check consultations/payments.
4. Either **cut over** (update `DATABASE_URL` secret → restart pods) or **copy back** the damaged rows with targeted SQL.
5. Reconcile external state: payments that succeeded at the PSP between `T` and now must be replayed — re-deliver webhook events from the PSP dashboard (they are idempotent by event id), then run the refund sweep for consultations that no longer exist.
6. Post-incident: restart workers; confirm the queue drains and `jobs_oldest_pending_age_seconds` returns to ~0.

## Procedure: region failover

1. Incident commander declares region loss. Freeze deploys.
2. In the DR region: ensure the KMS replica key, Secrets Manager replica and VPC/EKS exist (`terraform apply -var region=<dr>` from a pre-warmed workspace).
3. Restore the newest snapshot from the DR backup vault into a new Aurora cluster.
4. Deploy manifests (`kustomize build infra/k8s | kubectl apply -f -`); `migrate` Job runs first.
5. Lower DNS TTL beforehand (runbook prerequisite: 60 s); switch the API record. Webhooks from the PSP need their endpoint updated or DNS-routed.
6. Communicate the RPO loss window to affected users (bookings created after the snapshot may be missing; the PSP is the source of truth for payments → reconcile).

## Restore tests (mandatory)

* **Monthly**: automated restore of the latest snapshot into an isolated VPC, run `npm run migrate`, run the integration test suite's smoke subset against it, record the elapsed time (this is the real RTO).
* **Quarterly**: game-day — AZ failure injection, Redis kill, PSP outage, PITR restore. Record RPO/RTO achieved, update this table.
* After every restore test, verify `audit-logs/verify` returns `ok:true`.

## Capacity and failure behaviour worth knowing

* Workers can be scaled to zero without data loss: the outbox accumulates and drains on return (the `JobQueueBacklog` alert fires at 2 min of lag).
* Holds expire only while the scheduler runs; if all workers are down, expired holds are released on recovery and late payments are auto-refunded.
