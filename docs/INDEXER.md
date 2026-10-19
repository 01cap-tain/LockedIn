# Read-only blockchain indexer and notifications

## Authority boundary

Polygon contract state remains authoritative for balances, ownership, invitations, approvals, prices, settlements and rewards. The Fastify/PostgreSQL service is a disposable read projection. It has no signer, private key, transaction-submission route, editable discount, approval override, settlement override or reward-recipient authority. Frontend transaction controls must still read current contract state immediately before enabling or submitting an action.

Wallet authentication protects only notification records and preferences. It uses an expiring, single-use nonce signed by the EVM wallet, stores hashes of session bearer tokens, and creates a 30-minute session by default. A session cannot move funds or call a contract. There are no password accounts.

## Indexing lifecycle

1. Read the chain ID, contract addresses and deployment block from the versioned deployment manifest.
2. Resume from `indexer_state.last_safe_block`, never block zero.
3. Subtract the configured confirmation depth from the RPC head and query at most `INDEXER_LOG_RANGE` blocks per batch.
4. Scan the factory, market, RewardPool and safety controller, then include every factory-discovered vault. Address batches are bounded to 50.
5. Store block number/hash, transaction hash/index and log index. `(chain_id, transaction_hash, log_index)` is unique, so replay is idempotent.
6. Before each batch, compare the saved canonical block hash to the RPC. On mismatch, find the latest retained common ancestor, delete orphaned events/blocks and rebuild all chain-derived projections from canonical events.
7. Advance the cursor only in the same database transaction that stores all blocks, events and projections for the range.

RPC failures are retained in `indexer_errors`; `/health`, `/api/indexer/status` and `/api/indexer/errors` expose current health without exposing credentials.

## Stored projections

- Vault discovery and lifecycle
- Group invitations and member status changes
- Cooperative-exit requests and approvals
- Market listings and completed trades
- Reward-epoch events and claims
- Canonical deposit, withdrawal and transaction activity
- In-app notifications and optional wallet preferences

The chain-event table is the rebuild source. Authentication sessions, nonces and user preferences are not chain projections and are not deleted during a reorganization.

## Notifications

The service creates in-app notifications for invitations, responses, activation, cooperative requests/approvals, approvers below the independent 25% principal threshold, pending/authorized expiry warnings, exit completion/expiry, market settlement, approaching maturity and funded rewards. Notification delivery failure never changes a contract outcome. Web Push is intentionally disabled until a supported runtime and explicit VAPID configuration are supplied.

## Local setup

Copy the safe variable names from `.env.example` into the ignored `.env` and provide a dedicated PostgreSQL role/database. `INDEXER_RPC_URL` must be a read-only RPC; no account key is used.

```powershell
npm run contracts:deploy
npm run api:migrate
npm run api:dev
```

The API starts on `127.0.0.1:3001` by default. The server runs the indexer and advisory notification sweep in the same process for this testnet milestone. A production topology should run them as separately supervised processes against the same schema.

## Read APIs

- `GET /api/vaults`
- `GET /api/market/listings`
- `GET /api/market/trades`
- `GET /api/wallets/:wallet/history`
- `GET /api/groups/invitations`
- `GET /api/groups/exits`
- `GET /api/rewards/history`
- `GET /api/activity`
- `GET /api/indexer/status`

Authenticated notification APIs begin with `POST /api/auth/nonce`, `POST /api/auth/verify`, and then use the returned short-lived bearer token for `/api/notifications` and `/api/preferences`.
