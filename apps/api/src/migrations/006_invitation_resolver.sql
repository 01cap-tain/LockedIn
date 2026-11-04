BEGIN;

CREATE TABLE IF NOT EXISTS verified_wallet_profiles (
  wallet_address text PRIMARY KEY,
  username text NOT NULL,
  username_normalized text NOT NULL UNIQUE,
  updated_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT verified_username_format CHECK (username_normalized ~ '^[a-z0-9_]{3,24}$')
);

CREATE TABLE IF NOT EXISTS invitation_lookup_codes (
  code text PRIMARY KEY,
  chain_id bigint NOT NULL,
  vault_address text NOT NULL,
  creator_address text NOT NULL,
  invitee_address text NOT NULL,
  recipient_username text,
  commitment text NOT NULL UNIQUE,
  invitation_payload jsonb NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT invitation_code_format CHECK (code ~ '^[A-HJ-NP-Z2-9]{6}$')
);
CREATE INDEX IF NOT EXISTS invitation_lookup_invitee_idx
  ON invitation_lookup_codes (invitee_address, expires_at DESC);
CREATE INDEX IF NOT EXISTS invitation_lookup_creator_idx
  ON invitation_lookup_codes (creator_address, created_at DESC);

CREATE TABLE IF NOT EXISTS invitation_lookup_failures (
  actor_hash text NOT NULL,
  attempted_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS invitation_lookup_failures_window_idx
  ON invitation_lookup_failures (actor_hash, attempted_at DESC);

COMMIT;
