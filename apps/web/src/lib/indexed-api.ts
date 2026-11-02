import { formatUnits, getAddress } from "ethers";

import type { ActivityItem, CompletedTrade, IndexedVaultReference } from "./contracts";

interface Page<T> {
  items: T[];
  nextBeforeBlock: string | number | null;
}

interface TradeRow {
  listing_id: string;
  vault_address: string;
  position_id: string;
  is_group: boolean;
  seller: string;
  provider: string;
  claim_value: string;
  discount_bps: number;
  saver_payout: string;
  provider_return: string;
  provider_fee: string;
  block_number: string;
  transaction_hash: string;
  recorded_at: string;
}

interface ActivityRow {
  id: string;
  block_number: string;
  transaction_hash: string;
  contract_address: string;
  event_name: string;
  payload: Record<string, string | number | boolean>;
  recorded_at: string;
}

interface ListingRow {
  listing_id: string;
  market_address: string;
}

export interface IndexedListingReference {
  listingId: bigint;
  marketAddress: string;
}

interface VaultRow {
  address: string;
  deployment_id: string;
}

export interface IndexedBatchNotice {
  chainId: number;
  deploymentId: string;
  fromBlock: number;
  toBlock: number;
  events: Array<{
    blockNumber: number;
    transactionHash: string;
    contractAddress: string;
    eventName: string;
    payload: Record<string, string | number | boolean>;
  }>;
}

function apiBase(): string | null {
  const configured = import.meta.env.VITE_INDEXER_API_URL?.trim();
  return configured ? configured.replace(/\/$/, "") : null;
}

export function indexedApiAvailable(): boolean {
  return apiBase() !== null;
}

async function fetchJson<T>(path: string): Promise<T> {
  const base = apiBase();
  if (base === null) throw new Error("The indexed API is not configured.");
  const controller = new AbortController();
  const timeout = window.setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(`${base}${path}`, {
      headers: { Accept: "application/json" },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(`Indexed API returned ${response.status}.`);
    return await response.json() as T;
  } finally {
    window.clearTimeout(timeout);
  }
}

async function loadPages<T>(path: string, maximumPages = 10): Promise<T[]> {
  const rows: T[] = [];
  let beforeBlock: string | number | null = null;
  const seenCursors = new Set<string>();
  for (let page = 0; page < maximumPages; page += 1) {
    const separator = path.includes("?") ? "&" : "?";
    const cursor: string = beforeBlock === null ? "" : `${separator}beforeBlock=${beforeBlock}`;
    const result: Page<T> = await fetchJson<Page<T>>(`${path}${cursor}`);
    rows.push(...result.items);
    if (result.items.length < 100 || result.nextBeforeBlock === null) break;
    const next = String(result.nextBeforeBlock);
    if (seenCursors.has(next)) break;
    seenCursors.add(next);
    beforeBlock = result.nextBeforeBlock;
  }
  return rows;
}

export function mapIndexedTrade(row: TradeRow): CompletedTrade {
  const saverPayout = BigInt(row.saver_payout);
  const providerFee = BigInt(row.provider_fee);
  return {
    listingId: BigInt(row.listing_id),
    vault: getAddress(row.vault_address),
    positionId: BigInt(row.position_id),
    isGroup: row.is_group,
    seller: getAddress(row.seller),
    provider: getAddress(row.provider),
    claimValue: formatUnits(row.claim_value, 6),
    systemDiscountPercent: Number(row.discount_bps) / 100,
    saverPayout: formatUnits(saverPayout, 6),
    providerPotentialReturn: formatUnits(row.provider_return, 6),
    providerFee: formatUnits(providerFee, 6),
    totalProviderPaid: formatUnits(saverPayout + providerFee, 6),
    blockNumber: Number(row.block_number),
    transactionHash: row.transaction_hash,
    timestamp: new Date(row.recorded_at),
  };
}

export async function loadIndexedTrades(wallet?: string): Promise<CompletedTrade[]> {
  const walletQuery = wallet ? `&wallet=${encodeURIComponent(wallet)}` : "";
  const rows = await loadPages<TradeRow>(`/api/market/trades?limit=100${walletQuery}`);
  return rows.map(mapIndexedTrade);
}

const activityLabels: Record<string, [string, string]> = {
  VaultCreated: ["Savings vault created", "A new savings goal was created."],
  Deposited: ["Savings added", "Funds were added to this savings goal."],
  EmergencyWithdrawn: ["Emergency savings withdrawn", "Emergency funds returned to the saver."],
  LockedWithdrawn: ["Savings unlocked", "Matured locked savings were withdrawn."],
  ListingCreated: ["Exit requested", "A savings position was listed for an early exit."],
  ListingCancelled: ["Exit cancelled", "The early-exit request was cancelled."],
  ListingFunded: ["Exit completed", "A provider funded the exit and received the locked claim."],
  PositionTransferred: ["Savings claim transferred", "Ownership of the locked claim changed."],
  GroupExitRequested: ["Group exit requested", "A member requested a cooperative early exit."],
  GroupExitApproved: ["Group exit approved", "A member approved the cooperative exit."],
  GroupExitCompleted: ["Group exit completed", "The cooperative exit was completed."],
};

export function mapIndexedActivity(row: ActivityRow): ActivityItem {
  const [title, detail] = activityLabels[row.event_name] ?? [
    row.event_name.replace(/([a-z])([A-Z])/g, "$1 $2"),
    "Confirmed on Polygon.",
  ];
  const payloadVault = typeof row.payload.vault === "string" ? row.payload.vault : undefined;
  const member = typeof row.payload.member === "string"
    ? row.payload.member
    : typeof row.payload.owner === "string"
      ? row.payload.owner
      : undefined;
  const amount = typeof row.payload.amount === "string"
    ? formatUnits(row.payload.amount, 6)
    : undefined;
  return {
    id: row.id,
    blockNumber: Number(row.block_number),
    transactionHash: row.transaction_hash,
    title,
    detail,
    vault: payloadVault ?? row.contract_address,
    member,
    amount,
    timestamp: new Date(row.recorded_at),
  };
}

export async function loadIndexedActivity(wallet: string): Promise<ActivityItem[]> {
  const rows = await loadPages<ActivityRow>(
    `/api/wallets/${encodeURIComponent(wallet)}/history?limit=100`,
  );
  return rows.map(mapIndexedActivity);
}

export async function loadIndexedActiveListingIds(): Promise<IndexedListingReference[]> {
  const rows = await loadPages<ListingRow>("/api/market/listings?status=ACTIVE&limit=100");
  return rows.map((row) => ({
    listingId: BigInt(row.listing_id),
    marketAddress: getAddress(row.market_address),
  }));
}

export async function loadIndexedMemberVaults(wallet: string): Promise<IndexedVaultReference[]> {
  const rows = await loadPages<VaultRow>(
    `/api/vaults?limit=100&role=member&wallet=${encodeURIComponent(wallet)}`,
  );
  return rows.map((row) => ({ address: row.address, deploymentId: row.deployment_id }));
}

export function subscribeToIndexedBatches(
  onBatch: (batch: IndexedBatchNotice) => void,
  onConnectionChange?: (connected: boolean) => void,
): () => void {
  const base = apiBase();
  if (base === null || typeof EventSource === "undefined") return () => undefined;
  const source = new EventSource(`${base}/api/events`);
  source.addEventListener("ready", () => onConnectionChange?.(true));
  source.addEventListener("indexed", (event) => {
    try {
      onBatch(JSON.parse((event as MessageEvent<string>).data) as IndexedBatchNotice);
    } catch {
      // A malformed optional update cannot replace the durable API response.
    }
  });
  source.onerror = () => onConnectionChange?.(false);
  return () => source.close();
}
