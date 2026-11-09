import { describe, expect, it } from "vitest";

import { activeSavingsBalance, type ActiveSavingsPosition } from "./portfolio-balance";

const original = (overrides: Partial<ActiveSavingsPosition> = {}): ActiveSavingsPosition => ({
  access: "owner",
  isOriginalMember: true,
  currentValue: "90",
  emergencyBalance: "10",
  ...overrides,
});

describe("activeSavingsBalance", () => {
  it("uses current claim and emergency balances for normal and additional deposits", () => {
    expect(activeSavingsBalance([original()])).toBe(100);
    expect(activeSavingsBalance([original({ currentValue: "135", emergencyBalance: "15" })])).toBe(150);
  });

  it("removes emergency funds after withdrawal", () => {
    expect(activeSavingsBalance([original({ emergencyBalance: "0" })])).toBe(90);
  });

  it("removes a sold claim while retaining the seller's remaining emergency funds", () => {
    expect(activeSavingsBalance([original({ access: "emergency-only" })])).toBe(10);
  });

  it("attributes a purchased claim to its current owner without inventing emergency ownership", () => {
    expect(activeSavingsBalance([original({ isOriginalMember: false, currentValue: "84.5", emergencyBalance: "0" })])).toBe(84.5);
  });

  it("removes matured and cooperative claims after their on-chain balances are cleared", () => {
    expect(activeSavingsBalance([original({ access: "emergency-only", currentValue: "0", emergencyBalance: "0" })])).toBe(0);
    expect(activeSavingsBalance([original({ access: "emergency-only", currentValue: "0", emergencyBalance: "0" })])).toBe(0);
  });

  it("does not change for a cancelled listing", () => {
    const position = original();
    expect(activeSavingsBalance([position])).toBe(100);
  });

  it("clears on account change and reconstructs identically after reload", () => {
    const snapshots = [original(), original({ currentValue: "45", emergencyBalance: "5" })];
    expect(activeSavingsBalance([])).toBe(0);
    expect(activeSavingsBalance(snapshots)).toBe(150);
    expect(activeSavingsBalance(structuredClone(snapshots))).toBe(150);
  });

  it("cannot be inflated by duplicate event projections because only position snapshots are accepted", () => {
    expect(activeSavingsBalance([original()])).toBe(100);
  });

  it("ignores invalid or negative values", () => {
    expect(activeSavingsBalance([original({ currentValue: "NaN", emergencyBalance: "-1" })])).toBe(0);
  });
});
