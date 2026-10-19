BEGIN;

CREATE TABLE IF NOT EXISTS schema_migrations (
  version text PRIMARY KEY,
  applied_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexer_state (
  chain_id bigint PRIMARY KEY,
  last_safe_block bigint NOT NULL,
  last_safe_hash text NOT NULL,
  last_error text,
  last_error_at timestamptz,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS indexed_blocks (
  chain_id bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  parent_hash text NOT NULL,
  PRIMARY KEY (chain_id, block_number)
);

CREATE TABLE IF NOT EXISTS indexer_errors (
  id bigserial PRIMARY KEY,
  chain_id bigint NOT NULL,
  message text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS indexer_errors_chain_idx
  ON indexer_errors (chain_id, occurred_at DESC);

CREATE TABLE IF NOT EXISTS chain_events (
  id bigserial PRIMARY KEY,
  chain_id bigint NOT NULL,
  block_number bigint NOT NULL,
  block_hash text NOT NULL,
  transaction_hash text NOT NULL,
  transaction_index integer NOT NULL,
  log_index integer NOT NULL,
  contract_address text NOT NULL,
  event_name text NOT NULL,
  payload jsonb NOT NULL,
  recorded_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, transaction_hash, log_index)
);
CREATE INDEX IF NOT EXISTS chain_events_block_idx
  ON chain_events (chain_id, block_number, transaction_index, log_index);
CREATE INDEX IF NOT EXISTS chain_events_name_idx
  ON chain_events (event_name, block_number DESC);

CREATE TABLE IF NOT EXISTS vaults (
  address text PRIMARY KEY,
  creator text NOT NULL,
  is_group boolean NOT NULL,
  mode smallint NOT NULL,
  yield_adapter text NOT NULL,
  maturity bigint NOT NULL,
  lifecycle text NOT NULL DEFAULT 'ACTIVE',
  creation_transaction_hash text NOT NULL,
  creation_block_number bigint NOT NULL,
  source_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS vaults_discovery_idx
  ON vaults (is_group, creation_block_number DESC);

CREATE TABLE IF NOT EXISTS group_invitations (
  vault_address text NOT NULL,
  member_address text NOT NULL,
  status text NOT NULL,
  expires_at bigint,
  updated_block_number bigint NOT NULL,
  source_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
  PRIMARY KEY (vault_address, member_address)
);
CREATE INDEX IF NOT EXISTS group_invitations_member_idx
  ON group_invitations (member_address, updated_block_number DESC);

CREATE TABLE IF NOT EXISTS group_member_statuses (
  vault_address text NOT NULL,
  position_id numeric(78, 0) NOT NULL,
  member_address text NOT NULL,
  status smallint NOT NULL,
  updated_block_number bigint NOT NULL,
  source_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
  PRIMARY KEY (vault_address, position_id)
);
CREATE INDEX IF NOT EXISTS group_member_statuses_member_idx
  ON group_member_statuses (member_address, updated_block_number DESC);

CREATE TABLE IF NOT EXISTS cooperative_exit_requests (
  vault_address text NOT NULL,
  request_id numeric(78, 0) NOT NULL,
  requester text NOT NULL,
  position_id numeric(78, 0) NOT NULL,
  status text NOT NULL,
  pending_expires_at bigint,
  authorization_expires_at bigint,
  updated_block_number bigint NOT NULL,
  source_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
  PRIMARY KEY (vault_address, request_id)
);
CREATE INDEX IF NOT EXISTS cooperative_exit_requester_idx
  ON cooperative_exit_requests (requester, updated_block_number DESC);

CREATE TABLE IF NOT EXISTS cooperative_exit_approvals (
  vault_address text NOT NULL,
  request_id numeric(78, 0) NOT NULL,
  approver text NOT NULL,
  approved boolean NOT NULL,
  updated_block_number bigint NOT NULL,
  source_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
  PRIMARY KEY (vault_address, request_id, approver)
);

CREATE TABLE IF NOT EXISTS market_listings (
  market_address text NOT NULL,
  listing_id numeric(78, 0) NOT NULL,
  vault_address text NOT NULL,
  position_id numeric(78, 0) NOT NULL,
  seller text NOT NULL,
  claim_value numeric(78, 0) NOT NULL,
  discount_bps integer NOT NULL,
  saver_payout numeric(78, 0) NOT NULL,
  provider_return numeric(78, 0) NOT NULL,
  provider_fee numeric(78, 0) NOT NULL,
  minimum_payout numeric(78, 0) NOT NULL,
  expires_at bigint NOT NULL,
  status text NOT NULL,
  updated_block_number bigint NOT NULL,
  source_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
  PRIMARY KEY (market_address, listing_id)
);
CREATE INDEX IF NOT EXISTS market_listings_status_idx
  ON market_listings (status, updated_block_number DESC);
CREATE INDEX IF NOT EXISTS market_listings_seller_idx
  ON market_listings (seller, updated_block_number DESC);

CREATE TABLE IF NOT EXISTS completed_trades (
  market_address text NOT NULL,
  listing_id numeric(78, 0) NOT NULL,
  vault_address text NOT NULL,
  position_id numeric(78, 0) NOT NULL,
  seller text NOT NULL,
  provider text NOT NULL,
  claim_value numeric(78, 0) NOT NULL,
  discount_bps integer NOT NULL,
  saver_payout numeric(78, 0) NOT NULL,
  provider_return numeric(78, 0) NOT NULL,
  provider_fee numeric(78, 0) NOT NULL,
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL,
  source_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
  PRIMARY KEY (market_address, listing_id)
);
CREATE INDEX IF NOT EXISTS completed_trades_recent_idx
  ON completed_trades (block_number DESC);
CREATE INDEX IF NOT EXISTS completed_trades_parties_idx
  ON completed_trades (seller, provider, block_number DESC);

CREATE TABLE IF NOT EXISTS reward_epoch_events (
  chain_id bigint NOT NULL,
  epoch_id numeric(78, 0) NOT NULL,
  event_name text NOT NULL,
  vault_address text,
  payload jsonb NOT NULL,
  block_number bigint NOT NULL,
  source_event_id bigint NOT NULL REFERENCES chain_events(id) ON DELETE CASCADE,
  PRIMARY KEY (source_event_id)
);
CREATE INDEX IF NOT EXISTS reward_epoch_history_idx
  ON reward_epoch_events (epoch_id, block_number DESC);

CREATE TABLE IF NOT EXISTS reward_claims (
  recipient text NOT NULL,
  amount numeric(78, 0) NOT NULL,
  transaction_hash text NOT NULL,
  block_number bigint NOT NULL,
  source_event_id bigint PRIMARY KEY REFERENCES chain_events(id) ON DELETE CASCADE
);
CREATE INDEX IF NOT EXISTS reward_claims_recipient_idx
  ON reward_claims (recipient, block_number DESC);

CREATE TABLE IF NOT EXISTS notifications (
  id bigserial PRIMARY KEY,
  wallet_address text NOT NULL,
  kind text NOT NULL,
  title text NOT NULL,
  body text NOT NULL,
  data jsonb NOT NULL DEFAULT '{}'::jsonb,
  dedupe_key text UNIQUE,
  source_event_id bigint REFERENCES chain_events(id) ON DELETE CASCADE,
  read_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (wallet_address, kind, source_event_id)
);
CREATE INDEX IF NOT EXISTS notifications_wallet_idx
  ON notifications (wallet_address, created_at DESC);

CREATE TABLE IF NOT EXISTS wallet_preferences (
  wallet_address text PRIMARY KEY,
  in_app_enabled boolean NOT NULL DEFAULT true,
  web_push_enabled boolean NOT NULL DEFAULT false,
  push_subscription jsonb,
  updated_at timestamptz NOT NULL DEFAULT now()
);

CREATE TABLE IF NOT EXISTS auth_nonces (
  nonce_hash text PRIMARY KEY,
  wallet_address text NOT NULL,
  message text NOT NULL,
  expires_at timestamptz NOT NULL,
  consumed_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_nonces_wallet_idx
  ON auth_nonces (wallet_address, expires_at DESC);

CREATE TABLE IF NOT EXISTS auth_sessions (
  token_hash text PRIMARY KEY,
  wallet_address text NOT NULL,
  expires_at timestamptz NOT NULL,
  revoked_at timestamptz,
  created_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS auth_sessions_wallet_idx
  ON auth_sessions (wallet_address, expires_at DESC);

COMMIT;
