# LockedIn Circle group-rule audit — protocol 0.8.0

## Result

The production factory exposes only the creator-first group flow. A creator
defines immutable shared circle settings plus the creator's own target and
emergency allocation. The legacy function that accepted every member's
address and financial terms at creation has been removed from this release.

## Shared settings

- The group name is written once by `VaultFactory` when the vault is created.
- Visibility, Safe/Earn mode, maturity, enrolment deadline and maximum member
  count are immutable constructor values.
- A group starts pending and accepts no deposits until explicit activation.
- Activation requires at least four joined members and permanently closes
  membership.
- Cooperative exits retain the unanimous 24-hour approval and execution
  windows. Each approver must hold active principal equal to at least 25% of
  that approver's own target.

## Member-specific settings

- Each join transaction is sent by the joining wallet and supplies that
  member's own target and 10%-15% emergency allocation.
- Emergency balance, locked principal, Earn shares, goal completion and reward
  eligibility remain position-specific.
- Contribution schedules and savings-plan labels remain non-authoritative
  client preferences; they do not alter contract balances or rights.

## Preserved security rules

- Public wallets may join a public pending circle until capacity or deadline.
- Invite-only circles require an on-chain invitation from the creator while
  pending.
- Market ownership transfer changes only the locked claim. It neither changes
  the original member record nor grants voting or reward eligibility.
- Cooperative exits cannot reduce an active group below four members.
- Market pricing, reward eligibility, withdrawals and balance accounting are
  unchanged by this release.

## Test coverage

Tests cover creator-only initialization, independent join terms, public and
invite-only admission, capacity, minimum activation size, immutable membership
after activation, deposit blocking before activation, personal 25% approval
thresholds, market-buyer exclusion, cooperative exits and group rewards.
