# Invite-only group creation diagnosis

Date: 2026-10-22

## Result

The configured Polygon Amoy deployment is healthy, but it runs
`lockedin-circle/0.5.0`. The current frontend implements the creator-first
`0.7.0` group workflow. These interfaces are not compatible.

No contracts were deployed or changed during this diagnosis.

## Reproduction

- Connected chain: Polygon Amoy, chain ID `80002` (`0x13882`)
- Factory: `0xd018DBE28406357c5225c18B74feF33c6F964b5f`
- Protocol version: `lockedin-circle/0.5.0`
- Deployment ID: `0x277f664c85989be8cfe4382d33176437a3f28f887c2eb0e59acc4fc6825e46a8`
- Current frontend call:
  `createPublicGroupVault(string,uint256,uint16,uint32,uint64,uint64,uint8,bool)`
- Sanitised estimate arguments: `"Test Circle"`, `100000000` token units,
  `1000` emergency basis points, `4` maximum members, a future enrollment
  deadline, a future maturity, Safe mode (`0`), invite-only (`false`).
- `eth_estimateGas` result: error code `3`, `execution reverted`, revert data
  `0x`. There is no custom error to decode because the deployed factory has no
  function with that selector.
- No transaction was signed or submitted, so there is no transaction hash.

The legacy deployed call was also estimated without submitting a transaction:

`createGroupVault(address[],uint256[],uint16[],uint64,uint8)`

With four distinct members including the creator, four non-zero targets and
four allocations in the 10%–15% range, the estimate succeeded at `4,762,022`
gas in Safe mode. This proves the deployed factory still supports its legacy
fixed-member invite-only workflow.

## Exact failing layers

1. Frontend validation disabled every group creation when public groups were
   unavailable, including invite-only creation.
2. If that control was bypassed, the frontend always called the newer
   `createPublicGroupVault` interface against the older factory.
3. Gas estimation then reverted with empty data because the selector is absent.

Wallet connection, chain selection, deployment identity and factory bytecode
were verified successfully. The failure occurs before transaction signing.

## Legacy factory requirements

- Four to fifty members must be supplied at creation.
- Members must be distinct and non-zero.
- The creator must be included.
- The target and emergency-allocation arrays must exactly match the member
  array length.
- Every target must be non-zero.
- Every emergency allocation must be between 1,000 and 1,500 basis points.
- Group maturity must be more than the 72-hour invitation window in the future.
- Safe mode uses no adapter. Earn mode uses the deployment's configured
  `MockYieldAdapterFactory` on Amoy.

## Compatibility boundary

Protocol `0.5.0` fixes every invited address, target and emergency allocation
when the vault is created. It cannot implement the current requirement that a
creator opens an invite-only circle and each invited member later chooses an
independent target and allocation.

The frontend now blocks that incompatible call with a precise explanation
instead of producing a generic revert. Supporting the current invite-only
workflow requires a new immutable factory deployment. The existing deployment
must remain indexed so its vaults do not disappear after that migration.
