import { describe, expect, it } from "vitest";
import { parseAssetAmount, formatAssetAmount, requiredUsdtForEarlyExit } from "./amounts";
import { MockSwapAdapter } from "./mock-swap-adapter";

const request = (direction: "NIM_TO_POLYGON_USDT" | "POLYGON_USDT_TO_NIM", amount: bigint) => ({
  direction, sourceAmount: amount, sourceAddress: direction.startsWith("NIM") ? "NQ TEST" : "0xabc",
  destinationAddress: direction.startsWith("NIM") ? "0xabc" : "NQ TEST",
  sourceNetwork: direction.startsWith("NIM") ? "nimiq-testnet" as const : "polygon-amoy" as const,
  destinationNetwork: direction.startsWith("NIM") ? "polygon-amoy" as const : "nimiq-testnet" as const,
  slippageBps: 50,
});

describe("integer asset amounts", () => {
  it("converts NIM and USDT without floating point", () => {
    expect(parseAssetAmount("12.34567", 5)).toBe(1_234_567n);
    expect(parseAssetAmount("12.345678", 6)).toBe(12_345_678n);
    expect(formatAssetAmount(12_345_678n, 6)).toBe("12.345678");
  });

  it("calculates exact early-exit funding including the 0.9% fee", () => {
    expect(requiredUsdtForEarlyExit(19_868_750n)).toBe(20_047_568n);
  });
});

describe("MockSwapAdapter", () => {
  it("creates deterministic quotes in both directions with fee and slippage", async () => {
    let now = 1_000;
    const adapter = new MockSwapAdapter({ enabled: true, environment: "amoy-test", nimiqNetwork: "testnet", polygonChainId: 80_002, now: () => now });
    for (const direction of ["NIM_TO_POLYGON_USDT", "POLYGON_USDT_TO_NIM"] as const) {
      const quote = await adapter.getQuote(request(direction, 1_000_000n));
      expect(quote.providerFee).toBe(3_000n);
      expect(quote.minimumReceived).toBe(992_015n);
      expect(quote.simulated).toBe(true);
      now = quote.expiresAt;
      await expect(adapter.executeSwap(quote.id)).rejects.toThrow(/expired/i);
      now = 1_000;
    }
  });

  it("grosses up an exact early-exit requirement", async () => {
    const adapter = new MockSwapAdapter({ enabled: true, environment: "local", nimiqNetwork: "testnet", polygonChainId: 31_337 });
    const quote = await adapter.getQuote({ ...request("NIM_TO_POLYGON_USDT", 1n), sourceAmount: undefined, destinationAmount: 20_047_568n });
    expect(quote.minimumReceived).toBeGreaterThanOrEqual(20_047_568n);
  });

  it.each([
    { environment: "production" as const, nimiqNetwork: "testnet" as const, polygonChainId: 80_002 },
    { environment: "amoy-test" as const, nimiqNetwork: "mainnet" as const, polygonChainId: 80_002 },
    { environment: "local" as const, nimiqNetwork: "testnet" as const, polygonChainId: 137 },
  ])("locks out production configuration %#", (configuration) => {
    expect(() => new MockSwapAdapter({ enabled: true, ...configuration })).toThrow(/locked out/i);
  });

  it("reports failure and refund states without transaction hashes", async () => {
    for (const scenario of ["failure", "refund"] as const) {
      let now = 1_000;
      const adapter = new MockSwapAdapter({ enabled: true, environment: "local", nimiqNetwork: "testnet", polygonChainId: 31_337, scenario, now: () => now });
      const quote = await adapter.getQuote(request("NIM_TO_POLYGON_USDT", 100_000n));
      const execution = await adapter.executeSwap(quote.id);
      now += 800;
      let status = await adapter.getSwapStatus(execution.swapId);
      expect(status.sourceTransactionHash).toBeNull();
      expect(status.simulated).toBe(true);
      if (scenario === "failure") expect(status.status).toBe("FAILED");
      else {
        expect(status.status).toBe("REFUND_PENDING");
        now += 800;
        status = await adapter.getSwapStatus(execution.swapId);
        expect(status.status).toBe("REFUNDED");
      }
    }
  });
});
