# Next immutable redeployment notes

This file records approved product corrections for the next contract version. It is not the specification of the currently deployed contracts, and none of these notes changes an existing deployment.

Implementation status: incorporated into the Polygon Amoy V1.1 deployment candidate. Legacy deployments retain their original rules.

## Cooperative group exit

### Approved changes

- Keep the minimum group size for creation and activation at four members.
- Remove the requirement that every active member must have completed their savings goal before a cooperative exit can be completed.
- Permit cooperative exits while at least two active members will remain after the exit.
- Introduce a dedicated constant such as `MIN_ACTIVE_MEMBERS_AFTER_COOPERATIVE_EXIT = 2`. Do not lower or reuse the four-member creation/activation constant.
- A four-member active circle must therefore be able to approve one exit and continue with three active members. A three-member circle must be able to approve one exit and continue with two. A two-member circle must reject another cooperative exit.

### Rules that remain unless separately approved

- Only the requester can withdraw the requester's locked claim.
- Emergency savings remain owned and separately withdrawable by the original saver.
- Every other active member recorded for the request must approve.
- Each approver must have active principal equal to at least 25% of their own target.
- The request expires after 24 hours; authorization has a separate 24-hour completion window.
- The requester cannot self-approve, and market buyers receive no membership or voting power.
- A live market listing and a cooperative request remain mutually exclusive.
- Completion records the exiting member as ineligible for any future reward programme and cannot move another member's principal.
- Membership remains immutable after group activation.

### Security and product decisions to verify

- Revalidate the remaining-member count at execution, not only when the request is created, so concurrent exits cannot reduce the group below two.
- Retain checks-effects-interactions, reentrancy protection, exact token-transfer accounting and solvency assertions.
- Rewards remain unavailable and must continue to be presented as `Coming soon`. This redeployment must not activate rewards, make rewards claimable or change reward distribution.
- Preserve enough eligibility state to support a separately reviewed future reward deployment, but do not make the future programme a condition of cooperative group exits.
- Confirm how pending requests behave when another member exits through a different permitted path. Required approvers and active-member status must not create an unfinishable or incorrectly authorized request.
- Update frontend explanations and disabled-state reasons only after the new deployment identity is active. Legacy vaults must continue to show and enforce their original four-member/completed-goals rules.

### Required tests before redeployment

- Complete a cooperative exit from five to four, four to three and three to two active members.
- Reject a cooperative exit that would reduce the group from two to one.
- Complete an exit while one or more active members have not reached their goals.
- Preserve unanimous approval, the 25% per-approver threshold and both 24-hour windows.
- Prove that no reward can be activated or claimed through the cooperative-exit changes.
- Prove that only the requester's locked claim moves and every emergency balance remains isolated.
- Test simultaneous/pending requests and revalidate the two-member floor at execution.
- Verify market-listing exclusion, cancellation, expiry and maturity withdrawal remain intact.
- Verify legacy deployed vaults retain the old behavior while new vaults use the new rules.
- Add fuzz and invariant coverage proving active membership never falls below two through cooperative exits and total assets continue to cover liabilities.

