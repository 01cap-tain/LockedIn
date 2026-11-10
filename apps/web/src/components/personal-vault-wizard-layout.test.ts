import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const css = readFileSync(new URL("../index.css", import.meta.url), "utf8");

describe("personal vault wizard mobile layout", () => {
  it("respects reduced-motion preferences for ring progress", () => {
    expect(css).toMatch(/prefers-reduced-motion:\s*reduce[\s\S]*?wizard-progress-ring-value[\s\S]*?transition:\s*none/);
  });

  it("keeps the fixed proceed control above the safe area", () => {
    expect(css).toMatch(/creation-wizard \.wizard-next-row[\s\S]*?env\(safe-area-inset-bottom\)/);
  });

  it("adds enough scroll padding so the proceed control cannot obscure content", () => {
    expect(css).toMatch(/creation-wizard \.creation-step-frame[\s\S]*?padding-bottom:\s*calc\(108px \+ env\(safe-area-inset-bottom\)\)/);
  });
});
