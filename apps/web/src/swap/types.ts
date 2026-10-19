export type SwapDirection = "NIM_TO_POLYGON_USDT" | "POLYGON_USDT_TO_NIM";
export type SwapNetwork = "nimiq-mainnet" | "nimiq-testnet" | "polygon" | "polygon-amoy" | "local";

export interface SwapRequest {
  direction: SwapDirection;
  sourceAmount?: bigint;
  destinationAmount?: bigint;
  sourceAddress: string;
  destinationAddress: string;
  sourceNetwork: SwapNetwork;
  destinationNetwork: SwapNetwork;
  slippageBps: number;
}

export interface SwapQuote {
  id: string;
  direction: SwapDirection;
  sourceAmount: bigint;
  expectedDestinationAmount: bigint;
  minimumReceived: bigint;
  exchangeRateNumerator: bigint;
  exchangeRateDenominator: bigint;
  providerFee: bigint;
  sourceNetworkFee: bigint;
  destinationNetworkFee: bigint;
  slippageBps: number;
  createdAt: number;
  expiresAt: number;
  sourceAddress: string;
  destinationAddress: string;
  sourceNetwork: SwapNetwork;
  destinationNetwork: SwapNetwork;
  simulated: boolean;
}

export type SwapStatusKind =
  | "SUBMITTED"
  | "PENDING"
  | "COMPLETED"
  | "FAILED"
  | "REFUND_PENDING"
  | "REFUNDED";

export interface SwapExecution {
  swapId: string;
  quoteId: string;
  status: SwapStatusKind;
  submittedAt: number;
  sourceTransactionHash: string | null;
  destinationTransactionHash: string | null;
  refundTransactionHash?: string | null;
  simulated: boolean;
}

export interface SwapStatus extends SwapExecution {
  updatedAt: number;
  failureReason?: string;
  refundTransactionHash?: string | null;
}

export interface SwapAdapter {
  getQuote(request: SwapRequest): Promise<SwapQuote>;
  executeSwap(quoteId: string): Promise<SwapExecution>;
  getSwapStatus(swapId: string): Promise<SwapStatus>;
  cancelSwap?(swapId: string): Promise<void>;
}
