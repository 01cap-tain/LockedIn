# LockedIn Circle — Phase 1 specification

## Scope

Phase 1 is a local-development prototype for savings vault accounting with a USDT-compatible ERC-20. It does not include Aave, yield, early-exit trading, guardian recovery, mainnet deployment, or a production bridge between Nimiq identities and EVM accounts.

Nimiq Pay remains the Mini App host and supplies the connected Nimiq address. Local Solidity calls are signed by an unlocked Hardhat EVM development account. These are distinct identities. A production identity/linking design is required before deployment.

## Workflow

1. A creator selects personal or group mode, a common maturity timestamp, and a USDT-denominated target and emergency percentage for each member.
2. `VaultFactory` deploys a new, non-upgradeable `SavingsVault` and records it globally and per member.
3. Before maturity, a member approves the vault to spend the accepted token and deposits against their fixed position.
4. Each deposit is split using integer basis points: `emergency = amount * emergencyBps / 10_000`; all remainder goes to the locked balance.
5. A member may withdraw any part of their emergency balance at any time. This does not reduce cumulative deposited value or reverse goal completion.
6. At or after maturity, the current position owner may withdraw that position's locked balance exactly once (subsequent calls have no funds and revert).
7. Incomplete positions recover their locked funds but are not individually reward-eligible. For a group, rewards activate only if every fixed active member has reached their target.
8. Anyone may trigger reward activation once its objective vault-derived conditions hold. Eligible recipients claim equal shares from revenue funded specifically for that vault.

## Contract responsibilities

### VaultFactory

- Holds immutable references to the accepted token and its `RewardPool`.
- Deploys non-upgradeable personal and group vault contracts.
- Validates creation parameters and records all vaults plus member-to-vault indexes.
- Registers only factory-created vaults with the reward pool.
- Has no withdrawal or vault-administration authority.

### SavingsVault

- Maintains immutable membership, targets, emergency allocations and maturity.
- Maintains cumulative deposits and current emergency/locked balances per position.
- Maintains `positionId => owner`; the owner has the right to the locked balance only.
- Keeps emergency withdrawal rights with the original member.
- Exposes a transfer hook callable only by the immutable future early-exit market address. A zero address disables transfers in Phase 1.
- Uses checks-effects-interactions, `SafeERC20`, and `ReentrancyGuard` on value-moving operations.
- Has no administrator, developer withdrawal, pause, target-editing or maturity-editing function.

### RewardPool

- Accepts token revenue earmarked to registered vaults.
- Derives eligibility and recipients directly from the calling registered vault.
- Requires the vault to report that all members have completed before activation.
- Requires the vault reward budget to divide exactly by the eligible position count, then assigns equal claimable amounts.
- Allows recipients to pull their own rewards and has no administrator allocation or withdrawal function.

### Future interfaces

- `IEarlyExitMarket` defines the future atomic ownership-purchase boundary.
- `IYieldAdapter` defines asset deposit, withdrawal and accounting boundaries.
- `IAaveYieldAdapter` extends the yield boundary with the future Aave pool identity.
- No implementation of these modules exists in Phase 1.

## Permissions

| Action | Authorized caller |
| --- | --- |
| Create a vault | Any address |
| Deposit | Original member while they own the position |
| Withdraw emergency balance | Original member |
| Withdraw locked balance after maturity | Current position owner |
| Transfer a position | Immutable early-exit market only (disabled when zero) |
| Fund a vault reward budget | Any token holder |
| Activate rewards | Any caller through the eligible vault |
| Claim a reward | Reward recipient |

## Security invariants

- Accepted token, maturity, members, targets, allocations, reward pool and market authority are immutable after deployment.
- Emergency allocation is between 1,000 and 1,500 basis points inclusive.
- Members and positions are unique, fixed and bounded to 50 per group.
- A position's cumulative deposit never decreases; emergency withdrawal cannot undo completion.
- Vault liabilities are separated per position and transfers occur only after state is reduced.
- Locked funds cannot leave before `block.timestamp >= maturity`.
- New deposits are rejected at and after maturity.
- A locked balance cannot be withdrawn twice.
- No privileged party can withdraw member principal or choose reward recipients.
- Reward activation is one-time and depends only on registered-vault state.
- Fee-on-transfer and rebasing tokens are out of scope; Phase 1 assumes a standard USDT-compatible token whose received amount equals the requested transfer.
- Contracts are unaudited and intended only for local Hardhat use.
