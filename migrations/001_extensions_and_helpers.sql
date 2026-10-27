-- Extensions (all are "trusted" extensions in PG13+, so the DB owner can create them; available on RDS/Aurora).
CREATE EXTENSION IF NOT EXISTS btree_gist;  -- exclusion constraint on (doctor_id, time range)
CREATE EXTENSION IF NOT EXISTS pg_trgm;     -- fuzzy doctor-name search
CREATE EXTENSION IF NOT EXISTS pgcrypto;    -- gen_random_uuid() fallback / digest helpers

CREATE OR REPLACE FUNCTION set_updated_at() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.updated_at := now();
  RETURN NEW;
END $$;

-- Creates monthly RANGE partitions [now-months_back, now+months_ahead] for a partitioned parent table.
-- Idempotent and safe under concurrent callers. Called by the migration and by the scheduler ("partitions.ensure").
CREATE OR REPLACE FUNCTION ensure_monthly_partitions(parent regclass, months_back int, months_ahead int)
RETURNS int LANGUAGE plpgsql AS $$
DECLARE
  parent_name text;
  start_d date;
  end_d date;
  part_name text;
  created int := 0;
BEGIN
  SELECT relname INTO parent_name FROM pg_class WHERE oid = parent;
  PERFORM pg_advisory_xact_lock(hashtext('ensure_monthly_partitions:' || parent_name));
  FOR i IN -months_back..months_ahead LOOP
    start_d := (date_trunc('month', timezone('UTC', now())) + make_interval(months => i))::date;
    end_d   := (start_d + interval '1 month')::date;
    part_name := format('%s_%s', parent_name, to_char(start_d, 'YYYY_MM'));
    IF to_regclass(part_name) IS NULL THEN
      EXECUTE format(
        'CREATE TABLE %I PARTITION OF %s FOR VALUES FROM (%L) TO (%L)',
        part_name, parent, start_d::text || ' 00:00:00+00', end_d::text || ' 00:00:00+00');
      created := created + 1;
    END IF;
  END LOOP;
  RETURN created;
END $$;
