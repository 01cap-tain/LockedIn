import { describe, expect, it } from "vitest";

import {
  saveLocalUsername,
  walletAvatarLabel,
  walletDisplayName,
  walletFallbackName,
} from "./user-profile";

describe("local user profiles", () => {
  it("uses the first wallet characters until a username is set", () => {
    expect(walletFallbackName("0x7348ab00")).toBe("0x734");
    expect(walletFallbackName(null)).toBe("Connect wallets");
  });

  it("normalizes and bounds a chosen username", () => {
    expect(saveLocalUsername("0x123", "  Ada    Saver  ")).toBe("Ada Saver");
    expect(saveLocalUsername("0x123", "x".repeat(40))).toHaveLength(24);
  });

  it("uses saved names and initials anywhere a participant is displayed", () => {
    expect(walletDisplayName("0xea123", "Ella Adams")).toBe("Ella Adams");
    expect(walletAvatarLabel("0xea123", "Ella Adams")).toBe("EA");
    expect(walletAvatarLabel("0x734abc")).toBe("73");
  });
});
