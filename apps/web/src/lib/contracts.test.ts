import { describe, expect, it } from "vitest";

import {
  assertDeploymentMatches,
  describeContractError,
  groupCreationUnsupportedReason,
  supportsOpenEnrollmentProtocol,
} from "./contracts";

const actual = {
  protocolVersion: "lockedin-circle/0.5.0",
  deploymentId: `0x${"11".repeat(32)}`,
  chainId: 80_002n,
  asset: `0x${"22".repeat(20)}`,
  market: `0x${"33".repeat(20)}`,
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
    expect(message).toMatch(/wallet.*Polygon RPC could not submit/i);
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

  it("decodes a nested wallet-provider listing rejection into an actionable reason", () => {
    const message = describeContractError({
      code: -32603,
      error: { data: "0x8c02a5a1", message: "execution reverted: PositionListed()" },
    });
    expect(message).toMatch(/already listed.*cancel the listing/i);
    expect(message).not.toMatch(/32603|8c02/i);
  });

  it("explains insufficient token balance", () => {
    expect(describeContractError({
      cause: { message: "ERC20InsufficientBalance" },
    })).toMatch(/enough USDT/i);
  });

  it("explains invalid group creation settings", () => {
    expect(describeContractError({
      error: { message: "execution reverted", errorName: "InvalidConfiguration" },
    })).toMatch(/goal.*emergency.*member limit.*join deadline.*maturity/i);
  });

  it("explains duplicate available circle invitations", () => {
    expect(describeContractError(new Error("InvitationAlreadyAvailable"))).toMatch(
      /already has an available invitation/i
    );
  });

  it("explains invitation eligibility failures precisely", () => {
    expect(describeContractError(new Error("InvitationCreatorOnly"))).toMatch(/only the wallet that created/i);
    expect(describeContractError(new Error("InvitationEnrollmentClosed"))).toMatch(/join window has ended/i);
    expect(describeContractError(new Error("InvitationExpiryAfterEnrollment"))).toMatch(/on or before.*join deadline/i);
    expect(describeContractError(new Error("InvitationPublicCircle"))).toMatch(/join it directly/i);
  });

  it("explains invalid invitee wallet addresses", () => {
    expect(describeContractError(new Error("invalid address"))).toMatch(
      /valid Polygon wallet address/i
    );
  });

  it("preserves the calculated POL reserve and shortfall for vault creation", () => {
    expect(describeContractError(new Error(
      "The connected Amoy account 0xEA04 has 0.1075 POL, but this vault can reserve up to 0.1486 POL for gas."
    ))).toBe(
      "Not enough POL for this vault creation. Your wallet has 0.1075 POL; the transaction may need up to 0.1486 POL. Add at least 0.0411 POL and try again."
    );
  });

  it("preserves the standard wallet POL requirement", () => {
    expect(describeContractError(new Error(
      "Insufficient POL for network fees. Your wallet has 0.0200 POL; keep about 0.0500 POL available before continuing."
    ))).toBe(
      "Not enough POL for the network fee. Your wallet has 0.0200 POL; keep about 0.0500 POL available and try again."
    );
  });

  it("does not fall back to the old reasonless error copy", () => {
    const message = describeContractError({ unexpected: true });
    expect(message).toMatch(/wallet did not return the rejection reason/i);
    expect(message).not.toMatch(/POL/i);
    expect(message).not.toMatch(/action could not be completed/i);
  });
});

describe("group creation compatibility", () => {
  it("blocks insecure invite-only creation on pre-1.2 protocols", () => {
    expect(groupCreationUnsupportedReason("lockedin-circle/0.8.0", "invite-only")).toMatch(
      /secure invite-only circles require protocol 1\.2\.0/i
    );
    expect(groupCreationUnsupportedReason("lockedin-circle/1.1.0-safe", "invite-only")).toMatch(
      /secure invite-only circles require protocol 1\.2\.0/i
    );
    expect(groupCreationUnsupportedReason("lockedin-circle/1.2.0-safe", "invite-only")).toBeNull();
    expect(groupCreationUnsupportedReason("lockedin-circle/1.3.0-safe", "invite-only")).toBeNull();
  });

  it("allows creator-first circles on immutable Safe-only V1", () => {
    expect(groupCreationUnsupportedReason("lockedin-circle/1.0.0-safe", "public")).toBeNull();
    expect(supportsOpenEnrollmentProtocol("lockedin-circle/1.0.0-safe")).toBe(true);
    expect(groupCreationUnsupportedReason("lockedin-circle/1.1.0-safe", "public")).toBeNull();
    expect(supportsOpenEnrollmentProtocol("lockedin-circle/1.1.0-safe")).toBe(true);
  });

  it("explains the fixed-member limitation on the deployed 0.5 factory", () => {
    expect(groupCreationUnsupportedReason("lockedin-circle/0.5.0", "invite-only")).toMatch(
      /secure invite-only circles require protocol 1\.2\.0/i
    );
  });

  it("distinguishes unsupported public enrollment", () => {
    expect(groupCreationUnsupportedReason("lockedin-circle/0.5.0", "public")).toMatch(
      /require protocol 0\.8\.0/i
    );
  });
});
