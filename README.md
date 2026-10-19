# LockedIn Circle

LockedIn Circle is a Nimiq Pay Mini App prototype for personal and group savings. Solidity contracts own the financial state; the React and TypeScript client prepares wallet transactions and reads contract state.

The Nimiq and EVM addresses are separate identities and are displayed independently. Only the connected EVM address owns vault positions and signs contract transactions.

Group vaults retain one isolated position per member. They are not Nimiq multisig or shared-custody wallets. At least four proposed members must accept the immutable terms within 72 hours before deposits are enabled. Before maturity, a member can request a fee-free cooperative exit; every other required active Polygon EVM member must independently retain at least 25% of their target in active principal and approve on-chain within 24 hours. Authorization then has a separate 24-hour execution window and cannot leave fewer than four active savers. Cancellation or expiry enables the deterministic Early-Exit Market fallback.

## Requirements

- Node.js 22.13 or later
- npm
- Nimiq Pay for native-provider testing
- A development EVM wallet for Polygon Amoy testing

## Install and validate

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

The optional Polygon-mainnet fork suite additionally requires `POLYGON_RPC_URL`:

```sh
npm run test:polygon-fork -w @lockedin-circle/contracts
```

## NIM funding simulation

Nimiq Pay's documented Mini App interface does not currently expose a general
NIM/Polygon-USDT swap API. The frontend therefore keeps swap orchestration
behind a provider-neutral adapter and supplies a deterministic simulator for
local and Amoy UI testing only. It never moves, mints or reports real assets.

Set these values only in an ignored local/test environment file:

```sh
VITE_ENABLE_MOCK_SWAPS=true
VITE_SWAP_ENVIRONMENT=local
VITE_SWAP_NIMIQ_NETWORK=testnet
```

The simulator is disabled for mainnet configuration and all production builds.
See [the feasibility report](docs/NIM_SWAP_FEASIBILITY.md) for the inspected
official surfaces and the boundary that a future production adapter must meet.

## Local Hardhat development

Use three terminals from the repository root:

```sh
npm run contracts:node
npm run contracts:deploy
npm run contracts:smoke
npm run dev
```

Copy `.env.example` to the ignored `.env` and replace `VITE_FACTORY_ADDRESS` with the deployment output. Enable `VITE_ENABLE_HARDHAT_FALLBACK` only for local development. Hardhat accounts and their published keys must never receive real assets.

## Persistent Polygon Amoy development

Polygon Amoy uses chain ID `80002`. Because this project has no official Aave V3 deployment to use on Amoy, it deploys MockUSDT plus an isolated `MockYieldAdapter` for every Earn vault. It does not invent Aave addresses.

Copy `.env.amoy.example` to the ignored `.env.amoy`, fill it with disposable Amoy-only credentials, and follow [the Amoy runbook](docs/AMOY_TESTNET.md). The deployment command writes public versioned manifests under `packages/contracts/deployments/amoy/`.

```sh
npm run contracts:deploy:amoy
npm run contracts:test:amoy
npm run contracts:test:amoy:persistence
npm run contracts:inspect:amoy
npm run dev:amoy
```

The browser verifies the connected chain and the manifest's complete deployment
identity before enabling contract writes. A mismatched or stale manifest is a
hard blocker. Polygon-mainnet preparation is read-only: copy
`.env.polygon.example`, provide reviewed public governance/cap values and an RPC
in the environment, then run `npm run contracts:prepare:polygon`. That command
validates the maintained Aave address-book entries and never owns a signer or
broadcasts a transaction.

## Workspace

- `apps/web`: React, TypeScript and Vite Mini App UI
- `packages/contracts`: Hardhat 3, Solidity contracts, adapters, mocks and tests
- `docs/LOCKEDIN_SPEC.md`: workflow, permissions and security invariants
- `docs/AMOY_TESTNET.md`: credential-safe Amoy deployment and validation runbook
- `docs/INDEXER.md`: read-only PostgreSQL indexer, APIs and wallet-authenticated notifications

## Current limits

- Amoy uses MockUSDT and MockYieldAdapter; it does not claim real Aave integration.
- Production Aave behavior is tested locally and optionally against a Polygon-mainnet fork.
- Early exits are full-position, pre-maturity sales only.
- Cooperative group exits use a 24-hour window and require unanimous N-1 approval from active members who have each saved at least 25% of their target. Completion still requires completed active-member goals and at least four active members; market exits retain the system discount and fee.
- Nimiq Pay Amoy support is not officially documented and requires a real-device probe.
- No guardian recovery, borrowing or mainnet deployment exists. The PostgreSQL service is a read-only event projection and never has financial authority.
- Contracts remain unaudited.
