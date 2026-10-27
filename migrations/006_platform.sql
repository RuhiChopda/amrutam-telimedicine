-- Idempotency records are written in the SAME transaction as the business effect, so "effect happened" and
-- "response recorded" are atomic: there is no in-progress/crashed state to reconcile.
CREATE TABLE idempotency_keys (
  user_id         uuid NOT NULL,
  key             text NOT NULL,
  request_hash    bytea NOT NULL,
  response_status int,
  response_body   jsonb,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '24 hours',
  PRIMARY KEY (user_id, key)
);
CREATE INDEX idempotency_expiry_idx ON idempotency_keys (expires_at);

CREATE TABLE webhook_events (
  provider    text NOT NULL,
  event_id    text NOT NULL,
  received_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (provider, event_id)
);

-- Transactional outbox + work queue in one table. Claimed with FOR UPDATE SKIP LOCKED; leases make crashed workers safe.
CREATE TABLE jobs (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  type          text NOT NULL,
  payload       jsonb NOT NULL DEFAULT '{}',
  dedupe_key    text,
  status        text NOT NULL DEFAULT 'PENDING' CHECK (status IN ('PENDING','RUNNING','SUCCEEDED','DEAD')),
  attempts      int NOT NULL DEFAULT 0,
  max_attempts  int NOT NULL DEFAULT 8,
  run_at        timestamptz NOT NULL DEFAULT now(),
  locked_by     text,
  locked_until  timestamptz,
  last_error    text,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  finished_at   timestamptz
);
CREATE UNIQUE INDEX jobs_dedupe_uq ON jobs (dedupe_key) WHERE dedupe_key IS NOT NULL;
CREATE INDEX jobs_ready_idx ON jobs (run_at) WHERE status = 'PENDING';
CREATE INDEX jobs_lease_idx ON jobs (locked_until) WHERE status = 'RUNNING';
CREATE INDEX jobs_dead_idx ON jobs (finished_at DESC) WHERE status = 'DEAD';
CREATE INDEX jobs_cleanup_idx ON jobs (finished_at) WHERE status = 'SUCCEEDED';
ALTER TABLE jobs SET (autovacuum_vacuum_scale_factor = 0.02, autovacuum_vacuum_cost_limit = 1000);

-- Leader-less scheduler: each recurring task is claimed by atomically advancing last_run_at (compare-and-set).
CREATE TABLE recurring_tasks (
  name        text PRIMARY KEY,
  last_run_at timestamptz NOT NULL DEFAULT 'epoch',
  last_error  text
);

CREATE TABLE analytics_daily (
  day            date NOT NULL,
  specialty      text NOT NULL,
  scheduled      int NOT NULL DEFAULT 0,
  confirmed      int NOT NULL DEFAULT 0,
  completed      int NOT NULL DEFAULT 0,
  cancelled      int NOT NULL DEFAULT 0,
  no_shows       int NOT NULL DEFAULT 0,
  revenue_minor  bigint NOT NULL DEFAULT 0,
  refunds_minor  bigint NOT NULL DEFAULT 0,
  computed_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (day, specialty)
);
