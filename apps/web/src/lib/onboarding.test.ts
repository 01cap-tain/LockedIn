import { describe, expect, it } from "vitest";
import {
  markOnboardingComplete,
  onboardingIsComplete,
  onboardingStorageKey,
} from "./onboarding";

function memoryStorage() {
  const values = new Map<string, string>();
  return {
    getItem: (key: string) => values.get(key) ?? null,
    setItem: (key: string, value: string) => values.set(key, value),
  };
}

describe("onboarding persistence", () => {
  it("scopes completion to the deployment, chain and wallet", () => {
    const storage = memoryStorage();
    const chain = "0x89";
    const wallet = "0xABC";
    const deployment = "0xDEF";

    expect(onboardingIsComplete(storage, chain, wallet, deployment)).toBe(false);
    markOnboardingComplete(storage, chain, wallet, deployment);
    expect(onboardingIsComplete(storage, chain, wallet, deployment)).toBe(true);
    expect(onboardingIsComplete(storage, chain, "0x123", deployment)).toBe(false);
    expect(onboardingStorageKey(chain, wallet, deployment)).toContain("0x89:0xdef:0xabc");
  });
});
