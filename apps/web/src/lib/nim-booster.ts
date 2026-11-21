import type { Signer } from "ethers";

import type { ActivityItem, ExitListingSnapshot, VaultSummary } from "./contracts";
import { authenticatedFetch, responseError } from "./invitation-api";

export interface BoosterCampaign {
  id: string;
  name: string;
  status: "REGISTRATION" | "SCORING" | "CLOSED";
  winnerCount: number;
  rewardPerWinnerNim: number;
  totalRewardNim: number;
  rulesVersion: number;
  payoutEnabled: boolean;
}

export interface BoosterEntry {
  campaign_id: string;
  wallet_address: string;
  nimiq_address?: string;
  nimiq_address_verified?: boolean;
  status: "TRACKING" | "QUALIFIED" | "INELIGIBLE" | "WINNER" | "PAID";
  joined_at: string;
  updated_at: string;
}

export interface BoosterCriterion {
  id: "goal" | "progress" | "consistency" | "recent" | "retained";
  label: string;
  detail: string;
  met: boolean;
}

export interface BoosterQualification {
  score: number;
  eligible: boolean;
  criteria: BoosterCriterion[];
}

function apiBase(): string {
  return (import.meta.env.VITE_INDEXER_API_URL?.trim() || "").replace(/\/$/, "");
}

export function calculateBoosterQualification(
  vaults: VaultSummary[],
  activity: ActivityItem[],
  listings: ExitListingSnapshot[],
  now = new Date()
): BoosterQualification {
  const ownedGoals = vaults.filter((vault) => vault.isOriginalMember && vault.access === "owner");
  const bestProgress = ownedGoals.reduce(
    (maximum, vault) => Math.max(maximum, vault.progressPercent),
    0
  );
  const deposits = activity.filter((item) => item.title === "Savings added");
  const contributionDays = new Set(
    deposits.map((item) => item.timestamp.toISOString().slice(0, 10))
  ).size;
  const mostRecentDeposit = deposits.reduce<number | null>(
    (latest, item) => Math.max(latest ?? 0, item.timestamp.getTime()),
    null
  );
  const recent = mostRecentDeposit !== null
    && now.getTime() - mostRecentDeposit <= 14 * 24 * 60 * 60 * 1_000;
  const retained = ownedGoals.length > 0 && !ownedGoals.some((vault) =>
    listings.some((listing) =>
      listing.listing?.active
      && listing.listing.vault.toLowerCase() === vault.address.toLowerCase()
      && listing.listing.positionId === vault.positionId
    )
  );
  const schedulePoints = ownedGoals.some((vault) => vault.pace === "on-track" || vault.pace === "complete")
    ? 25
    : ownedGoals.length > 0
      ? 10
      : 0;
  const score = Math.min(40, contributionDays * 10)
    + schedulePoints
    + Math.min(15, Math.floor(bestProgress / 10) * 3)
    + (recent ? 10 : 0)
    + (retained ? 10 : 0);
  const criteria: BoosterCriterion[] = [
    {
      id: "goal",
      label: "Own a savings goal",
      detail: "Use a goal you created and still own.",
      met: ownedGoals.length > 0,
    },
    {
      id: "progress",
      label: "Reach 25% progress",
      detail: `${Math.min(100, bestProgress).toFixed(0)}% reached on your strongest goal.`,
      met: bestProgress >= 25,
    },
    {
      id: "consistency",
      label: "Save on four different days",
      detail: `${Math.min(4, contributionDays)} of 4 contribution days recorded.`,
      met: contributionDays >= 4,
    },
    {
      id: "recent",
      label: "Keep saving recently",
      detail: "Make at least one contribution within the last 14 days.",
      met: recent,
    },
    {
      id: "retained",
      label: "Keep the goal active",
      detail: "The participating position must not be listed or sold.",
      met: retained,
    },
  ];
  return {
    score: Math.min(100, score),
    eligible: score >= 70 && criteria.every((criterion) => criterion.met),
    criteria,
  };
}

export async function loadBoosterCampaign(): Promise<BoosterCampaign> {
  const response = await fetch(`${apiBase()}/api/booster/campaign`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await responseError(response, "The Booster campaign could not be loaded.");
  const result = await response.json() as { campaign: BoosterCampaign };
  return result.campaign;
}

export async function loadBoosterEntry(signer: Signer): Promise<BoosterEntry | null> {
  const response = await authenticatedFetch(signer, "/api/booster/entry");
  if (!response.ok) throw await responseError(response, "Your Booster entry could not be loaded.");
  const result = await response.json() as { entry: BoosterEntry | null };
  return result.entry;
}

export async function loadBoosterEntryStatus(address: string): Promise<BoosterEntry | null> {
  const response = await fetch(`${apiBase()}/api/booster/status/${encodeURIComponent(address)}`, {
    headers: { Accept: "application/json" },
  });
  if (!response.ok) throw await responseError(response, "Your Booster entry could not be loaded.");
  const result = await response.json() as { entry: BoosterEntry | null };
  return result.entry;
}

export async function enrollInBooster(
  signer: Signer,
  nimiqAddress: string
): Promise<BoosterEntry> {
  const response = await authenticatedFetch(signer, "/api/booster/entry", {
    method: "POST",
    body: JSON.stringify({ nimiqAddress }),
  });
  if (!response.ok) throw await responseError(response, "The Booster entry could not be created.");
  const result = await response.json() as { entry: BoosterEntry };
  return result.entry;
}
