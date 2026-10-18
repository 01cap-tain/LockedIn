# LockedIn Circle

LockedIn Circle is a Nimiq Pay Mini App prototype for personal and group savings. Solidity contracts own the financial state; the React and TypeScript client prepares wallet transactions and reads contract state.

The Nimiq and EVM addresses are separate identities and are displayed independently. Only the connected EVM address owns vault positions and signs contract transactions.

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

## Local Hardhat development

Use three terminals from the repository root:

```sh
npm run contracts:node
npm run contracts:deploy
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
npm run dev:amoy
```

## Workspace

- `apps/web`: React, TypeScript and Vite Mini App UI
- `packages/contracts`: Hardhat 3, Solidity contracts, adapters, mocks and tests
- `docs/LOCKEDIN_SPEC.md`: workflow, permissions and security invariants
- `docs/AMOY_TESTNET.md`: credential-safe Amoy deployment and validation runbook

## Current limits

- Amoy uses MockUSDT and MockYieldAdapter; it does not claim real Aave integration.
- Production Aave behavior is tested locally and optionally against a Polygon-mainnet fork.
- Early exits are full-position, pre-maturity sales only.
- Nimiq Pay Amoy support is not officially documented and requires a real-device probe.
- No guardian recovery, borrowing, mainnet deployment or PostgreSQL indexer exists yet.
- Contracts remain unaudited.
