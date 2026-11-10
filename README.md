# LockedIn Circle

LockedIn Circle is a goal-based savings application for individuals and groups. It combines self-custodial Polygon USDT vaults, independent emergency balances, cooperative group saving and a deterministic early-exit market in a mobile experience designed for Nimiq Pay.

The Safe-only V1 release is deployed on Polygon mainnet. Financial state, balances, position ownership, maturity rights and exit settlement remain authoritative on-chain. The API and PostgreSQL indexer are read-only discovery and history infrastructure; they cannot move funds or override contract state.

> **Real-funds warning:** the production contracts are non-upgradeable and have not received an independent external audit. Review the contracts, deployment manifest and current limits before depositing funds.

## Production deployment

| Setting | Value |
| --- | --- |
| Network | Polygon mainnet |
| Chain ID | `137` (`0x89`) |
| Protocol | `lockedin-circle/1.5.0-safe` |
| Deployment block | `97068820` |
| Asset | Official Polygon USDT, 6 decimals |
| USDT | [`0xc2132D05D31c914a87C6611c10748AEb04B58e8F`](https://polygonscan.com/address/0xc2132D05D31c914a87C6611c10748AEb04B58e8F) |
| VaultFactory | [`0x3D0f94dD59dD085f1E22Cd82e4bD4f4677291dFE`](https://polygonscan.com/address/0x3D0f94dD59dD085f1E22Cd82e4bD4f4677291dFE) |
| EarlyExitMarket | [`0x2141eD01031eE3aD32EaA0154Df2096238954064`](https://polygonscan.com/address/0x2141eD01031eE3aD32EaA0154Df2096238954064) |
| SavingsVaultDeployer | [`0x4543eAce7ebB9343044fE94C493d27af1076dcCb`](https://polygonscan.com/address/0x4543eAce7ebB9343044fE94C493d27af1076dcCb) |
| SafetyController | [`0xC27daCfD0e08a3cB23845231f21fa30967EB1790`](https://polygonscan.com/address/0xC27daCfD0e08a3cB23845231f21fa30967EB1790) |
| RewardPool (inactive) | [`0xe9002BcAC27F07Cf79Cbd84D9cD5d00dB85EF18C`](https://polygonscan.com/address/0xe9002BcAC27F07Cf79Cbd84D9cD5d00dB85EF18C) |

The complete immutable deployment identity, constructor arguments, transaction hashes, fee configuration and exposure controls are recorded in [`packages/contracts/deployments/polygon/latest.json`](packages/contracts/deployments/polygon/latest.json).

## What is available

- Personal savings goals with a target, maturity and 10%–15% emergency allocation.
- Public and invite-only group circles with independent member targets and balances.
- A minimum of four active members before a circle can activate and accept deposits.
- Direct deposits using official Polygon USDT.
- Emergency-fund withdrawals that do not transfer the locked savings position.
- Maturity withdrawal by the current owner of the locked position.
- Cooperative group exits under the contract's approval and eligibility rules.
- A public early-exit market with a deterministic on-chain discount between 4.5% and 8%.
- Full-position ownership transfer to the first liquidity provider whose settlement succeeds.

Early-exit settlement recalculates the live claim and discount on-chain. Liquidity providers cannot choose or negotiate the discount. The provider pays the saver payout plus a separate 0.9% fee. In this release, the complete fee is routed to the configured maintenance fee wallet; automated rewards are not active.

## Wallet model

LockedIn Circle uses two distinct identities:

- Nimiq Pay identifies the Mini App user.
- The injected Polygon EVM account owns vault positions and signs contract transactions.

The addresses may differ and are displayed separately. The application can be explored in a regular browser, but protected savings actions must be opened in Nimiq Pay. The contracts never receive or store a wallet private key.

## Release boundaries

The following features are intentionally unavailable in the Safe-only V1 release:

- Earn vaults and Aave deposits.
- Automated saver rewards.
- NIM-to-Polygon-USDT conversion.
- Borrowing, collateral activation and Aave Umbrella staking.
- Guardian recovery.

The interface may label future features as **Coming soon**, but production builds cannot activate them. Savings are funded directly with Polygon USDT.

## Safety model and limits

- Each savings vault is deployed as a non-upgradeable contract.
- Safe-mode locked principal remains in its SavingsVault and does not enter Aave.
- The Safety Council can use only the documented pause and exposure-control paths; it cannot withdraw user principal, claim matured savings, transfer claims or change position ownership.
- Maximum principal per position: `5,000 USDT` (`5,000,000,000` base units).
- Maximum principal per vault: `25,000 USDT` (`25,000,000,000` base units).
- Maximum protocol principal: `50,000 USDT` (`50,000,000,000` base units).
- New vaults require a maturity of at least seven hours.
- Polygon USDT retains its issuer-level centralisation and freeze risks.

## Group circles

Group contracts hold one isolated position per member; they are not Nimiq multisig or shared-custody wallets. The creator configures the shared circle rules and only their own target and emergency allocation. Other members join with their own Polygon wallets and independently choose their targets and allocations.

Membership becomes immutable after activation. A market buyer who acquires a locked claim receives its maturity rights but does not become a circle member and receives no voting power. Cooperative exits use the contract-defined approval window and eligibility checks. If a cooperative exit cannot complete, the saver may use the deterministic early-exit market while the position remains eligible.

## Repository structure

- `apps/web`: React, TypeScript and Vite Mini App frontend.
- `apps/api`: Fastify API, PostgreSQL indexer and wallet-authenticated profile/invitation services.
- `packages/contracts`: Hardhat 3 contracts, deployment scripts, mocks and tests.
- `packages/contracts/deployments/polygon`: immutable Polygon mainnet deployment records.
- `docs/LOCKEDIN_SPEC.md`: protocol workflows, permissions and security invariants.
- `docs/INDEXER.md`: read-only indexing model and API boundaries.
- `docs/AMOY_TESTNET.md`: development-only Polygon Amoy runbook.

## Install and validate

Requirements:

- Node.js 22.13 or later.
- npm.
- PostgreSQL for API and indexer development.
- Nimiq Pay for real injected-provider testing.

Install dependencies and run the repository validation suites:

```sh
npm install
npm run lint
npm run typecheck
npm test
npm run build
npm run size -w @lockedin-circle/contracts
```

The optional Polygon mainnet-fork suite requires an explicitly configured private RPC endpoint:

```sh
npm run test:polygon-fork -w @lockedin-circle/contracts
```

Keep RPC credentials, database credentials, API keys, keystores, mnemonics and private keys outside Git. Supply them through local ignored configuration or the hosting provider's secret manager. Never place secrets in deployment manifests or browser-exposed `VITE_` variables.

## Local development

Run a local Hardhat chain, deploy the local contracts, execute the smoke test and start the frontend in separate terminals:

```sh
npm run contracts:node
npm run contracts:deploy
npm run contracts:smoke
npm run dev
```

The local Hardhat fallback is development-only. Published Hardhat test keys must never receive real assets.

## Polygon Amoy development

Polygon Amoy is retained only for testnet development and historical compatibility. It uses chain ID `80002`, valueless MockUSDT and test-only deployment manifests. Amoy tokens, mock adapters and faucet controls must never be presented as production assets.

Follow [`docs/AMOY_TESTNET.md`](docs/AMOY_TESTNET.md) for the isolated testnet workflow. Mainnet and Amoy addresses are deliberately stored in separate manifest directories.

## Indexer and backend

The Fastify/PostgreSQL service indexes contract events to improve discovery, history and responsiveness. It also supports signed-wallet profiles and short invitation lookup. It has no signer and cannot determine balances, position ownership, discounts, settlement outcomes or withdrawal rights. Clients must verify current contract state before enabling or submitting financial actions.

See [`docs/INDEXER.md`](docs/INDEXER.md) for the schema, deployment identity model and recovery rules.

## Licence

LockedIn Circle is released under the [MIT License](LICENSE).
