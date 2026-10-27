-- Append-only, tamper-evident audit trail. RANGE-partitioned monthly so old partitions can be detached and archived
-- to object storage (WORM) without touching hot data.
CREATE TABLE audit_logs (
  id          bigint GENERATED ALWAYS AS IDENTITY,
  created_at  timestamptz NOT NULL,
  actor_id    uuid,
  actor_role  text,
  action      text NOT NULL,
  entity_type text,
  entity_id   text,
  outcome     text NOT NULL DEFAULT 'SUCCESS' CHECK (outcome IN ('SUCCESS','DENIED','FAILURE')),
  ip          inet,
  user_agent  text,
  request_id  text,
  trace_id    text,
  metadata    jsonb NOT NULL DEFAULT '{}',               -- never contains PHI/PII values, only identifiers and field names
  sig         bytea NOT NULL,                            -- HMAC-SHA256 over canonical row (key is NOT in the database)
  PRIMARY KEY (id, created_at)
) PARTITION BY RANGE (created_at);
CREATE TABLE audit_logs_default PARTITION OF audit_logs DEFAULT;
SELECT ensure_monthly_partitions('audit_logs', 1, 6);

CREATE INDEX audit_logs_actor_idx ON audit_logs (actor_id, created_at DESC);
CREATE INDEX audit_logs_entity_idx ON audit_logs (entity_type, entity_id, created_at DESC);
CREATE INDEX audit_logs_action_idx ON audit_logs (action, created_at DESC);
CREATE INDEX audit_logs_time_brin ON audit_logs USING brin (created_at);

CREATE FUNCTION audit_logs_block_mutation() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'audit_logs is append-only (% blocked)', TG_OP USING ERRCODE = 'insufficient_privilege';
END $$;
CREATE TRIGGER audit_logs_no_update_delete BEFORE UPDATE OR DELETE ON audit_logs
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
CREATE TRIGGER audit_logs_no_truncate BEFORE TRUNCATE ON audit_logs
  FOR EACH STATEMENT EXECUTE FUNCTION audit_logs_block_mutation();

-- Hash-chained checkpoints over windows of audit rows: lets an auditor detect deleted/reordered/forged rows even if an
-- attacker holds DB write access (they would also need the HMAC key and to rewrite every later checkpoint).
CREATE TABLE audit_checkpoints (
  id            bigint GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  period_start  timestamptz NOT NULL,
  period_end    timestamptz NOT NULL,
  row_count     int NOT NULL,
  digest        bytea NOT NULL,
  prev_digest   bytea,
  created_at    timestamptz NOT NULL DEFAULT now(),
  UNIQUE (period_end)
);
CREATE TRIGGER audit_checkpoints_no_update_delete BEFORE UPDATE OR DELETE ON audit_checkpoints
  FOR EACH ROW EXECUTE FUNCTION audit_logs_block_mutation();
