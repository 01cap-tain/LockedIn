# Polygon mainnet readiness checkpoint

Date: 5 November 2026. This is a preparation checkpoint, not a deployment record.

## Decision

**Await exact deployment inputs and owner approval.** No Polygon mainnet transaction was signed or broadcast. The application fails closed when a reviewed `packages/contracts/deployments/polygon/latest.json` manifest is absent or inconsistent, and the factory independently rejects a mainnet minimum maturity below seven hours. The provider-fee split and durable transaction recovery corrections are implemented and tested; live RPC preflight, fork validation, address review, cost estimation and the exact approval manifest remain outstanding.

## Preserved working tree

The repository already contained uncommitted invitation/API and contract-helper work. It was preserved. No reset, checkout, deployment, key access, fund movement, or migration was performed.

## Contract inventory

Production graph under consideration:

- `VaultFactory`: immutable factory identity and vault creation.
- `SavingsVaultDeployer`: factory-bound non-upgradeable vault deployment.
- `SavingsVault`: separate emergency/locked accounting, membership, maturity, claims and cooperative exit.
- `EarlyExitMarket`: deterministic listing and first-successful funding settlement.
- `SafetyController`: delayed pause and exposure caps; it cannot transfer saver principal.
- `RewardPool`: retained for protocol-graph compatibility. Safe-only V1 routes no early-exit fee to it, and reward activation and claims remain disabled.

Present in source but disabled in the Safe-only V1 graph:

- `AaveYieldAdapter` and adapter interfaces.
- mocks and reentrancy harnesses, which must never appear in a production manifest.

There is no proxy or upgrade mechanism. A changed immutable rule requires a versioned deployment; existing vaults cannot be upgraded in place.

## Network and asset identity

Production configuration is pinned to Polygon chain `137` (`0x89`) and Polygon USDT `0xc2132D05D31c914a87C6611c10748AEb04B58e8F`, using six decimals. The production build accepts this identity only from a schema-v6-or-newer manifest with protocol `lockedin-circle/1.5.0-safe`, `testConfiguration: false`, minimum maturity at least `25200`, and complete factory/market/safety identities.

The read-only preflight scripts require explicit RPC, governance, cap, deployer-address and nonce inputs. They validate chain, bytecode and decimals and hold no signer. The separate Aave preflight resolves addresses from the maintained Aave address-book package and validates live Pool/reserve/aToken relationships; Aave is not enabled in the Safe-only launch graph.

## Seven-hour production maturity

Protocol 1.5 enforces a seven-hour minimum maturity for every newly deployed factory, including testnets. The shared minimum is used by both personal and group creation. Existing testnet factories retain their immutable historical minimums, but the ten-minute capability is absent from the new contract source. This changes factory bytecode and cannot alter already deployed factories.

## Dashboard current-savings formula

For every authoritative loaded position owned by the selected EVM account:

`active savings = owned locked current claim + original-member unwithdrawn emergency balance`

The implementation sums `currentValue` only when `access === "owner"`, and sums `emergencyBalance` only when `isOriginalMember`. It ignores invalid or negative values. Consequently, a sold locked claim leaves the seller's total while retained emergency funds remain; a purchased claim enters the buyer's total; withdrawn or claimed balances contribute zero. Indexed events are discovery hints only and cannot inflate this calculation.

Tests cover deposits/reconstruction, emergency withdrawal, sale, purchase, matured/cooperative clearing, cancelled listings, wallet changes, reloads and duplicate-event non-inflation.

## Exit-fee distribution

The immutable market charges the existing 0.9% provider fee and atomically allocates 100% to the Maintenance Treasury. RewardPool and Risk Reserve allocations are zero while rewards are unavailable. Factory construction still requires nonzero compatibility destinations, but permits the inactive Risk Reserve address to equal maintenance. Settlement emits the total fee and all three allocations, and any failed transfer reverts the entire settlement.

## Nimiq Pay and NIM boundary

Production now requires the documented Nimiq Pay host/injected-provider environment. External browsers receive an “Open in Nimiq Pay” screen. Development builds remain available locally without a production override flag. Polygon interactions continue through the injected EIP-1193 provider.

Direct Polygon USDT remains the only savings route. NIM-to-USDT controls remain disabled and labelled coming soon when the explicit local/test mock is unavailable. See `NIM_TO_POLYGON_USDT_PRODUCTION_REVIEW_2026-11-05.md`.

Native NIM Boost was not implemented. Although the SDK can submit a native transaction, this repository has no authoritative Nimiq finality verifier/indexer that can verify network, sender, recipient, amount and execution and then safely reconstruct confirmed Boost activity. A submitted hash must not be represented as a confirmed Boost.

## Transaction recovery

Financial and ownership-changing operations persist non-secret intent metadata before the wallet prompt and attach the hash/nonce after submission. Recovery handles reloads, account/chain isolation, rejection, failure, replacement lookup, dropped transactions, temporary RPC failure and unknown outcomes. Polygon mainnet completion requires two confirmations plus matching chain, sender, target, receipt status, expected event and intended event arguments. Unknown outcomes stay recoverable and the interface offers recheck and PolygonScan actions without encouraging a duplicate transaction.

## Validation results

- API: 11 tests passed.
- Frontend: 88 tests passed.
- Solidity: 104 active tests passed; 31 legacy/optional Earn, reward, Amoy-mock and Polygon-fork tests were skipped by their declared environment gates (135 Mocha cases total).
- TypeScript, ESLint and all workspace production builds passed.
- Contract sizes passed; `SavingsVaultDeployer` is the closest to the EIP-170 ceiling at 23,808 bytes (768 bytes remaining).
- `git diff --check` passed and the tracked-file secret-pattern scan found no match.
- API and web production-runtime audits report zero advisories. The monorepo-wide audit still reports one high advisory in Hardhat's development-only Zod 3.25.76 dependency; it is not bundled into the web/API runtime or contract bytecode and currently has no compatible Hardhat-side remediation.
- Live Polygon-fork validation and static analysis were not run in this checkpoint because no explicit fork RPC/static-analysis tool was configured. They remain mandatory before deployment.

## Deployment inputs still required

- reviewed Safety Council multisig;
- reviewed Risk Reserve and Maintenance Treasury identities (RewardPool is deployed as part of the immutable graph);
- mainnet exposure caps in six-decimal units;
- deployer address and exact nonce for deterministic address review;
- dedicated production Polygon RPC for read-only preflight and indexing;
- independently reviewed bytecode, constructor arguments, compiler settings and source-verification plan;
- gas estimate at the chosen broadcast time;
- security review/static analysis report and explicit deployment approval.

The `.env.polygon.example` file lists configuration names only. It contains no credentials or signer material.

## Authoritative references

- Nimiq Mini Apps and injected providers: https://nimiq.dev/mini-apps
- Nimiq EVM tokens and Polygon USDT: https://www.nimiq.dev/mini-apps/features/evm-tokens
- Nimiq Ethereum provider: https://nimiq.dev/mini-apps/api-reference/ethereum-provider
- Aave maintained addresses: https://www.aave.com/docs/reference/addresses

## Approval boundary

After all tests and security checks pass, produce the final immutable addresses, constructor arguments, caps, compiler metadata, predicted addresses, gas estimate, verification commands and manifest for human review. Stop again before any mainnet signature or broadcast.
