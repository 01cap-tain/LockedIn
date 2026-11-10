# LockedIn Circle Polygon Mainnet Readiness — 2026-11-09

## Decision

**NO-GO. Do not broadcast a Polygon mainnet deployment yet.**

This review is read-only with respect to Polygon. No transaction was signed or broadcast.

## Source state

- Reviewed commit: `d8b4ec8fa749e3653f457a5bdc0a193693c5fc5a`
- Branch: `main`
- Worktree: dirty because the requested `apps/landing` removal, lockfile cleanup, and Safe-only preflight command correction are not committed.
- Tracked `.env*` files: none.
- Polygon production manifest: absent.
- Hardhat encrypted keystore: present, with `POLYGON_DEPLOYER_PRIVATE_KEY` configured.

Deployment must use a clean, committed source tree. The eventual manifest must record that exact commit.

## Intended production profile

- Chain: Polygon mainnet (`137`, `0x89`)
- Asset: official Polygon USDT, six decimals
- Protocol version expected by the frontend: `lockedin-circle/1.5.0-safe`
- Mode: Safe-only
- Earn/Aave: disabled and not part of the deployment graph
- Rewards: unavailable in V1
- Minimum maturity: 25,200 seconds (seven hours)
- Maximum maturity: five years
- Early-exit provider fee: 0.9%
- Fee routing: 100% maintenance treasury; RewardPool and risk-reserve allocations are zero while rewards are unavailable
- Upgradeability: none

## Deployment graph

The Safe-only deployment script creates:

1. `SafetyController`
2. `SavingsVaultDeployer`
3. `RewardPool`
4. `VaultFactory`, which creates `EarlyExitMarket`
5. Non-upgradeable `SavingsVault` instances created later by the factory

`AaveYieldAdapter` and mock contracts are not deployed by this production graph.

## Configuration blockers

The read-only preflight stopped before gas-cost and nonce calculation because:

- `POLYGON_SAFETY_COUNCIL_ADDRESS`
- `POLYGON_RISK_RESERVE_ADDRESS`
- `POLYGON_MAINTENANCE_TREASURY_ADDRESS`

currently resolve to the same address. The risk-reserve compatibility address may match maintenance because its allocation is zero, but the Safety Council must remain a distinct security authority.

The following launch caps are also not stored in the local production configuration:

- `POLYGON_MAX_POSITION_PRINCIPAL`
- `POLYGON_MAX_VAULT_PRINCIPAL`
- `POLYGON_MAX_PROTOCOL_PRINCIPAL`

Approved launch ceilings, in six-decimal USDT units:

- Position: `5000000000` (5,000 USDT)
- Vault: `25000000000` (25,000 USDT)
- Protocol: `50000000000` (50,000 USDT)

The deployment-cost ceiling and approved nonce must be copied from a successful fresh preflight. They must not be guessed. The deployment approval phrase must remain unset until the exact plan is reviewed.

## Authority and principal safety

The Safety Council can:

- Pause deposits and new risk-taking actions immediately.
- Schedule unpausing through the immutable timelock.
- Schedule exposure-cap changes through the immutable timelock.
- Cancel pending unpause or cap changes.

The Safety Council cannot withdraw saver principal. Risk-reserve and maintenance addresses are fee recipients only. The deployer receives no general post-deployment withdrawal authority. Locked principal can be paid only through the position-owner maturity path or the defined cooperative-exit path. Emergency funds remain controlled by the original member.

Market settlement transfers only the locked position claim. It does not transfer emergency ownership, group membership, voting power, or reward identity.

## Early-exit pricing

- Discount calculation is on-chain and deterministic.
- Discount is clamped to 4.5%–8%.
- Providers cannot choose or negotiate the discount.
- Settlement recalculates the live claim and discount.
- Settlement reverts below the saver-recorded minimum payout.
- The first successful provider settlement wins.

## Safe-vault reward isolation

The approved product rule is that Safe vaults receive no rewards. Rewards belong only to the future Earn mode, which is not implemented in Safe-only V1.

Safe-only V1 sends no provider fee to `RewardPool`. The complete 0.9% provider fee is transferred atomically to the immutable maintenance treasury. The retained RewardPool contract receives no early-exit revenue and cannot make Safe-vault rewards available.

## Validation results

### Passed

- Solidity active suite: 106 passing
- Solidity legacy/optional cases: 29 pending
- Frontend: 88 passing
- TypeScript: passed for API and frontend
- ESLint: passed
- Production build: passed
- Contract build: passed
- Git diff whitespace check: passed
- Tracked env scan: passed; no `.env*` files tracked

Contract sizes:

- `SavingsVaultDeployer`: 23,808 bytes (768 bytes remaining)
- `SavingsVault`: 19,127 bytes (5,449 bytes remaining)
- `EarlyExitMarket`: 9,080 bytes (15,496 bytes remaining)
- `VaultFactory`: 5,430 bytes (19,146 bytes remaining)
- `SafetyController`: 2,878 bytes (21,698 bytes remaining)

`SavingsVaultDeployer` is close to the EVM runtime-size limit and has limited growth capacity.

### Failed or unavailable

- API suite: 9 tests passed, but the PostgreSQL integration setup timed out and two integration cases were skipped. The local configuration uses Render's private/internal database URL, which is not reachable from the local computer. Re-run from Render or use Render's external database URL locally.
- Production dependency audit: one high-severity transitive `zod@3.25.76` advisory. The API directly uses patched `zod@4.6.7`; the reported v3 dependency comes through contract tooling/dependencies, but the audit is not clean.
- Slither: unavailable, so no current static-analysis report exists.
- Polygon Safe-only live preflight must be rerun after configuring a Safety Council distinct from the maintenance/fee address.
- Polygon mainnet manifest and explorer verification: unavailable because deployment has not occurred.

## Backend and database

Render PostgreSQL is suitable. The database remains read-only infrastructure relative to financial authority; contracts remain authoritative for ownership, balances, discounts, and settlement.

Before production:

1. Run all migrations from the Render API service.
2. Confirm `/health` reports database and indexer status as healthy.
3. Complete initial indexing from the deployment block.
4. Verify profile, invitation, vault, listing, trade, and wallet-history routes.
5. Configure the production frontend with the deployed API origin only after the API is healthy.

## Frontend production switch

The currently hosted frontend is configured for Amoy. Production must use:

- Explorer: `https://polygonscan.com`
- Chain ID: `0x89`
- Network name: `Polygon`
- Mock faucet: disabled
- Hardhat fallback: disabled
- A separate browser-restricted Polygon mainnet RPC key
- Production build mode, not `build:amoy`

The frontend production build intentionally disables contract actions until a reviewed `packages/contracts/deployments/polygon/latest.json` exists and passes identity validation.

## Required actions before GO

1. Commit and validate the requested landing-site removal and preflight correction.
2. Configure a reviewed Safety Council that is distinct from the maintenance/fee address.
3. Confirm the approved 5,000 / 25,000 / 50,000 USDT exposure caps.
4. Run the Safe-only read-only preflight successfully.
5. Record the exact cost ceiling, pending deployer nonce, predicted addresses, constructors, bytecode hashes, and clean Git commit.
6. Resolve or formally isolate the high dependency-audit finding.
7. Install and run Slither, then resolve or document every finding.
8. Run PostgreSQL integration tests successfully against a reachable isolated database.
9. Obtain an independent smart-contract security review before accepting meaningful real-fund exposure.
10. Confirm the immutable 100% maintenance provider-fee routing in the final preflight manifest.
11. Set `POLYGON_DEPLOYMENT_APPROVED=I_APPROVE_THE_EXACT_MANIFEST` only after the final plan is approved.

