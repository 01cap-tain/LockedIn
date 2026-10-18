# LockedIn Circle — Phase 1 through Phase 2B specification

## Scope

Phase 1 established savings-vault accounting with a USDT-compatible ERC-20. Phase 2A adds EVM ownership through Nimiq Pay and deterministic full-position early exits. Phase 2B adds immutable Safe and Earn vault modes, with Earn vaults using isolated Aave V3 adapters and share-based yield accounting. Guardian recovery, borrowing, performance fees and production deployment remain out of scope.

Nimiq Pay supplies the connected Nimiq identity. Its separately injected EIP-1193 provider supplies the EVM account that owns vault positions. The interface displays both addresses. An unlocked Hardhat account is available only through the explicit local-development fallback.

## Savings workflow

1. A creator selects personal or group mode, Safe or Earn mode, a common maturity, and a USDT target and emergency percentage for each member.
2. `VaultFactory` deploys a non-upgradeable `SavingsVault` and records it globally and per member.
3. Before maturity, a member approves and deposits the accepted token into their fixed position.
4. Each deposit uses integer basis points: `emergency = amount * emergencyBps / 10_000`; all rounding remainder enters the locked balance.
5. A member may withdraw their emergency balance at any time. This never reduces cumulative deposits or reverses goal completion.
6. At or after maturity, the current position owner may withdraw its locked claim exactly once.
7. Incomplete positions recover their funds but are not reward-eligible. A sold position is inactive and permanently reward-disqualified. Group rewards require every remaining active member to have reached the target.
8. Anyone may trigger reward activation at or after maturity when the vault-derived conditions hold. Eligible recipients claim equal shares from revenue funded for that vault.

## Contract responsibilities

### VaultFactory

- Holds immutable accepted-token and `RewardPool` references.
- Deploys non-upgradeable personal and group vaults.
- Creates a dedicated adapter for each Earn vault.
- Validates creation parameters and records vault and member indexes.
- Registers only factory-created vaults with the reward pool.
- Has no withdrawal or vault-administration authority.

### SavingsVault

- Maintains immutable membership, targets, emergency allocations, maturity and mode.
- Separates cumulative deposits, emergency balances, locked principal and Earn shares per position.
- Maintains `positionId => owner`; ownership conveys only the locked claim.
- Keeps emergency withdrawal rights with the original saver after an early exit.
- Allows only the immutable factory-created market to transfer position ownership.
- Freezes deposits while a non-expired listing is active.
- Tracks liabilities and rejects non-exact token transfer deltas.
- Uses checks-effects-interactions, `SafeERC20` and `ReentrancyGuard` on value-moving operations.
- Exposes no administrator, developer withdrawal, pause, target-editing or maturity-editing function.

### RewardPool

- Accepts revenue earmarked to registered vaults.
- Derives recipients from the calling registered vault.
- Requires maturity and completion by every non-exited active member.
- Divides a valid campaign equally and requires an exactly divisible budget.
- Separates campaign budgets, activated claims and non-distributable protocol revenue.
- Lets recipients pull their rewards and provides no administrator allocation or withdrawal.

### Yield interfaces

- `IEarlyExitMarket` defines the atomic listing-funding and ownership-transfer boundary.
- `IYieldAdapter` defines asset deposit, withdrawal, share conversion and total-asset accounting.
- `IAaveYieldAdapter` extends it with immutable Aave Pool and aToken identities.
- `AaveYieldAdapter` is assigned once to exactly one Earn vault.

## Safe and Earn modes

- Safe keeps locked USDT in the vault and earns no yield.
- Earn sends only the locked portion to its dedicated adapter. Emergency funds never enter Aave.
- Mode is immutable from creation and cannot change after any deposit.
- Only the assigned vault can supply to or redeem from its adapter.
- The adapter accepts USDT only, disables collateral use, has no borrowing path, and exposes no administrator or arbitrary-token withdrawal.
- Deployment validates chain ID, six-decimal underlying and aToken, aToken underlying, and the Pool reserve's configured aToken.

### Share and yield accounting

An Earn deposit mints shares at the pre-deposit exchange rate: `shares = assets * totalShares / totalAssets`; the first deposit uses one share per base unit. Current value is `positionShares * totalAdapterAssets / totalShares`. Principal remains separately recorded. Accrued yield is the positive difference between value and principal, flooring at zero after a loss.

An early-exit sale transfers the fixed share balance and all future yield or loss exposure. Settlement reads the live share value rather than trusting the listing snapshot.

At maturity, the adapter redeems the position shares. The vault clears shares and withdrawal state only after receiving the exact USDT amount. If Aave reverts or lacks liquidity, the transaction reverts, the position remains intact, and the owner may retry. Phase 2B has no custom withdrawal queue.

The displayed Aave liquidity rate is variable and is never represented as guaranteed interest or capital safety.

### Polygon configuration source

Production configuration comes from the maintained `@aave-dao/aave-address-book` package, not handwritten constants. The selected package identifies Polygon chain ID `137`, Pool `0x794a61358D6845594F94dc1DB02A252b5b4814aD`, six-decimal USDT/USDT0 `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`, and aUSDT `0x6ab707Aca953eDAeFBc4fD23bA73294241490620`. Deployment still validates these identities on-chain.

## Deterministic early-exit workflow

1. Before maturity, the original saver may list their entire locked position with an expiration no later than maturity and a minimum acceptable payout. The contract calculates the displayed discount from objective on-chain history; neither saver nor provider can override it.
2. A liquidity provider decides only whether to fund at the current system price. Multiple providers may race, but there are no competing prices and only the first successful transaction wins.
3. Settlement recalculates current claim value and discount. It reverts if the saver payout is below the listing's recorded minimum.
4. The provider grants allowance for the current saver payout plus the separate 0.9% fee. Tokens remain with the provider until settlement.
5. Funding atomically pays the saver, distributes the fee and transfers locked-position ownership. Failure of any step reverts everything.
6. Emergency withdrawal rights remain with the original saver. The provider receives only the locked claim.
7. A sale permanently disqualifies the original position from rewards. It does not disqualify the entire group; every remaining active member must still complete.
8. A position may sell only once and never at maturity, after locked withdrawal or after ownership changes. Active listings freeze deposits so new principal cannot invalidate a quote.
9. Cancellation or expiration permits relisting. Each attempt remains visible in immutable event history.

Personal and group listings use identical settlement rules. Clients derive the category from the vault's immutable `isGroup` value and may filter by it.

### Market fee

- Provider fee: `saverPayout * 90 / 10_000` (0.9%), paid on top of the payout.
- Reward pool: `fee * 60 / 100`.
- Risk reserve: `fee * 20 / 100`.
- Maintenance treasury: all remaining fee units, preserving integer rounding dust.
- Destinations are immutable. RewardPool records its share as protocol revenue; no developer allocates it.

### System discount v1

The discount starts at 450 basis points and is clamped to 450–800 basis points. It adds:

- Remaining-time penalty: 0–150 basis points, proportional to the share of the original savings duration still remaining.
- Commitment penalty: 0–125 basis points, derived only from on-chain position history:
  - actual savings versus expected time-weighted savings: 0–45;
  - goal-completion percentage: 0–35;
  - deposit regularity versus expected monthly contributions: 0–25;
  - recent contribution activity after a 30-day grace period: 0–20.
- Aave/liquidity-risk penalty: 0–75 basis points. Safe vaults receive zero. Earn vaults use the adapter's current Aave liquidity-rate signal as a deterministic utilization-risk proxy, increasing linearly to the maximum at a 15% ray-denominated liquidity rate.

The listing stores display snapshots of claim value, discount, payout, provider potential return, fee and expiration. Settlement does not trust them: `fundListing` recalculates the claim and discount in the funding transaction. The saver controls only expiration and minimum payout. Providers cannot choose or negotiate a rate.

## Permissions

| Action                                          | Authorized caller                                  |
| ----------------------------------------------- | -------------------------------------------------- |
| Create a vault                                  | Any address                                        |
| Deposit                                         | Original member while they own the position        |
| Withdraw emergency balance                      | Original member                                    |
| Withdraw locked balance after maturity          | Current position owner                             |
| Transfer a position                             | Immutable early-exit market only                   |
| Create/cancel listing                           | Original saver while still current owner           |
| Fund an active listing at its live system price | Any provider with sufficient balance and allowance |
| Fund a vault reward budget                      | Any token holder                                   |
| Activate rewards                                | Any caller through an eligible vault               |
| Claim a reward                                  | Reward recipient                                   |

## Security invariants

- Accepted token, maturity, members, targets, allocations, mode, reward pool and market authority are immutable.
- Emergency allocation is 1,000–1,500 basis points inclusive.
- Members and positions are unique, fixed and limited to 50 per group.
- Cumulative deposit never decreases; emergency withdrawal cannot undo completion.
- Emergency ownership never transfers with the locked position.
- Vault liabilities are separated by position and state is reduced before outbound calls.
- Locked funds cannot leave before maturity; deposits are rejected at and after maturity.
- Deposits are rejected while a non-expired listing is active.
- A locked balance cannot be withdrawn twice.
- A position cannot be sold twice, partially, or at/after maturity.
- Discounts are deterministic, remain within 450–800 basis points and are recalculated atomically at settlement.
- Settlement reverts below the saver's immutable listing payout floor.
- Settlement, fee distribution and position transfer are atomic and reentrancy-protected.
- Risk-reserve and maintenance-treasury recipients are immutable.
- No privileged party can withdraw principal or choose reward recipients.
- Reward activation is one-time, post-maturity and derived only from registered-vault state.
- A seller is reward-disqualified atomically while emergency ownership remains unchanged.
- Vault balances cover emergency and locked liabilities. RewardPool balances cover campaigns, claims and retained protocol revenue.
- The factory accepts only tokens reporting six decimals. Exact balance-delta checks reject fee-on-transfer tokens.
- Negative rebases are unsupported. Solvency checks block later outflows after an external balance reduction but cannot restore removed tokens; production requires reviewed non-rebasing USDT.
- Contracts are unaudited and intended for local Hardhat or explicitly configured test environments only.
