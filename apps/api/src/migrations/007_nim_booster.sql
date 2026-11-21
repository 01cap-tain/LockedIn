BEGIN;

CREATE TABLE IF NOT EXISTS booster_campaigns (
  id text PRIMARY KEY,
  name text NOT NULL,
  status text NOT NULL CHECK (status IN ('REGISTRATION', 'SCORING', 'CLOSED')),
  winner_count integer NOT NULL CHECK (winner_count > 0),
  reward_per_winner_nim integer NOT NULL CHECK (reward_per_winner_nim > 0),
  rules_version integer NOT NULL DEFAULT 1,
  created_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS booster_entries (
  campaign_id text NOT NULL REFERENCES booster_campaigns(id),
  wallet_address text NOT NULL,
  nimiq_address text NOT NULL,
  nimiq_address_verified boolean NOT NULL DEFAULT false,
  status text NOT NULL DEFAULT 'TRACKING' CHECK (status IN ('TRACKING', 'QUALIFIED', 'INELIGIBLE', 'WINNER', 'PAID')),
  joined_at timestamptz NOT NULL DEFAULT now(),
  updated_at timestamptz NOT NULL DEFAULT now(),
  PRIMARY KEY (campaign_id, wallet_address)
);
CREATE INDEX IF NOT EXISTS booster_entries_status_idx
  ON booster_entries (campaign_id, status, joined_at);

INSERT INTO booster_campaigns
  (id, name, status, winner_count, reward_per_winner_nim, rules_version)
VALUES
  ('lockedin-nim-booster-001', 'Stay LockedIn', 'REGISTRATION', 5, 10000, 1)
ON CONFLICT (id) DO NOTHING;

COMMIT;
