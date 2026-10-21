import { useEffect, useMemo, useState } from "react";

import { formatAssetAmount, parseAssetAmount } from "../swap/amounts";
import {
  applySwapStatus,
  contractActionFailure,
  clearSwapFlow,
  newSwapFlow,
  persistSwapFlow,
  restoreSwapFlow,
  withStage,
  type SwapFlowKind,
  type SwapFlowState,
} from "../swap/flow-state";
import type { SwapAdapter, SwapNetwork } from "../swap/types";

interface NimSwapFlowProps {
  adapter: SwapAdapter | null;
  flowKey: string;
  kind: SwapFlowKind;
  nimiqAddress: string;
  polygonAddress: string;
  nimiqNetwork: "testnet" | "mainnet";
  polygonNetwork: "polygon-amoy" | "polygon" | "local";
  nimBalanceLuna: bigint | null;
  usdtBalance: string | null;
  exactUsdtRequired?: bigint;
  withdrawalUsdtAmount?: bigint;
  onContractAction: (readyDestinationAmount?: bigint) => Promise<bigint | void>;
  contractActionLabel: string;
}

function contextFor(props: NimSwapFlowProps) {
  const reverse = props.kind === "WITHDRAW_AS_NIM";
  return {
    sourceAddress: reverse ? props.polygonAddress : props.nimiqAddress,
    destinationAddress: reverse ? props.nimiqAddress : props.polygonAddress,
    sourceNetwork: (reverse ? props.polygonNetwork : `nimiq-${props.nimiqNetwork}`) as SwapNetwork,
    destinationNetwork: (reverse ? `nimiq-${props.nimiqNetwork}` : props.polygonNetwork) as SwapNetwork,
  };
}

/**
 * Coordinates a provider-neutral swap and a separate Polygon contract action.
 * The component never treats those approvals as atomic or stores wallet secrets.
 */
export function NimSwapFlow(props: NimSwapFlowProps) {
  const context = useMemo(() => contextFor(props), [props.kind, props.nimiqAddress, props.polygonAddress, props.nimiqNetwork, props.polygonNetwork]);
  const [amount, setAmount] = useState("10");
  const [clock, setClock] = useState(Date.now());
  const [state, setState] = useState<SwapFlowState>(() => {
    const initial = newSwapFlow(props.flowKey, props.kind, context.sourceAddress, context.destinationAddress, context.sourceNetwork, context.destinationNetwork);
    return restoreSwapFlow(props.flowKey, initial) ?? initial;
  });

  useEffect(() => {
    const initial = newSwapFlow(props.flowKey, props.kind, context.sourceAddress, context.destinationAddress, context.sourceNetwork, context.destinationNetwork);
    setState(restoreSwapFlow(props.flowKey, initial) ?? initial);
  }, [props.flowKey, context.sourceAddress, context.destinationAddress, context.sourceNetwork, context.destinationNetwork, props.kind]);

  useEffect(() => persistSwapFlow(state), [state]);
  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 500);
    return () => window.clearInterval(timer);
  }, []);
  useEffect(() => {
    if (state.stage === "QUOTE_READY" && state.quote && clock >= state.quote.expiresAt) setState((current) => withStage(current, "QUOTE_EXPIRED", { error: "Quote expired. Request a fresh quote." }));
  }, [clock, state.stage, state.quote]);
  useEffect(() => {
    if (!props.adapter || !state.execution || !["SWAP_SUBMITTED", "SWAP_PENDING", "REFUND_PENDING"].includes(state.stage)) return;
    let cancelled = false;
    const poll = async () => {
      try {
        const status = await props.adapter!.getSwapStatus(state.execution!.swapId);
        if (!cancelled) setState((current) => applySwapStatus(current, status));
      } catch (error) {
        if (!cancelled) setState((current) => withStage(current, "FAILED", { error: error instanceof Error ? error.message : "Swap status could not be recovered." }));
      }
    };
    void poll();
    const timer = window.setInterval(() => void poll(), 750);
    return () => { cancelled = true; window.clearInterval(timer); };
  }, [props.adapter, state.execution?.swapId, state.stage]);

  async function quote(): Promise<void> {
    if (!props.adapter) return;
    if (nimFundingError) {
      setState((current) => withStage(current, "FAILED", { error: nimFundingError }));
      return;
    }
    setState((current) => withStage(current, "QUOTING", { error: null }));
    try {
      const direction = props.kind === "WITHDRAW_AS_NIM" ? "POLYGON_USDT_TO_NIM" : "NIM_TO_POLYGON_USDT";
      const requestAmount = props.kind === "SAVE_WITH_NIM" ? parseAssetAmount(amount, 5) : undefined;
      const sourceAmount = props.kind === "WITHDRAW_AS_NIM"
        ? state.confirmedSourceAmount ?? props.withdrawalUsdtAmount
        : requestAmount;
      const destinationAmount = props.kind === "PURCHASE_WITH_NIM" ? props.exactUsdtRequired : undefined;
      if (!sourceAmount && !destinationAmount) throw new Error("The required swap amount is unavailable.");
      const nextQuote = await props.adapter.getQuote({
        direction, sourceAmount, destinationAmount,
        sourceAddress: context.sourceAddress, destinationAddress: context.destinationAddress,
        sourceNetwork: context.sourceNetwork, destinationNetwork: context.destinationNetwork,
        slippageBps: 50,
      });
      setState((current) => withStage(current, "QUOTE_READY", { quote: nextQuote, execution: null, error: null }));
    } catch (error) {
      setState((current) => withStage(current, "FAILED", { error: error instanceof Error ? error.message : "Quote failed." }));
    }
  }

  async function execute(): Promise<void> {
    if (!props.adapter || !state.quote) return;
    const quoteToExecute = state.quote;
    if (props.kind !== "WITHDRAW_AS_NIM") {
      const nimBalance = props.nimBalanceLuna;
      if (nimBalance === null) {
        setState((current) => withStage(current, "FAILED", { error: "Your NIM balance is still loading." }));
        return;
      }
      if (quoteToExecute.sourceAmount > nimBalance) {
        setState((current) => withStage(current, "FAILED", {
          error: `Insufficient NIM. This action needs ${formatAssetAmount(quoteToExecute.sourceAmount, 5)} NIM, but your wallet has ${formatAssetAmount(nimBalance, 5)} NIM.`,
        }));
        return;
      }
    }
    setState((current) => withStage(current, "SOURCE_APPROVAL_PENDING", { error: null }));
    try {
      const execution = await props.adapter.executeSwap(quoteToExecute.id);
      setState((current) => withStage(current, "SWAP_SUBMITTED", { execution }));
    } catch (error) {
      setState((current) => withStage(current, "FAILED", { error: error instanceof Error ? error.message : "Swap submission failed." }));
    }
  }

  async function contractAction(first = false): Promise<void> {
    setState((current) => withStage(current, "CONTRACT_ACTION_PENDING", { error: null }));
    try {
      const confirmedSourceAmount = await props.onContractAction(state.quote?.expectedDestinationAmount);
      setState((current) => withStage(current, first ? "DESTINATION_ASSET_CONFIRMED" : "COMPLETED", {
        confirmedSourceAmount: confirmedSourceAmount ?? current.confirmedSourceAmount,
      }));
    } catch (error) {
      const reason = error instanceof Error ? error.message : "Contract action failed.";
      setState((current) => withStage(current, "FAILED", { error: contractActionFailure(props.kind, reason) }));
    }
  }

  function reset(): void {
    clearSwapFlow(props.flowKey);
    setState(newSwapFlow(props.flowKey, props.kind, context.sourceAddress, context.destinationAddress, context.sourceNetwork, context.destinationNetwork));
  }

  const quoteRemaining = state.quote ? Math.max(0, Math.ceil((state.quote.expiresAt - clock) / 1_000)) : 0;
  const sourceDecimals = props.kind === "WITHDRAW_AS_NIM" ? 6 : 5;
  const destinationDecimals = props.kind === "WITHDRAW_AS_NIM" ? 5 : 6;
  const contractFirst = props.kind === "WITHDRAW_AS_NIM";
  const canRetryContract = state.stage === "FAILED" && state.execution?.status === "COMPLETED" && !contractFirst;
  const enteredNimAmount = props.kind === "SAVE_WITH_NIM"
    ? (() => {
        try {
          return parseAssetAmount(amount, 5);
        } catch {
          return null;
        }
      })()
    : null;
  const nimFundingError = props.kind === "SAVE_WITH_NIM"
    ? enteredNimAmount === null || enteredNimAmount <= 0n
      ? "Enter a valid NIM amount."
      : props.nimBalanceLuna === null
        ? "Your NIM balance is still loading."
        : enteredNimAmount > props.nimBalanceLuna
          ? `Insufficient NIM. Your wallet has ${formatAssetAmount(props.nimBalanceLuna, 5)} NIM.`
          : null
    : null;

  if (!props.adapter) {
    return (
      <div className="notice error" role="status">
        <strong>NIM swap unavailable</strong>
        <span>
          No official general Nimiq Pay NIM/Polygon-USDT swap API is currently
          documented. The simulator requires explicit local/testnet configuration.
        </span>
      </div>
    );
  }

  return (
    <div className="nim-swap-flow">
      <div className="warning compact">
        <strong>Simulated testnet swap</strong>
        <span>
          No real NIM or USDT transaction occurs. Swap and Polygon contract actions are separate approvals.
          {props.kind === "PURCHASE_WITH_NIM" && " Another provider may buy this listing while the swap is running; converted USDT stays in your wallet if that happens."}
        </span>
      </div>
      <div className="swap-balances">
        <span>NIM balance: <strong>{props.nimBalanceLuna === null ? "Unavailable" : `${formatAssetAmount(props.nimBalanceLuna, 5)} NIM`}</strong></span>
        <span>USDT balance: <strong>{props.usdtBalance ?? "Unavailable"} USDT</strong></span>
      </div>
      <ol className="swap-steps" aria-label="Swap progress">
        <li>USDT withdrawal or NIM approval</li><li>Swap confirmation</li><li>Destination confirmed</li><li>Contract handoff</li>
      </ol>
      {state.stage === "IDLE" && contractFirst && <button className="primary" onClick={() => void contractAction(true)}>1. {props.contractActionLabel}</button>}
      {state.stage === "IDLE" && !contractFirst && props.kind === "SAVE_WITH_NIM" && (
        <label>
          <span>NIM amount</span>
          <input aria-invalid={Boolean(nimFundingError)} value={amount} onChange={(event) => setAmount(event.target.value)} inputMode="decimal" />
          {nimFundingError && <small className="field-error" role="alert">{nimFundingError}</small>}
        </label>
      )}
      {((state.stage === "IDLE" && !contractFirst) || state.stage === "DESTINATION_ASSET_CONFIRMED" || state.stage === "QUOTE_EXPIRED") && (
        <button className="secondary" disabled={!props.adapter || Boolean(nimFundingError)} onClick={() => void quote()}>{state.stage === "QUOTE_EXPIRED" ? "Refresh quote" : "Get NIM/USDT quote"}</button>
      )}
      {state.stage === "QUOTING" && <p role="status">Requesting quote…</p>}
      {state.quote && ["QUOTE_READY", "SOURCE_APPROVAL_PENDING"].includes(state.stage) && (
        <div className="swap-quote">
          <Metric label="Source amount" value={`${formatAssetAmount(state.quote.sourceAmount, sourceDecimals)} ${props.kind === "WITHDRAW_AS_NIM" ? "USDT" : "NIM"}`} />
          <Metric label="Estimated received" value={`${formatAssetAmount(state.quote.expectedDestinationAmount, destinationDecimals)} ${props.kind === "WITHDRAW_AS_NIM" ? "NIM" : "USDT"}`} />
          <Metric label="Minimum received" value={formatAssetAmount(state.quote.minimumReceived, destinationDecimals)} />
          <Metric label="Provider fee" value={formatAssetAmount(state.quote.providerFee, destinationDecimals)} />
          <Metric label="Source network fee" value={formatAssetAmount(state.quote.sourceNetworkFee, sourceDecimals)} />
          <Metric label="Destination network fee" value={formatAssetAmount(state.quote.destinationNetworkFee, destinationDecimals)} />
          <Metric label="Exchange rate" value={`${state.quote.exchangeRateNumerator.toString()} / ${state.quote.exchangeRateDenominator.toString()}`} />
          <Metric label="Slippage" value={`${state.quote.slippageBps / 100}%`} />
          <Metric label="Quote expires" value={`${quoteRemaining}s`} />
          <small>From {state.quote.sourceAddress} to {state.quote.destinationAddress}</small>
          <button className="primary" disabled={state.stage !== "QUOTE_READY"} onClick={() => void execute()}>Confirm simulated swap</button>
        </div>
      )}
      {["SWAP_SUBMITTED", "SWAP_PENDING", "SOURCE_APPROVAL_PENDING", "CONTRACT_ACTION_PENDING", "REFUND_PENDING"].includes(state.stage) && <p role="status">{state.stage.replaceAll("_", " ").toLowerCase()}…</p>}
      {state.execution && (
        <div className="transaction-links">
          <TransactionLink hash={state.execution.sourceTransactionHash} label="Source transaction" network={context.sourceNetwork} />
          <TransactionLink hash={state.execution.destinationTransactionHash} label="Destination transaction" network={context.destinationNetwork} />
          {state.execution.refundTransactionHash && (
            <TransactionLink hash={state.execution.refundTransactionHash ?? null} label="Refund transaction" network={context.sourceNetwork} />
          )}
        </div>
      )}
      {state.stage === "CONTRACT_ACTION_READY" && (
        <div className="notice"><strong>USDT ready to deposit or spend</strong><span>This is a simulated conversion state. Confirm the real wallet balance before the separate Polygon action.</span><button className="primary" onClick={() => void contractAction()}>{props.contractActionLabel}</button></div>
      )}
      {state.stage === "COMPLETED" && <div className="notice"><strong>{contractFirst ? "NIM receipt simulated" : "Flow completed"}</strong><span>The mock reports no production transaction hash.</span></div>}
      {state.stage === "REFUNDED" && <div className="notice"><strong>Simulated refund completed</strong><span>No real funds moved.</span></div>}
      {state.error && <div className="notice error" role="alert"><strong>Recovery required</strong><span>{state.error}</span>{canRetryContract && <button className="secondary" onClick={() => void contractAction()}>Retry contract action</button>}</div>}
      {state.stage !== "IDLE" && <button className="secondary compact" onClick={reset}>Start over</button>}
    </div>
  );
}

function Metric({ label, value }: { label: string; value: string }) {
  return <div><small>{label}</small><strong>{value}</strong></div>;
}

function TransactionLink({ hash, label, network }: { hash: string | null; label: string; network: SwapNetwork }) {
  if (!hash) return null;
  const base = network === "polygon-amoy"
    ? "https://amoy.polygonscan.com/tx/"
    : network === "polygon"
      ? "https://polygonscan.com/tx/"
      : null;
  return base
    ? <a href={`${base}${hash}`} rel="noreferrer" target="_blank">{label}</a>
    : <span>{label}: <code>{hash}</code></span>;
}
