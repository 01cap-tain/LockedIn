import { afterEach, describe, expect, it, vi } from "vitest";

import { copyText } from "./clipboard";

describe("invitation clipboard", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it("waits for the secure Clipboard API to succeed", async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    vi.stubGlobal("window", { isSecureContext: true });
    vi.stubGlobal("navigator", { clipboard: { writeText } });
    await copyText("K7M4PX");
    expect(writeText).toHaveBeenCalledWith("K7M4PX");
  });

  it("uses the selection fallback used by iOS webviews", async () => {
    const copy = vi.fn().mockReturnValue(true);
    const field = { value: "", readOnly: false, style: {}, setAttribute: vi.fn(), focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", { createElement: vi.fn(() => field), body: { appendChild: vi.fn() }, execCommand: copy, querySelector: vi.fn(() => null) });
    await copyText("https://lockedin.example/#/explore-circles?invite=K7M4PX");
    expect(copy).toHaveBeenCalledWith("copy");
    expect(document.querySelector("textarea")).toBeNull();
  });

  it("does not claim success when both clipboard paths fail", async () => {
    const field = { value: "", readOnly: false, style: {}, setAttribute: vi.fn(), focus: vi.fn(), select: vi.fn(), setSelectionRange: vi.fn(), remove: vi.fn() };
    vi.stubGlobal("window", { isSecureContext: false });
    vi.stubGlobal("navigator", {});
    vi.stubGlobal("document", { createElement: vi.fn(() => field), body: { appendChild: vi.fn() }, execCommand: vi.fn().mockReturnValue(false) });
    await expect(copyText("K7M4PX")).rejects.toThrow("ClipboardUnavailable");
  });
});
