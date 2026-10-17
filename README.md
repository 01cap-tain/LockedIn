# LockedIn Circle

Phase 1 local-development prototype for personal and group savings vaults. It preserves the Nimiq Pay Mini App wallet connection and adds non-upgradeable Solidity contracts tested on Hardhat with mock USDT.

The Nimiq account shown by the Mini App and the local Hardhat EVM signer are separate identities. The local signer is only a development mechanism; a production identity and signing architecture is not implemented.

## Requirements

- Node.js 22.13 or later
- npm
- Nimiq Pay for native provider testing

## Install and verify

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
```

## Run locally

Use three terminals from the repository root.

1. Start the local EVM:

   ```sh
   npm run contracts:node
   ```

2. Deploy mock USDT, `VaultFactory`, and `RewardPool`:

   ```sh
   npm run contracts:deploy
   ```

3. Copy `.env.example` to `.env.local`, replace `VITE_FACTORY_ADDRESS` with the deployed factory address, then start the frontend:

   ```sh
   npm run dev
   ```

The frontend defaults to `http://127.0.0.1:8545` and uses Hardhat's first unlocked account for local contract calls. The deployer receives mock USDT for testing.

Open `http://localhost:5173` for the browser preview. To test the preserved Nimiq connection, put the phone and development computer on the same network and open the Vite network URL through Nimiq Pay's Mini App custom URL field.

## Workspace

- `apps/web`: React, TypeScript and Vite Mini App UI
- `packages/contracts`: Hardhat 3 project, Solidity contracts, mocks and JavaScript tests
- `docs/LOCKEDIN_SPEC.md`: Phase 1 workflow, permissions and security invariants

## Phase 1 limits

- Mock USDT and local Hardhat only
- No Aave integration or yield adapter implementation
- No early-exit market implementation
- No guardian recovery
- No mainnet deployment configuration
- No production link between Nimiq and EVM identities
- Contracts are unaudited
