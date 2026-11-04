import { describe, expect, it } from "vitest";

import {
  decodeGroupInvitation,
  encodeGroupInvitation,
  groupInvitationCommitment,
  type SecureGroupInvitation,
} from "./contracts";

const invitation: SecureGroupInvitation = {
  vault: "0x1111111111111111111111111111111111111111",
  invitee: "0x2222222222222222222222222222222222222222",
  secret: `0x${"ab".repeat(32)}`,
  expiry: 1_800_000_000n,
  nonce: 42n,
  chainId: 80_002n,
  commitment: "",
};
invitation.commitment = groupInvitationCommitment(invitation);

describe("secure group invitation codes", () => {
  it("round-trips every commitment-bound field", () => {
    expect(decodeGroupInvitation(encodeGroupInvitation(invitation))).toEqual(invitation);
  });

  it("changes the commitment for another circle, wallet or chain", () => {
    expect(groupInvitationCommitment({ ...invitation, vault: "0x3333333333333333333333333333333333333333" }))
      .not.toBe(invitation.commitment);
    expect(groupInvitationCommitment({ ...invitation, invitee: "0x4444444444444444444444444444444444444444" }))
      .not.toBe(invitation.commitment);
    expect(groupInvitationCommitment({ ...invitation, chainId: 1n }))
      .not.toBe(invitation.commitment);
  });

  it("rejects malformed or short secrets", () => {
    expect(() => decodeGroupInvitation("LIC1.invalid")).toThrow("Invalid invitation code");
  });
});
