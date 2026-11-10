// @vitest-environment jsdom

import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { afterEach, describe, expect, it, vi } from "vitest";
import { useState } from "react";
import { ONBOARDING_STEPS, OnboardingGuide } from "./OnboardingGuide";

afterEach(cleanup);

function GuideHarness({ onFinish = vi.fn() }: { onFinish?: () => void }) {
  const [step, setStep] = useState(0);
  return <OnboardingGuide onFinish={onFinish} onStepChange={setStep} step={step} />;
}

describe("OnboardingGuide", () => {
  it("moves forward, backward and reports segmented progress", async () => {
    const user = userEvent.setup();
    const { container } = render(<GuideHarness />);

    expect(screen.getByRole("heading", { name: "Your savings, in one view." })).toBeTruthy();
    expect(container.querySelectorAll(".onboarding-progress i")).toHaveLength(ONBOARDING_STEPS.length);
    expect(container.querySelectorAll(".onboarding-progress i.active")).toHaveLength(1);

    await user.click(screen.getByRole("button", { name: /continue/i }));
    expect(screen.getByRole("heading", { name: "Start from one place." })).toBeTruthy();
    expect(container.querySelectorAll(".onboarding-progress i.active")).toHaveLength(2);

    await user.click(screen.getByRole("button", { name: /previous onboarding step/i }));
    expect(screen.getByRole("heading", { name: "Your savings, in one view." })).toBeTruthy();
  });

  it("supports keyboard and swipe navigation", () => {
    render(<GuideHarness />);
    const dialog = screen.getByRole("dialog");

    fireEvent.keyDown(dialog, { key: "ArrowRight" });
    expect(screen.getByRole("heading", { name: "Start from one place." })).toBeTruthy();

    fireEvent.touchStart(dialog, { changedTouches: [{ clientX: 220 }] });
    fireEvent.touchEnd(dialog, { changedTouches: [{ clientX: 110 }] });
    expect(screen.getByRole("heading", { name: "Every plan has its place." })).toBeTruthy();

    fireEvent.keyDown(dialog, { key: "ArrowLeft" });
    expect(screen.getByRole("heading", { name: "Start from one place." })).toBeTruthy();
  });

  it("allows skipping and completes from the final step", async () => {
    const user = userEvent.setup();
    const onSkip = vi.fn();
    const first = render(<GuideHarness onFinish={onSkip} />);
    await user.click(screen.getByRole("button", { name: /^skip$/i }));
    expect(onSkip).toHaveBeenCalledOnce();
    first.unmount();

    const onFinish = vi.fn();
    render(
      <OnboardingGuide
        onFinish={onFinish}
        onStepChange={vi.fn()}
        step={ONBOARDING_STEPS.length - 1}
      />
    );
    await user.click(screen.getByRole("button", { name: /get started/i }));
    expect(onFinish).toHaveBeenCalledOnce();
  });
});
