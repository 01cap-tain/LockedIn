import { describe, expect, it } from "vitest";

import {
  assertDeploymentMatches,
  describeContractError,
  groupCreationUnsupportedReason,
} from "./contracts";

const actual = {
  protocolVersion: "lockedin-circle/0.5.0",
  deploymentId: `0x${"11".repeat(32)}`,
  chainId: 80_002n,
  asset: `0x${"22".repeat(20)}`,
  market: `0x${"33".repeat(20)}`,
  rewardPool: `0x${"44".repeat(20)}`,
  safetyController: `0x${"55".repeat(20)}`,
};

describe("deployment manifest verification", () => {
  it("accepts the exact chain and protocol graph", () => {
    expect(() => assertDeploymentMatches(actual, actual)).not.toThrow();
  });

  it.each([
    ["chainId", 137n],
    ["deploymentId", `0x${"99".repeat(32)}`],
    ["asset", `0x${"88".repeat(20)}`],
    ["market", `0x${"77".repeat(20)}`],
    ["rewardPool", `0x${"66".repeat(20)}`],
    ["safetyController", `0x${"aa".repeat(20)}`],
  ] as const)("blocks a mismatched %s", (field, value) => {
    expect(() =>
      assertDeploymentMatches(actual, { ...actual, [field]: value })
    ).toThrow(/Deployment mismatch/);
  });
});

describe("contract error copy", () => {
  it.each([
    "could not decode result data",
    "code=BAD_DATA",
  ])("turns low-level read failures into a recovery message", (message) => {
    expect(describeContractError(new Error(message))).toMatch(
      /could not be read on Polygon Amoy/i
    );
  });

  it.each([
    "execution reverted: require(false)",
    "missing revert data",
  ])("does not mislabel a rejected transaction as a chain read failure", (message) => {
    expect(describeContractError(new Error(message))).toMatch(
      /declined this action/i
    );
  });

  it("never exposes JSON-RPC payloads or provider codes", () => {
    const message = describeContractError(
      new Error('could not coalesce error (error={ "code": -32603 }, payload={ "method": "eth_sendTransaction" })')
    );
    expect(message).toMatch(/Polygon Amoy is taking longer/i);
    expect(message).not.toMatch(/-32603|payload|eth_sendTransaction/i);
  });

  it("explains a rejected wallet request without treating it as a failure", () => {
    expect(describeContractError(new Error("ACTION_REJECTED code=4001"))).toBe(
      "The request was cancelled in your wallet. Nothing was changed."
    );
  });

  it("explains why a saver cannot buy their own exit", () => {
    expect(describeContractError(new Error("execution reverted: ProviderOnly()"))).toMatch(
      /different provider wallet/i
    );
  });

  it("turns a filled-listing race into a useful refresh message", () => {
    expect(describeContractError(new Error("execution reverted: ListingUnavailable()"))).toMatch(
      /no longer available/i
    );
  });
});

describe("group creation compatibility", () => {
  it("allows the creator-first group flow on protocol 0.7", () => {
    expect(groupCreationUnsupportedReason("lockedin-circle/0.8.0", "invite-only")).toBeNull();
  });

  it("explains the fixed-member limitation on the deployed 0.5 factory", () => {
    expect(groupCreationUnsupportedReason("lockedin-circle/0.5.0", "invite-only")).toMatch(
      /at least four member addresses, targets and emergency allocations/i
    );
  });

  it("distinguishes unsupported public enrollment", () => {
    expect(groupCreationUnsupportedReason("lockedin-circle/0.5.0", "public")).toMatch(
      /require protocol 0\.8\.0/i
    );
  });
});
