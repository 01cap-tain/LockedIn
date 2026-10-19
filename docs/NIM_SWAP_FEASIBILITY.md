# NIM swap feasibility

Investigation date: 20 October 2026. Installed SDK: `@nimiq/mini-app-sdk` `0.2.4`.

## Conclusion

Nimiq Pay contains a self-custodial swap path for paying Bitcoin Lightning invoices with NIM or USDT, but its public Mini App surface does **not** expose a general NIM ↔ Polygon-USDT quote, execution, status, cancellation or refund API. No official deeplink was found for pre-filling or starting that swap, and no official TestAlbatross ↔ Polygon Amoy swap route is documented. LockedIn Circle must therefore stop at the provider-neutral adapter boundary and an explicitly simulated test adapter until Nimiq publishes a supported interface.

`payLightningInvoice({ invoice })` is not a general swap API. Its destination is a fixed Lightning invoice, and successful submission does not mean Lightning settlement is final. LockedIn Circle does not call it for vault funding or withdrawals.

## Sources inspected

- Installed package declarations and README: `node_modules/@nimiq/mini-app-sdk/dist/index.d.ts`, `provider.d.ts`, package README and package version `0.2.4`.
- [Official Mini App API reference](https://nimiq.dev/mini-apps/api-reference) and [Nimiq provider reference](https://nimiq.dev/mini-apps/api-reference/nimiq-provider).
- [Official Ethereum provider reference](https://nimiq.dev/mini-apps/api-reference/ethereum-provider) and [EVM-token guide](https://www.nimiq.dev/mini-apps/features/evm-tokens).
- [Official Nimiq Pay source](https://github.com/nimiq/nimiq-pay-app), including the published Mini App/provider entry points and repository structure.
- [Official Nimiq Pay open-source announcement](https://www.nimiq.com/blog/nimiq-pay-is-now-open-source/) and [Mini Apps Framework announcement](https://www.nimiq.com/blog/mini-apps-framework/).
- Public Mini App opening deeplink documented by the ecosystem: `https://nimpay.app/miniapps/open/<domain>`. This opens a Mini App; it does not invoke a wallet swap.

The public source confirms that Nimiq Pay itself has internal payment/swap flows. Those internal modules are not treated as a Mini App API. No private method was reverse-engineered or called.

## Public methods relevant to this investigation

The installed typed provider exposes account listing, message signing, consensus/block reads, NIM balance reads, basic NIM transactions, staking transactions and `payLightningInvoice`. It also exposes the generic provider `request`, but official documentation does not define a general swap method name or payload. Guessing a request name would violate the supported integration boundary.

Nimiq Pay separately injects the standard EIP-1193 Ethereum provider. That provider can read and submit Polygon transactions approved by the user, but it cannot itself convert native NIM into Polygon USDT.

## Feasibility matrix

| Route | Result |
| --- | --- |
| Documented Mini App SDK NIM/USDT swap method | Not available |
| Documented Nimiq Pay swap deeplink | Not available |
| Official general quote/execution/status/refund API | Not available |
| Official TestAlbatross → Amoy route | Not documented |
| Polygon contract call after USDT reaches the wallet | Supported through EIP-1193 |
| Lightning invoice payment with an internal swap | Supported, but unsuitable for this use case |

## Recommended production route

Wait for an official, documented Nimiq Pay interface that supplies quote, minimum received, expiry, execution approval, durable swap identifier, status and refund results for both NIM → Polygon USDT and Polygon USDT → NIM. Implement that interface behind `SwapAdapter`; do not change vault contracts or route funds through the LockedIn backend.

Before enabling production:

1. Verify the Nimiq Pay host network and connected Nimiq address.
2. Verify Polygon chain, asset and destination address.
3. Obtain an official quote with minimum-received protection.
4. Require the wallet's explicit swap approval.
5. Treat the swap and subsequent vault/market action as separate transactions.
6. Confirm completion from the official provider or chain state—not a timer.
7. Re-read wallet balance and current contract/listing state before the Polygon action.
8. If that action fails, leave USDT in the user's wallet and never purchase another listing automatically.

The development `MockSwapAdapter` exists only to exercise this orchestration. It creates no production transaction, holds no key, sends no asset and cannot run with Nimiq mainnet, Polygon mainnet or production configuration.
