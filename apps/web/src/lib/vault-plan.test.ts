import { describe, expect, it } from "vitest";

import { calculatePlanProjection, calculateSavingsPace } from "./vault-plan";

describe("vault planning projections", () => {
  it("warns when a daily plan cannot reach its target", () => {
    const projection = calculatePlanProjection({
      target: 100,
      contributionAmount: 1,
      frequency: "daily",
      preferredDays: [],
      startDate: "2026-01-01",
      maturityDate: "2026-01-10",
    });
    expect(projection.plannedTotal).toBe(10);
    expect(projection.sufficient).toBe(false);
    expect(projection.requiredPerPeriod).toBe(10);
  });

  it("uses selected weekly contribution days", () => {
    const projection = calculatePlanProjection({
      target: 80,
      contributionAmount: 20,
      frequency: "weekly",
      preferredDays: [5],
      startDate: "2026-01-02",
      maturityDate: "2026-01-23",
    });
    expect(projection.plannedPeriods).toBe(4);
    expect(projection.plannedTotal).toBe(80);
    expect(projection.sufficient).toBe(true);
    expect(projection.estimatedCompletionDate?.getFullYear()).toBe(2026);
    expect(projection.estimatedCompletionDate?.getMonth()).toBe(0);
    expect(projection.estimatedCompletionDate?.getDate()).toBe(23);
  });

  it("caps the planned total at the vault target", () => {
    const projection = calculatePlanProjection({
      target: 200,
      contributionAmount: 20,
      frequency: "weekly",
      preferredDays: [1, 3, 5],
      startDate: "2026-01-02",
      maturityDate: "2026-01-30",
    });
    expect(projection.plannedPeriods).toBe(13);
    expect(projection.scheduledCapacity).toBe(260);
    expect(projection.plannedTotal).toBe(200);
    expect(projection.contributionsNeeded).toBe(10);
    expect(projection.sufficient).toBe(true);
  });

  it("reports a supportive behind-schedule recovery pace", () => {
    const pace = calculateSavingsPace({
      target: 100,
      deposited: 20,
      contributionAmount: 10,
      frequency: "daily",
      startDate: "2026-01-01",
      maturityDate: "2026-01-10",
      now: new Date("2026-01-05T12:00:00"),
    });
    expect(pace.status).toBe("behind");
    expect(pace.behindAmount).toBe(30);
    expect(pace.missedPeriods).toBe(3);
    expect(pace.requiredPerRemainingPeriod).toBe(16);
  });

  it("marks a reached target as completed", () => {
    const pace = calculateSavingsPace({
      target: 100,
      deposited: 100,
      startDate: "2026-01-01",
      maturityDate: "2026-02-01",
      now: new Date("2026-01-10T12:00:00"),
    });
    expect(pace.status).toBe("completed");
    expect(pace.nextSuggestedContribution).toBe(0);
  });
});
