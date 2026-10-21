export type ContributionFrequency = "daily" | "weekly" | "monthly" | "custom";
export type SavingsPaceStatus = "ahead" | "on-track" | "behind" | "completed";

export interface VaultPlanPreferences {
  version: 1;
  owner: string;
  vaultName: string;
  purpose: string;
  contributionAmount: number | null;
  frequency: ContributionFrequency;
  preferredDays: number[];
  startDate: string;
  maturityDate: string;
  savedAt: string;
}

export interface PlanProjection {
  plannedPeriods: number;
  plannedTotal: number;
  scheduledCapacity: number;
  contributionsNeeded: number | null;
  requiredPerPeriod: number;
  estimatedCompletionDate: Date | null;
  sufficient: boolean;
}

export interface PaceProjection {
  status: SavingsPaceStatus;
  expectedAmount: number;
  behindAmount: number;
  missedPeriods: number;
  requiredPerRemainingPeriod: number;
  remainingDays: number;
  nextSuggestedContribution: number;
}

export type StoredVaultPlans = Record<string, VaultPlanPreferences>;

const STORAGE_KEY = "lockedin-vault-plans-v1";
const DAY_MS = 86_400_000;

function validDate(value: string | Date): Date {
  const date = value instanceof Date ? value : new Date(value);
  return Number.isNaN(date.getTime()) ? new Date(0) : date;
}

function startOfDay(value: string | Date): Date {
  const date = validDate(value);
  return new Date(date.getFullYear(), date.getMonth(), date.getDate());
}

function scheduledDates(
  startValue: string | Date,
  maturityValue: string | Date,
  frequency: ContributionFrequency,
  preferredDays: number[]
): Date[] {
  const start = startOfDay(startValue);
  const maturity = startOfDay(maturityValue);
  if (maturity < start) return [];
  const dates: Date[] = [];

  if (frequency === "monthly") {
    const contributionDay = start.getDate();
    let cursor = new Date(start);
    while (cursor <= maturity) {
      dates.push(new Date(cursor));
      const next = new Date(cursor.getFullYear(), cursor.getMonth() + 1, 1);
      const finalDay = new Date(next.getFullYear(), next.getMonth() + 1, 0).getDate();
      cursor = new Date(next.getFullYear(), next.getMonth(), Math.min(contributionDay, finalDay));
    }
    return dates;
  }

  const selectedDays = new Set(preferredDays);
  for (let cursor = new Date(start); cursor <= maturity; cursor = new Date(cursor.getTime() + DAY_MS)) {
    if (
      frequency === "daily" ||
      ((frequency === "weekly" || frequency === "custom") &&
        (selectedDays.size === 0 ? cursor.getDay() === start.getDay() : selectedDays.has(cursor.getDay())))
    ) {
      dates.push(new Date(cursor));
    }
  }
  return dates;
}

export function calculatePlanProjection(input: {
  target: number;
  contributionAmount: number | null;
  frequency: ContributionFrequency;
  preferredDays: number[];
  startDate: string | Date;
  maturityDate: string | Date;
}): PlanProjection {
  const dates = scheduledDates(
    input.startDate,
    input.maturityDate,
    input.frequency,
    input.preferredDays
  );
  const amount = Math.max(0, input.contributionAmount ?? 0);
  const target = Math.max(0, input.target);
  const scheduledCapacity = dates.length * amount;
  // The vault rejects deposits above its target. Present the amount the saver
  // can actually contribute, while retaining schedule capacity for explanation.
  const plannedTotal = Math.min(target, scheduledCapacity);
  const requiredPerPeriod = dates.length > 0 ? target / dates.length : target;
  const periodsNeeded = amount > 0 ? Math.ceil(target / amount) : Number.POSITIVE_INFINITY;
  return {
    plannedPeriods: dates.length,
    plannedTotal,
    scheduledCapacity,
    contributionsNeeded: Number.isFinite(periodsNeeded) ? periodsNeeded : null,
    requiredPerPeriod,
    estimatedCompletionDate:
      Number.isFinite(periodsNeeded) && periodsNeeded > 0 && periodsNeeded <= dates.length
        ? dates[periodsNeeded - 1] ?? null
        : null,
    sufficient: target > 0 && scheduledCapacity >= target,
  };
}

export function calculateSavingsPace(input: {
  target: number;
  deposited: number;
  startDate: string | Date;
  maturityDate: string | Date;
  contributionAmount?: number | null;
  frequency?: ContributionFrequency;
  preferredDays?: number[];
  now?: Date;
}): PaceProjection {
  const target = Math.max(0, input.target);
  const deposited = Math.max(0, input.deposited);
  const start = startOfDay(input.startDate);
  const maturity = startOfDay(input.maturityDate);
  const now = startOfDay(input.now ?? new Date());
  const frequency = input.frequency ?? "daily";
  const preferredDays = input.preferredDays ?? [];
  const allDates = scheduledDates(start, maturity, frequency, preferredDays);
  const elapsedDates = allDates.filter((date) => date <= now);
  const remainingDates = allDates.filter((date) => date > now);
  const elapsedRatio = allDates.length === 0 ? 1 : Math.min(1, elapsedDates.length / allDates.length);
  const expectedAmount = Math.min(target, target * elapsedRatio);
  const behindAmount = Math.max(0, expectedAmount - deposited);
  const contribution = Math.max(0, input.contributionAmount ?? 0);
  const completedPeriods = contribution > 0 ? Math.floor(deposited / contribution) : elapsedDates.length;
  const missedPeriods = Math.max(0, elapsedDates.length - completedPeriods);
  const remainingPeriodCount = Math.max(1, remainingDates.length);
  const requiredPerRemainingPeriod = Math.max(0, target - deposited) / remainingPeriodCount;
  const remainingDays = Math.max(0, Math.ceil((maturity.getTime() - now.getTime()) / DAY_MS));
  const tolerance = Math.max(0.000001, target * 0.005);
  const status: SavingsPaceStatus =
    deposited >= target
      ? "completed"
      : deposited > expectedAmount + tolerance
        ? "ahead"
        : deposited + tolerance >= expectedAmount
          ? "on-track"
          : "behind";
  return {
    status,
    expectedAmount,
    behindAmount,
    missedPeriods,
    requiredPerRemainingPeriod,
    remainingDays,
    nextSuggestedContribution: Math.min(
      Math.max(0, target - deposited),
      Math.max(contribution, requiredPerRemainingPeriod)
    ),
  };
}

export function vaultPlanKey(chainId: string, address: string, positionId: bigint): string {
  return `${chainId.toLowerCase()}:${address.toLowerCase()}:${positionId.toString()}`;
}

export function loadVaultPlans(): StoredVaultPlans {
  if (typeof window === "undefined") return {};
  try {
    const parsed = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    return parsed && typeof parsed === "object" ? parsed as StoredVaultPlans : {};
  } catch {
    return {};
  }
}

export function saveVaultPlan(
  key: string,
  plan: VaultPlanPreferences,
  current: StoredVaultPlans = loadVaultPlans()
): StoredVaultPlans {
  const next = { ...current, [key]: plan };
  if (typeof window !== "undefined") {
    try {
      window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next));
    } catch {
      // Planning metadata must never make a confirmed contract transaction
      // appear to have failed when browser storage is blocked or full.
    }
  }
  return next;
}
