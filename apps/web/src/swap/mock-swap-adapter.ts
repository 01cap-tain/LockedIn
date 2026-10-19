import { applyBasisPoints, grossSourceForDestination } from "./amounts";
import type { SwapAdapter, SwapExecution, SwapQuote, SwapRequest, SwapStatus } from "./types";

export type MockSwapScenario = "success" | "failure" | "refund";

export interface MockSwapConfiguration {
  enabled: boolean;
  environment: "local" | "amoy-test" | "production";
  nimiqNetwork: "testnet" | "mainnet";
  polygonChainId: number;
  scenario?: MockSwapScenario;
  now?: () => number;
}

const PROVIDER_FEE_BPS = 30;
const QUOTE_LIFETIME_MS = 60_000;

function encode(prefix: string, value: object): string {
  return `${prefix}.${encodeURIComponent(JSON.stringify(value, (_key, item: unknown) =>
    typeof item === "bigint" ? item.toString() : item
  ))}`;
}

function decode<T>(prefix: string, value: string): T {
  if (!value.startsWith(`${prefix}.`)) throw new Error("Unknown simulated swap identifier.");
  return JSON.parse(decodeURIComponent(value.slice(prefix.length + 1))) as T;
}

/**
 * Deterministic UI/test adapter. It never asks a wallet to send funds and never
 * mints, transfers or reports a real NIM/USDT transaction.
 */
export class MockSwapAdapter implements SwapAdapter {
  private readonly now: () => number;
  private readonly scenario: MockSwapScenario;

  constructor(config: MockSwapConfiguration) {
    if (!config.enabled || config.environment === "production" || config.nimiqNetwork === "mainnet" || config.polygonChainId === 137) {
      throw new Error("Simulated swaps are locked out of mainnet and production configuration.");
    }
    this.now = config.now ?? Date.now;
    this.scenario = config.scenario ?? "success";
  }

  async getQuote(request: SwapRequest): Promise<SwapQuote> {
    if (!request.sourceAddress || !request.destinationAddress) throw new Error("Both wallet addresses are required.");
    if (request.slippageBps < 0 || request.slippageBps > 500) throw new Error("Mock slippage must be between 0% and 5%.");
    if ((request.sourceAmount === undefined) === (request.destinationAmount === undefined)) throw new Error("Specify exactly one source or destination amount.");

    // Test rate: 1 NIM (100,000 luna) = 0.10 USDT (100,000 base units),
    // so the integer base-unit value is identical in either direction.
    const sourceAmount = request.sourceAmount ?? grossSourceForDestination(request.destinationAmount!, PROVIDER_FEE_BPS, request.slippageBps);
    const grossDestination = sourceAmount;
    const providerFee = applyBasisPoints(grossDestination, PROVIDER_FEE_BPS);
    const expectedDestinationAmount = grossDestination - providerFee;
    const minimumReceived = expectedDestinationAmount - applyBasisPoints(expectedDestinationAmount, request.slippageBps);
    if (request.destinationAmount !== undefined && minimumReceived < request.destinationAmount) throw new Error("Unable to protect the exact destination amount.");
    const createdAt = this.now();
    const payload = { ...request, sourceAmount: sourceAmount.toString(), createdAt, expiresAt: createdAt + QUOTE_LIFETIME_MS, scenario: this.scenario };
    return {
      id: encode("mockq", payload), direction: request.direction, sourceAmount,
      expectedDestinationAmount, minimumReceived, exchangeRateNumerator: 1n,
      exchangeRateDenominator: 1n, providerFee,
      sourceNetworkFee: request.direction === "NIM_TO_POLYGON_USDT" ? 100n : 10_000n,
      destinationNetworkFee: 0n, slippageBps: request.slippageBps,
      createdAt, expiresAt: createdAt + QUOTE_LIFETIME_MS,
      sourceAddress: request.sourceAddress, destinationAddress: request.destinationAddress,
      sourceNetwork: request.sourceNetwork, destinationNetwork: request.destinationNetwork,
      simulated: true,
    };
  }

  async executeSwap(quoteId: string): Promise<SwapExecution> {
    const quote = decode<{ expiresAt: number; scenario: MockSwapScenario }>("mockq", quoteId);
    if (this.now() >= quote.expiresAt) throw new Error("The simulated quote expired. Request a fresh quote.");
    const submittedAt = this.now();
    const swapId = encode("mocks", { quoteId, submittedAt, scenario: quote.scenario });
    return { swapId, quoteId, status: "SUBMITTED", submittedAt, sourceTransactionHash: null, destinationTransactionHash: null, simulated: true };
  }

  async getSwapStatus(swapId: string): Promise<SwapStatus> {
    const execution = decode<{ quoteId: string; submittedAt: number; scenario: MockSwapScenario }>("mocks", swapId);
    const elapsed = this.now() - execution.submittedAt;
    let status: SwapStatus["status"] = elapsed < 750 ? "PENDING" : "COMPLETED";
    let failureReason: string | undefined;
    if (execution.scenario === "failure" && elapsed >= 750) {
      status = "FAILED";
      failureReason = "Simulated provider failure. No real funds moved.";
    } else if (execution.scenario === "refund" && elapsed >= 750) {
      status = elapsed < 1_500 ? "REFUND_PENDING" : "REFUNDED";
      failureReason = "Simulated swap entered refund recovery.";
    }
    return {
      swapId, quoteId: execution.quoteId, status, submittedAt: execution.submittedAt,
      updatedAt: this.now(), sourceTransactionHash: null, destinationTransactionHash: null,
      refundTransactionHash: null, failureReason, simulated: true,
    };
  }
}

export function createConfiguredMockSwapAdapter(): MockSwapAdapter | null {
  // VITE_* values cannot activate the simulator in an optimized production build.
  if (import.meta.env.PROD) return null;
  if (import.meta.env.VITE_ENABLE_MOCK_SWAPS !== "true") return null;
  const environment = import.meta.env.VITE_SWAP_ENVIRONMENT;
  if (environment !== "local" && environment !== "amoy-test") return null;
  const nimiqNetwork = import.meta.env.VITE_SWAP_NIMIQ_NETWORK === "testnet" ? "testnet" : "mainnet";
  const polygonChainId = Number(import.meta.env.VITE_EXPECTED_CHAIN_ID ?? (environment === "amoy-test" ? "80002" : "31337"));
  return new MockSwapAdapter({ enabled: true, environment, nimiqNetwork, polygonChainId });
}
