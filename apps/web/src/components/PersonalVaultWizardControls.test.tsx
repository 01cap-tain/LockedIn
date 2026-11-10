// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";

import {
  allocationAmounts,
  EmergencyAllocationSlider,
  nextPersonalCreationStep,
  personalCreationStepReady,
  PersonalVaultReview,
  VaultModePreview,
  wizardProgressPercent,
  WizardProgressRing,
} from "./PersonalVaultWizardControls";

class ResizeObserverStub {
  observe() {}
  unobserve() {}
  disconnect() {}
}

globalThis.ResizeObserver = ResizeObserverStub as typeof ResizeObserver;
afterEach(cleanup);

describe("personal vault wizard controls", () => {
  it("derives circular progress from forward and backward step state", () => {
    expect([0, 1, 2, 3, 4].map((step) => wizardProgressPercent(step))).toEqual([0, 20, 40, 60, 100]);
    expect(wizardProgressPercent(3)).toBe(60);
    expect(wizardProgressPercent(1)).toBe(20);
  });

  it("renders one accessible SVG progress ring without visible step copy", () => {
    const { container } = render(<WizardProgressRing step={2} stepTitle="Schedule" />);
    expect(screen.getByLabelText("Step 3 of 5: Schedule")).toBeTruthy();
    expect(container.querySelectorAll("svg")).toHaveLength(1);
    expect(container.textContent).toBe("");
  });

  it("calculates the emergency and locked amounts from the goal", () => {
    expect(allocationAmounts(500, 10)).toEqual({ emergencyAmount: 50, lockedAmount: 450 });
    expect(allocationAmounts(500, 15)).toEqual({ emergencyAmount: 75, lockedAmount: 425 });
  });

  it("keeps the Radix slider controlled at its minimum and supports keyboard input", async () => {
    const user = userEvent.setup();
    const onChange = vi.fn();
    render(<EmergencyAllocationSlider value={10} goal={200} onChange={onChange} formatAmount={String} />);
    const slider = screen.getByRole("slider", { name: "Emergency allocation percentage" });
    expect(slider.getAttribute("aria-valuemin")).toBe("10");
    expect(slider.getAttribute("aria-valuemax")).toBe("15");
    expect(slider.getAttribute("aria-valuenow")).toBe("10");
    slider.focus();
    await user.keyboard("{ArrowRight}");
    expect(onChange).toHaveBeenCalledWith(11);
  });

  it("renders Earn as legible but unavailable", () => {
    render(<VaultModePreview />);
    const earn = screen.getByRole("button", { name: /Earn/i });
    expect(earn.hasAttribute("disabled")).toBe(true);
    expect(earn.getAttribute("aria-disabled")).toBe("true");
    expect(screen.getByText("A future option to earn yield on your savings.")).toBeTruthy();
  });

  it("returns Review edits to the selected step without changing row values", () => {
    const onEdit = vi.fn();
    render(<PersonalVaultReview rows={[{ label: "Schedule", value: "20 USDT · weekly", step: 1 }]} onEdit={onEdit} />);
    fireEvent.click(screen.getByRole("button", { name: "Edit Schedule" }));
    expect(onEdit).toHaveBeenCalledWith(1);
    expect(screen.getByText("20 USDT · weekly")).toBeTruthy();
    expect(nextPersonalCreationStep(1, true)).toBe(4);
  });

  it("validates the proceed control from the current form values", () => {
    expect(personalCreationStepReady({ step: 1, target: 100, contribution: 0, hasEstimatedMaturity: false, maturityError: null })).toBe(false);
    expect(personalCreationStepReady({ step: 1, target: 100, contribution: 20, hasEstimatedMaturity: true, maturityError: null })).toBe(true);
    expect(personalCreationStepReady({ step: 2, target: 100, contribution: 20, hasEstimatedMaturity: true, maturityError: "Too soon" })).toBe(false);
  });
});
