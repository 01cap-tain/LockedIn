BEGIN;

CREATE TABLE IF NOT EXISTS protocol_deployments (
  deployment_id text PRIMARY KEY,
  chain_id bigint NOT NULL,
  protocol_version text NOT NULL,
  factory_address text NOT NULL,
  deployment_block bigint NOT NULL,
  manifest_path text,
  active boolean NOT NULL DEFAULT false,
  created_at timestamptz NOT NULL DEFAULT now(),
  UNIQUE (chain_id, factory_address)
);

ALTER TABLE indexer_state ADD COLUMN IF NOT EXISTS deployment_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE indexer_state DROP CONSTRAINT IF EXISTS indexer_state_pkey;
ALTER TABLE indexer_state ADD PRIMARY KEY (chain_id, deployment_id);

ALTER TABLE chain_events ADD COLUMN IF NOT EXISTS deployment_id text NOT NULL DEFAULT 'legacy';
ALTER TABLE chain_events DROP CONSTRAINT IF EXISTS chain_events_chain_id_transaction_hash_log_index_key;
CREATE UNIQUE INDEX IF NOT EXISTS chain_events_deployment_tx_log_idx
  ON chain_events (deployment_id, transaction_hash, log_index);
CREATE INDEX IF NOT EXISTS chain_events_deployment_block_idx
  ON chain_events (deployment_id, block_number, transaction_index, log_index);

ALTER TABLE vaults ADD COLUMN IF NOT EXISTS deployment_id text NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS vaults_deployment_idx
  ON vaults (deployment_id, creation_block_number DESC);

ALTER TABLE indexer_errors ADD COLUMN IF NOT EXISTS deployment_id text NOT NULL DEFAULT 'legacy';
CREATE INDEX IF NOT EXISTS indexer_errors_deployment_idx
  ON indexer_errors (deployment_id, occurred_at DESC);

COMMIT;
