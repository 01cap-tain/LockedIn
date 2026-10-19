BEGIN;

CREATE TABLE IF NOT EXISTS indexer_errors (
  id bigserial PRIMARY KEY,
  chain_id bigint NOT NULL,
  message text NOT NULL,
  occurred_at timestamptz NOT NULL DEFAULT now()
);
CREATE INDEX IF NOT EXISTS indexer_errors_chain_idx
  ON indexer_errors (chain_id, occurred_at DESC);

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

ALTER TABLE notifications ADD COLUMN IF NOT EXISTS dedupe_key text;
CREATE UNIQUE INDEX IF NOT EXISTS notifications_dedupe_key_idx
  ON notifications (dedupe_key);

COMMIT;
