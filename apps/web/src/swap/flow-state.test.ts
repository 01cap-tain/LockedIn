import { describe, expect, it } from "vitest";
import { contractActionFailure, newSwapFlow, persistSwapFlow, restoreSwapFlow, withStage } from "./flow-state";

class MemoryStorage {
  values = new Map<string, string>();
  getItem(key: string) { return this.values.get(key) ?? null; }
  setItem(key: string, value: string) { this.values.set(key, value); }
  removeItem(key: string) { this.values.delete(key); }
}

describe("persistent swap flow", () => {
  it("restores bigint quote values after refresh", () => {
    const storage = new MemoryStorage();
    const initial = newSwapFlow("save:1", "SAVE_WITH_NIM", "NQ A", "0xabc", "nimiq-testnet", "polygon-amoy");
    const state = withStage(initial, "QUOTE_READY", { quote: { sourceAmount: 123n } as never });
    persistSwapFlow(state, storage as never);
    expect(restoreSwapFlow("save:1", initial, storage as never)?.quote?.sourceAmount).toBe(123n);
  });

  it("restores the exact USDT amount confirmed after a vault withdrawal", () => {
    const storage = new MemoryStorage();
    const initial = newSwapFlow("withdraw:1", "WITHDRAW_AS_NIM", "0xabc", "NQ A", "polygon-amoy", "nimiq-testnet");
    const state = withStage(initial, "DESTINATION_ASSET_CONFIRMED", { confirmedSourceAmount: 4_250_001n });
    persistSwapFlow(state, storage as never);
    expect(restoreSwapFlow("withdraw:1", initial, storage as never)?.confirmedSourceAmount).toBe(4_250_001n);
  });

  it("fails safely after an address or network change", () => {
    const storage = new MemoryStorage();
    const initial = newSwapFlow("purchase:1", "PURCHASE_WITH_NIM", "NQ A", "0xabc", "nimiq-testnet", "polygon-amoy");
    persistSwapFlow(initial, storage as never);
    expect(restoreSwapFlow("purchase:1", { ...initial, destinationAddress: "0xdef" }, storage as never)?.stage).toBe("FAILED");
  });

  it("ignores malformed persisted state", () => {
    const storage = new MemoryStorage();
    const initial = newSwapFlow("save:bad", "SAVE_WITH_NIM", "NQ A", "0xabc", "nimiq-testnet", "polygon-amoy");
    storage.setItem("lockedin.swap.v1.save:bad", "not-json");
    expect(restoreSwapFlow("save:bad", initial, storage as never)).toBeNull();
  });

  it("keeps USDT recoverable when the second operation fails", () => {
    expect(contractActionFailure("PURCHASE_WITH_NIM", "Listing sold.")).toContain("no other listing");
    expect(contractActionFailure("WITHDRAW_AS_NIM", "Reverse swap failed.")).toContain("USDT remains");
    expect(contractActionFailure("SAVE_WITH_NIM", "Deposit failed.")).toContain("USDT remains");
  });
});
