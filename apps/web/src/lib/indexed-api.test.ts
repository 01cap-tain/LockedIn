import { describe, expect, it } from "vitest";

import { mapIndexedActivity, mapIndexedTrade } from "./indexed-api";

describe("indexed API mapping", () => {
  it("maps token base units without losing the provider fee", () => {
    const trade = mapIndexedTrade({
      listing_id: "4", vault_address: "0x0000000000000000000000000000000000000001",
      position_id: "2", is_group: false,
      seller: "0x0000000000000000000000000000000000000002",
      provider: "0x0000000000000000000000000000000000000003",
      claim_value: "10000000", discount_bps: 450, saver_payout: "9550000",
      provider_return: "450000", provider_fee: "85950", block_number: "10",
      transaction_hash: "0xabc", recorded_at: "2026-11-01T00:00:00.000Z",
    });
    expect(trade.saverPayout).toBe("9.55");
    expect(trade.totalProviderPaid).toBe("9.63595");
  });

  it("turns indexed events into readable activity", () => {
    const activity = mapIndexedActivity({
      id: "1", block_number: "20", transaction_hash: "0xdef",
      contract_address: "0x0000000000000000000000000000000000000001",
      event_name: "Deposited", payload: { amount: "5000000" },
      recorded_at: "2026-11-01T00:00:00.000Z",
    });
    expect(activity.title).toBe("Savings added");
    expect(activity.amount).toBe("5.0");
  });
});
