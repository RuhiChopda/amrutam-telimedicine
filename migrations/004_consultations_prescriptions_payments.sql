-- consultations: RANGE-partitioned by scheduled_at (monthly). 100k/day ~ 3M rows/month per partition.
-- Partition key must be part of the PK/unique indexes. prescriptions/payments reference consultation_id logically
-- (no FK: Postgres cannot FK to a partitioned table without the partition key); integrity is enforced in the
-- service layer inside one transaction (see docs/architecture.md, "Partitioning").
CREATE TABLE consultations (
  id            uuid NOT NULL DEFAULT gen_random_uuid(),
  scheduled_at  timestamptz NOT NULL,
  ends_at       timestamptz NOT NULL,
  slot_id       uuid NOT NULL REFERENCES availability_slots(id),
  patient_id    uuid NOT NULL REFERENCES users(id),
  doctor_id     uuid NOT NULL REFERENCES doctors(id),
  specialty     text,
  status        text NOT NULL CHECK (status IN ('PENDING_PAYMENT','CONFIRMED','IN_PROGRESS','COMPLETED','CANCELLED','NO_SHOW')),
  cancel_reason text,
  cancelled_by  uuid,
  cancelled_at  timestamptz,
  reason_enc    text,                                    -- C4: chief complaint
  notes_enc     text,                                    -- C4: clinical notes
  fee_minor     int NOT NULL CHECK (fee_minor >= 0),
  currency      char(3) NOT NULL DEFAULT 'INR',
  started_at    timestamptz,
  completed_at  timestamptz,
  version       int NOT NULL DEFAULT 0,
  created_at    timestamptz NOT NULL DEFAULT now(),
  updated_at    timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (id, scheduled_at)
) PARTITION BY RANGE (scheduled_at);
CREATE TABLE consultations_default PARTITION OF consultations DEFAULT;
SELECT ensure_monthly_partitions('consultations', 2, 6);

-- Defence in depth against double booking: at most one live consultation per slot.
CREATE UNIQUE INDEX consultations_slot_live_uq ON consultations (slot_id, scheduled_at)
  WHERE status IN ('PENDING_PAYMENT','CONFIRMED','IN_PROGRESS','COMPLETED','NO_SHOW');
CREATE INDEX consultations_patient_idx ON consultations (patient_id, scheduled_at DESC, id);
CREATE INDEX consultations_doctor_idx ON consultations (doctor_id, scheduled_at DESC, id);
CREATE INDEX consultations_active_idx ON consultations (scheduled_at) WHERE status IN ('CONFIRMED','IN_PROGRESS');
CREATE INDEX consultations_status_idx ON consultations (status, scheduled_at);
CREATE INDEX consultations_id_idx ON consultations (id);

CREATE TRIGGER consultations_updated_at BEFORE UPDATE ON consultations FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE payments (
  id                  uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id     uuid NOT NULL,
  patient_id          uuid NOT NULL REFERENCES users(id),
  amount_minor        int  NOT NULL CHECK (amount_minor > 0),
  currency            char(3) NOT NULL DEFAULT 'INR',
  status              text NOT NULL DEFAULT 'PENDING'
                      CHECK (status IN ('PENDING','REQUIRES_PAYMENT','SUCCEEDED','FAILED','VOIDED','REFUND_PENDING','REFUNDED')),
  provider            text NOT NULL DEFAULT 'mock',
  provider_ref        text,
  client_secret_enc   text,                              -- C4
  refund_amount_minor int,
  refund_ref          text,
  failure_code        text,
  expires_at          timestamptz,                       -- payment window == slot hold expiry
  paid_at             timestamptz,
  refunded_at         timestamptz,
  created_at          timestamptz NOT NULL DEFAULT now(),
  updated_at          timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER payments_updated_at BEFORE UPDATE ON payments FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE UNIQUE INDEX payments_consultation_live_uq ON payments (consultation_id) WHERE status NOT IN ('FAILED','VOIDED');
CREATE UNIQUE INDEX payments_provider_ref_uq ON payments (provider, provider_ref) WHERE provider_ref IS NOT NULL;
CREATE INDEX payments_patient_idx ON payments (patient_id, created_at DESC);
CREATE INDEX payments_consultation_idx ON payments (consultation_id);
CREATE INDEX payments_expiry_idx ON payments (expires_at) WHERE status IN ('PENDING','REQUIRES_PAYMENT');

-- Prescriptions are immutable, versioned, and integrity-signed. A revision supersedes the previous version.
CREATE TABLE prescriptions (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL,
  patient_id      uuid NOT NULL REFERENCES users(id),
  doctor_id       uuid NOT NULL REFERENCES doctors(id),
  version         int  NOT NULL DEFAULT 1,
  status          text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUPERSEDED')),
  supersedes_id   uuid REFERENCES prescriptions(id),
  content_enc     text NOT NULL,                         -- C4: diagnosis + medication items (JSON, encrypted)
  content_sha256  bytea NOT NULL,
  signature       text NOT NULL,                         -- HMAC (or KMS signature) over id|consultation|version|hash
  created_at      timestamptz NOT NULL DEFAULT now(),
  UNIQUE (consultation_id, version)
);
CREATE INDEX prescriptions_patient_idx ON prescriptions (patient_id, created_at DESC, id);
CREATE INDEX prescriptions_doctor_idx ON prescriptions (doctor_id, created_at DESC, id);

CREATE TABLE reviews (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  consultation_id uuid NOT NULL UNIQUE,
  patient_id      uuid NOT NULL REFERENCES users(id),
  doctor_id       uuid NOT NULL REFERENCES doctors(id),
  rating          smallint NOT NULL CHECK (rating BETWEEN 1 AND 5),
  comment         text CHECK (char_length(comment) <= 1000),
  created_at      timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX reviews_doctor_idx ON reviews (doctor_id, created_at DESC);
