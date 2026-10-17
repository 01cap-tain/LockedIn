# LockedIn Circle — Phase 1 and Phase 2A specification

## Scope

Phase 1 established savings-vault accounting with a USDT-compatible ERC-20. Phase 2A adds EVM ownership through Nimiq Pay and full-position early-exit trading. Aave, yield, guardian recovery and production mainnet deployment remain out of scope.

Nimiq Pay remains the Mini App host and supplies the connected Nimiq address. Its separately injected EIP-1193 `window.ethereum` provider supplies the EVM account that owns vault positions. These are distinct addresses and both are shown to the user. The unlocked Hardhat account is available only when the explicit development fallback flag is enabled.

## Workflow

1. A creator selects personal or group mode, a common maturity timestamp, and a USDT-denominated target and emergency percentage for each member.
2. `VaultFactory` deploys a new, non-upgradeable `SavingsVault` and records it globally and per member.
3. Before maturity, a member approves the vault to spend the accepted token and deposits against their fixed position.
4. Each deposit is split using integer basis points: `emergency = amount * emergencyBps / 10_000`; all remainder goes to the locked balance.
5. A member may withdraw any part of their emergency balance at any time. This does not reduce cumulative deposited value or reverse goal completion.
6. At or after maturity, the current position owner may withdraw that position's locked balance exactly once (subsequent calls have no funds and revert).
7. Incomplete positions recover their locked funds but are not individually reward-eligible. A sold position is inactive and permanently reward-disqualified. For a group, rewards activate only if every remaining active member has reached their target.
8. Reward activation is allowed only at or after maturity. Anyone may trigger it once the objective vault-derived conditions hold. Eligible recipients claim equal shares from revenue funded specifically for that vault.

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
- Exposes a transfer hook callable only by the immutable factory-created early-exit market.
- Freezes deposits while a non-expired listing is active; emergency withdrawals remain independent and permitted.
- Tracks aggregate emergency and locked liabilities and rejects any transfer whose observed token-balance delta is not exact.
- Uses checks-effects-interactions, `SafeERC20`, and `ReentrancyGuard` on value-moving operations.
- Has no administrator, developer withdrawal, pause, target-editing or maturity-editing function.

### RewardPool

- Accepts token revenue earmarked to registered vaults.
- Derives eligibility and recipients directly from the calling registered vault.
- Requires maturity and completion by every non-exited active member before activation.
- Requires the vault reward budget to divide exactly by the eligible position count, then assigns equal claimable amounts.
- Separately accounts for funded campaign budgets, activated claims and non-distributable protocol revenue.
- Allows recipients to pull their own rewards and has no administrator allocation or withdrawal function.

### Future interfaces

- `IEarlyExitMarket` defines the implemented Phase 2A atomic ownership-purchase boundary.
- `IYieldAdapter` defines asset deposit, withdrawal and accounting boundaries.
- `IAaveYieldAdapter` extends the yield boundary with the future Aave pool identity.
- Yield adapters remain interface-only.

## Phase 2A early-exit workflow

1. Before maturity, the original saver lists their entire locked position with a maximum acceptable discount from 4.5% to 8% and an expiration no later than maturity.
2. Liquidity providers submit competing offers within 4.5% to 8%. An offer's discount may not exceed the listing's asking discount.
3. Submitting an offer grants the market token allowance for the calculated claim value plus the 0.9% provider fee. Tokens remain with the provider until acceptance.
4. The saver may reject any offer, cancel an unaccepted listing, or accept one offer. The developer has no selection role.
5. Acceptance pulls the claim value and fee from the selected provider, pays the saver, distributes the fee, and transfers the locked-position ownership in one transaction. Any failed step reverts the complete transaction.
6. The original saver retains emergency withdrawal rights. The provider receives only the locked claim and may withdraw it at maturity.
7. A sale permanently disqualifies the original position from rewards. It does not disqualify the whole group: remaining active members may activate an equally divided campaign at maturity if all of them completed.
8. A position may be sold only once. Sales are prohibited at maturity, after locked withdrawal, when ownership changed, or when the locked balance changed after listing.

### Market fee

- Provider fee: `sellerReceipt * 90 / 10_000` (0.9%), paid on top of the offer.
- Reward pool: `fee * 60 / 100`.
- Risk reserve: `fee * 20 / 100`.
- Maintenance treasury: the remaining fee, preserving all integer rounding dust.
- All fee destinations are immutable. The reward share is recorded as protocol revenue and is not arbitrarily allocatable by a developer.

### Reference discount v1

The reference starts at 450 basis points and is capped at 800. It adds four on-chain scores:

- Remaining time: up to 125 points, scaling linearly from zero to 365 remaining days.
- Time-weighted progress lag: up to 100 points, comparing actual goal progress with elapsed-plan progress.
- Deposit consistency: up to 75 points, comparing deposit count with one expected deposit per elapsed 30-day period.
- Current locked value: up to 50 points for positions below a 1,000 USDT reference size.

The reference is informational. Providers choose their own valid discount and the saver chooses the offer.

## Permissions

| Action | Authorized caller |
| --- | --- |
| Create a vault | Any address |
| Deposit | Original member while they own the position |
| Withdraw emergency balance | Original member |
| Withdraw locked balance after maturity | Current position owner |
| Transfer a position | Factory-created immutable early-exit market only |
| Create/cancel listing | Original saver and current position owner |
| Submit/cancel offer | Liquidity provider |
| Accept/reject offer | Listing saver |
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
- New deposits are rejected while a non-expired early-exit listing is active.
- A locked balance cannot be withdrawn twice.
- A position cannot be sold twice, partially sold, or sold at/after maturity.
- Market settlement, fee distribution and position transfer are atomic.
- Market entry points that move value are reentrancy-protected.
- Risk-reserve and maintenance-treasury fee recipients cannot be changed.
- No privileged party can withdraw member principal or choose reward recipients.
- Reward activation is one-time, cannot occur before maturity and depends only on registered-vault state.
- A seller is reward-disqualified atomically with position transfer, while emergency ownership remains unchanged.
- Vault token balances must cover aggregate emergency plus locked liabilities. Reward-pool balances must cover campaign budgets, activated claims and retained protocol revenue.
- The factory accepts only token contracts reporting six decimals. Every inbound and outbound transfer verifies exact sender/recipient balance deltas; fee-on-transfer behaviour reverts atomically.
- Negative rebases are unsupported. Solvency checks block state-changing outflows after an external balance reduction, but they cannot restore tokens removed by the token contract. Production deployment therefore requires a reviewed, non-rebasing USDT contract.
- Contracts are unaudited and intended only for local Hardhat use.
