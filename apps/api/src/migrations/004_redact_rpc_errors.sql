BEGIN;

UPDATE indexer_state
SET last_error = regexp_replace(
  last_error,
  '(https?|wss?)://[^[:space:]"''\\]+',
  '[redacted RPC URL]',
  'gi'
)
WHERE last_error ~* '(https?|wss?)://';

UPDATE indexer_errors
SET message = regexp_replace(
  message,
  '(https?|wss?)://[^[:space:]"''\\]+',
  '[redacted RPC URL]',
  'gi'
)
WHERE message ~* '(https?|wss?)://';

COMMIT;
