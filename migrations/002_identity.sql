-- Data classification: see docs/security/threat-model.md (C1 public, C2 internal, C3 PII, C4 PHI/secret).
CREATE TABLE users (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  email_bidx            bytea NOT NULL UNIQUE,          -- HMAC-SHA256 blind index of normalised email (lookup without decrypting)
  email_enc             text  NOT NULL,                 -- C3: AES-256-GCM field encryption
  password_hash         text  NOT NULL,                 -- scrypt, per-user salt
  role                  text  NOT NULL CHECK (role IN ('patient','doctor','admin','auditor')),
  status                text  NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','SUSPENDED','DELETED')),
  mfa_enabled           boolean NOT NULL DEFAULT false,
  mfa_secret_enc        text,                           -- C4: TOTP secret
  mfa_pending_secret_enc text,
  mfa_last_counter      bigint,                         -- TOTP replay protection
  mfa_recovery_hashes   text[] NOT NULL DEFAULT '{}',   -- sha256 of single-use recovery codes
  failed_login_count    int NOT NULL DEFAULT 0,
  locked_until          timestamptz,
  last_login_at         timestamptz,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now()
);
CREATE TRIGGER users_updated_at BEFORE UPDATE ON users FOR EACH ROW EXECUTE FUNCTION set_updated_at();

CREATE TABLE profiles (
  user_id           uuid PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  full_name_enc     text NOT NULL,                      -- C3
  phone_enc         text,                               -- C3
  phone_bidx        bytea,
  date_of_birth_enc text,                               -- C3
  gender            text CHECK (gender IN ('female','male','other','undisclosed')),
  locale            text NOT NULL DEFAULT 'en-IN',
  timezone          text NOT NULL DEFAULT 'Asia/Kolkata',
  created_at        timestamptz NOT NULL DEFAULT now(),
  updated_at        timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX profiles_phone_bidx_idx ON profiles (phone_bidx) WHERE phone_bidx IS NOT NULL;
CREATE TRIGGER profiles_updated_at BEFORE UPDATE ON profiles FOR EACH ROW EXECUTE FUNCTION set_updated_at();

-- Refresh-token sessions. Tokens are opaque; only sha256(token) is stored.
-- family_id links a rotation chain: presenting an already-rotated token revokes the whole family (theft detection).
CREATE TABLE sessions (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  user_id      uuid NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  family_id    uuid NOT NULL,
  token_hash   bytea NOT NULL UNIQUE,
  status       text NOT NULL DEFAULT 'ACTIVE' CHECK (status IN ('ACTIVE','ROTATED','REVOKED')),
  mfa_verified boolean NOT NULL DEFAULT false,
  ip           inet,
  user_agent   text,
  created_at   timestamptz NOT NULL DEFAULT now(),
  expires_at   timestamptz NOT NULL,
  rotated_at   timestamptz
);
CREATE INDEX sessions_user_idx ON sessions (user_id) WHERE status = 'ACTIVE';
CREATE INDEX sessions_family_idx ON sessions (family_id);
CREATE INDEX sessions_expiry_idx ON sessions (expires_at);
