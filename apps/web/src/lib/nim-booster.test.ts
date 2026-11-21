import { describe, expect, it } from "vitest";

import type { ActivityItem, ExitListingSnapshot, VaultSummary } from "./contracts";
import { calculateBoosterQualification } from "./nim-booster";

const goal: VaultSummary = {
  address: "0x1111111111111111111111111111111111111111",
  positionId: 0n,
  access: "owner",
  isOriginalMember: true,
  isGroup: false,
  createdAt: new Date("2026-10-01T00:00:00Z"),
  maturity: new Date("2027-01-01T00:00:00Z"),
  memberCount: 1,
  target: "100",
  deposited: "30",
  emergencyBalance: "3",
  currentValue: "27",
  progressPercent: 30,
  expectedProgressPercent: 25,
  pace: "on-track",
  vaultMode: "safe",
  legacy: false,
};

function deposit(day: number): ActivityItem {
  return {
    id: `deposit-${day}`,
    blockNumber: day,
    transactionHash: `0x${String(day).padStart(64, "0")}`,
    title: "Savings added",
    detail: "Funds were added.",
    vault: goal.address,
    timestamp: new Date(`2026-11-${String(day).padStart(2, "0")}T12:00:00Z`),
  };
}

describe("NIM Booster qualification", () => {
  it("qualifies consistent progress without favouring one large deposit", () => {
    const result = calculateBoosterQualification(
      [goal],
      [deposit(2), deposit(5), deposit(8), deposit(11)],
      [],
      new Date("2026-11-12T12:00:00Z")
    );
    expect(result.eligible).toBe(true);
    expect(result.score).toBeGreaterThanOrEqual(70);
    expect(result.criteria.every((criterion) => criterion.met)).toBe(true);
  });

  it("does not treat one contribution day as consistency", () => {
    const result = calculateBoosterQualification(
      [goal],
      [deposit(11)],
      [],
      new Date("2026-11-12T12:00:00Z")
    );
    expect(result.eligible).toBe(false);
    expect(result.criteria.find((criterion) => criterion.id === "consistency")?.met).toBe(false);
  });

  it("does not qualify a position that is offered for an early exit", () => {
    const listing = {
      listing: {
        active: true,
        vault: goal.address,
        positionId: goal.positionId,
      },
    } as ExitListingSnapshot;
    const result = calculateBoosterQualification(
      [goal],
      [deposit(2), deposit(5), deposit(8), deposit(11)],
      [listing],
      new Date("2026-11-12T12:00:00Z")
    );
    expect(result.eligible).toBe(false);
    expect(result.criteria.find((criterion) => criterion.id === "retained")?.met).toBe(false);
  });
});
