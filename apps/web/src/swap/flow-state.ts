import type { SwapExecution, SwapQuote, SwapStatus } from "./types";

export type SwapFlowStage =
  | "IDLE" | "QUOTING" | "QUOTE_READY" | "QUOTE_EXPIRED"
  | "SOURCE_APPROVAL_PENDING" | "SWAP_SUBMITTED" | "SWAP_PENDING"
  | "SWAP_COMPLETED" | "DESTINATION_ASSET_CONFIRMED"
  | "CONTRACT_ACTION_READY" | "CONTRACT_ACTION_PENDING" | "COMPLETED"
  | "FAILED" | "REFUND_PENDING" | "REFUNDED";

export type SwapFlowKind = "SAVE_WITH_NIM" | "PURCHASE_WITH_NIM" | "WITHDRAW_AS_NIM";

export interface SwapFlowState {
  version: 1;
  key: string;
  kind: SwapFlowKind;
  stage: SwapFlowStage;
  sourceAddress: string;
  destinationAddress: string;
  sourceNetwork: string;
  destinationNetwork: string;
  quote: SwapQuote | null;
  execution: SwapExecution | null;
  confirmedSourceAmount: bigint | null;
  error: string | null;
  updatedAt: number;
}

export function newSwapFlow(key: string, kind: SwapFlowKind, sourceAddress: string, destinationAddress: string, sourceNetwork: string, destinationNetwork: string): SwapFlowState {
  return { version: 1, key, kind, stage: "IDLE", sourceAddress, destinationAddress, sourceNetwork, destinationNetwork, quote: null, execution: null, confirmedSourceAmount: null, error: null, updatedAt: Date.now() };
}

export function withStage(state: SwapFlowState, stage: SwapFlowStage, patch: Partial<SwapFlowState> = {}): SwapFlowState {
  return { ...state, ...patch, stage, updatedAt: Date.now() };
}

export function applySwapStatus(state: SwapFlowState, status: SwapStatus): SwapFlowState {
  const execution: SwapExecution = status;
  if (status.status === "COMPLETED") return withStage(state, state.kind === "WITHDRAW_AS_NIM" ? "COMPLETED" : "CONTRACT_ACTION_READY", { execution, error: null });
  if (status.status === "REFUND_PENDING") return withStage(state, "REFUND_PENDING", { execution, error: status.failureReason ?? null });
  if (status.status === "REFUNDED") return withStage(state, "REFUNDED", { execution, error: status.failureReason ?? null });
  if (status.status === "FAILED") return withStage(state, "FAILED", { execution, error: status.failureReason ?? "Swap failed." });
  return withStage(state, "SWAP_PENDING", { execution });
}

export function contractActionFailure(kind: SwapFlowKind, reason: string): string {
  if (kind === "PURCHASE_WITH_NIM")
    return `${reason} The converted USDT remains in your Polygon wallet; no other listing will be purchased automatically.`;
  if (kind === "WITHDRAW_AS_NIM")
    return `${reason} Any withdrawn USDT remains in your Polygon wallet and can be swapped later.`;
  return `${reason} Any available USDT remains in your Polygon wallet.`;
}

const STORAGE_PREFIX = "lockedin.swap.v1.";
const bigintReplacer = (_key: string, value: unknown) => typeof value === "bigint" ? { __lockedinBigInt: value.toString() } : value;
const bigintReviver = (_key: string, value: unknown) => {
  if (typeof value === "object" && value !== null && "__lockedinBigInt" in value) return BigInt(String((value as { __lockedinBigInt: unknown }).__lockedinBigInt));
  return value;
};

export function persistSwapFlow(state: SwapFlowState, storage: Pick<Storage, "setItem"> = localStorage): void {
  storage.setItem(`${STORAGE_PREFIX}${state.key}`, JSON.stringify(state, bigintReplacer));
}

export function restoreSwapFlow(key: string, expected: Pick<SwapFlowState, "sourceAddress" | "destinationAddress" | "sourceNetwork" | "destinationNetwork">, storage: Pick<Storage, "getItem"> = localStorage): SwapFlowState | null {
  const raw = storage.getItem(`${STORAGE_PREFIX}${key}`);
  if (!raw) return null;
  let state: SwapFlowState;
  try {
    state = JSON.parse(raw, bigintReviver) as SwapFlowState;
  } catch {
    return null;
  }
  if (state.version !== 1 || state.key !== key) return null;
  const changed = state.sourceAddress.toLowerCase() !== expected.sourceAddress.toLowerCase()
    || state.destinationAddress.toLowerCase() !== expected.destinationAddress.toLowerCase()
    || state.sourceNetwork !== expected.sourceNetwork
    || state.destinationNetwork !== expected.destinationNetwork;
  return changed ? withStage(state, "FAILED", { error: "Wallet or network changed. Reconnect the original wallets or start a new flow before continuing." }) : state;
}

export function clearSwapFlow(key: string, storage: Pick<Storage, "removeItem"> = localStorage): void {
  storage.removeItem(`${STORAGE_PREFIX}${key}`);
}
