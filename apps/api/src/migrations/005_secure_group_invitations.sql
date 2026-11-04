-- Invitation secrets never enter PostgreSQL. This nullable commitment lets the
-- read-only indexer distinguish one-time protocol 1.2 invitations while keeping
-- legacy deployment rows readable.
ALTER TABLE group_invitations
  ADD COLUMN IF NOT EXISTS commitment text;

CREATE UNIQUE INDEX IF NOT EXISTS group_invitations_commitment_idx
  ON group_invitations (vault_address, commitment)
  WHERE commitment IS NOT NULL;
