# LockedIn Circle

Phase 2A local/test prototype for personal and group savings vaults with a competitive early-exit market. It preserves the Nimiq Pay Mini App wallet connection and uses Nimiq Pay's separate injected EVM provider for contract ownership and signing.

The Nimiq and EVM addresses are separate identities and are displayed independently. Contract actions use the EVM address. Hardhat's unlocked signer is disabled unless the explicit development fallback is enabled.

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

3. Copy `.env.example` to `.env.local`, replace `VITE_FACTORY_ADDRESS` with the deployed factory address, and set `VITE_ENABLE_HARDHAT_FALLBACK=true` for local development only. Then start the frontend:

   ```sh
   npm run dev
   ```

The frontend defaults to Hardhat chain ID `0x7a69`. With the explicit fallback enabled it uses Hardhat's first unlocked account; otherwise contract actions require `window.ethereum` from Nimiq Pay. The deployer receives mock USDT for testing.

Open `http://localhost:5173` for the browser preview. To test the preserved Nimiq connection, put the phone and development computer on the same network and open the Vite network URL through Nimiq Pay's Mini App custom URL field.

## Workspace

- `apps/web`: React, TypeScript and Vite Mini App UI
- `packages/contracts`: Hardhat 3 project, Solidity contracts, mocks and JavaScript tests
- `docs/LOCKEDIN_SPEC.md`: Phase 1 workflow, permissions and security invariants

## Current limits

- Mock USDT and local Hardhat only
- No Aave integration or yield adapter implementation
- Early exits are full-position, pre-maturity sales only
- No guardian recovery
- No mainnet deployment configuration
- No assertion that the Nimiq and EVM addresses belong to the same key or account
- Contracts are unaudited
