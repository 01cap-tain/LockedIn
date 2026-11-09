# NIM to Polygon USDT production-route review

Investigation date: 5 November 2026. Installed SDK: `@nimiq/mini-app-sdk` `0.2.4`.

## Decision

**Stop: no verified, public production provider currently exposes the route LockedIn Circle needs.**

The required route is native NIM input, an enforceable quote, user-authorized conversion, final Polygon USDT delivery, and then a separate user-authorized `SavingsVault` deposit. The public Nimiq Pay Mini App surface does not expose general NIM-to-Polygon-USDT quote, execution, status, cancellation, or refund methods.

LockedIn Circle therefore keeps direct Polygon USDT funding as the only production funding route. NIM deposit and purchase controls are disabled when the explicit development/test simulator is unavailable. No developer wallet, manual settlement, database credit, or custom custodial exchange is used.

## Repository audit

### Wallet and payment entry points

- `apps/web/src/lib/nimiq.ts` connects to the injected Nimiq provider and lists the wallet account. It does not send a payment or request a swap.
- `apps/web/src/lib/nim-balance.ts` reads a NIM balance. A balance read is not a payment or conversion.
- `window.ethereum` is used for Polygon reads and user-approved Polygon transactions. It cannot convert native NIM.
- The Solidity vault contracts accept the configured six-decimal Polygon USDT-compatible asset. They contain no NIM, bridge, HTLC, or conversion path.
- The API has no swap intent, quote, settlement, refund, or provider-callback endpoint. It cannot and must not manufacture a vault credit.

### Existing simulator

- `apps/web/src/swap/mock-swap-adapter.ts` is a deterministic UI/test simulator. It sends no funds and produces no transaction hash.
- It is available only when `VITE_ENABLE_MOCK_SWAPS=true`, the environment is `local` or `amoy-test`, Nimiq is testnet, and the build is not a production build.
- Its constructor rejects production, Nimiq mainnet, and Polygon mainnet (`137`).
- `apps/web/src/swap/flow-state.ts` persists simulated UI progress in local storage. It is not an authoritative settlement record.
- `apps/web/src/components/NimSwapFlow.tsx` labels the route as simulated and does not represent it as a real transfer.

No production quote binding, HTLC, bridge transaction, conversion proof, provider callback, durable backend state machine, or refund execution exists in this repository.

## Official capability audit

The installed TypeScript declarations expose account listing, signing, NIM balance lookup, basic NIM transactions, staking transactions, and `payLightningInvoice`. The declarations do not expose a general swap quote, execute, status, cancel, or refund API.

`payLightningInvoice({ invoice })` is not the required route. It pays a fixed Bitcoin Lightning invoice: the user chooses NIM or Polygon USDT and the merchant receives BTC. The Mini App cannot choose NIM as the source, cannot choose Polygon USDT as the destination, and a resolved call only means the spending transaction was submitted, not that Lightning settlement completed.

The public Hub `checkout()` API offers NIM and Polygon USDT as alternative direct payment methods; it does not convert NIM into USDT. Hub `setupSwap()` and `refundSwap()` are restricted to official-wallet origins or a privileged self-hosted Hub. LockedIn is not authorized to treat those private methods as a public production integration.

Nimiq's announced Polygon bridge is still described by Nimiq as being implemented and tested. It bridges NIM 1:1 into an EVM representation of NIM; a separate DEX swap would still be required to obtain USDT. Nimiq has not published the production contract addresses, supported Mini App interface, route provider, audit evidence, or end-to-end settlement proof needed here.

## Feasibility matrix

| Requirement | Evidence | Result |
| --- | --- | --- |
| Public NIM-to-Polygon-USDT quote | No SDK or documented Mini App method | Unavailable |
| Quote expiry and minimum received | Only the local simulator models these | Unavailable in production |
| Nimiq Pay authorization for this route | Lightning authorization targets BTC, not Polygon USDT | Unavailable |
| Durable swap/settlement identifier | Lightning exposes a Lightning-specific `swapId` | Unsuitable |
| Polygon USDT destination binding | EVM provider can transfer existing USDT only | Conversion unavailable |
| Status, failure, and refund API | Hub swap methods are privileged | Unavailable to LockedIn |
| Public Amoy/TestAlbatross route | No official route documented | Unavailable |
| Direct Polygon USDT vault deposit | Standard EIP-1193 plus the vault contract | Supported |

## Required state machine before production enablement

A future provider adapter must durably record and recover these states server-side or from an authoritative provider: `QUOTE_CREATED`, `QUOTE_EXPIRED`, `SOURCE_APPROVAL_PENDING`, `SOURCE_SUBMITTED`, `SOURCE_CONFIRMED`, `CONVERSION_PENDING`, `DESTINATION_SUBMITTED`, `DESTINATION_CONFIRMED`, `VAULT_APPROVAL_PENDING`, `VAULT_DEPOSIT_PENDING`, `COMPLETED`, `FAILED`, `REFUND_PENDING`, and `REFUNDED`.

Each intent must bind the Nimiq account, Polygon account, source amount, destination asset and chain, vault address, minimum received, quote expiry, provider identifier, and unique nonce. A page reload must recover the same intent. A USDT arrival must be confirmed independently before a vault deposit is offered. Failure of the vault deposit must leave the USDT in the user's Polygon wallet and must never trigger an automatic second conversion or purchase.

## Production enablement checklist

Do not enable NIM funding until all of the following exist and are independently verified:

1. An official or audited provider documents the exact production route and supported jurisdictions.
2. Production Nimiq and Polygon contract addresses are published by the provider and verified independently.
3. The route provides signed/bound quotes, minimum-received protection, expiry, fees, and slippage.
4. The user explicitly approves the NIM spend and separately approves the Polygon vault action.
5. Status and refund APIs are idempotent and recoverable after reload or network loss.
6. Destination USDT is the official Polygon token at `0xc2132D05D31c914a87C6611c10748AEb04B58e8F`, with six decimals, and the configured vault asset matches it.
7. Tests cover expired quotes, account/network changes, insufficient NIM, partial or delayed settlement, duplicate callbacks, provider downtime, slippage breach, vault-action failure after conversion, and refunds.
8. At least one real mainnet transaction proves NIM debit, Polygon USDT receipt, and vault credit without a custodial LockedIn intermediary.

## Sources

- [Nimiq Mini Apps overview](https://nimiq.dev/mini-apps)
- [Nimiq Provider API](https://www.nimiq.dev/mini-apps/api-reference/nimiq-provider)
- [Bitcoin Lightning payments](https://www.nimiq.dev/mini-apps/features/bitcoin-lightning-payments)
- [EVM tokens in Mini Apps](https://www.nimiq.dev/mini-apps/features/evm-tokens)
- [Nimiq Hub API access levels](https://www.nimiq.dev/hub/api-reference)
- [Nimiq Bridge status and design](https://www.nimiq.com/blog/what-is-the-nimiq-bridge/)
- [Nimiq Pay source](https://github.com/nimiq/nimiq-pay-app)

The development `MockSwapAdapter` remains useful only for deterministic interface tests. It is not evidence of a viable provider and cannot be activated by a production build.
