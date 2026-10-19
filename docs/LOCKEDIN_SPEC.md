# LockedIn Circle — Phase 1 through Phase 2B specification

## Scope

Phase 1 established savings-vault accounting with a USDT-compatible ERC-20. Phase 2A adds EVM ownership through Nimiq Pay and deterministic full-position early exits. Phase 2B adds immutable Safe and Earn vault modes, with Earn vaults using isolated Aave V3 adapters and share-based yield accounting. Cooperative group exits add unanimous, contract-controlled approval without shared custody. Guardian recovery, borrowing, performance fees and production deployment remain out of scope.

Nimiq Pay supplies the connected Nimiq identity. Its separately injected EIP-1193 provider supplies the EVM account that owns vault positions and signs group approvals. The interface displays both addresses. Native Nimiq addresses are not Polygon signers, group vaults are not Nimiq multisig wallets, and no shared-custody wallet is introduced. An unlocked Hardhat account is available only through the explicit local-development fallback.

## Savings workflow

1. A creator selects personal or group mode, Safe or Earn mode, a common maturity, and a USDT target and emergency percentage for each member.
2. `VaultFactory` deploys a non-upgradeable `SavingsVault` and records it globally and per member. A group requires at least four proposed members and begins in `Pending` invitation state.
3. The creator's creation transaction counts as acceptance. Every other invited EVM wallet has 72 hours to inspect the immutable terms and accept. One decline or invitation expiry prevents activation; the creator may then cancel the never-funded group.
4. Group deposits, listings, cooperative exits and rewards remain disabled until every invitation is accepted. Before maturity, a member of an active group approves and deposits the accepted token into their fixed position.
5. Each deposit uses integer basis points: `emergency = amount * emergencyBps / 10_000`; all rounding remainder enters the locked balance.
6. A member may withdraw their emergency balance at any time. This never reduces cumulative deposits or reverses goal completion, but it does reduce active principal used for cooperative-exit approval eligibility.
7. At or after maturity, the current position owner may withdraw its locked claim exactly once.
8. Incomplete positions recover their funds but are not reward-eligible. A market-sold or cooperatively exited position is inactive and permanently reward-disqualified. Group rewards require at least four eligible members and completion by every eligible member.
9. Anyone may trigger reward activation at or after maturity when the vault-derived conditions hold. Eligible recipients claim equal shares from revenue funded for that vault.

## Contract responsibilities

### VaultFactory

- Holds immutable accepted-token and `RewardPool` references.
- Refuses new vault creation while the shared safety controller is paused.
- Uses an immutable, factory-only `SavingsVaultDeployer` to deploy non-upgradeable personal and group vaults while keeping runtime bytecode below the EVM size limit.
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
- Records cooperative requests, Polygon-account approvals, revocations, expiry and final authorization on-chain.
- Releases a cooperative exit only to the requesting member and never moves that member's emergency balance.
- Tracks liabilities and rejects non-exact token transfer deltas.
- Uses checks-effects-interactions, `SafeERC20` and `ReentrancyGuard` on value-moving operations.
- Exposes no administrator, developer withdrawal, pause, target-editing or maturity-editing function.
- Reports every principal deposit and withdrawal to the immutable safety controller; generated yield is excluded from exposure.

### SafetyController

- Has no token custody, transfer, upgrade, position-ownership or fee-routing capability.
- Accepts an immutable deployment-configured safety council. Production is designed for an EVM multisig; the local and Amoy deployer-controlled council is explicitly test-only.
- Allows that council to pause immediately. Unpausing and every cap change require the immutable timelock and may be executed permissionlessly after it expires.
- While paused, blocks only new vaults, deposits, final group activation, new listings and market funding. Because Earn supply occurs only inside `deposit`, the same boundary blocks new yield supplies.
- Never blocks emergency withdrawals, matured withdrawals, listing cancellation, authorized cooperative-exit execution, already allocated reward claims or reads.
- Tracks net outstanding six-decimal principal for each registered vault and protocol-wide. Caps apply independently per position, per vault and protocol-wide.
- Allows caps to be lowered below current exposure without moving funds; only a later deposit is blocked. Principal withdrawals reduce exposure, while market ownership transfers and generated yield do not change it.

### RewardPool

- Accepts revenue earmarked to registered vaults.
- Derives recipients from the calling registered vault.
- Requires maturity and completion by every non-exited active member.
- Divides a valid campaign equally and requires an exactly divisible budget.
- Separates campaign budgets, activated claims and non-distributable protocol revenue.
- Lets recipients pull their rewards and provides no administrator allocation or withdrawal.
- Snapshots qualifying completed groups and allocates early-exit revenue by immutable epoch rules; no administrator chooses a group or recipient.

### Protocol-revenue epochs

Sponsored vault funding and protocol-wide early-exit revenue are independent ledgers. Sponsored funding keeps the existing vault-specific activation path. The 60% RewardPool share of each early-exit fee is assigned automatically to `revenueEpoch = floor(block.timestamp / epochDuration)` when received.

Production epochs are 30 days. The duration is immutable and may be shorter only in an explicitly labelled local or Amoy deployment. Each deployment also fixes a registration grace period, minimum per-member reward target and minimum saving duration; production minimums remain unset pending audit and economic review.

A completed group registers permissionlessly for `completionEpoch = floor(maturity / epochDuration)`. Registration is allowed from maturity through, but not including, `epochEnd + registrationGrace`. The pool accepts only a factory-registered group for which `rewardsReady()` is true, `maturity - createdAt` meets the minimum duration, at least four members remain eligible, and every eligible member's immutable target meets the minimum. Registration snapshots the eligible original-member recipients and targets. A sold or cooperatively exited member is absent; a market buyer is never substituted. Emergency withdrawals and generated yield do not alter the snapshot.

The deterministic completion weight is:

```text
member completed principal = immutable member target
group completion weight = sum(member completed principal for snapshotted eligible members)
```

Using the capped-at-target amount prevents excess deposits, generated yield and repeated transfers from increasing weight. The per-member minimum target, minimum duration, four-member minimum, immutable membership and one registration per vault/epoch are the initial Sybil-resistance boundaries; they do not eliminate all coordination or identity risk.

Epochs finalize chronologically. At or after `epochEnd + registrationGrace`, anyone may freeze the epoch's revenue and weight. Anyone may then allocate each registered group:

```text
group gross allocation = floor(epoch revenue * group weight / total epoch weight)
reward per eligible member = floor(group gross allocation / eligible member count)
group distributed amount = reward per member * eligible member count
```

The allocation caller cannot select or replace recipients. When the last group is allocated, `epoch revenue - sum(group distributed amount)` rolls into the next epoch. If an epoch has no qualifying registrations, all its revenue rolls into the next epoch. Sequential completion makes rollover deterministic and prevents a later epoch from finalizing before the earlier epoch's remainder is known. Claims remain pull-based, and total claimable rewards can never exceed received sponsored funding plus received protocol revenue.

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

## Cooperative group exits

1. An active member with a funded group position may open one unresolved request. The request expires exactly 24 hours after creation.
2. A request is unavailable while that position has an active Early-Exit Market listing. Deposits are frozen while a cooperative request is pending or authorized.
3. Every other member who is active when the request is created must approve from their own recorded Polygon EVM address. Approval eligibility is `remaining locked principal contribution + remaining emergency principal >= 25% of that member's own target`; generated yield and another participant's savings never count. Members below that threshold may keep depositing into their own position while another member's request is pending, then approve once eligible. The requester cannot self-approve; non-members, exited members, position buyers, factories, treasuries and deployers have no approval power.
4. Eligibility is revalidated when unanimous authorization is formed and again at execution. Emergency withdrawal can therefore invalidate a recorded approval without changing historical goal completion or reward eligibility; the approver may restore eligibility with another deposit before expiry.
5. An approver may revoke only while the request is pending. The last valid required approval records an irreversible `Authorized` state and starts a separate 24-hour execution window. If it expires, a fresh request and fresh approvals are required.
6. Authorization alone does not release funds. Before maturity, completion also requires every currently active member to have reached their goal and `activeMemberCount - 1 >= 4`, so a cooperative exit can never leave fewer than four active savers.
7. The requester completes the authorized exit and receives only their live locked-position value, including attributable Earn yield or loss. Emergency funds remain separately withdrawable by the original member.
8. Cooperative completion charges no market discount and no provider fee. It marks the requester as `CooperativeExit`, removes approval power and permanently revokes reward eligibility.
9. A pending request may be cancelled by its requester. Pending or authorized expiry may be finalized by anyone or lazily finalized when the requester creates a market listing. Cancellation or expiry enables the existing market fallback.
10. A market exit that leaves fewer than four eligible active members disables further cooperative early unlocks and group rewards, without blocking emergency or maturity withdrawals.
11. `Active`, `CooperativeExit`, `MarketExit` and `Matured` are member-status records. A market buyer receives only position ownership; the original immutable member identity is never replaced.

The vault emits invitation lifecycle events (`GroupInvitationCreated`, `GroupInvitationAccepted`, `GroupInvitationDeclined`, `GroupActivated`, `GroupInvitationExpired`, `UnactivatedGroupCancelled`) and cooperative-exit events (`GroupExitRequested`, `GroupExitApproved`, `GroupExitApprovalRevoked`, `GroupExitCancelled`, `GroupExitExpired`, `GroupExitAuthorized`, `GroupExitAuthorizationExpired`, `GroupExitCompleted`, `GroupMemberStatusChanged`). A PostgreSQL service may index these events but cannot accept, approve, price or settle on behalf of a wallet.

### Polygon configuration source

Production configuration comes from the maintained `@aave-dao/aave-address-book` package, not handwritten constants. The selected package identifies Polygon chain ID `137`, Pool `0x794a61358D6845594F94dc1DB02A252b5b4814aD`, six-decimal USDT/USDT0 `0xc2132D05D31c914a87C6611C10748AEb04B58e8F`, and aUSDT `0x6ab707Aca953eDAeFBc4fD23bA73294241490620`. Deployment still validates these identities on-chain.

## Deterministic early-exit workflow

1. Before maturity, the original saver may list their entire locked position with an expiration no later than maturity and a minimum acceptable payout, provided no pending or authorized cooperative request exists. The contract calculates the displayed discount from objective on-chain history; neither saver nor provider can override it.
2. A liquidity provider decides only whether to fund at the current system price. Multiple providers may race, but there are no competing prices and only the first successful transaction wins.
3. Settlement recalculates current claim value and discount. It reverts if the saver payout is below the listing's recorded minimum.
4. The provider grants allowance for the current saver payout plus the separate 0.9% fee. Tokens remain with the provider until settlement.
5. Funding atomically pays the saver, distributes the fee and transfers locked-position ownership. Failure of any step reverts everything.
6. Emergency withdrawal rights remain with the original saver. The provider receives only the locked claim.
7. A sale permanently disqualifies the original position from rewards. It does not disqualify the entire group; every remaining active member must still complete.
8. A position may sell only once and never at maturity, after locked withdrawal or after ownership changes. Active listings freeze deposits so new principal cannot invalidate a quote.
9. Cancellation or expiration permits relisting. Each attempt remains visible in immutable event history.

Personal and group listings use identical settlement rules. Clients derive the category from the vault's immutable `isGroup` value and may filter by it.

### Settlement history

- `ListingFunded` is the authoritative completed-trade record. Clients join it to the matching immutable `ListingCreated` event to recover the saver, vault and position identity.
- A connected wallet's completed-trade history contains settlements where that address was either the saver or the funding liquidity provider. Both parties see the same finalized execution values and explorer-verifiable transaction.
- The public market exposes a recent-trades view containing every finalized saver-to-provider transfer, including Personal/Group classification and an explorer link.
- Receipt cards are presentation-only projections of canonical events. They cannot alter ownership, pricing or accounting, and a future indexer may cache them without becoming authoritative.
- After settlement, portfolio discovery follows current `positionOwner`: the provider sees the acquired locked claim, while the original saver sees only any unwithdrawn emergency balance. Once that emergency balance is withdrawn, the sold vault no longer appears as the saver's position.

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
| Request a cooperative group exit                | Active original group member                       |
| Approve a pending group exit                    | Other active original members at 25%+ of target    |
| Revoke approval for a pending group exit        | An active original member who previously approved  |
| Cancel a pending group exit                     | Requester only                                     |
| Complete an authorized cooperative exit         | Requester only, after active goals are complete    |
| Record expiry                                   | Any caller, or immutable market during listing     |
| Transfer a position                             | Immutable early-exit market only                   |
| Create/cancel listing                           | Original saver while still current owner           |
| Fund an active listing at its live system price | Any provider with sufficient balance and allowance |
| Fund a vault reward budget                      | Any token holder                                   |
| Activate rewards                                | Any caller through an eligible vault               |
| Claim a reward                                  | Reward recipient                                   |
| Register a qualifying completed group           | Any address                                        |
| Finalize an elapsed reward epoch                 | Any address, after epoch plus grace                 |
| Allocate a finalized group's epoch share        | Any address                                        |
| Pause risk-increasing actions                   | Immutable safety council                           |
| Schedule unpause or cap changes                 | Immutable safety council                           |
| Execute elapsed safety changes                  | Any address after the timelock                      |

## Security invariants

- Accepted token, maturity, members, targets, allocations, mode, reward pool and market authority are immutable.
- Emergency allocation is 1,000–1,500 basis points inclusive.
- Members and positions are unique, fixed and limited to 50 per group.
- A group has at least four proposed members, accepts no deposits before unanimous invitation acceptance, and cannot activate after a decline or the 72-hour invitation deadline.
- Cumulative deposit never decreases; emergency withdrawal cannot undo completion.
- Emergency ownership never transfers with the locked position.
- Vault liabilities are separated by position and state is reduced before outbound calls.
- Locked funds cannot leave before maturity; deposits are rejected at and after maturity.
- Deposits are rejected while a non-expired listing is active.
- Deposits to the requester's position are rejected while its cooperative request is pending or authorized; other active members may continue funding their own positions.
- A position cannot have a live cooperative request and market listing simultaneously.
- Cooperative authorization requires unanimous N-1 approval within 24 hours from the request's snapshotted active approvers. Each approver must retain active non-yield principal of at least 25% of their own target both at authorization and execution.
- Authorized cooperative exits have a separate 24-hour execution window and cannot be reused after it expires.
- Cooperative completion must leave at least four active saving members.
- Cooperative settlement pays only the requester's live claim, charges no discount or fee, and leaves emergency ownership unchanged.
- Market buyers never acquire immutable membership, approval power or reward eligibility.
- Fewer than four reward-eligible group members disables group rewards without blocking maturity withdrawals.
- A locked balance cannot be withdrawn twice.
- A position cannot be sold twice, partially, or at/after maturity.
- Discounts are deterministic, remain within 450–800 basis points and are recalculated atomically at settlement.
- Settlement reverts below the saver's immutable listing payout floor.
- Settlement, fee distribution and position transfer are atomic and reentrancy-protected.
- Risk-reserve and maintenance-treasury recipients are immutable.
- No privileged party can withdraw principal or choose reward recipients.
- Safety authority cannot move user funds, transfer claims, upgrade contracts, set market prices or redirect protocol fees.
- Pausing cannot block emergency withdrawals, matured withdrawals, listing cancellation, authorized cooperative exits or already allocated reward claims.
- Position, vault and protocol exposure caps count net outstanding principal only; generated yield and claim transfers never inflate or reduce principal exposure.
- Reward activation is one-time, post-maturity and derived only from registered-vault state.
- A seller is reward-disqualified atomically while emergency ownership remains unchanged.
- Vault balances cover emergency and locked liabilities. RewardPool balances cover campaigns, claims and retained protocol revenue.
- The factory accepts only tokens reporting six decimals. Exact balance-delta checks reject fee-on-transfer tokens.
- Negative rebases are unsupported. Solvency checks block later outflows after an external balance reduction but cannot restore removed tokens; production requires reviewed non-rebasing USDT.
- Contracts are unaudited and intended for local Hardhat or explicitly configured test environments only.
