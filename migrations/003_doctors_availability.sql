CREATE TABLE doctors (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id              uuid NOT NULL UNIQUE REFERENCES users(id),
  display_name         text NOT NULL,                    -- C1 public profile fields
  bio                  text,
  specialties          text[] NOT NULL CHECK (cardinality(specialties) BETWEEN 1 AND 8),
  primary_specialty    text GENERATED ALWAYS AS (specialties[1]) STORED,
  languages            text[] NOT NULL DEFAULT '{}',
  city                 text,
  license_number       text NOT NULL UNIQUE,
  years_experience     int  NOT NULL DEFAULT 0 CHECK (years_experience BETWEEN 0 AND 70),
  consultation_fee_minor int NOT NULL CHECK (consultation_fee_minor >= 0),
  currency             char(3) NOT NULL DEFAULT 'INR',
  rating_avg           numeric(3,2) NOT NULL DEFAULT 0,
  rating_count         int NOT NULL DEFAULT 0,
  verification_status  text NOT NULL DEFAULT 'PENDING' CHECK (verification_status IN ('PENDING','VERIFIED','REJECTED','SUSPENDED')),
  verified_at          timestamptz,
  verified_by          uuid REFERENCES users(id),
  search_tsv           tsvector,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER doctors_updated_at BEFORE UPDATE ON doctors FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE FUNCTION doctors_search_tsv() RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  NEW.search_tsv :=
    setweight(to_tsvector('simple', coalesce(NEW.display_name, '')), 'A') ||
    setweight(to_tsvector('simple', array_to_string(NEW.specialties, ' ')), 'B') ||
    setweight(to_tsvector('simple', coalesce(NEW.bio, '')), 'C');
  RETURN NEW;
END $$;
CREATE TRIGGER doctors_search_tsv_trg BEFORE INSERT OR UPDATE OF display_name, bio, specialties ON doctors
  FOR EACH ROW EXECUTE FUNCTION doctors_search_tsv();

CREATE INDEX doctors_search_gin ON doctors USING gin (search_tsv);
CREATE INDEX doctors_name_trgm ON doctors USING gin (display_name gin_trgm_ops);
CREATE INDEX doctors_specialties_gin ON doctors USING gin (specialties);
CREATE INDEX doctors_languages_gin ON doctors USING gin (languages);
CREATE INDEX doctors_city_idx ON doctors (lower(city)) WHERE verification_status = 'VERIFIED';
CREATE INDEX doctors_rating_idx ON doctors (rating_avg DESC, id) WHERE verification_status = 'VERIFIED';
CREATE INDEX doctors_fee_idx ON doctors (consultation_fee_minor, id) WHERE verification_status = 'VERIFIED';
CREATE INDEX doctors_experience_idx ON doctors (years_experience DESC, id) WHERE verification_status = 'VERIFIED';
CREATE INDEX doctors_pending_idx ON doctors (created_at) WHERE verification_status = 'PENDING';

-- Slot lifecycle: OPEN -> HELD (payment pending, expires) -> BOOKED; HELD -> OPEN (hold expiry / payment failure / cancel).
-- The exclusion constraint makes overlapping slots for one doctor impossible regardless of application bugs/races.
CREATE TABLE availability_slots (
  id              uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  doctor_id       uuid NOT NULL REFERENCES doctors(id),
  start_at        timestamptz NOT NULL,
  end_at          timestamptz NOT NULL,
  status          text NOT NULL DEFAULT 'OPEN' CHECK (status IN ('OPEN','HELD','BOOKED','CANCELLED')),
  held_by         uuid REFERENCES users(id),
  hold_expires_at timestamptz,
  version         int NOT NULL DEFAULT 0,
  created_at      timestamptz NOT NULL DEFAULT now(),
  updated_at      timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT slot_range_valid CHECK (end_at > start_at AND end_at - start_at <= interval '4 hours'),
  CONSTRAINT slot_hold_consistent CHECK ((status = 'HELD') = (hold_expires_at IS NOT NULL)),
  CONSTRAINT slots_no_overlap EXCLUDE USING gist (
    doctor_id WITH =, tstzrange(start_at, end_at, '[)') WITH &&
  ) WHERE (status <> 'CANCELLED')
);
CREATE TRIGGER slots_updated_at BEFORE UPDATE ON availability_slots FOR EACH ROW EXECUTE FUNCTION set_updated_at();
CREATE INDEX slots_open_idx ON availability_slots (doctor_id, start_at) WHERE status = 'OPEN';
CREATE INDEX slots_doctor_time_idx ON availability_slots (doctor_id, start_at);
CREATE INDEX slots_open_time_idx ON availability_slots (start_at) WHERE status = 'OPEN';
CREATE INDEX slots_hold_expiry_idx ON availability_slots (hold_expires_at) WHERE status = 'HELD';
