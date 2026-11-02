# LockedIn Circle pre-redeployment review — 2026-11-02

## Scope and limitations

This review covers the immutable Safe-only V1 contracts, their current tests, the frontend maturity-withdrawal path, and the proposed 24-hour minimum maturity plus cooperative group-exit corrections. No contract was changed or deployed during this review. This is an internal technical review, not an independent professional smart-contract audit.

## Maturity claim verification

### Personal position

Pass. At `block.timestamp >= maturity`, `withdrawLocked(positionId)` pays the entire remaining locked principal to `positionOwner[positionId]`. Goal completion is not required. The call clears the locked balance and liability before the token transfer, is non-reentrant, verifies exact token delivery, and prevents a second withdrawal.

### Group position

Pass. A group member can withdraw their own matured locked position without group approval and without every member completing their goal. The normal maturity path does not apply the cooperative-exit member-floor rules.

### Purchased position

Pass at the contract level. Market settlement changes `positionOwner[positionId]` to the provider. At maturity only that current owner can withdraw the locked claim. The original member retains only their emergency balance and cannot withdraw the sold locked claim.

Coverage gap: the suite directly tests a purchased personal position through maturity, and separately tests group ownership transfer and group maturity withdrawal. Add one explicit end-to-end test that purchases a group position and has the buyer claim it at maturity.

The frontend exposes maturity withdrawal whenever the connected account owns the locked position, including a purchased claim. Portfolio discovery must continue merging live ownership reads with indexed transfer events so indexer lag cannot hide the claim.

## Proposed 24-hour minimum maturity

The current value is enforced on-chain by `SavingsVault.MIN_MATURITY_DURATION = 7 days`. The frontend independently hardcodes the same seven-day boundary in vault validation and contract-call validation. All copies must change together.

Required changes:

- Set the new immutable contract minimum to `1 days`.
- Update frontend validation, helper text and transaction validation from seven days to 24 hours.
- Replace seven-day boundary tests with `24 hours - 1`, exactly `24 hours`, and `24 hours + 1`.
- Keep the five-year maximum unchanged unless separately approved.
- Bump `PROTOCOL_VERSION` and create a new deployment manifest and deployment identity. Never overwrite the existing manifest.
- Keep legacy vault discovery and maturity withdrawal available through the old factory.

Security impact: a shorter minimum does not weaken custody or ownership checks, but it shortens the time available for deposits, public-group enrollment, market funding and cooperative approval. It should be treated as a product/economic change, not merely a UI change.

For groups, a 24-hour vault can spend most of its lifetime waiting for four wallets to join. The enrollment deadline must remain before maturity. Add a clear creation warning and consider a contract-level minimum gap between enrollment close and maturity so users do not create circles that cannot practically activate and receive deposits.

## Cooperative group-exit corrections

Approved direction is recorded in `NEXT_REDEPLOYMENT.md`:

- Creation and activation continue to require four members.
- Remove the all-active-goals-complete requirement from cooperative completion.
- Allow exits while at least two active members remain.
- Keep unanimous approval, the 25% per-approver principal threshold, separate 24-hour request and authorization windows, emergency isolation, and no buyer voting power.

Required implementation details:

- Add a separate `MIN_ACTIVE_MEMBERS_AFTER_COOPERATIVE_EXIT = 2`; do not lower `MIN_GROUP_SIZE`.
- Request creation should require more than two active members.
- Approval/authorization must not retain the current `activeMemberCount() < MIN_GROUP_SIZE` gate after membership has fallen to three.
- Completion must revalidate that the current active count minus the requester is at least two.
- Remove `_allActiveGoalsComplete()` only from cooperative completion; do not change deposit targets, maturity withdrawals or other accounting.
- Decide and test a single policy for concurrent cooperative requests. Current per-position requests can coexist; after one completes, another request may still require approval eligibility from the exited member and become unfinishable until expiry. The safest simple V-next policy is one unresolved cooperative request per vault.
- Cap or clearly present request and authorization deadlines relative to maturity. A request may currently have a nominal deadline after maturity even though cooperative completion is forbidden at maturity.

## Security observations

No critical principal-loss issue was found in the reviewed maturity paths.

- Maturity withdrawal is non-reentrant and follows checks-effects-interactions.
- Failed or inexact token delivery reverts the complete state change.
- Principal liability and `SafetyController` exposure are reduced only with a successful atomic withdrawal.
- Protocol pause does not block matured or emergency withdrawals.
- Factories, deployers, safety council and maintenance treasury cannot call the owner-only withdrawal path.
- A market buyer receives the locked claim only; membership, emergency ownership and voting power do not transfer.
- Rewards remain disabled: `rewardsReady()` is false, eligible count is zero and activation reverts.

Residual risks and required follow-up:

- Polygon USDT is centrally issued; issuer freezing or token-level failure can prevent transfers. Contract state is preserved on revert, but the protocol cannot override the token issuer.
- Frontend maturity withdrawal currently uses a fixed gas limit. Add exact simulation and dynamic gas estimation, as already done for vault creation, so wallet failures produce actionable errors.
- Live ownership reads must remain authoritative; PostgreSQL and the indexer are discovery/performance layers only.
- Run a dedicated Amoy multi-wallet test for personal maturity, group maturity and purchased group-position maturity after the new deployment.
- Obtain an independent external audit before any mainnet real-funds deployment.

## Validation performed

- Full active Solidity suite: 88 passed, 31 legacy/optional tests skipped.
- Maturity-focused tests: 8 passed, 1 legacy Earn test skipped.
- Buyer-focused tests: 2 passed, 2 legacy tests skipped.
- Runtime contract sizes are below the EVM limit. `SavingsVaultDeployer` is the largest at 20,562 bytes, leaving 4,014 bytes.
- Slither, Solhint and Semgrep are not installed, so no claim of clean automated static analysis is made.
- Dependency audit reports no critical advisories, 13 high and 15 moderate advisories. The high findings are in the Hardhat/tooling dependency tree, principally the tooling's old transitive Zod version. The production API resolves Zod 4.6.7; the affected Zod 3.25.76 copies belong to contract development tooling. Resolve or formally accept these tooling findings before the release build.

## Redeployment gate

Do not redeploy until the 24-hour boundary, group-exit rules, concurrent-request policy and purchased-group maturity test are implemented and the full suite passes. Do not move to mainnet based only on this internal review.

## V1.1 implementation addendum

The reviewed corrections were subsequently implemented for the Amoy V1.1 candidate: a 24-hour minimum, a separate two-member cooperative-exit floor, no goal-completion gate, one unresolved cooperative request per circle, and a purchased-group maturity claim test. The active Solidity suite increased to 90 passing tests. This addendum does not convert the internal review into an independent audit and does not authorize a mainnet deployment.

