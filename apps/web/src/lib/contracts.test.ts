import { describe, expect, it } from "vitest";

import { assertDeploymentMatches } from "./contracts";

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
