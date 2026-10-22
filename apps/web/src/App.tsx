import { lazy, Suspense, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import {
  acceptGroupInvitation,
  activateGroup,
  approveGroupExit,
  authorizeGroupExit,
  cancelExitListing,
  cancelGroupExit,
  cancelUnactivatedGroup,
  completeGroupExit,
  createExitListing,
  createVault,
  depositToVault,
  declineGroupInvitation,
  describeContractError,
  loadActivity,
  loadAllExitListings,
  loadPublicCompletedTrades,
  loadPublicGroups,
  joinPublicGroup,
  loadExitListing,
  fundExitListing,
  groupCreationUnsupportedReason,
  loadExitMarket,
  loadGroupExitRequests,
  loadMockUsdtBalance,
  loadUsdtBalance,
  loadUsdtBalanceUnits,
  loadVault,
  loadVaultsForSigner,
  requestMockUsdt,
  requestGroupExit,
  revokeGroupExitApproval,
  withdrawEmergency,
  withdrawLocked,
  verifyDeployment,
  type ActivityItem,
  type CompletedTrade,
  type CreateVaultInput,
  type ExitListingSnapshot,
  type GroupExitRequestSnapshot,
  type VaultSnapshot,
  type VaultSummary,
  type PublicGroupSummary,
  type DeploymentVerification,
} from "./lib/contracts";
import { loadNimBalance } from "./lib/nim-balance";
import { NimSwapFlow } from "./components/NimSwapFlow";
import { createConfiguredMockSwapAdapter } from "./swap/mock-swap-adapter";
import { formatAssetAmount, parseAssetAmount } from "./swap/amounts";
import {
  connectEvmWallet,
  getInjectedEvmProvider,
  listDevelopmentAccounts,
  watchEvmWallet,
  type EvmWalletSession,
} from "./lib/evm-wallet";
import {
  connectNimiqWallet,
  describeWalletError,
  type WalletConnection,
} from "./lib/nimiq";
import { SavingsCalendar } from "./components/SavingsCalendar";
import { GroupCashAnimation } from "./components/GroupCashAnimation";
import { LoadingAnimation } from "./components/LoadingAnimation";
import {
  calculatePlanProjection,
  calculateSavingsPace,
  estimatePlanMaturity,
  loadVaultPlans,
  saveVaultPlan,
  vaultPlanKey,
  type ContributionFrequency,
  type SavingsPaceStatus,
  type VaultPlanPreferences,
} from "./lib/vault-plan";
import {
  loadLocalUsername,
  saveLocalUsername,
  walletAvatarLabel,
  walletDisplayName,
  walletFallbackName,
} from "./lib/user-profile";
import {
  ArrowRight,
  BadgeCheck,
  CalendarDays,
  Check,
  CircleCheckBig,
  CircleDollarSign,
  ClockAlert,
  Compass,
  Gift,
  HandCoins,
  History,
  Home,
  Landmark,
  LockKeyhole,
  LogOut,
  Menu,
  Plus,
  RefreshCw,
  Target,
  TrendingUp,
  Trophy,
  UserRound,
  UsersRound,
  Vault,
  WalletCards,
  X,
} from "lucide-react";

type AppRoute = "discover" | "vaults" | "position" | "groups" | "market" | "rewards" | "activity" | "wallet";
type VaultDetailTab = "overview" | "circle" | "withdraw" | "activity";
type NimiqState =
  | { status: "idle" | "connecting" }
  | { status: "connected"; wallet: WalletConnection }
  | { status: "error"; message: string };
type EvmState =
  | { status: "idle" | "connecting" }
  | { status: "connected"; session: EvmWalletSession }
  | { status: "error"; message: string };
type TransactionState =
  | { status: "idle" }
  | { status: "pending" | "success" | "error"; message: string };
type CreatedVaultReceipt = {
  address: string;
  vaultType: "personal" | "group";
  yieldMode: "safe" | "earn";
};
type DeploymentState =
  | { status: "idle" | "checking" }
  | { status: "valid"; value: DeploymentVerification }
  | { status: "error"; message: string };
type ListingFilter = "all" | "personal" | "group";
type MarketView = "fund" | "mine" | "recent";
type HistoryView = "trades" | "events";
type VaultView = "active" | "sold";
type CelebrationState = {
  title: string;
  message: string;
};
type CachedPublicGroup = Omit<PublicGroupSummary, "maturity" | "enrollmentDeadline" | "members"> & {
  maturity: string;
  enrollmentDeadline: string;
  members: Array<
    Omit<PublicGroupSummary["members"][number], "positionId"> & {
      positionId: string;
    }
  >;
};

const PUBLIC_GROUP_CACHE_KEY = "lockedin-public-groups-v1";
const WEEK_DAYS = [
  { value: 1, label: "Mon" },
  { value: 2, label: "Tue" },
  { value: 3, label: "Wed" },
  { value: 4, label: "Thu" },
  { value: 5, label: "Fri" },
  { value: 6, label: "Sat" },
  { value: 0, label: "Sun" },
] as const;
const PROFILE_VAULT_TABS = ["personal", "group", "purchased", "listed"] as const;
const MARKET_TABS = ["fund", "mine", "recent"] as const;
const HISTORY_TABS = ["trades", "events"] as const;
const VAULT_DETAIL_TABS = ["overview", "circle", "withdraw", "activity"] as const;
const VAULT_VIEW_TABS = ["active", "sold"] as const;
const LISTING_FILTER_TABS = ["all", "personal", "group"] as const;
const CREATE_MODE_TABS = ["personal", "group"] as const;

const routes: Array<{ id: AppRoute; label: string }> = [
  { id: "discover", label: "Discover circles" },
  { id: "position", label: "My vaults" },
  { id: "groups", label: "Group vaults" },
  { id: "vaults", label: "Create vault" },
  { id: "market", label: "Early withdrawal" },
  { id: "rewards", label: "Rewards" },
  { id: "activity", label: "Transaction history" },
];

const secondaryRoutes: Array<{ id: AppRoute; label: string }> = [
  { id: "rewards", label: "Rewards" },
  { id: "activity", label: "Transaction history" },
  { id: "wallet", label: "Wallet & network" },
];

const routeIcons = {
  discover: Compass,
  position: Vault,
  groups: UsersRound,
  vaults: Plus,
  market: HandCoins,
  rewards: Gift,
  activity: History,
  wallet: WalletCards,
} as const;

// These screens are deliberately separate chunks: market and history reads can
// be RPC-heavy, and group management is unnecessary for personal vaults.
const MarketRoute = lazy(() =>
  import("./routes/MarketRoute").then((module) => ({ default: module.MarketRoute }))
);
const ActivityRoute = lazy(() =>
  import("./routes/ActivityRoute").then((module) => ({ default: module.ActivityRoute }))
);
const RewardsRoute = lazy(() =>
  import("./routes/RewardsRoute").then((module) => ({ default: module.RewardsRoute }))
);
const GroupManagementRoute = lazy(() =>
  import("./routes/GroupManagementRoute").then((module) => ({ default: module.GroupManagementRoute }))
);
const TradeCompletionAnimation = lazy(() =>
  import("./components/TradeCompletionAnimation").then((module) => ({
    default: module.TradeCompletionAnimation,
  }))
);
const SaverListingAnimation = lazy(() =>
  import("./components/SaverListingAnimation").then((module) => ({
    default: module.SaverListingAnimation,
  }))
);
function routeFromHash(): AppRoute {
  const value = window.location.hash.replace(/^#\/?/, "");
  return routes.some((route) => route.id === value) || value === "wallet"
    ? (value as AppRoute)
    : "discover";
}

function futureInput(days: number): string {
  const date = new Date(Date.now() + days * 86_400_000);
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset());
  return date.toISOString().slice(0, 16);
}

function short(value: string): string {
  return `${value.slice(0, 8)}…${value.slice(-6)}`;
}
function vaultType(isGroup: boolean): string {
  return isGroup ? "Group" : "Personal";
}

/** Adds predictable left/right touch navigation to any ordered tab group. */
function useSwipeTabs<T extends string>(
  tabs: readonly T[],
  active: T,
  onChange: (tab: T) => void
) {
  const touchStart = useRef<number | null>(null);
  return {
    onTouchStart: (event: React.TouchEvent<HTMLElement>) => {
      touchStart.current = event.changedTouches[0]?.clientX ?? null;
    },
    onTouchEnd: (event: React.TouchEvent<HTMLElement>) => {
      if (touchStart.current === null) return;
      const distance = (event.changedTouches[0]?.clientX ?? touchStart.current) - touchStart.current;
      touchStart.current = null;
      if (Math.abs(distance) < 42) return;
      const current = tabs.indexOf(active);
      const next = distance < 0
        ? Math.min(tabs.length - 1, current + 1)
        : Math.max(0, current - 1);
      if (next !== current) onChange(tabs[next]!);
    },
  };
}

function localDateInput(date = new Date()): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 10);
}

function localDateTimeInput(date: Date): string {
  const local = new Date(date.getTime() - date.getTimezoneOffset() * 60_000);
  return local.toISOString().slice(0, 16);
}

function amountLabel(value: number): string {
  return value.toLocaleString(undefined, { maximumFractionDigits: 2 });
}

function daysUntil(date: Date, now = Date.now()): number {
  return Math.max(0, Math.ceil((date.getTime() - now) / 86_400_000));
}

function PaceIcon({ status, size = 15 }: { status: SavingsPaceStatus; size?: number }) {
  if (status === "completed") return <Trophy aria-hidden="true" size={size} />;
  if (status === "ahead") return <TrendingUp aria-hidden="true" size={size} />;
  if (status === "behind") return <ClockAlert aria-hidden="true" size={size} />;
  return <CircleCheckBig aria-hidden="true" size={size} />;
}

function CurrencyToggle({
  value,
  onChange,
  nimDisabled = false,
}: {
  value: "nim" | "usdt";
  onChange: (value: "nim" | "usdt") => void;
  nimDisabled?: boolean;
}) {
  return (
    <div className={`currency-toggle ${value}`} role="radiogroup" aria-label="Currency">
      <button aria-checked={value === "nim"} disabled={nimDisabled} onClick={() => onChange("nim")} role="radio" type="button">NIM{nimDisabled && <small>Coming soon</small>}</button>
      <i aria-hidden="true" />
      <button aria-checked={value === "usdt"} onClick={() => onChange("usdt")} role="radio" type="button">USDT</button>
    </div>
  );
}

function QuickAmounts({ values, unit, value, onSelect }: { values: number[]; unit: string; value: string; onSelect: (value: string) => void }) {
  return (
    <div className="quick-amounts" aria-label={`Suggested ${unit} amounts`}>
      {values.slice(0, 3).map((amount) => (
        <button aria-pressed={Number(value) === amount} className={Number(value) === amount ? "selected" : ""} key={amount} onClick={() => onSelect(String(amount))} type="button">{amount} {unit}</button>
      ))}
    </div>
  );
}

/** A deterministic, privacy-safe visual derived from the public wallet address. */
function WalletIdenticon({ address }: { address: string }) {
  const seed = address.replace(/^0x/, "").slice(0, 9);
  return (
    <span className="wallet-identicon" aria-hidden="true">
      {Array.from({ length: 9 }, (_, index) => (
        <i
          className={parseInt(seed[index] ?? "0", 16) % 2 === 0 ? "active" : ""}
          key={index}
        />
      ))}
    </span>
  );
}

function TrustSummary({ earn = false }: { earn?: boolean }) {
  return (
    <aside className="trust-summary" aria-label="How your savings are protected">
      <LockKeyhole aria-hidden="true" size={17} />
      <div>
        <strong>Your funds follow the rules you choose.</strong>
        <span>
          The smart contract holds your savings. LockedIn Circle cannot withdraw
          your principal, and emergency savings remain available.
          {earn ? " Earn returns are variable and not guaranteed." : ""}
        </span>
      </div>
    </aside>
  );
}

/** Four savers visually feed one shared target without implying pooled ownership. */
function GroupPowerVisual({ group }: { group: PublicGroupSummary }) {
  const paths = [
    "M 42 38 C 92 38, 102 79, 160 90",
    "M 278 38 C 228 38, 218 79, 160 90",
    "M 42 142 C 92 142, 102 101, 160 90",
    "M 278 142 C 228 142, 218 101, 160 90",
  ];
  const visibleMembers = group.members.slice(0, 4);

  return (
    <div
      className="group-power-visual"
      aria-label={`${group.memberCount} participants powering a shared ${group.totalTarget} mUSDT goal`}
    >
      <svg aria-hidden="true" viewBox="0 0 320 180">
        {visibleMembers.map((member, index) => (
          <g key={`flow-${member.address}`}>
            <path className="power-line" d={paths[index]} />
            <circle className="power-pulse" r="3.5">
              <animateMotion
                begin={`${index * 0.35}s`}
                dur="2.4s"
                path={paths[index]}
                repeatCount="indefinite"
              />
            </circle>
          </g>
        ))}
      </svg>
      {visibleMembers.map((member, index) => (
        <span
          className={`power-member power-member-${index + 1}`}
          key={member.address}
          title={walletDisplayName(member.address)}
        >
          <b>{walletAvatarLabel(member.address)}</b>
          <i>
            <span style={{ width: `${member.progressPercent}%` }} />
          </i>
        </span>
      ))}
      <div className="cash-core">
        <GroupCashAnimation />
      </div>
      {group.memberCount > 4 && (
        <span className="power-more">+{group.memberCount - 4}</span>
      )}
    </div>
  );
}

function SwipeReviewInvitation({ onReview }: { onReview: () => void }) {
  const startX = useRef<number | null>(null);
  const moved = useRef(false);
  const currentOffset = useRef(0);
  const [offset, setOffset] = useState(0);

  function finishSwipe() {
    const completed = currentOffset.current >= 34;
    startX.current = null;
    currentOffset.current = 0;
    setOffset(0);
    if (completed) onReview();
  }

  return (
    <div className={`review-invitation-track ${offset > 0 ? "moving" : ""}`}>
      <button
        className="join-circle-button review-invitation"
        onClick={() => {
          if (!moved.current) onReview();
          moved.current = false;
        }}
        onPointerDown={(event) => {
          startX.current = event.clientX;
          moved.current = false;
          event.currentTarget.setPointerCapture(event.pointerId);
        }}
        onPointerMove={(event) => {
          if (startX.current === null) return;
          const distance = Math.max(0, Math.min(46, event.clientX - startX.current));
          if (distance > 4) moved.current = true;
          currentOffset.current = distance;
          setOffset(distance);
        }}
        onPointerUp={finishSwipe}
        onPointerCancel={() => {
          startX.current = null;
          moved.current = false;
          currentOffset.current = 0;
          setOffset(0);
        }}
        style={{ transform: `translateX(${offset}px)` }}
        type="button"
      >
        <span>Review invitation</span>
        <span className="invite-move-cue">Move <ArrowRight aria-hidden="true" size={16} /></span>
      </button>
    </div>
  );
}

/** Avoid flashing a loader for quick RPC calls; surface only genuinely slow work. */
function DelayedFunctionLoader({
  active,
  label,
}: {
  active: boolean;
  label: string;
}) {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    if (!active) {
      setVisible(false);
      return;
    }
    const timer = window.setTimeout(() => setVisible(true), 650);
    return () => window.clearTimeout(timer);
  }, [active]);

  if (!active || !visible) return null;
  return (
    <div className="slow-function-loader" role="status" aria-live="polite">
      <LoadingAnimation />
      <strong>{label}</strong>
      <span>Securing your savings update</span>
    </div>
  );
}

export function App() {
  const networkName = import.meta.env.VITE_NETWORK_NAME ?? "Local Hardhat";
  const explorerBaseUrl = import.meta.env.VITE_BLOCK_EXPLORER_URL?.replace(
    /\/$/,
    ""
  );
  const mockTokenFaucetEnabled =
    import.meta.env.VITE_ENABLE_MOCK_TOKEN_FAUCET === "true";
  const usesMockYieldAdapter =
    import.meta.env.VITE_YIELD_ADAPTER_KIND === "MockYieldAdapter" ||
    mockTokenFaucetEnabled;
  const developmentFallbackEnabled =
    import.meta.env.VITE_ENABLE_HARDHAT_FALLBACK === "true";
  const deploymentReady = import.meta.env.VITE_DEPLOYMENT_READY !== "false";
  // Temporary product switch: Polygon ownership is sufficient for app access.
  // Set VITE_REQUIRE_NIMIQ_CONNECTION=true to restore the dual-wallet gate.
  const nimiqConnectionRequired =
    import.meta.env.VITE_REQUIRE_NIMIQ_CONNECTION === "true";

  // Nimiq identity and EVM ownership are intentionally separate. Nimiq Pay
  // identifies the Mini App user, while only the EVM signer can own or move
  // an on-chain savings position.
  const [route, setRoute] = useState<AppRoute>(routeFromHash);
  const [nimiq, setNimiq] = useState<NimiqState>({ status: "idle" });
  const [evm, setEvm] = useState<EvmState>({ status: "idle" });
  const [transaction, setTransaction] = useState<TransactionState>({
    status: "idle",
  });
  const [deployment, setDeployment] = useState<DeploymentState>({
    status: "idle",
  });
  const [mode, setMode] = useState<"personal" | "group">("personal");
  const [yieldMode, setYieldMode] = useState<"safe" | "earn">("safe");
  const [createdVaultReceipt, setCreatedVaultReceipt] =
    useState<CreatedVaultReceipt | null>(null);
  const [earnRiskAccepted, setEarnRiskAccepted] = useState(false);
  const [withdrawalNeedsRetry, setWithdrawalNeedsRetry] = useState(false);
  const [target, setTarget] = useState("");
  const [maturity, setMaturity] = useState(() => futureInput(30));
  const [vaultName, setVaultName] = useState("");
  const [vaultPurpose, setVaultPurpose] = useState("");
  const [planContribution, setPlanContribution] = useState("");
  const [planFrequency, setPlanFrequency] = useState<ContributionFrequency>("monthly");
  const [preferredDays, setPreferredDays] = useState<number[]>([]);
  const [planStartDate, setPlanStartDate] = useState(() => localDateInput());
  const [vaultPlans, setVaultPlans] = useState(loadVaultPlans);
  const [emergencyPercent, setEmergencyPercent] = useState(10);
  const [maxParticipants, setMaxParticipants] = useState(8);
  const [groupVisibility, setGroupVisibility] = useState<"public" | "invite-only">("public");
  const [enrollmentDeadline, setEnrollmentDeadline] = useState(() => futureInput(7));
  const [joinTarget, setJoinTarget] = useState("100");
  const [joinContribution, setJoinContribution] = useState("");
  const [joinFrequency, setJoinFrequency] = useState<ContributionFrequency>("monthly");
  const [joinPreferredDays, setJoinPreferredDays] = useState<number[]>([]);
  const [joinEmergencyPercent, setJoinEmergencyPercent] = useState(10);
  const [joinPurpose, setJoinPurpose] = useState("");
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [depositAmount, setDepositAmount] = useState("");
  const [withdrawAmount, setWithdrawAmount] = useState("1");
  const [listings, setListings] = useState<ExitListingSnapshot[]>([]);
  const [exitState, setExitState] = useState<ExitListingSnapshot | null>(null);
  const [listingFilter, setListingFilter] = useState<ListingFilter>("all");
  const [marketView, setMarketView] = useState<MarketView>("fund");
  const [exitExpiration, setExitExpiration] = useState(() => futureInput(7));
  const [minimumPayout, setMinimumPayout] = useState("0");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [completedTrades, setCompletedTrades] = useState<CompletedTrade[]>([]);
  const [publicTradesError, setPublicTradesError] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState<HistoryView>("trades");
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [developmentAccounts, setDevelopmentAccounts] = useState<string[]>([]);
  const [mockTokenBalance, setMockTokenBalance] = useState<string | null>(null);
  const [nativeTokenBalance, setNativeTokenBalance] = useState<string | null>(null);
  const [nimBalanceLuna, setNimBalanceLuna] = useState<bigint | null>(null);
  const [depositAsset, setDepositAsset] = useState<"usdt" | "nim">("usdt");
  const [receiveAsset, setReceiveAsset] = useState<"usdt" | "nim">("usdt");
  const [purchaseAsset, setPurchaseAsset] = useState<"usdt" | "nim">("usdt");
  const [groupExitRequests, setGroupExitRequests] = useState<
    GroupExitRequestSnapshot[]
  >([]);
  // Public circle discovery deliberately works before wallet connection. The
  // factory remains the source of truth; this is not a second membership DB.
  const [publicGroups, setPublicGroups] = useState<PublicGroupSummary[]>([]);
  const [publicGroupsStatus, setPublicGroupsStatus] = useState<
    "loading" | "ready" | "error"
  >("loading");
  const [publicGroupsError, setPublicGroupsError] = useState<string | null>(null);
  const [menuOpen, setMenuOpen] = useState(false);
  const [profileOpen, setProfileOpen] = useState(false);
  const [profileUsername, setProfileUsername] = useState("");
  const [profileUsernameDraft, setProfileUsernameDraft] = useState("");
  const [editingProfileUsername, setEditingProfileUsername] = useState(false);
  const [connectionSheetOpen, setConnectionSheetOpen] = useState(false);
  const [pendingGroup, setPendingGroup] = useState<PublicGroupSummary | null>(null);
  const [profileVaultKind, setProfileVaultKind] = useState<"personal" | "group" | "purchased" | "listed">("personal");
  const [openingVault, setOpeningVault] = useState(false);
  const [portfolioLoading, setPortfolioLoading] = useState(false);
  const [marketPositionPickerOpen, setMarketPositionPickerOpen] = useState(false);
  const [vaultDetailTab, setVaultDetailTab] = useState<VaultDetailTab>("overview");
  const [vaultView, setVaultView] = useState<VaultView>("active");
  const [celebration, setCelebration] = useState<CelebrationState | null>(null);
  const [clock, setClock] = useState(Date.now());
  const mockSwapAdapter = useMemo(() => {
    try {
      return createConfiguredMockSwapAdapter();
    } catch {
      return null;
    }
  }, []);
  const profileTabSwipe = useSwipeTabs(PROFILE_VAULT_TABS, profileVaultKind, setProfileVaultKind);
  const marketTabSwipe = useSwipeTabs(MARKET_TABS, marketView, setMarketView);
  const historyTabSwipe = useSwipeTabs(HISTORY_TABS, historyView, setHistoryView);
  const vaultDetailSwipe = useSwipeTabs(VAULT_DETAIL_TABS, vaultDetailTab, setVaultDetailTab);
  const vaultViewSwipe = useSwipeTabs(VAULT_VIEW_TABS, vaultView, setVaultView);
  const listingFilterSwipe = useSwipeTabs(LISTING_FILTER_TABS, listingFilter, setListingFilter);
  const createModeSwipe = useSwipeTabs(CREATE_MODE_TABS, mode, setMode);

  const evmSession = evm.status === "connected" ? evm.session : null;
  const nimiqWallet = nimiq.status === "connected" ? nimiq.wallet : null;
  const profileWalletAddress = evmSession?.address ?? nimiqWallet?.address ?? null;
  const displayedUsername = profileUsername || walletFallbackName(profileWalletAddress);
  const walletAccessReady = Boolean(
    evmSession &&
    deployment.status === "valid" &&
    (!nimiqConnectionRequired || nimiqWallet)
  );
  const polygonSwapNetwork = evmSession?.chainId === "0x13882"
    ? "polygon-amoy" as const
    : evmSession?.chainId === "0x7a69"
      ? "local" as const
      : "polygon" as const;
  const swapAdapter =
    nimiq.status === "connected" && nimiq.wallet.network === "testnet"
      ? mockSwapAdapter
      : null;
  const nimWithdrawalAvailable = Boolean(swapAdapter && nimiqWallet && evmSession);
  const connectedAddress = evmSession?.address.toLowerCase();
  const connectedMember = snapshot?.members.find(
    (member) => member.member.toLowerCase() === connectedAddress
  );
  const actionsDisabled =
    !deploymentReady ||
    !evmSession ||
    deployment.status !== "valid" ||
    transaction.status === "pending";
  // A safety pause blocks only risk-increasing operations. Withdrawals,
  // cancellations and already-authorized exits intentionally remain usable.
  const riskActionsDisabled =
    actionsDisabled ||
    (deployment.status === "valid" && deployment.value.paused);
  const deploymentBlocked =
    !deploymentReady || deployment.status === "error";
  const publicGroupsSupported =
    deployment.status === "valid" &&
    deployment.value.protocolVersion === "lockedin-circle/0.8.0";
  const groupCreationBlockReason = deployment.status === "valid"
    ? groupCreationUnsupportedReason(
        deployment.value.protocolVersion,
        groupVisibility
      )
    : null;
  const estimatedMaturity = useMemo(
    () => estimatePlanMaturity({
      target: Number(target),
      contributionAmount: planContribution ? Number(planContribution) : null,
      frequency: planFrequency,
      preferredDays,
      startDate: planStartDate,
    }),
    [planContribution, planFrequency, planStartDate, preferredDays, target]
  );
  useEffect(() => {
    if (!estimatedMaturity) return;
    const nextMaturity = localDateTimeInput(estimatedMaturity);
    setMaturity(nextMaturity);
    const latestEnrollment = new Date(estimatedMaturity.getTime() - 86_400_000);
    if (new Date(enrollmentDeadline).getTime() >= estimatedMaturity.getTime()) {
      setEnrollmentDeadline(localDateTimeInput(latestEnrollment));
    }
  }, [estimatedMaturity, enrollmentDeadline]);
  const progress = snapshot
    ? Math.min(
        100,
        (Number(snapshot.deposited) / Number(snapshot.target)) * 100
      )
    : 0;
  const planProjection = useMemo(
    () =>
      calculatePlanProjection({
        target: Number(target),
        contributionAmount: planContribution ? Number(planContribution) : null,
        frequency: planFrequency,
        preferredDays,
        startDate: planStartDate,
        maturityDate: maturity,
      }),
    [maturity, planContribution, planFrequency, planStartDate, preferredDays, target]
  );
  const hasContributionPlan = Number(planContribution) > 0;
  const joinPlanProjection = useMemo(
    () => calculatePlanProjection({
      target: Number(joinTarget),
      contributionAmount: joinContribution ? Number(joinContribution) : null,
      frequency: joinFrequency,
      preferredDays: joinPreferredDays,
      startDate: localDateInput(),
      maturityDate: pendingGroup?.maturity ?? new Date(),
    }),
    [joinContribution, joinFrequency, joinPreferredDays, joinTarget, pendingGroup]
  );
  const selectedPlan = snapshot && evmSession
    ? vaultPlans[vaultPlanKey(evmSession.chainId, snapshot.address, snapshot.positionId)]
    : undefined;
  const selectedPace = snapshot
    ? calculateSavingsPace({
        target: Number(snapshot.target),
        deposited: Number(snapshot.deposited),
        startDate: selectedPlan?.startDate ?? snapshot.createdAt,
        maturityDate: snapshot.maturity,
        contributionAmount: selectedPlan?.contributionAmount,
        frequency: selectedPlan?.frequency,
        preferredDays: selectedPlan?.preferredDays,
      })
    : null;
  const remainingGoal = snapshot
    ? Math.max(0, Number(snapshot.target) - Number(snapshot.deposited))
    : 0;
  const depositDaysCloser = snapshot && Number(depositAmount) > 0
    ? Math.max(
        1,
        Math.round(
          Number(depositAmount) /
            Math.max(
              Number(snapshot.target) /
                Math.max(1, Math.ceil((snapshot.maturity.getTime() - snapshot.createdAt.getTime()) / 86_400_000)),
              0.000001
            )
        )
      )
    : 1;
  const depositAmountNumber = Number(depositAmount);
  const depositAmountError = snapshot && depositAmount !== ""
    ? !Number.isFinite(depositAmountNumber) || depositAmountNumber <= 0
      ? "Enter an amount greater than zero."
      : depositAmountNumber > remainingGoal + 0.0000001
        ? `This exceeds your goal. You can save up to ${amountLabel(remainingGoal)} mUSDT more.`
        : mockTokenBalance === null
          ? "Your USDT balance is still loading."
          : depositAmountNumber > Number(mockTokenBalance) + 0.0000001
            ? `Insufficient wallet funds. Available: ${mockTokenBalance} mUSDT.`
            : null
    : null;
  const withdrawAmountNumber = Number(withdrawAmount);
  const withdrawAmountError = snapshot && withdrawAmount !== ""
    ? !Number.isFinite(withdrawAmountNumber) || withdrawAmountNumber <= 0
      ? "Enter an amount greater than zero."
      : withdrawAmountNumber > Number(snapshot.emergencyBalance) + 0.0000001
        ? `Insufficient emergency funds. Available: ${snapshot.emergencyBalance} mUSDT.`
        : null
    : null;
  // These projections are display-only. EarlyExitMarket independently reads
  // live chain state and recalculates the quote inside the funding transaction.
  const systemDiscount = exitState?.reference.discountPercent ?? 4.5;
  const projectedSaverPayout = snapshot
    ? Number(snapshot.currentValue) * (1 - systemDiscount / 100)
    : 0;
  const projectedFee = projectedSaverPayout * 0.009;
  const selectedListing = exitState?.listing;
  const listingFundingError = selectedListing && purchaseAsset === "usdt"
    ? mockTokenBalance === null
      ? "Your USDT balance is still loading."
      : Number(selectedListing.currentTotalProviderPaid) > Number(mockTokenBalance) + 0.0000001
        ? `Insufficient wallet funds. This purchase requires ${selectedListing.currentTotalProviderPaid} mUSDT; you have ${mockTokenBalance} mUSDT.`
        : null
    : null;
  const activePositionKeys = useMemo(
    () =>
      new Set(
        listings
          .filter((entry) => entry.listing?.active)
          .map(
            (entry) =>
              `${entry.listing!.vault.toLowerCase()}:${entry.listing!.positionId.toString()}`
          )
      ),
    [listings]
  );
  const marketEligibleVaults = useMemo(
    () =>
      vaults.filter(
        (vault) =>
          vault.access === "owner" &&
          vault.isOriginalMember &&
          vault.maturity.getTime() > Date.now() &&
          !activePositionKeys.has(
            `${vault.address.toLowerCase()}:${vault.positionId.toString()}`
          )
      ),
    [activePositionKeys, vaults]
  );
  const canComposeListing = Boolean(
    snapshot &&
      snapshot.ownsLockedPosition &&
      snapshot.isOriginalMember &&
      (!snapshot.isGroup || snapshot.groupLifecycle === "active") &&
      (!selectedListing ||
        (!selectedListing.active &&
          selectedListing.vault === snapshot.address &&
          selectedListing.positionId === snapshot.positionId))
  );
  const filteredListings = useMemo(
    () =>
      listings.filter((entry) => {
        const listing = entry.listing;
        // Open Listings must never retain cancelled, expired or funded sales.
        if (!listing || !listing.active || listing.status !== "active")
          return false;
        if (marketView === "mine")
          return listing.seller.toLowerCase() === connectedAddress;
        if (marketView === "fund" && listing.seller.toLowerCase() === connectedAddress)
          return false;
        if (listingFilter === "personal") return !listing.isGroup;
        if (listingFilter === "group") return listing.isGroup;
        return true;
      }),
    [listings, listingFilter, connectedAddress, marketView]
  );
  const myActiveListings = useMemo(
    () =>
      listings.filter(
        (entry) =>
          entry.listing?.active &&
          entry.listing.seller.toLowerCase() === connectedAddress
      ),
    [connectedAddress, listings]
  );
  const ownActiveListing = Boolean(
    snapshot &&
      selectedListing?.active &&
      selectedListing.seller.toLowerCase() === connectedAddress &&
      selectedListing.vault.toLowerCase() === snapshot.address.toLowerCase() &&
      selectedListing.positionId === snapshot.positionId
  );
  const selectedVaultDeposits = useMemo(
    () =>
      snapshot
        ? activity.filter(
            (item) =>
              item.vault?.toLowerCase() === snapshot.address.toLowerCase() &&
              item.title === "Deposit confirmed"
          )
        : [],
    [activity, snapshot]
  );
  const selectedVaultActivity = useMemo(
    () =>
      snapshot
        ? activity.filter(
            (item) => item.vault?.toLowerCase() === snapshot.address.toLowerCase()
          )
        : [],
    [activity, snapshot]
  );
  // A completed settlement belongs in personal history for both sides of the
  // trade: the original saver and the provider who acquired the claim.
  const myCompletedTrades = useMemo(
    () =>
      completedTrades.filter(
        (trade) =>
          trade.seller.toLowerCase() === connectedAddress ||
          trade.provider.toLowerCase() === connectedAddress
      ),
    [completedTrades, connectedAddress]
  );
  const selectedCompletedTrade =
    myCompletedTrades.find(
      (trade) => trade.listingId.toString() === selectedTradeId
    ) ?? myCompletedTrades[0] ?? null;
  const soldPositions = completedTrades.filter(
    (trade) => trade.seller.toLowerCase() === connectedAddress
  );
  const visibleSoldPositions = soldPositions.filter(
    (trade) => route !== "groups" || trade.isGroup
  );
  const visibleVaults = vaults.filter(
    (vault) =>
      (route !== "groups" || vault.isGroup) &&
      // A saver who sold the locked claim keeps only emergency access. Keep
      // that record out of active goals and show the completed sale separately.
      vault.access === "owner"
  );

  useEffect(() => {
    const updateRoute = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  useEffect(() => {
    const username = loadLocalUsername(profileWalletAddress);
    setProfileUsername(username);
    setProfileUsernameDraft(username);
    setEditingProfileUsername(false);
  }, [profileWalletAddress]);

  useEffect(() => {
    if (route === "discover" || walletAccessReady) return;
    window.history.replaceState(null, "", "#/discover");
    setRoute("discover");
    setPendingGroup(null);
    setConnectionSheetOpen(true);
  }, [route, walletAccessReady]);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (transaction.status !== "success" && transaction.status !== "error")
      return;
    const timer = window.setTimeout(
      () => setTransaction({ status: "idle" }),
      3_000
    );
    return () => window.clearTimeout(timer);
  }, [transaction.status]);

  useEffect(() => {
    if (!deploymentReady) return;
    void refreshPublicTradeHistory();
    let hasFreshCache = false;
    try {
      const cached = JSON.parse(
        window.sessionStorage.getItem(PUBLIC_GROUP_CACHE_KEY) ?? "null"
      ) as { savedAt: number; groups: CachedPublicGroup[] } | null;
      if (cached) {
        setPublicGroups(
          cached.groups.map((group) => ({
            ...group,
            maturity: new Date(group.maturity),
            enrollmentDeadline: new Date(group.enrollmentDeadline),
            members: group.members.map((member) => ({
              ...member,
              positionId: BigInt(member.positionId),
            })),
          }))
        );
        setPublicGroupsStatus("ready");
        // Render the last successful catalogue immediately, then refresh it
        // without replacing the cards with a loading screen.
        hasFreshCache = true;
      }
    } catch {
      window.sessionStorage.removeItem(PUBLIC_GROUP_CACHE_KEY);
    }
    void refreshPublicGroups(!hasFreshCache);
  }, [deploymentReady, evmSession?.address]);

  useEffect(() => {
    // Account and network changes invalidate every address-scoped query. Clear
    // the previous portfolio before reconnecting so one wallet never sees
    // another wallet's cached positions in the interface.
    if (evm.status !== "connected" || evm.session.source !== "injected-wallet")
      return;
    const provider = getInjectedEvmProvider();
    if (!provider) return;
    return watchEvmWallet(provider, {
      onAccountsChanged: (accounts) => {
        clearPortfolio();
        if (accounts.length === 0)
          setEvm({ status: "error", message: "The EVM wallet disconnected." });
        else void connectEvm();
      },
      onChainChanged: () => {
        clearPortfolio();
        void connectEvm();
      },
    });
  }, [evm.status === "connected" ? evm.session.source : null]);

  useEffect(() => {
    // Establishing a wallet session and proving the configured deployment are
    // separate operations. Do not start contract reads until the latter has
    // succeeded; a transient RPC failure must not erase the wallet session.
    if (!evmSession || !deploymentReady || deployment.status !== "valid")
      return;
    void refreshPortfolio(evmSession).catch((error) =>
      setTransaction({ status: "error", message: describeContractError(error) })
    );
    if (evmSession.source === "hardhat-development") {
      void listDevelopmentAccounts()
        .then(setDevelopmentAccounts)
        .catch(() => setDevelopmentAccounts([]));
    }
  }, [evmSession?.address, evmSession?.chainId, deployment.status]);

  function clearPortfolio() {
    setVaults([]);
    setSnapshot(null);
    setListings([]);
    setExitState(null);
    setActivity([]);
    setSelectedTradeId(null);
    setMockTokenBalance(null);
    setGroupExitRequests([]);
    setCreatedVaultReceipt(null);
  }

  async function connectNimiq(): Promise<void> {
    setNimiq({ status: "connecting" });
    try {
      const wallet = await connectNimiqWallet();
      setNimiq({ status: "connected", wallet });
      setNimBalanceLuna(await loadNimBalance(wallet.address));
    } catch (error) {
      setNimiq({
        status: "error",
        message: describeWalletError(error).message,
      });
    }
  }

  async function connectEvm(developmentAccountIndex?: number): Promise<void> {
    clearPortfolio();
    setEvm({ status: "connecting" });
    setDeployment({ status: "idle" });
    let session: EvmWalletSession;
    try {
      session = await connectEvmWallet({
        // Supplying an index is an explicit local-only action. Production
        // connections must come from Nimiq Pay's injected EIP-1193 provider.
        // MetaMask and Nimiq Pay both expose the standard EIP-1193 interface.
        // Local unlocked accounts remain available only through the explicit
        // development-account selector below.
        provider:
          developmentAccountIndex === undefined
            ? getInjectedEvmProvider()
            : undefined,
        developmentAccountIndex,
        // The main connect action is always an injected wallet. A local
        // unlocked signer requires the explicit development action below.
        allowDevelopmentFallback: developmentAccountIndex !== undefined,
        forceDevelopmentFallback: developmentAccountIndex !== undefined,
      });
      setEvm({ status: "connected", session });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "EVM connection failed.";
      setEvm({
        status: "error",
        message,
      });
      return;
    }

    if (deploymentReady) await verifyConnectedDeployment(session);
  }

  async function verifyConnectedDeployment(
    session = requireSession()
  ): Promise<void> {
    setDeployment({ status: "checking" });
    try {
      const verified = await verifyDeployment(session.signer);
      setDeployment({ status: "valid", value: verified });
    } catch (error) {
      console.error("LockedIn deployment verification failed", error);
      setDeployment({
        status: "error",
        message: describeContractError(error),
      });
    }
  }

  function requireSession(): EvmWalletSession {
    if (!evmSession)
      throw new Error("Connect a supported EVM wallet before using contracts.");
    return evmSession;
  }

  async function refreshPortfolio(session = requireSession()): Promise<void> {
    // The chain remains authoritative. This MVP reconstructs the portfolio and
    // activity feed from contract views and events rather than trusting a DB.
    setPortfolioLoading(true);
    try {
      const nextVaults = await loadVaultsForSigner(
        session.signer,
        completedTrades
      );
      setVaults(nextVaults);

    // Market history, activity and faucet balances are secondary projections.
    // A temporary RPC/indexing failure must never make a confirmed transaction
    // look reverted or prevent the newly created vault from opening.
      const [listingsResult, activityResult, balanceResult, nativeBalanceResult] =
        await Promise.allSettled([
          loadAllExitListings(session.signer),
          loadActivity(
            session.signer,
            nextVaults.map((vault) => vault.address)
          ),
          loadUsdtBalance(session.signer),
          session.signer.provider?.getBalance(session.address) ?? Promise.reject(new Error("Wallet provider unavailable.")),
        ]);
      if (listingsResult.status === "fulfilled")
        setListings(listingsResult.value);
      if (activityResult.status === "fulfilled")
        setActivity(activityResult.value);
      if (balanceResult.status === "fulfilled")
        setMockTokenBalance(balanceResult.value);
      if (nativeBalanceResult.status === "fulfilled")
        setNativeTokenBalance(formatAssetAmount(nativeBalanceResult.value, 18));
      void refreshPublicTradeHistory();
      if (
        snapshot &&
        nextVaults.some(
          (vault) =>
            vault.address === snapshot.address &&
            vault.positionId === snapshot.positionId
        )
      )
        await openVault(snapshot.address, snapshot.positionId, session);
      else if (snapshot) {
        setSnapshot(null);
        setExitState(null);
        setGroupExitRequests([]);
      }
    } finally {
      setPortfolioLoading(false);
    }
  }

  async function refreshPublicTradeHistory(): Promise<void> {
    try {
      const trades = await loadPublicCompletedTrades();
      setCompletedTrades(trades);
      setPublicTradesError(null);
      // Public settlement history also discovers positions bought from savers.
      // Refresh only the compact vault index; do not rescan every activity log.
      if (evmSession && deployment.status === "valid")
        setVaults(await loadVaultsForSigner(evmSession.signer, trades));
    } catch (error) {
      console.error("Public trade history failed", error);
      setPublicTradesError(
        "Trade history is temporarily unavailable. Check the selected network and try again."
      );
    }
  }

  async function refreshPublicGroups(showLoading = true): Promise<void> {
    if (showLoading) setPublicGroupsStatus("loading");
    try {
      const groups = await loadPublicGroups(evmSession?.signer.provider);
      setPublicGroups(groups);
      window.sessionStorage.setItem(
        PUBLIC_GROUP_CACHE_KEY,
        JSON.stringify({
          savedAt: Date.now(),
          groups: groups.map((group) => ({
            ...group,
            maturity: group.maturity.toISOString(),
            enrollmentDeadline: group.enrollmentDeadline.toISOString(),
            members: group.members.map((member) => ({
              ...member,
              positionId: member.positionId.toString(),
            })),
          })),
        })
      );
      setPublicGroupsError(null);
      setPublicGroupsStatus("ready");
    } catch (error) {
      console.error("Public circle discovery failed", error);
      setPublicGroupsError(
        "Circle data is temporarily unavailable. Check the selected network and try again."
      );
      // Keep the last successfully read catalogue visible during transient RPC
      // failures. Cached discovery is informational; contract calls still
      // revalidate membership and capacity before any transaction.
      setPublicGroupsStatus(showLoading ? "error" : "ready");
    }
  }

  function disconnectWallets(): void {
    // EIP-1193 does not define a universal permission-revocation method.
    // Clearing app state is safe; the copy tells users where full revocation lives.
    clearPortfolio();
    setNimiq({ status: "idle" });
    setEvm({ status: "idle" });
    setDeployment({ status: "idle" });
    setNimBalanceLuna(null);
    setNativeTokenBalance(null);
    setProfileOpen(false);
    setConnectionSheetOpen(false);
    setTransaction({
      status: "success",
      message: "Wallets disconnected from this app. Revoke site access in the wallet to remove permissions completely.",
    });
  }

  function navigate(nextRoute: AppRoute): void {
    setMenuOpen(false);
    setProfileOpen(false);
    if (nextRoute !== "market" && route === "market") {
      setMarketPositionPickerOpen(false);
      setSnapshot(null);
      setExitState(null);
    }
    if (
      nextRoute !== "discover" &&
      !walletAccessReady
    ) {
      setPendingGroup(null);
      setConnectionSheetOpen(true);
      return;
    }
    window.location.hash = `#/${nextRoute}`;
  }

  function requestGroupJoin(group: PublicGroupSummary): void {
    if (!group.publicJoining) {
      setTransaction({
        status: "error",
        message: "This is an invite-only circle. Only wallet addresses invited by the circle creator can join.",
      });
      return;
    }
    if (!group.joiningOpen) {
      setTransaction({
        status: "error",
        message: group.memberCount >= group.maxMemberCount
          ? "This savings circle is full. No additional members can join."
          : "This circle is no longer accepting members because it is active or its enrollment deadline has passed.",
      });
      return;
    }
    setPendingGroup(group);
    setJoinTarget(group.creatorTarget || "100");
    setJoinContribution("");
    setJoinFrequency("monthly");
    setJoinPreferredDays([]);
    setJoinEmergencyPercent(10);
    setJoinPurpose("");
    setConnectionSheetOpen(true);
  }

  function continueToInvitedGroup(): void {
    if (!pendingGroup || !evmSession) return;
    const member = pendingGroup.members.find(
      (item) => item.address.toLowerCase() === evmSession.address.toLowerCase()
    );
    if (!member) {
      if (pendingGroup.publicJoining && pendingGroup.joiningOpen) {
        const group = pendingGroup;
        setConnectionSheetOpen(false);
        void runTransaction(
          "Joining public savings circle…",
          async () => {
            const positionId = await joinPublicGroup(
              evmSession.signer,
              group.address,
              joinTarget,
              joinEmergencyPercent
            );
            const preferences: VaultPlanPreferences = {
              version: 1,
              owner: evmSession.address,
              vaultName: group.groupName,
              purpose: joinPurpose.trim(),
              contributionAmount: joinContribution ? Number(joinContribution) : null,
              frequency: joinFrequency,
              preferredDays: joinPreferredDays,
              startDate: localDateInput(),
              maturityDate: group.maturity.toISOString(),
              savedAt: new Date().toISOString(),
            };
            setVaultPlans((current) => saveVaultPlan(
              vaultPlanKey(evmSession.chainId, group.address, positionId),
              preferences,
              current
            ));
            await Promise.all([
              refreshPortfolio(evmSession),
              refreshPublicGroups(false),
            ]);
            navigate("groups");
            await openVault(group.address, positionId, evmSession);
          },
          "You joined the savings circle."
        );
        return;
      }
      setTransaction({
        status: "error",
        message: pendingGroup.publicJoining
          ? "This circle is full, active, or its enrollment deadline has passed."
          : "This circle has fixed on-chain invitations. The connected EVM address was not invited by its creator.",
      });
      setConnectionSheetOpen(false);
      return;
    }
    setConnectionSheetOpen(false);
    navigate("groups");
    void runTransaction(
      "Opening your group invitation…",
      () => openVault(pendingGroup.address, member.positionId),
      "Group invitation loaded."
    );
  }

  async function openVault(
    address: string,
    positionId?: bigint,
    session = requireSession()
  ): Promise<void> {
    setOpeningVault(true);
    let next: VaultSnapshot;
    try {
      next = await loadVault(session.signer, address, positionId);
      // Present principal, progress and ownership immediately. Secondary exit
      // history must never hold the visible vault sheet hostage.
      setSnapshot(next);
    } finally {
      setOpeningVault(false);
    }
    const [exitResult, groupExitResult] = await Promise.allSettled([
      loadExitMarket(session.signer, next),
      loadGroupExitRequests(session.signer, address),
    ]);
    const nextExit = exitResult.status === "fulfilled" ? exitResult.value : null;
    // Always replace position-scoped state. Keeping a previous vault's listing
    // here can hide the composer or present the wrong cancellation action.
    setExitState(nextExit);
    setGroupExitRequests(
      groupExitResult.status === "fulfilled" ? groupExitResult.value : []
    );
    // Start at the current system payout. The saver may lower this protection
    // floor, but neither the saver nor a provider can choose the discount.
    const defaultFloor =
      nextExit?.listing?.minimumPayout ??
      (
        Number(next.currentValue) *
        (1 - (nextExit?.reference.discountPercent ?? 4.5) / 100)
      ).toFixed(6);
    setMinimumPayout(defaultFloor);
  }

  async function runTransaction(
    message: string,
    action: () => Promise<void>,
    success: string,
    successCelebration?: CelebrationState
  ) {
    setTransaction({ status: "pending", message: "Checking wallet balance…" });
    try {
      await assertWalletCanAffordTransaction();
      setTransaction({ status: "pending", message });
      await action();
      setTransaction({ status: "success", message: success });
      if (successCelebration) setCelebration(successCelebration);
    } catch (error) {
      setTransaction({
        status: "error",
        message: describeContractError(error),
      });
    }
  }

  async function assertWalletCanAffordTransaction(
    session = requireSession()
  ): Promise<void> {
    const provider = session.signer.provider;
    if (!provider) throw new Error("The wallet network provider is unavailable.");
    const [balance, feeData] = await Promise.all([
      provider.getBalance(session.address),
      provider.getFeeData(),
    ]);
    const feePerGas = feeData.maxFeePerGas ?? feeData.gasPrice ?? 25_000_000_000n;
    // Covers the largest current vault-creation path. The wallet still performs
    // its exact estimate before signing; this check prevents futile prompts.
    const requiredReserve = feePerGas * 1_500_000n;
    setNativeTokenBalance(formatAssetAmount(balance, 18));
    if (balance < requiredReserve) {
      throw new Error(
        `Insufficient POL for network fees. Your wallet has ${Number(formatAssetAmount(balance, 18)).toFixed(4)} POL; keep about ${Number(formatAssetAmount(requiredReserve, 18)).toFixed(4)} POL available before continuing.`
      );
    }
  }

  async function transactAndRefresh(
    label: string,
    action: () => Promise<void>,
    success: string,
    successCelebration?: CelebrationState
  ) {
    // Always reload confirmed chain state after a transaction; optimistic UI
    // state is unsafe for balances, ownership and listing availability.
    await runTransaction(
      label,
      async () => {
        await action();
        await refreshPortfolio();
        if (!snapshot && selectedListing)
          setExitState(
            await loadExitListing(requireSession().signer, selectedListing.id)
          );
      },
      success,
      successCelebration
    );
  }

  async function createVaultSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (mode === "group" && !vaultName.trim()) {
      setTransaction({ status: "error", message: "Enter a group name before creating the circle." });
      return;
    }
    if (yieldMode === "earn" && !earnRiskAccepted) {
      setTransaction({
        status: "error",
        message:
          "Acknowledge the variable-yield risks before creating an Earn vault.",
      });
      return;
    }
    setTransaction({ status: "pending", message: "Checking wallet balance…" });
    try {
      const session = requireSession();
      await assertWalletCanAffordTransaction(session);
      setTransaction({ status: "pending", message: "Creating vault…" });
      const input: CreateVaultInput = {
        groupMode: mode,
        yieldMode,
        target,
        maturity,
        emergencyPercent,
        additionalMembers: [],
        maxParticipants,
        groupName: mode === "group" ? vaultName.trim() : undefined,
        groupVisibility: mode === "group" ? groupVisibility : undefined,
        enrollmentDeadline: mode === "group" ? enrollmentDeadline : undefined,
      };
      const created = await createVault(session.signer, input);
      const preferences: VaultPlanPreferences = {
        version: 1,
        owner: session.address,
        vaultName: vaultName.trim(),
        purpose: vaultPurpose.trim(),
        contributionAmount: planContribution ? Number(planContribution) : null,
        frequency: planFrequency,
        preferredDays,
        startDate: planStartDate,
        maturityDate: maturity,
        savedAt: new Date().toISOString(),
      };
      setVaultPlans((current) =>
        saveVaultPlan(
          vaultPlanKey(session.chainId, created, 0n),
          preferences,
          current
        )
      );
      // Keep the confirmed result visible instead of returning the user to a
      // fresh form that could be submitted a second time by mistake.
      setCreatedVaultReceipt({
        address: created,
        vaultType: mode,
        yieldMode,
      });
      setTransaction({
        status: "success",
        message: "Vault transaction confirmed on Polygon Amoy.",
      });

      try {
        await refreshPortfolio(session);
        void refreshPublicGroups(false);
      } catch (error) {
        // The transaction is already final. Report a read/RPC problem without
        // implying that the user should submit another vault transaction.
        setTransaction({
          status: "error",
          message: `Vault ${short(created)} was created successfully, but its data could not be refreshed: ${describeContractError(error)} Use Retry chain reads; do not create it again.`,
        });
      }
    } catch (error) {
      setTransaction({
        status: "error",
        message: describeContractError(error),
      });
    }
  }

  async function withdrawMaturedPosition() {
    if (!snapshot) return;
    setWithdrawalNeedsRetry(false);
    setTransaction({
      status: "pending",
      message:
        snapshot.vaultMode === "earn"
          ? "Redeeming from Aave…"
          : "Withdrawing locked funds…",
    });
    try {
      await assertWalletCanAffordTransaction();
      await withdrawLocked(
        requireSession().signer,
        snapshot.address,
        snapshot.positionId
      );
      await refreshPortfolio();
      setTransaction({
        status: "success",
        message: "Maturity withdrawal confirmed.",
      });
      setCelebration({
        title: "Congratulations, savings habit unlocked",
        message: "Your matured savings have been released to your wallet.",
      });
    } catch (error) {
      setWithdrawalNeedsRetry(snapshot.vaultMode === "earn");
      setTransaction({
        status: "error",
        message: describeContractError(error),
      });
    }
  }

  // The reverse swap must use the amount actually delivered by the vault, not
  // an earlier UI estimate that may have changed with Earn-vault yield.
  async function withdrawMaturedPositionForSwap(): Promise<bigint> {
    if (!snapshot)
      throw new Error("Open a vault position before withdrawing.");
    const session = requireSession();
    await assertWalletCanAffordTransaction(session);
    const before = await loadUsdtBalanceUnits(session.signer);
    await withdrawLocked(session.signer, snapshot.address, snapshot.positionId);
    const after = await loadUsdtBalanceUnits(session.signer);
    if (after <= before) {
      throw new Error(
        "The withdrawal confirmed, but no USDT balance increase could be verified."
      );
    }
    await refreshPortfolio(session);
    setTransaction({
      status: "success",
      message: "Maturity withdrawal confirmed in the connected wallet.",
    });
    setCelebration({
      title: "Congratulations, savings habit unlocked",
      message: "Your matured savings were released and are ready for the selected payout flow.",
    });
    return after - before;
  }

  function requestTestFunds(): void {
    void runTransaction(
      "Requesting 250 mUSDT from the Amoy test token…",
      async () => {
        const session = requireSession();
        await requestMockUsdt(session.signer);
        setMockTokenBalance(await loadMockUsdtBalance(session.signer));
      },
      "250 mUSDT minted to the connected test wallet."
    );
  }

  const slowOperationActive =
    openingVault ||
    (route === "discover" && publicGroupsStatus === "loading") ||
    evm.status === "connecting" ||
    nimiq.status === "connecting" ||
    deployment.status === "checking" ||
    transaction.status === "pending";
  const slowOperationLabel =
    transaction.status === "pending"
      ? transaction.message
      : evm.status === "connecting" || nimiq.status === "connecting"
        ? "Connecting your wallet…"
        : openingVault
          ? "Opening your vault…"
          : publicGroupsStatus === "loading"
              ? "Loading savings circles…"
              : "Checking the deployment…";

  return (
    <main className="page-shell">
      <DelayedFunctionLoader
        active={slowOperationActive}
        label={slowOperationLabel}
      />
      <header className="mobile-app-header">
        <button aria-label="Open navigation" className="header-icon menu-icon" onClick={() => setMenuOpen(true)} type="button">
          <Menu aria-hidden="true" size={20} strokeWidth={2} />
        </button>
        <button className="wordmark" onClick={() => navigate("discover")} type="button">
          <span>LockedIn</span><strong>Circle</strong>
        </button>
        <button aria-label={walletAccessReady ? "Open profile" : "Connect wallets"} className={`header-icon profile-avatar ${evmSession ? "connected" : ""}`} onClick={() => walletAccessReady ? setProfileOpen(true) : setConnectionSheetOpen(true)} type="button">
          {evmSession ? <WalletIdenticon address={evmSession.address} /> : <UserRound aria-hidden="true" size={18} />}
        </button>
      </header>

      {menuOpen && (
        <div className="overlay-layer">
          <button aria-label="Close navigation" className="overlay-backdrop" onClick={() => setMenuOpen(false)} type="button" />
          <aside className="side-drawer" aria-label="Primary navigation">
            <div className="drawer-heading">
              <div><span className="eyebrow">LockedIn Circle</span><h2>Navigate</h2></div>
              <button aria-label="Close navigation" className="icon-button" onClick={() => setMenuOpen(false)} type="button"><X aria-hidden="true" size={18} /></button>
            </div>
            <nav className="drawer-nav">
              {secondaryRoutes.map((item) => {
                const Icon = routeIcons[item.id as keyof typeof routeIcons];
                const locked = !walletAccessReady;
                return (
                <button className={route === item.id ? "active" : ""} key={item.id} onClick={() => navigate(item.id)} type="button">
                  <Icon aria-hidden="true" size={17} /><span>{item.label}</span>{locked && <LockKeyhole aria-hidden="true" className="nav-lock" size={13} />}
                </button>
              )})}
            </nav>
            <div className="drawer-network-note">
              <span>Test network</span>
              <strong>Polygon Amoy</strong>
              <small>Mock assets only. No real funds.</small>
            </div>
          </aside>
        </div>
      )}

      {profileOpen && (
        <div className="overlay-layer">
          <button aria-label="Close profile" className="overlay-backdrop" onClick={() => setProfileOpen(false)} type="button" />
          <aside className="profile-sheet" aria-label="Your profile">
            <div className="sheet-grabber" />
            <div className="profile-heading">
              <div className="profile-avatar large">{evmSession ? <WalletIdenticon address={evmSession.address} /> : <UserRound aria-hidden="true" size={20} />}</div>
              <div>
                <span className="eyebrow">Your profile</span>
                <h2>{displayedUsername || "Connect wallets"}</h2>
                {profileWalletAddress && <small>{short(profileWalletAddress)}</small>}
              </div>
              <button aria-label="Close profile" className="icon-button" onClick={() => setProfileOpen(false)} type="button"><X aria-hidden="true" size={18} /></button>
            </div>
            {profileWalletAddress && (
              <div className="profile-name-editor">
                {editingProfileUsername ? (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      const saved = saveLocalUsername(profileWalletAddress, profileUsernameDraft);
                      setProfileUsername(saved);
                      setProfileUsernameDraft(saved);
                      setEditingProfileUsername(false);
                    }}
                  >
                    <label htmlFor="profile-username">Profile name</label>
                    <div>
                      <input
                        autoFocus
                        id="profile-username"
                        maxLength={24}
                        onChange={(event) => setProfileUsernameDraft(event.target.value)}
                        placeholder={walletFallbackName(profileWalletAddress)}
                        value={profileUsernameDraft}
                      />
                      <button className="primary compact" type="submit">Save</button>
                    </div>
                    <small>Leave it blank to use {walletFallbackName(profileWalletAddress)}.</small>
                  </form>
                ) : (
                  <button className="profile-name-action" onClick={() => setEditingProfileUsername(true)} type="button">
                    <span><UserRound aria-hidden="true" size={15} />Profile name</span>
                    <strong>{profileUsername || "Set a username"}</strong>
                  </button>
                )}
              </div>
            )}
            {portfolioLoading && (
              <div className="profile-sync-status" role="status">
                <RefreshCw aria-hidden="true" size={14} />
                Syncing your positions…
              </div>
            )}
            <div className="wallet-balance-grid">
              <div><span><CircleDollarSign aria-hidden="true" size={13} />NIM wallet</span><strong>{nimBalanceLuna === null ? "—" : `${formatAssetAmount(nimBalanceLuna, 5)} NIM`}</strong><small>{nimiqWallet ? short(nimiqWallet.address) : "Not connected"}</small></div>
              <div>
                <span><Landmark aria-hidden="true" size={13} />Polygon wallet</span>
                <strong>{mockTokenBalance === null ? "—" : `${mockTokenBalance} mUSDT`}</strong>
                <small>{nativeTokenBalance === null ? "POL fee balance unavailable" : `${nativeTokenBalance} POL for transaction fees`}</small>
              </div>
            </div>
            <SavingsCalendar activity={activity} />
            <section className="profile-vaults">
              <div className="segmented compact-tabs swipe-tabs" {...profileTabSwipe}>
                <button className={profileVaultKind === "personal" ? "active" : ""} onClick={() => setProfileVaultKind("personal")} type="button">Personal</button>
                <button className={profileVaultKind === "group" ? "active" : ""} onClick={() => setProfileVaultKind("group")} type="button">Group</button>
                <button className={profileVaultKind === "purchased" ? "active" : ""} onClick={() => setProfileVaultKind("purchased")} type="button">Purchased</button>
                <button className={profileVaultKind === "listed" ? "active" : ""} onClick={() => setProfileVaultKind("listed")} type="button">Listed</button>
              </div>
              {profileVaultKind === "listed" ? (
                myActiveListings.length === 0 ? (
                  <p className="empty-mini">No active early-exit requests.</p>
                ) : (
                  myActiveListings.map((entry) =>
                    entry.listing && (
                      <button
                        className="mini-vault-card listed-position-card"
                        key={`listed-${entry.listing.id.toString()}`}
                        onClick={() => {
                          setProfileOpen(false);
                          window.location.hash = "#/market";
                          setExitState(entry);
                          void openVault(
                            entry.listing!.vault,
                            entry.listing!.positionId
                          ).catch((error) =>
                            setTransaction({
                              status: "error",
                              message: describeContractError(error),
                            })
                          );
                        }}
                        type="button"
                      >
                        <span>
                          <b>{vaultType(entry.listing.isGroup)} early exit</b>
                          <em className="listing-status active">Active</em>
                        </span>
                        <strong>{entry.listing.currentSaverPayout} mUSDT payout</strong>
                        <small>{entry.reference.discountPercent.toFixed(2)}% system discount</small>
                      </button>
                    )
                  )
                )
              ) : profileVaultKind === "purchased" ? (
                vaults.filter((vault) => !vault.isOriginalMember && vault.access === "owner").length === 0 ? (
                  <p className="empty-mini">No purchased positions for this address.</p>
                ) : (
                  vaults
                    .filter((vault) => !vault.isOriginalMember && vault.access === "owner")
                    .map((vault) => (
                      <button
                        className="mini-vault-card purchased-position-card"
                        key={`purchased-${vault.address}-${vault.positionId.toString()}`}
                        onClick={() => {
                          setProfileOpen(false);
                          navigate(vault.isGroup ? "groups" : "position");
                          void openVault(vault.address, vault.positionId);
                        }}
                        type="button"
                      >
                        <span>
                          <b>{vaultType(vault.isGroup)} claim #{vault.positionId.toString()}</b>
                          {vault.legacy && <em className="tag legacy">Legacy vault</em>}
                          <em className={`tag ${vault.vaultMode}`}>{vault.vaultMode}</em>
                        </span>
                        <strong>{vault.currentValue} mUSDT current value</strong>
                        <small>Matures {vault.maturity.toLocaleDateString()}</small>
                      </button>
                    ))
                )
              ) : vaults.filter((vault) => vault.isOriginalMember && vault.isGroup === (profileVaultKind === "group")).length === 0 ? (
                <p className="empty-mini">No {profileVaultKind} vaults for this address.</p>
              ) : vaults.filter((vault) => vault.isOriginalMember && vault.isGroup === (profileVaultKind === "group")).map((vault) => {
                  const plan = evmSession ? vaultPlans[vaultPlanKey(evmSession.chainId, vault.address, vault.positionId)] : undefined;
                  const remaining = Math.max(0, Number(vault.target) - Number(vault.deposited));
                  const next = Math.min(remaining, plan?.contributionAmount ?? remaining);
                  return (
                    <button className="mini-vault-card companion-vault-card" key={`${vault.address}-${vault.positionId}`} onClick={() => { setProfileOpen(false); navigate(vault.isGroup ? "groups" : "position"); void openVault(vault.address, vault.positionId); }} type="button">
                      <span><b><Target aria-hidden="true" size={15} />{plan?.vaultName || (vault.isGroup ? "Group savings goal" : "Personal savings goal")}</b>{vault.legacy && <em className="tag legacy">Legacy vault</em>}<em className={`pace ${vault.pace}`}>{vault.pace === "on-track" ? "On track" : vault.pace.replace("-", " ")}</em></span>
                      <strong>{vault.deposited} of {vault.target} USDT</strong>
                      <i><span style={{ width: `${vault.progressPercent}%` }} /></i>
                      <div className="milestone-row" aria-label={`${vault.progressPercent.toFixed(0)} percent complete`}>{[25, 50, 75, 100].map((milestone) => <span className={vault.progressPercent >= milestone ? "reached" : ""} key={milestone}>{milestone}%</span>)}</div>
                      <small>{remaining <= 0 ? "Goal completed" : `Next contribution: ${amountLabel(next)} USDT`} · matures {vault.maturity.toLocaleDateString()}</small>
                    </button>
                  );
                })}
            </section>
            {(nimiqWallet || evmSession) ? (
              <button className="disconnect-button icon-action" onClick={disconnectWallets} type="button"><LogOut aria-hidden="true" size={17} />Disconnect wallets</button>
            ) : (
              <button className="primary full-width icon-action" onClick={() => setConnectionSheetOpen(true)} type="button"><WalletCards aria-hidden="true" size={17} />Connect wallets</button>
            )}
          </aside>
        </div>
      )}

      {connectionSheetOpen && (
        <div className="overlay-layer">
          <button aria-label="Close wallet connection" className="overlay-backdrop" onClick={() => setConnectionSheetOpen(false)} type="button" />
          <section className="connection-sheet" role="dialog" aria-modal="true" aria-label="Connect wallets">
            <div className="sheet-grabber" />
            <span className="eyebrow">Polygon wallet access</span>
            <h2>Connect to continue</h2>
            <p>Your EVM address owns vault positions and signs Polygon transactions. Nimiq Pay is optional for now and is only needed for NIM actions.</p>
            <button className={evmSession ? "connection-row complete" : "connection-row"} disabled={evm.status === "connecting" || Boolean(evmSession)} onClick={() => void connectEvm()} type="button">
              <span>01</span><div><strong>{evmSession ? "Polygon wallet connected" : "Connect EVM wallet"}</strong><small>{evmSession ? short(evmSession.address) : "Required for vault ownership and transactions"}</small></div><b>{evmSession ? <Check aria-hidden="true" size={17} /> : <ArrowRight aria-hidden="true" size={17} />}</b>
            </button>
            <button className={nimiqWallet ? "connection-row complete optional" : "connection-row optional"} disabled={nimiq.status === "connecting" || Boolean(nimiqWallet)} onClick={() => void connectNimiq()} type="button">
              <span>02</span><div><strong>{nimiqWallet ? "Nimiq connected" : "Connect Nimiq Pay (optional)"}</strong><small>{nimiqWallet ? short(nimiqWallet.address) : "Only needed for NIM payments and swaps"}</small></div><b>{nimiqWallet ? <Check aria-hidden="true" size={17} /> : <ArrowRight aria-hidden="true" size={17} />}</b>
            </button>
            {developmentFallbackEnabled && !evmSession && (
              <button className="secondary full-width" disabled={evm.status === "connecting"} onClick={() => void connectEvm(0)} type="button">
                Use local test account
              </button>
            )}
            {pendingGroup?.publicJoining && pendingGroup.joiningOpen && (
              <section className="join-position-review">
                <div className="join-shared-rules">
                  <strong>{pendingGroup.groupName}</strong>
                  <span>{pendingGroup.vaultMode === "earn" ? "Earn" : "Safe"} · matures {pendingGroup.maturity.toLocaleDateString()}</span>
                  <span>{pendingGroup.memberCount}/{pendingGroup.maxMemberCount} members · enrollment closes {pendingGroup.enrollmentDeadline.toLocaleDateString()}</span>
                </div>
                <p>You are joining this circle under its shared maturity and exit rules, but your savings target and balances remain independent.</p>
                <div className="join-position-grid">
                  <label><span>Your target</span><div className="input-unit"><input min="0.000001" onChange={(event) => setJoinTarget(event.target.value)} placeholder="Example: 500" required step="0.000001" type="number" value={joinTarget} /><b>USDT</b></div></label>
                  <label><span>Emergency allocation</span><select onChange={(event) => setJoinEmergencyPercent(Number(event.target.value))} value={joinEmergencyPercent}>{[10, 11, 12, 13, 14, 15].map((value) => <option key={value} value={value}>{value}%</option>)}</select></label>
                  <label><span>Contribution amount</span><div className="input-unit"><input min="0.000001" onChange={(event) => setJoinContribution(event.target.value)} placeholder="Example: 20" step="0.000001" type="number" value={joinContribution} /><b>USDT</b></div><QuickAmounts values={[5, 10, 20]} unit="USDT" value={joinContribution} onSelect={setJoinContribution} /></label>
                  <label><span>Frequency</span><select onChange={(event) => setJoinFrequency(event.target.value as ContributionFrequency)} value={joinFrequency}><option value="daily">Daily</option><option value="weekly">Weekly</option><option value="monthly">Monthly</option><option value="custom">Custom</option></select></label>
                  {(joinFrequency === "weekly" || joinFrequency === "custom") && <fieldset className="weekday-picker full-width"><legend>Preferred days</legend><div>{WEEK_DAYS.map((day) => <button aria-pressed={joinPreferredDays.includes(day.value)} className={joinPreferredDays.includes(day.value) ? "active" : ""} key={day.value} onClick={() => setJoinPreferredDays((current) => current.includes(day.value) ? current.filter((value) => value !== day.value) : [...current, day.value])} type="button">{day.label}</button>)}</div></fieldset>}
                  <label className="full-width"><span>Personal purpose <small>Optional</small></span><input maxLength={100} onChange={(event) => setJoinPurpose(event.target.value)} placeholder="What are you saving for?" value={joinPurpose} /></label>
                </div>
                <div className={`join-plan-result ${joinPlanProjection.sufficient ? "sufficient" : "insufficient"}`}><strong>{joinPlanProjection.sufficient ? "Your plan can reach the target" : "This plan needs adjustment"}</strong><span>Required per period: {amountLabel(joinPlanProjection.requiredPerPeriod)} mUSDT · expected {joinPlanProjection.estimatedCompletionDate?.toLocaleDateString() ?? "after maturity"}</span></div>
              </section>
            )}
            <button className="primary full-width" disabled={!walletAccessReady || Boolean(pendingGroup?.publicJoining && (!pendingGroup.joiningOpen || Number(joinTarget) <= 0))} onClick={() => pendingGroup ? continueToInvitedGroup() : setConnectionSheetOpen(false)} type="button">
              {pendingGroup?.publicJoining && pendingGroup.joiningOpen
                ? "Join public circle"
                : pendingGroup
                  ? "Continue to invitation"
                  : "Continue"}
            </button>
            {pendingGroup && !pendingGroup.publicJoining && <small className="connection-note">This is an invite-only circle. The contract will verify that this EVM address was invited.</small>}
          </section>
        </div>
      )}
      <header className="topbar">
        <div>
          <span className="kicker">Nimiq Pay Mini App · Local prototype</span>
          <h1>LockedIn Circle</h1>
        </div>
        <div className="wallet-actions">
          {nimiq.status === "connected" ? (
            <WalletChip label="Nimiq identity" address={nimiq.wallet.address} />
          ) : (
            <button
              className="secondary compact"
              disabled={nimiq.status === "connecting"}
              onClick={() => void connectNimiq()}
            >
              {nimiq.status === "connecting" ? "Connecting…" : "Connect Nimiq"}
            </button>
          )}
          {evmSession ? (
            <WalletChip
              label={`EVM owner · ${evmSession.source}`}
              address={evmSession.address}
            />
          ) : (
            <button
              className="primary compact"
              disabled={evm.status === "connecting"}
              onClick={() => void connectEvm()}
            >
              {evm.status === "connecting"
                ? "Connecting…"
                : "Connect EVM wallet"}
            </button>
          )}
        </div>
      </header>
      <nav className="app-nav" aria-label="Primary navigation">
        {routes.map((item) => (
          <a
            aria-current={route === item.id ? "page" : undefined}
            className={route === item.id ? "active" : ""}
            href={`#/${item.id}`}
            key={item.id}
          >
            {item.label}
          </a>
        ))}
      </nav>
      {(nimiq.status === "error" || evm.status === "error") && (
        <div className="notice error" role="alert">
          {nimiq.status === "error" && <span>{nimiq.message}</span>}
          {evm.status === "error" && <span>{evm.message}</span>}
        </div>
      )}
      {!deploymentReady && (
        <div className="notice" role="status">
          <strong>Deployment verification unavailable.</strong>{" "}
          {import.meta.env.VITE_DEPLOYMENT_BLOCK_REASON ??
            "Wallet connection is available, but contract actions remain disabled until a current deployment manifest is installed."}
        </div>
      )}
      {deployment.status === "error" && (
        <div className="notice error" role="alert">
          <strong>Contract deployment could not be verified.</strong>
          <span>{deployment.message}</span>
          {evmSession && (
            <button
              className="secondary compact"
              onClick={() => void verifyConnectedDeployment()}
              type="button"
            >
              Retry contract check
            </button>
          )}
        </div>
      )}
      {deployment.status === "valid" && deployment.value.paused && (
        <div className="notice error" role="alert">
          <strong>Protocol safety pause is active.</strong>
          <span>
            New vaults, deposits and market purchases are blocked. Principal
            withdrawals, listing cancellation and safe exit completion remain available.
          </span>
        </div>
      )}

      {/* The discover route is intentionally usable without either wallet. */}
      {route === "discover" && (
        <section className="route-page discover-page">
          <div className="discover-hero">
            <span className="eyebrow">Save better, together</span>
            <h1>Find your circle.<br />Stay locked in.</h1>
            <p>Explore public savings circles, understand the shared goal, and connect only when you are ready to join.</p>
          </div>
          <div className="discover-section-heading">
            <div><h2>Group savings circles</h2><p>Live from the current testnet deployment.</p></div>
            <button aria-label="Refresh circles" className="icon-button" onClick={() => void refreshPublicGroups()} type="button" title="Refresh circles"><RefreshCw aria-hidden="true" size={17} /></button>
          </div>
          {!publicGroupsSupported && deployment.status === "valid" && (
            <details className="technical-details discovery-compatibility"><summary>Why some circles may be unavailable</summary><p>This test deployment predates open group joining. Existing invite-only circles can still appear, while public creation requires the updated contracts.</p></details>
          )}
          {publicGroupsError && publicGroupsStatus === "ready" && (
            <div className="notice warning-notice"><strong>Showing the last successful circle list</strong><span>Live refresh is temporarily unavailable. Joining still revalidates the circle on-chain.</span></div>
          )}
          {publicGroupsStatus === "loading" ? (
            <div className="circle-loading"><span /><span /><span /></div>
          ) : publicGroupsStatus === "error" ? (
            <div className="circle-recovery"><RefreshCw aria-hidden="true" size={20} /><div><strong>Your savings circles are refreshing</strong><span>We could not reach the selected network. Check your connection and try again.</span></div><button className="secondary icon-action" onClick={() => void refreshPublicGroups()} type="button"><RefreshCw aria-hidden="true" size={15} />Refresh circles</button></div>
          ) : publicGroups.length === 0 ? (
            <article className="empty-circle"><UsersRound aria-hidden="true" className="empty-icon" size={26} /><h3>No group circles yet</h3><p>Create the first invitation-based group on this deployment.</p><button className="primary icon-action" onClick={() => navigate("vaults")} type="button"><Plus aria-hidden="true" size={17} />Create group vault</button></article>
          ) : (
            <div className="circle-stack">
              {publicGroups.map((group, index) => (
                <article className="circle-card" key={group.address}>
                  <div className="circle-card-top">
                    <div><span className={`tag ${group.vaultMode}`}>{group.vaultMode}</span><span className={`circle-state ${group.lifecycle}`}>{group.lifecycle}</span></div>
                    <small>Circle {String(index + 1).padStart(2, "0")}</small>
                  </div>
                  <h3>{group.groupName || `Savings Circle ${index + 1}`}</h3>
                  <p className="circle-address">Created by {walletDisplayName(group.creator)}</p>
                  <GroupPowerVisual group={group} />
                  <p className="member-avatar-note">Wallet initials represent the members powering this shared goal.</p>
                  <div className="circle-roadmap">
                    <div><span>Collecting</span><span>Goal</span><span>Maturity</span></div>
                    <i><span style={{ width: `${group.progressPercent}%` }} /></i>
                    <div><b>{group.progressPercent.toFixed(0)}% saved</b><small>{group.totalDeposited} / {group.totalTarget} mUSDT</small></div>
                  </div>
                  <div className="circle-meta"><span><UsersRound aria-hidden="true" size={13} />{group.memberCount}/{group.maxMemberCount} participants</span><span><CircleDollarSign aria-hidden="true" size={13} />Independent targets</span><span><CalendarDays aria-hidden="true" size={13} />Due {group.maturity.toLocaleDateString()}</span></div>
                  {group.publicJoining ? (
                    <button className="join-circle-button" onClick={() => requestGroupJoin(group)} type="button">
                      <span>{group.joiningOpen ? "Join public circle" : group.memberCount >= group.maxMemberCount ? "Circle full" : "Enrollment closed"}</span>
                      {group.joiningOpen ? <ArrowRight aria-hidden="true" size={18} /> : <LockKeyhole aria-hidden="true" size={17} />}
                    </button>
                  ) : (
                    <SwipeReviewInvitation onReview={() => requestGroupJoin(group)} />
                  )}
                </article>
              ))}
            </div>
          )}
          <p className="invitation-disclaimer">Public circles accept members until activation, capacity or their enrollment deadline. Deposits begin only after activation.</p>
        </section>
      )}

      {deploymentBlocked && route !== "wallet" && route !== "discover" && (
        <section className="route-page">
          <article className="panel narrow-panel empty-state" role="alert">
            <h2>Contract actions are blocked</h2>
            <p>
              Connect to the deployment recorded by the current manifest. No
              transaction will be prepared while its chain or contract identity is stale.
            </p>
            <a className="primary" href="#/wallet">Review wallet connection</a>
          </article>
        </section>
      )}

      {!deploymentBlocked && route === "vaults" && (
        <section className="route-page">
          {createdVaultReceipt ? (
            <article className="panel narrow-panel vault-created-state" role="status">
              <div className="completion-watermark" aria-hidden="true">
                <Check />
              </div>
              <span className="completion-kicker">Vault created</span>
              <h2>Your {createdVaultReceipt.vaultType} vault is ready.</h2>
              <p>
                {createdVaultReceipt.vaultType === "group"
                  ? "The transaction is confirmed. Membership is now open; deposits begin only after at least four members join and the circle activates."
                  : "The transaction is confirmed. You can now open the vault and make its first deposit."}
              </p>
              <dl className="creation-receipt">
                <div>
                  <dt>Vault</dt>
                  <dd>{short(createdVaultReceipt.address)}</dd>
                </div>
                <div>
                  <dt>Mode</dt>
                  <dd>{createdVaultReceipt.yieldMode}</dd>
                </div>
              </dl>
              <button
                className="primary full-width"
                onClick={() => {
                  const destination =
                    createdVaultReceipt.vaultType === "group" ? "groups" : "position";
                  navigate(destination);
                  void openVault(createdVaultReceipt.address).catch((error) =>
                    setTransaction({
                      status: "error",
                      message: describeContractError(error),
                    })
                  );
                }}
                type="button"
              >
                Open my vault <ArrowRight aria-hidden="true" size={17} />
              </button>
              <button
                className="text-action"
                onClick={() => setCreatedVaultReceipt(null)}
                type="button"
              >
                Create another vault
              </button>
            </article>
          ) : (
          <article className="panel narrow-panel">
            <div className="panel-heading">
              <div>
                <span className="step">01</span>
                <div>
                  <h2>Create a savings vault</h2>
                  <p>Choose who saves and define the target.</p>
                </div>
              </div>
              <div className="segmented swipe-tabs" {...createModeSwipe}>
                <button
                  className={mode === "personal" ? "active" : ""}
                  onClick={() => setMode("personal")}
                  type="button"
                >
                  Personal
                </button>
                <button
                  className={mode === "group" ? "active" : ""}
                  onClick={() => setMode("group")}
                  type="button"
                >
                  Group
                </button>
              </div>
            </div>
            <form className="form-grid" onSubmit={createVaultSubmit}>
              <fieldset className="creation-section full-width">
                <legend><b>1</b>{mode === "group" ? "Circle identity" : "Savings goal"}</legend>
                <div className="plan-field-grid">
                  <label>
                    <span>{mode === "group" ? "Group name" : "Vault name"}</span>
                    <input
                      maxLength={40}
                      onChange={(event) => setVaultName(event.target.value)}
                      placeholder={mode === "group" ? "December Travel Circle" : "New Laptop"}
                      required={mode === "group"}
                      value={vaultName}
                    />
                  </label>
                  <label>
                    <span>{mode === "group" ? "Group description" : "Short purpose"} <small>Optional</small></span>
                    <input
                      maxLength={100}
                      onChange={(event) => setVaultPurpose(event.target.value)}
                      placeholder={mode === "group" ? "Saving together for our December trip" : "Saving for a new work laptop"}
                      value={vaultPurpose}
                    />
                  </label>
                  {mode === "group" && vaultName.trim() && <label><span>Visibility</span><select onChange={(event) => setGroupVisibility(event.target.value as "public" | "invite-only")} value={groupVisibility}><option value="public">Public — discoverable</option><option value="invite-only">Invite-only</option></select></label>}
                  {mode === "group" && vaultName.trim() && <label><span>Maximum participants</span><input max="50" min="4" onChange={(event) => setMaxParticipants(Number(event.target.value))} placeholder="Example: 6" required type="number" value={maxParticipants} /><small>At least four savers are required before activation.</small></label>}
                  {mode === "group" && vaultName.trim() && <label className="full-width"><span>Enrollment deadline</span><input onChange={(event) => setEnrollmentDeadline(event.target.value)} required type="datetime-local" value={enrollmentDeadline} /><small>Must be before the shared maturity date.</small></label>}
                  {mode === "personal" && <label><span>Target amount</span><div className="input-unit"><input min="0.000001" onChange={(event) => setTarget(event.target.value)} placeholder="Example: 500" required step="0.000001" type="number" value={target} /><b>USDT</b></div><small>The most you plan to save in this vault.</small></label>}
                  {mode === "personal" && <label><span>Start date</span><input onChange={(event) => setPlanStartDate(event.target.value)} required type="date" value={planStartDate} /></label>}
                </div>
              </fieldset>

              {mode === "group" && vaultName.trim() && <fieldset className="creation-section full-width progressive-section"><legend><b>2</b>Shared circle rules</legend><div className="shared-rule-copy"><p>Every member owns an independent position. The circle shares its mode, maturity, membership limit and cooperative-exit rules—not a pooled balance.</p><p>At least four members must join before activation. Activation permanently freezes membership. Market buyers receive the locked claim, not group voting rights.</p></div><div className="mode-picker embedded">
                <button
                  className={yieldMode === "safe" ? "active" : ""}
                  onClick={() => {
                    setYieldMode("safe");
                    setEarnRiskAccepted(false);
                  }}
                  type="button"
                >
                  <strong>Safe</strong>
                  <span>Held in this vault. No yield.</span>
                </button>
                <button
                  className={yieldMode === "earn" ? "active" : ""}
                  onClick={() => setYieldMode("earn")}
                  type="button"
                >
                  <strong>Earn</strong>
                  <span>
                    {usesMockYieldAdapter
                      ? "Uses a simulated testnet yield adapter. Not Aave."
                      : "Supplied to Aave V3. Variable yield and protocol risk."}
                  </span>
                </button>
              </div></fieldset>}

              {(mode === "personal" ? Number(target) > 0 : Boolean(vaultName.trim())) && <fieldset className="creation-section full-width progressive-section">
                <legend><b>{mode === "group" ? "3" : "2"}</b>{mode === "group" ? "Your savings goal" : "Savings plan"}</legend>
                {mode === "group" && <p className="section-guidance">These terms belong only to your position. Future members choose their own target, schedule and emergency allocation.</p>}
                <div className="plan-field-grid">
                {mode === "group" && <label><span>Your personal target</span><div className="input-unit"><input min="0.000001" onChange={(event) => setTarget(event.target.value)} placeholder="Example: 500" required step="0.000001" type="number" value={target} /><b>USDT</b></div></label>}
                {mode === "group" && <label><span>Personal saving purpose <small>Optional</small></span><input maxLength={100} onChange={(event) => setVaultPurpose(event.target.value)} placeholder="Saving for flights and accommodation" value={vaultPurpose} /></label>}
                <div className="full-width contribution-currency">
                  <span>Plan contribution currency</span>
                  <CurrencyToggle value="usdt" onChange={() => undefined} nimDisabled />
                  <small>NIM plan contributions are coming soon. No conversion is estimated or performed here.</small>
                </div>
                <label>
                <span>Contribution amount</span>
                <div className="input-unit">
                  <input
                    min="0.000001"
                    onChange={(event) => setPlanContribution(event.target.value)}
                    placeholder="Example: 20"
                    step="0.000001"
                    type="number"
                    value={planContribution}
                  />
                  <b>mUSDT</b>
                </div>
                <QuickAmounts values={[5, 10, 20]} unit="USDT" value={planContribution} onSelect={setPlanContribution} />
              </label>
              {Number(planContribution) > 0 && <label>
                <span>Contribution frequency</span>
                <select
                  onChange={(event) => setPlanFrequency(event.target.value as ContributionFrequency)}
                  value={planFrequency}
                >
                  <option value="daily">Daily</option>
                  <option value="weekly">Weekly</option>
                  <option value="monthly">Monthly</option>
                  <option value="custom">Custom / whenever possible</option>
                </select>
              </label>}
                </div>
              {Number(planContribution) > 0 && (planFrequency === "weekly" || planFrequency === "custom") && (
                <fieldset className="weekday-picker full-width">
                  <legend>Preferred contribution days</legend>
                  <div>
                    {WEEK_DAYS.map((day) => (
                      <button
                        aria-pressed={preferredDays.includes(day.value)}
                        className={preferredDays.includes(day.value) ? "active" : ""}
                        key={day.value}
                        onClick={() =>
                          setPreferredDays((current) =>
                            current.includes(day.value)
                              ? current.filter((value) => value !== day.value)
                              : [...current, day.value]
                          )
                        }
                        type="button"
                      >
                        {day.label}
                      </button>
                    ))}
                  </div>
                  <small>
                    {preferredDays.length === 0
                      ? "Choose days, or the plan will use your start-date weekday."
                      : "These reminders stay on this device for now."}
                  </small>
                </fieldset>
              )}
              {Number(planContribution) > 0 && <div className="estimated-date full-width"><CalendarDays aria-hidden="true" size={18} /><div><span>Estimated maturity</span><strong>{estimatedMaturity ? estimatedMaturity.toLocaleDateString() : "Choose a contribution schedule"}</strong><small>Calculated after your contribution amount and frequency are known.</small></div></div>}
              {Number(planContribution) > 0 && <aside className={`plan-preview full-width ${!hasContributionPlan ? "unconfigured" : planProjection.sufficient ? "sufficient" : "insufficient"}`}>
                <div className="plan-preview-heading">
                  <Target aria-hidden="true" size={18} />
                  <div>
                    <strong>Plan check</strong>
                    <span>Informational only — your contract target remains authoritative.</span>
                  </div>
                </div>
                <dl>
                  <div><dt>Planned total</dt><dd>{hasContributionPlan ? `${amountLabel(planProjection.plannedTotal)} mUSDT` : "Add an amount"}</dd></div>
                  <div><dt>Required each period</dt><dd>{amountLabel(planProjection.requiredPerPeriod)} mUSDT</dd></div>
                  <div><dt>Estimated completion</dt><dd>{planProjection.estimatedCompletionDate ? planProjection.estimatedCompletionDate.toLocaleDateString() : "Not reached by maturity"}</dd></div>
                </dl>
                {hasContributionPlan && (
                  <small className="plan-calculation-note">
                    {planProjection.contributionsNeeded === null
                      ? `${planProjection.plannedPeriods} contribution dates are available before maturity.`
                      : `${planProjection.contributionsNeeded} contributions reach the goal; ${planProjection.plannedPeriods} contribution dates are available before maturity.`}
                    {planProjection.scheduledCapacity > planProjection.plannedTotal &&
                      ` The schedule could hold ${amountLabel(planProjection.scheduledCapacity)} mUSDT, but planned savings stop at your ${amountLabel(planProjection.plannedTotal)} mUSDT goal.`}
                  </small>
                )}
                {hasContributionPlan && !planProjection.sufficient && (
                  <p>
                    This plan may not reach the target in time. Increase the contribution amount or frequency; you can still save whenever possible.
                  </p>
                )}
              </aside>}
              {mode === "group" && <label className="range-field">
                <span>
                  Your emergency allocation <strong>{emergencyPercent}%</strong>
                </span>
                <input
                  max="15"
                  min="10"
                  onChange={(event) =>
                    setEmergencyPercent(Number(event.target.value))
                  }
                  type="range"
                  value={emergencyPercent}
                />
                <small>
                  Available anytime and never sold with an early exit.
                </small>
              </label>}
              </fieldset>}

              {estimatedMaturity && Number(planContribution) > 0 && <fieldset className="creation-section full-width progressive-section">
                <legend><b>{mode === "group" ? "4" : "3"}</b>{mode === "group" ? "Review and create" : "Vault protection"}</legend>
                {mode === "personal" && <div className="mode-picker embedded">
                  <button className={yieldMode === "safe" ? "active" : ""} onClick={() => { setYieldMode("safe"); setEarnRiskAccepted(false); }} type="button"><strong>Safe</strong><span>Locked funds remain in the vault and earn no yield.</span></button>
                  <button className={yieldMode === "earn" ? "active" : ""} onClick={() => setYieldMode("earn")} type="button"><strong>Earn</strong><span>{usesMockYieldAdapter ? "Uses the testnet mock adapter." : "Supplied to Aave V3 with variable, non-guaranteed yield."}</span></button>
                </div>}
                {mode === "personal" && <label className="range-field"><span>Emergency allocation <strong>{emergencyPercent}%</strong></span><input max="15" min="10" onChange={(event) => setEmergencyPercent(Number(event.target.value))} type="range" value={emergencyPercent} /><small>This portion remains available anytime. The remainder is locked until maturity or transferred through an early exit.</small></label>}
                <TrustSummary earn={yieldMode === "earn"} />
              {yieldMode === "earn" && (
                <label className="risk-ack full-width">
                  <input
                    checked={earnRiskAccepted}
                    onChange={(event) =>
                      setEarnRiskAccepted(event.target.checked)
                    }
                    required
                    type="checkbox"
                  />
                  <span>
                    {usesMockYieldAdapter
                      ? "I understand this test deployment simulates yield and does not supply funds to Aave. Emergency funds remain in the vault."
                      : "I understand Aave yield is variable and not guaranteed, withdrawals can temporarily fail, and smart-contract or protocol losses are possible. Emergency funds remain outside Aave."}
                  </span>
                </label>
              )}
                {mode === "group" && <dl className="creation-review">
                  <div><dt>Circle</dt><dd>{vaultName || "Name required"} · {groupVisibility}</dd></div>
                  <div><dt>Shared rules</dt><dd>{yieldMode} · matures {new Date(maturity).toLocaleDateString()} · max {maxParticipants}</dd></div>
                  <div><dt>Your position</dt><dd>{target} mUSDT · {planContribution || "Flexible"} {planFrequency}</dd></div>
                  <div><dt>Emergency allocation</dt><dd>{emergencyPercent}% emergency · {100 - emergencyPercent}% locked</dd></div>
                  <div><dt>Expected completion</dt><dd>{planProjection.sufficient ? `Target by ${planProjection.estimatedCompletionDate?.toLocaleDateString() ?? "maturity"}` : "Plan is currently below the required pace"}</dd></div>
                </dl>}
              </fieldset>}
              {mode === "personal" && estimatedMaturity && Number(planContribution) > 0 && <fieldset className="creation-section full-width progressive-section">
                <legend><b>4</b>Review</legend>
                <dl className="creation-review">
                  <div><dt>Goal</dt><dd>{target} mUSDT{vaultName ? ` for ${vaultName}` : ""}</dd></div>
                  <div><dt>Schedule</dt><dd>{planContribution || "Flexible"} mUSDT · {planFrequency}</dd></div>
                  <div><dt>Maturity</dt><dd>{new Date(maturity).toLocaleDateString()}</dd></div>
                  <div><dt>Emergency allocation</dt><dd>{emergencyPercent}% emergency · {100 - emergencyPercent}% locked</dd></div>
                  <div><dt>Mode</dt><dd>{yieldMode === "earn" ? "Earn · variable simulated yield" : "Safe · no yield"}</dd></div>
                  <div><dt>Estimated outcome</dt><dd>{planProjection.sufficient ? `Target by ${planProjection.estimatedCompletionDate?.toLocaleDateString() ?? "maturity"}` : "Plan is currently below the required pace"}</dd></div>
                </dl>
              </fieldset>}
              {estimatedMaturity && Number(planContribution) > 0 && mode === "group" && groupCreationBlockReason && (
                <div className="notice warning-notice full-width" role="status">
                  <strong>{groupVisibility === "public" ? "Public circles need newer contracts" : "This invite-only flow is not supported by the current factory"}</strong>
                  <span>{groupCreationBlockReason}</span>
                </div>
              )}
              {estimatedMaturity && Number(planContribution) > 0 && <button
                className="primary full-width"
                disabled={
                  riskActionsDisabled ||
                  (mode === "group" && Boolean(groupCreationBlockReason)) ||
                  (yieldMode === "earn" && !earnRiskAccepted)
                }
                type="submit"
              >
                Create {mode === "group" ? "Group Vault" : "Personal Vault"}
              </button>}
            </form>
          </article>
          )}
        </section>
      )}

      {!deploymentBlocked && (route === "position" || route === "groups") && (
        <section className={`route-page dashboard-grid ${openingVault || snapshot ? "vault-detail-active" : ""}`}>
          <aside className="panel vault-sidebar">
            <div className="section-title">
              <div>
                <h2>{route === "groups" ? "My savings circles" : "My savings goals"}</h2>
                <p>{route === "groups" ? "Shared goals you joined or created." : "Your goals, progress and next contribution."}</p>
              </div>
              <button
                className="icon-button"
                disabled={actionsDisabled}
                onClick={() => void refreshPortfolio()}
                title="Refresh"
              >
                <RefreshCw aria-hidden="true" size={17} />
              </button>
            </div>
            <div className="vault-view-tabs swipe-tabs" role="tablist" aria-label="Savings position status" {...vaultViewSwipe}>
              <button aria-selected={vaultView === "active"} className={vaultView === "active" ? "active" : ""} onClick={() => setVaultView("active")} role="tab" type="button">Active goals</button>
              <button aria-selected={vaultView === "sold"} className={vaultView === "sold" ? "active" : ""} onClick={() => setVaultView("sold")} role="tab" type="button">Completed exits</button>
            </div>
            {vaultView === "sold" ? (
              visibleSoldPositions.length === 0 ? (
                <div className="empty-mini">No completed exits for these savings goals.</div>
              ) : (
                <div className="sold-position-list">
                  {visibleSoldPositions.map((trade) => (
                    <button className="sold-position-card" key={`sold-${trade.listingId.toString()}`} onClick={() => { navigate("activity"); setHistoryView("trades"); setSelectedTradeId(trade.listingId.toString()); }} type="button">
                      <span><b>{vaultType(trade.isGroup)} savings exit</b><em>Completed</em></span>
                      <strong>+{trade.saverPayout} USDT received</strong>
                      <small>{trade.timestamp.toLocaleDateString()} · View receipt</small>
                    </button>
                  ))}
                </div>
              )
            ) : visibleVaults.length === 0 ? (
              <div className="empty-mini">
                No active savings goals for this account.
              </div>
            ) : (
              <div className="vault-list">
                {visibleVaults.map((vault) => {
                  const plan = evmSession
                    ? vaultPlans[vaultPlanKey(evmSession.chainId, vault.address, vault.positionId)]
                    : undefined;
                  const pace = calculateSavingsPace({
                    target: Number(vault.target),
                    deposited: Number(vault.deposited),
                    startDate: plan?.startDate ?? vault.createdAt,
                    maturityDate: vault.maturity,
                    contributionAmount: plan?.contributionAmount,
                    frequency: plan?.frequency,
                    preferredDays: plan?.preferredDays,
                  });
                  const planLabel = plan?.contributionAmount
                    ? `${amountLabel(plan.contributionAmount)} USDT ${plan.frequency}`
                    : "Flexible contributions";
                  return (
                  <button
                    className={
                      snapshot?.address === vault.address &&
                      snapshot.positionId === vault.positionId
                        ? "vault-row selected"
                        : "vault-row"
                    }
                    key={`${vault.address}-${vault.positionId.toString()}`}
                    onClick={() => {
                      setVaultDetailTab("overview");
                      setSnapshot(null);
                      void openVault(vault.address, vault.positionId).catch((error) =>
                        setTransaction({ status: "error", message: describeContractError(error) })
                      );
                    }}
                  >
                    <span className={`vault-art ${vault.isGroup ? "group" : "personal"}`}>
                      <span className="vault-art-top">
                        <span>{vaultType(vault.isGroup)}</span>
                        <code>{vault.progressPercent.toFixed(0)}%</code>
                      </span>
                      <span className="vault-art-mark">
                        {vault.isGroup ? (
                          <UsersRound aria-hidden="true" size={29} />
                        ) : (
                          <Vault aria-hidden="true" size={29} />
                        )}
                      </span>
                      <span className="vault-art-value">
                        <small>Saved</small>
                        <strong>{vault.deposited}</strong>
                        <b>USDT</b>
                      </span>
                    </span>
                    <span className="vault-collection-copy">
                      <span className="vault-collection-title">
                        <strong>{plan?.vaultName || (vault.isGroup ? "Group circle" : "Personal goal")}</strong>
                        {vault.legacy && <em className="tag legacy">Legacy vault</em>}
                        <em className={`tag ${vault.vaultMode}`}>{vault.vaultMode}</em>
                      </span>
                      <small>{short(vault.address)}</small>
                      <span className="vault-card-progress"><i style={{ width: `${vault.progressPercent}%` }} /></span>
                      <span className="vault-card-footer">
                        <b>{vault.progressPercent.toFixed(0)}% of {vault.target} USDT</b>
                        <em className={`pace ${pace.status}`}><PaceIcon status={pace.status} size={11} />{pace.status.replace("-", " ")}</em>
                      </span>
                      <span className="vault-collection-meta">
                        <span><small><Target aria-hidden="true" size={10} /> Goal</small><b>{vault.target} USDT</b></span>
                        <span><small><CalendarDays aria-hidden="true" size={10} /> Due</small><b>{vault.maturity.toLocaleDateString()}</b></span>
                      </span>
                      <span className="vault-plan-line"><CalendarDays aria-hidden="true" size={12} />{planLabel}</span>
                      <span className="vault-plan-line"><BadgeCheck aria-hidden="true" size={12} />Save next: {amountLabel(pace.nextSuggestedContribution)} USDT</span>
                      <span className="vault-card-action">View savings details <ArrowRight aria-hidden="true" size={15} /></span>
                    </span>
                  </button>
                  );
                })}
              </div>
            )}
          </aside>
          {(openingVault || snapshot) && <button aria-label="Close vault details" className="vault-detail-backdrop" onClick={() => { setSnapshot(null); setOpeningVault(false); }} type="button" />}
          <article className={`panel vault-main ${openingVault || snapshot ? "vault-detail-sheet" : ""}`}>
            {openingVault && !snapshot ? (
              <div className="vault-sheet-loading" role="status">
                <div className="sheet-grabber" />
                <span className="skeleton-line wide" />
                <span className="skeleton-line" />
                <div className="skeleton-metrics"><i /><i /><i /><i /></div>
              </div>
            ) : snapshot ? (
              <>
                <div className="sheet-grabber" />
                <div className="vault-detail-sticky">
                <button className="mobile-detail-back" onClick={() => { setSnapshot(null); setExitState(null); setGroupExitRequests([]); }} type="button">
                  <X aria-hidden="true" size={16} /> Close details
                </button>
                <div className="section-title">
                  <div>
                    <span
                      className={`tag ${
                        snapshot.isGroup ? "group" : "personal"
                      }`}
                    >
                      {vaultType(snapshot.isGroup)}
                    </span>
                    <span className={`tag ${snapshot.vaultMode}`}>
                      {snapshot.vaultMode === "earn"
                        ? usesMockYieldAdapter
                          ? "Earn · mock adapter"
                          : "Earn · Aave V3"
                        : "Safe · no yield"}
                    </span>
                    <h2>
                      {snapshot.isGroup ? snapshot.groupName || "Group savings" : selectedPlan?.vaultName || "Personal savings"}
                    </h2>
                    {selectedPlan?.purpose && <p className="vault-purpose">{selectedPlan.purpose}</p>}
                    {!snapshot.isGroup && <code>{snapshot.address}</code>}
                  </div>
                  <span
                    className={
                      !snapshot.ownsLockedPosition || snapshot.goalComplete
                        ? "status-pill complete"
                        : "status-pill"
                    }
                  >
                    {!snapshot.ownsLockedPosition
                      ? "Position sold"
                      : snapshot.lockedWithdrawn
                        ? "Exited"
                      : Date.now() >= snapshot.maturity.getTime()
                        ? "Matured"
                      : !snapshot.isOriginalMember
                        ? "Purchased claim"
                        : snapshot.goalComplete
                          ? "Target reached"
                          : "In progress"}
                  </span>
                </div>
                {snapshot.isGroup && (
                  <nav className="vault-detail-tabs swipe-tabs" aria-label="Group vault details" role="tablist" {...vaultDetailSwipe}>
                    {VAULT_DETAIL_TABS.map((tab) => (
                      <button
                        aria-selected={vaultDetailTab === tab}
                        className={vaultDetailTab === tab ? "active" : ""}
                        key={tab}
                        onClick={() => setVaultDetailTab(tab)}
                        role="tab"
                        type="button"
                      >
                        {tab.charAt(0).toUpperCase() + tab.slice(1)}
                      </button>
                    ))}
                  </nav>
                )}
                </div>
                {snapshot.isGroup && !snapshot.openEnrollment && vaultDetailTab === "circle" && snapshot.groupLifecycle !== "active" && (
                  <Suspense fallback={<RouteLoading label="Loading group controls" />}>
                  <GroupManagementRoute>
                  <GroupInvitationPanel
                    clock={clock}
                    disabled={riskActionsDisabled}
                    snapshot={snapshot}
                    onAccept={() =>
                      void transactAndRefresh(
                        "Accepting group invitation…",
                        () =>
                          acceptGroupInvitation(
                            requireSession().signer,
                            snapshot.address
                          ),
                        "Invitation accepted."
                      )
                    }
                    onCancel={() =>
                      void transactAndRefresh(
                        "Cancelling unactivated group…",
                        () =>
                          cancelUnactivatedGroup(
                            requireSession().signer,
                            snapshot.address
                          ),
                        "Unactivated group cancelled."
                      )
                    }
                    onDecline={() =>
                      void transactAndRefresh(
                        "Declining group invitation…",
                        () =>
                          declineGroupInvitation(
                            requireSession().signer,
                            snapshot.address
                          ),
                        "Invitation declined."
                      )
                    }
                  />
                  </GroupManagementRoute>
                  </Suspense>
                )}
                {snapshot.isGroup && snapshot.openEnrollment && vaultDetailTab === "circle" && snapshot.circleState !== "active" && (
                  <section className="group-activation-card">
                    <div><strong>{snapshot.circleState === "ready" ? "Circle ready to activate" : "Membership is open"}</strong><span>{snapshot.members.length}/{snapshot.maxMemberCount} members joined. At least four are required before deposits can begin.</span></div>
                    {snapshot.circleState === "ready" && <button className="primary" disabled={riskActionsDisabled} onClick={() => void transactAndRefresh("Activating circle…", () => activateGroup(requireSession().signer, snapshot.address), "Circle activated. Membership is now permanently fixed.")} type="button">Activate and freeze membership</button>}
                  </section>
                )}
                <div className="vault-tab-section" hidden={snapshot.isGroup && vaultDetailTab !== "overview"} role={snapshot.isGroup ? "tabpanel" : undefined}>
                {snapshot.isOriginalMember && snapshot.ownsLockedPosition && (
                  <>
                <div className="progress-copy">
                  <span>Your goal progress</span>
                  <strong>{progress.toFixed(1)}%</strong>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${progress}%` }} />
                </div>
                {selectedPace && (
                  <aside className={`pace-summary ${selectedPace.status}`}>
                    <PaceIcon status={selectedPace.status} size={20} />
                    <div>
                      <strong>
                        {selectedPace.status === "completed"
                          ? "Goal completed"
                          : selectedPace.status === "ahead"
                            ? "You are ahead"
                            : selectedPace.status === "on-track"
                              ? "You are on track"
                              : "A small adjustment can get you back on track"}
                      </strong>
                      <span>
                        {selectedPace.status === "behind"
                          ? `Your plan calls for ${amountLabel(selectedPace.expectedAmount)} mUSDT by today. You have saved ${snapshot.deposited} mUSDT, leaving ${amountLabel(selectedPace.behindAmount)} mUSDT to catch up. Save about ${amountLabel(selectedPace.requiredPerRemainingPeriod)} mUSDT per remaining period over the next ${selectedPace.remainingDays} days.`
                          : selectedPace.status === "completed"
                            ? "You reached the contract target. No further deposit is needed."
                            : `Next suggested contribution: ${amountLabel(selectedPace.nextSuggestedContribution)} mUSDT. ${selectedPace.remainingDays} days remain.`}
                      </span>
                      {selectedPace.status === "behind" && (
                        <small>{selectedPace.missedPeriods} contribution period{selectedPace.missedPeriods === 1 ? "" : "s"} currently missed.</small>
                      )}
                      {selectedPlan && (
                        <small>“{selectedPlan.vaultName || "Savings plan"}” preferences are stored only on this device.</small>
                      )}
                    </div>
                  </aside>
                )}
                  </>
                )}
                {!snapshot.ownsLockedPosition && (
                  <div className="notice">
                    <strong>Locked position sold</strong>
                    <span>
                      You no longer own this savings claim. This vault remains
                      visible only so you can withdraw your separate emergency
                      balance.
                    </span>
                  </div>
                )}
                <div className="metrics">
                  {snapshot.isOriginalMember && (
                  <Metric
                    label="Deposited"
                    value={`${snapshot.deposited} mUSDT`}
                  />
                  )}
                  {snapshot.isOriginalMember && (
                  <Metric
                    label="Emergency (outside Aave)"
                    value={`${snapshot.emergencyBalance} mUSDT`}
                  />
                  )}
                  {snapshot.ownsLockedPosition && (
                  <Metric
                    label="Locked principal"
                    value={`${snapshot.lockedBalance} mUSDT`}
                  />
                  )}
                  {snapshot.ownsLockedPosition && snapshot.vaultMode === "earn" && (
                  <Metric
                    label="Generated yield"
                    value={`${snapshot.accruedYield} mUSDT`}
                  />
                  )}
                  {snapshot.ownsLockedPosition && !snapshot.isGroup && snapshot.currentValue !== snapshot.lockedBalance && (
                  <Metric
                    label="Current position value"
                    value={`${snapshot.currentValue} mUSDT`}
                  />
                  )}
                  {snapshot.ownsLockedPosition && snapshot.vaultMode === "earn" && (
                  <Metric
                    label={
                      usesMockYieldAdapter
                        ? "Simulated rate signal"
                        : "Variable APY"
                    }
                    value={
                      snapshot.variableApyPercent === null
                        ? "No yield"
                        : `${snapshot.variableApyPercent.toFixed(2)}% · ${
                            usesMockYieldAdapter
                              ? "test value"
                              : "not guaranteed"
                          }`
                    }
                  />
                  )}
                  {snapshot.ownsLockedPosition && !snapshot.isGroup && snapshot.vaultMode === "earn" && (
                  <Metric
                    label={
                      usesMockYieldAdapter
                        ? "Test yield adapter"
                        : "Aave supply"
                    }
                    value={
                      snapshot.vaultMode === "earn" ? (
                        explorerBaseUrl ? (
                          <a
                            href={`${explorerBaseUrl}/address/${snapshot.yieldAdapter}`}
                            rel="noreferrer"
                            target="_blank"
                          >
                            {usesMockYieldAdapter ? "Mock" : "Active"} ·{" "}
                            {short(snapshot.yieldAdapter)}
                          </a>
                        ) : (
                          `${
                            usesMockYieldAdapter ? "Mock" : "Active"
                          } · ${short(snapshot.yieldAdapter)}`
                        )
                      ) : (
                        "Not used"
                      )
                    }
                  />
                  )}
                  <Metric
                    label="Maturity"
                    value={snapshot.maturity.toLocaleString()}
                  />
                </div>
                <TrustSummary earn={snapshot.vaultMode === "earn"} />
                {snapshot.ownsLockedPosition && snapshot.vaultMode === "earn" && (
                  <div className="notice">
                    <strong>
                      {usesMockYieldAdapter
                        ? "Simulated testnet yield position"
                        : "Variable Aave position"}
                    </strong>
                    <span>
                      {usesMockYieldAdapter
                        ? "The locked portion is held by an isolated MockYieldAdapter. It gains simulated yield only when extra mUSDT is explicitly funded into that adapter; no tokens are sent to Aave."
                        : "Only the locked portion earns. Yield is not guaranteed and redemption depends on Aave liquidity and protocol conditions."}
                    </span>
                  </div>
                )}
                {snapshot.ownsLockedPosition && snapshot.aaveSafety && (
                  <div className={snapshot.aaveSafety.withdrawalTemporarilyUnavailable ? "notice error" : "notice"}>
                    <strong>Aave reserve status</strong>
                    <span>
                      {snapshot.aaveSafety.active ? "Active" : "Inactive"} ·{" "}
                      {snapshot.aaveSafety.frozen ? "Frozen" : "Not frozen"} ·{" "}
                      {snapshot.aaveSafety.paused ? "Paused" : "Not paused"}.{" "}
                      Available withdrawal liquidity: {snapshot.aaveSafety.availableLiquidity} USDT.
                      Supply: {snapshot.aaveSafety.currentSupply} USDT
                      {snapshot.aaveSafety.supplyCap === "0"
                        ? " with no configured cap."
                        : ` against a ${snapshot.aaveSafety.supplyCap} USDT cap.`}
                    </span>
                    <small>
                      Variable APY is not guaranteed. Earn mode carries Aave smart-contract,
                      USDT stablecoin and temporary liquidity risk. LockedIn Circle never
                      borrows against your funds and never enables them as collateral.
                    </small>
                  </div>
                )}
                </div>
                <div className="vault-tab-section" hidden={snapshot.isGroup && vaultDetailTab !== "withdraw"} role={snapshot.isGroup ? "tabpanel" : undefined}>
                {snapshot.ownsLockedPosition && (
                  <div className="maturity-action">
                    <div>
                      <strong>Maturity withdrawal</strong>
                      <span>
                        {Date.now() >= snapshot.maturity.getTime()
                          ? "Available now."
                          : `Available ${snapshot.maturity.toLocaleString()} · ${expiryCountdown(snapshot.maturity, clock)}`}
                      </span>
                      {withdrawalNeedsRetry && (
                        <small>
                          Redemption failed without burning your shares. You can
                          retry safely.
                        </small>
                      )}
                    </div>
                    {Date.now() >= snapshot.maturity.getTime() && (
                    <div className="segmented" aria-label="Withdrawal asset">
                      <button
                        className={receiveAsset === "usdt" ? "active" : ""}
                        onClick={() => setReceiveAsset("usdt")}
                        type="button"
                      >
                        Receive as USDT
                      </button>
                      {nimWithdrawalAvailable && <button
                        className={receiveAsset === "nim" ? "active" : ""}
                        onClick={() => setReceiveAsset("nim")}
                        type="button"
                      >
                        Receive as NIM
                      </button>}
                    </div>
                    )}
                  </div>
                )}
                {snapshot.ownsLockedPosition && Date.now() >= snapshot.maturity.getTime() && (receiveAsset === "usdt" || !nimWithdrawalAvailable) && (
                  <button
                    className="secondary"
                    disabled={
                      actionsDisabled ||
                      snapshot.lockedWithdrawn ||
                      Date.now() < snapshot.maturity.getTime()
                    }
                    onClick={() => void withdrawMaturedPosition()}
                  >
                    {withdrawalNeedsRetry
                      ? "Retry redemption"
                      : snapshot.lockedWithdrawn
                        ? "Withdrawn"
                        : "Withdraw at maturity as USDT"}
                  </button>
                )}
                {snapshot.ownsLockedPosition &&
                  Date.now() < snapshot.maturity.getTime() &&
                  !snapshot.isGroup &&
                  snapshot.isOriginalMember &&
                  snapshot.groupLifecycle !== "pending" && (
                    <button
                      className="exit-position-cta"
                      disabled={riskActionsDisabled}
                      onClick={() => navigate("market")}
                      type="button"
                    >
                      <span>
                        <HandCoins aria-hidden="true" size={20} />
                        <span>
                          <strong>
                            {selectedListing?.active &&
                            selectedListing.vault.toLowerCase() ===
                              snapshot.address.toLowerCase() &&
                            selectedListing.positionId === snapshot.positionId
                              ? "View active exit listing"
                              : "Exit this savings position"}
                          </strong>
                          <small>
                            The system calculates a 4.5%–8% discount. Selling permanently transfers your locked claim; emergency funds stay yours.
                          </small>
                        </span>
                      </span>
                      <ArrowRight aria-hidden="true" size={18} />
                    </button>
                  )}
                {snapshot.ownsLockedPosition &&
                  Date.now() >= snapshot.maturity.getTime() &&
                  receiveAsset === "nim" &&
                  nimWithdrawalAvailable &&
                  nimiqWallet &&
                  evmSession && (
                  <NimSwapFlow
                    adapter={swapAdapter}
                    flowKey={`withdraw:${snapshot.address}:${snapshot.positionId}:${evmSession.address}`}
                    kind="WITHDRAW_AS_NIM"
                    nimiqAddress={nimiqWallet.address}
                    polygonAddress={evmSession.address}
                    nimiqNetwork={
                      nimiqWallet.network === "testnet" ? "testnet" : "mainnet"
                    }
                    polygonNetwork={polygonSwapNetwork}
                    nimBalanceLuna={nimBalanceLuna}
                    usdtBalance={mockTokenBalance}
                    withdrawalUsdtAmount={parseAssetAmount(
                      snapshot.currentValue,
                      6
                    )}
                    onContractAction={withdrawMaturedPositionForSwap}
                    contractActionLabel="Withdraw USDT from vault"
                  />
                )}
                </div>
                <div className="action-grid">
                  {snapshot.ownsLockedPosition &&
                    snapshot.isOriginalMember &&
                    (!snapshot.isGroup || vaultDetailTab === "overview") &&
                    (!snapshot.isGroup || snapshot.groupLifecycle === "active") && (
                      <div className="funding-action">
                        <div className="deposit-currency-heading">
                          <div><strong>Make a contribution</strong><small>Choose how you want to fund this savings goal.</small></div>
                          <CurrencyToggle value={depositAsset} onChange={setDepositAsset} />
                        </div>
                        {depositAsset === "usdt" ? (
                          <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (depositAmountError) return;
                      void transactAndRefresh(
                        "Approving and depositing…",
                        () =>
                          depositToVault(
                            requireSession().signer,
                            snapshot.address,
                            snapshot.positionId,
                            depositAmount
                          ),
                        "Deposit confirmed.",
                        {
                          title: "You moved closer to your goal",
                          message: `This contribution puts you about ${depositDaysCloser} ${depositDaysCloser === 1 ? "day" : "days"} closer to your planned finish.`,
                        }
                      );
                    }}
                          >
                    <label>
                      <span>Deposit USDT</span>
                      <input
                        aria-describedby={depositAmountError ? "deposit-amount-error" : undefined}
                        aria-invalid={Boolean(depositAmountError)}
                        max={remainingGoal}
                        min="0.000001"
                        onChange={(event) =>
                          setDepositAmount(event.target.value)
                        }
                        step="0.000001"
                        type="number"
                        value={depositAmount}
                        placeholder="Example: 20"
                      />
                      <QuickAmounts values={[5, 10, 20]} unit="USDT" value={depositAmount} onSelect={setDepositAmount} />
                      {depositAmountError && <small className="field-error" id="deposit-amount-error">{depositAmountError}</small>}
                      {!depositAmountError && <small className="field-hint">Up to {amountLabel(remainingGoal)} mUSDT remains toward your goal.</small>}
                    </label>
                    <button className="primary" disabled={riskActionsDisabled || Boolean(depositAmountError) || remainingGoal <= 0}>
                      Deposit
                    </button>
                          </form>
                        ) : nimiqWallet && evmSession ? (
                          <NimSwapFlow
                      adapter={swapAdapter}
                      flowKey={`save:${snapshot.address}:${snapshot.positionId}:${evmSession.address}`}
                      kind="SAVE_WITH_NIM"
                      nimiqAddress={nimiqWallet.address}
                      polygonAddress={evmSession.address}
                      nimiqNetwork={
                        nimiqWallet.network === "testnet"
                          ? "testnet"
                          : "mainnet"
                      }
                      polygonNetwork={polygonSwapNetwork}
                      nimBalanceLuna={nimBalanceLuna}
                      usdtBalance={mockTokenBalance}
                      onContractAction={async (readyAmount) => {
                        const convertedAmount = Number(formatAssetAmount(readyAmount!, 6));
                        if (convertedAmount > remainingGoal + 0.0000001) {
                          throw new Error(`This exceeds your goal. You can save up to ${amountLabel(remainingGoal)} mUSDT more.`);
                        }
                        await assertWalletCanAffordTransaction();
                        return depositToVault(
                          requireSession().signer,
                          snapshot.address,
                          snapshot.positionId,
                          formatAssetAmount(readyAmount!, 6)
                        );
                      }}
                      contractActionLabel="Deposit ready USDT into vault"
                          />
                        ) : (
                          <div className="notice">
                            <span>
                              Connect both Nimiq Pay and an EVM wallet to save
                              with NIM.
                            </span>
                          </div>
                        )}
                      </div>
                    )}
                  {snapshot.isOriginalMember &&
                    (!snapshot.isGroup || vaultDetailTab === "withdraw") &&
                    Number(snapshot.emergencyBalance) > 0 && (
                  <form
                    className="emergency-withdrawal-card"
                    onSubmit={(event) => {
                      event.preventDefault();
                      if (withdrawAmountError) return;
                      void transactAndRefresh(
                        "Withdrawing emergency funds…",
                        () =>
                          withdrawEmergency(
                            requireSession().signer,
                            snapshot.address,
                            snapshot.positionId,
                            withdrawAmount
                          ),
                        "Emergency withdrawal confirmed.",
                        {
                          title: "Congratulations, savings habit unlocked",
                          message: "Your emergency funds are back in your wallet. Your recorded goal progress is unchanged.",
                        }
                      );
                    }}
                  >
                    <div>
                      <strong>Emergency withdrawal</strong>
                      <small>Available anytime. Withdrawing this balance does not reduce your recorded goal progress or reward eligibility.</small>
                    </div>
                    <label>
                      <span>Withdraw emergency funds</span>
                      <input
                        aria-describedby={withdrawAmountError ? "withdraw-amount-error" : undefined}
                        aria-invalid={Boolean(withdrawAmountError)}
                        max={snapshot.emergencyBalance}
                        min="0.000001"
                        onChange={(event) =>
                          setWithdrawAmount(event.target.value)
                        }
                        step="0.000001"
                        type="number"
                        value={withdrawAmount}
                        placeholder="Example: 10"
                      />
                      {withdrawAmountError && <small className="field-error" id="withdraw-amount-error">{withdrawAmountError}</small>}
                      {!withdrawAmountError && <small className="field-hint">Available: {snapshot.emergencyBalance} mUSDT.</small>}
                    </label>
                    <button className="secondary" disabled={actionsDisabled || Boolean(withdrawAmountError)}>
                      Withdraw emergency funds
                    </button>
                  </form>
                  )}
                </div>
                {snapshot.isGroup &&
                  vaultDetailTab === "withdraw" &&
                  snapshot.groupLifecycle === "active" &&
                  connectedMember && (
                  <Suspense fallback={<RouteLoading label="Loading group exit controls" />}>
                  <GroupManagementRoute>
                  <GroupExitPanel
                    activeMemberCount={
                      snapshot.members.filter(
                        (member) => member.status === "active"
                      ).length
                    }
                    clock={clock}
                    connectedAddress={connectedAddress ?? ""}
                    connectedMemberStatus={connectedMember.status}
                    connectedMemberProgress={
                      connectedMember.approvalProgressPercent / 100
                    }
                    maturity={snapshot.maturity}
                    ownsLockedPosition={snapshot.ownsLockedPosition}
                    lockedBalance={snapshot.lockedBalance}
                    disabled={actionsDisabled}
                    requests={groupExitRequests}
                    onApprove={(requestId) =>
                      void transactAndRefresh(
                        "Approving group exit…",
                        () =>
                          approveGroupExit(
                            requireSession().signer,
                            snapshot.address,
                            requestId
                          ),
                        "Group-exit approval recorded."
                      )
                    }
                    onAuthorize={(requestId) =>
                      void transactAndRefresh(
                        "Rechecking unanimous approval eligibility…",
                        () =>
                          authorizeGroupExit(
                            requireSession().signer,
                            snapshot.address,
                            requestId
                          ),
                        "Group exit authorized for 24 hours."
                      )
                    }
                    onCancel={(requestId) =>
                      void transactAndRefresh(
                        "Cancelling group exit…",
                        () =>
                          cancelGroupExit(
                            requireSession().signer,
                            snapshot.address,
                            requestId
                          ),
                        "Group-exit request cancelled."
                      )
                    }
                    onComplete={(requestId) =>
                      void transactAndRefresh(
                        "Withdrawing authorized group position…",
                        () =>
                          completeGroupExit(
                            requireSession().signer,
                            snapshot.address,
                            requestId
                          ),
                        "Cooperative group exit completed."
                      )
                    }
                    onMarket={() => {
                      window.location.hash = "/market";
                    }}
                    onRequest={() =>
                      void transactAndRefresh(
                        "Requesting unanimous group approval…",
                        () =>
                          requestGroupExit(
                            requireSession().signer,
                            snapshot.address
                          ),
                        "24-hour group-exit request created."
                      )
                    }
                    onRevoke={(requestId) =>
                      void transactAndRefresh(
                        "Revoking group-exit approval…",
                        () =>
                          revokeGroupExitApproval(
                            requireSession().signer,
                            snapshot.address,
                            requestId
                          ),
                        "Group-exit approval revoked."
                      )
                    }
                  />
                  </GroupManagementRoute>
                  </Suspense>
                )}
                {snapshot.isGroup && vaultDetailTab === "circle" && (
                  <div className="members">
                    <div className="section-title">
                      <div>
                        <h3>Circle progress</h3>
                        <p>
                          Every member has an independent balance and target.
                        </p>
                      </div>
                      <span>
                        {
                          snapshot.members.filter(
                            (member) => member.goalComplete
                          ).length
                        }
                        /{snapshot.members.length} complete
                      </span>
                    </div>
                    <div className="circle-summary-grid">
                      <Metric
                        label="Overall goal progress"
                        value={`${amountLabel(
                          snapshot.members.reduce((total, member) => total + Number(member.deposited), 0)
                        )} / ${amountLabel(
                          snapshot.members.reduce((total, member) => total + Number(member.target), 0)
                        )} mUSDT`}
                      />
                      <Metric
                        label="Active members"
                        value={`${snapshot.members.filter((member) => member.status === "active").length}`}
                      />
                      <Metric
                        label="Completed goals"
                        value={`${snapshot.members.filter((member) => member.goalComplete).length}`}
                      />
                      <Metric label="Minimum active members" value="4" />
                    </div>
                    <div className="member-table">
                      {snapshot.members.map((member) => {
                        const memberProgress = Math.min(
                          100,
                          (Number(member.deposited) / Number(member.target)) *
                            100
                        );
                        return (
                          <div className="member-row" key={member.member}>
                            <div>
                              <strong>{walletDisplayName(member.member)}</strong>
                              {member.member.toLowerCase() ===
                                connectedAddress && (
                                <span className="you">You</span>
                              )}
                              <details className="member-address">
                                <summary>{short(member.member)}</summary>
                                <div>
                                  <code>{member.member}</code>
                                  <button
                                    aria-label={`Copy ${walletDisplayName(member.member)} wallet address`}
                                    onClick={() => void navigator.clipboard.writeText(member.member)}
                                    type="button"
                                  >
                                    Copy
                                  </button>
                                </div>
                              </details>
                            </div>
                            <div>
                              <span>
                                {member.deposited} / {member.target} mUSDT
                              </span>
                              <div className="mini-progress">
                                <i style={{ width: `${memberProgress}%` }} />
                              </div>
                              <small>
                                Active principal: {member.activePrincipal} mUSDT ·{" "}
                                {member.approvalProgressPercent.toFixed(1)}% ·{" "}
                                {member.approvalEligible
                                  ? "approval eligible"
                                  : "25% required"}
                              </small>
                            </div>
                            <span
                              className={
                                member.goalComplete
                                  ? "status-pill complete"
                                  : "status-pill"
                              }
                            >
                              {member.status === "cooperative-exit"
                                ? "Cooperative exit"
                                : member.status === "market-exit"
                                ? "Market exit"
                                : member.status === "matured"
                                ? "Matured"
                                : member.goalComplete
                                ? "Complete"
                                : `${memberProgress.toFixed(0)}%`}
                            </span>
                          </div>
                        );
                      })}
                    </div>
                  </div>
                )}
                {snapshot.isGroup && vaultDetailTab === "activity" && (
                  <section className="vault-activity-tab" role="tabpanel">
                    <div className="section-title">
                      <div>
                        <h3>Vault activity</h3>
                        <p>Confirmed on-chain events for this group vault.</p>
                      </div>
                    </div>
                    {selectedVaultActivity.length === 0 ? (
                      <div className="empty-mini">No activity found for this vault.</div>
                    ) : (
                      <div className="vault-activity-list">
                        {selectedVaultActivity.map((item) => (
                          <article key={item.id}>
                            <span className="activity-icon"><History aria-hidden="true" size={15} /></span>
                            <div>
                              <strong>{item.title}</strong>
                              <span>{item.detail}</span>
                              <time dateTime={item.timestamp.toISOString()}>{item.timestamp.toLocaleString()}</time>
                            </div>
                            {explorerBaseUrl ? (
                              <a href={`${explorerBaseUrl}/tx/${item.transactionHash}`} rel="noreferrer" target="_blank">
                                {short(item.transactionHash)}
                              </a>
                            ) : (
                              <code>{short(item.transactionHash)}</code>
                            )}
                          </article>
                        ))}
                      </div>
                    )}
                    <details className="technical-details">
                      <summary>Technical details</summary>
                      <dl>
                        <div><dt>Vault contract</dt><dd><code>{snapshot.address}</code></dd></div>
                        <div><dt>Position ID</dt><dd>{snapshot.positionId.toString()}</dd></div>
                        <div><dt>Yield adapter</dt><dd><code>{snapshot.yieldAdapter}</code></dd></div>
                        <div><dt>Deployment ID</dt><dd><code>{deployment.status === "valid" ? deployment.value.deploymentId : "Unavailable"}</code></dd></div>
                        <div><dt>Network</dt><dd>{networkName}</dd></div>
                        <div><dt>Chain ID</dt><dd>{evmSession?.chainId ?? "Unavailable"}</dd></div>
                      </dl>
                    </details>
                  </section>
                )}
              </>
            ) : (
              <div className="empty-state">
                Connect an EVM wallet and select one of your vaults.
              </div>
            )}
          </article>
        </section>
      )}

      {!deploymentBlocked && route === "market" && (
        <Suspense fallback={<RouteLoading label="Loading early withdrawals" />}>
        <MarketRoute>
          <div className="market-flowline" aria-label="How an early withdrawal works">
            <span>Request an exit</span>
            <ArrowRight aria-hidden="true" size={15} />
            <span>Your payout is calculated</span>
            <ArrowRight aria-hidden="true" size={15} />
            <span>First funder completes it</span>
          </div>
          <div className="panel view-switch swipe-tabs" aria-label="Early withdrawal view" {...marketTabSwipe}>
            <button
              className={marketView === "fund" ? "active" : ""}
              onClick={() => setMarketView("fund")}
            >
              Fund an exit
            </button>
            <button
              className={marketView === "mine" ? "active" : ""}
              onClick={() => setMarketView("mine")}
            >
              My exit requests
            </button>
            <button
              className={marketView === "recent" ? "active" : ""}
              onClick={() => {
                setMarketView("recent");
                setMarketPositionPickerOpen(false);
                setSnapshot(null);
                setExitState(null);
              }}
            >
              Recent exits
            </button>
          </div>
          {marketView !== "recent" ? (
            <>
            <div className="market-layout">
          <aside className="panel market-browser">
            <div className="section-title">
              <div>
                <h2>{marketView === "mine" ? "My exit requests" : "Fund an early withdrawal"}</h2>
                <p>{marketView === "mine" ? "Create, review or cancel your own early-withdrawal requests." : "Help another saver withdraw early and receive their future savings claim."}</p>
              </div>
              {marketView === "mine" && <button
                className="secondary compact icon-action"
                disabled={riskActionsDisabled}
                onClick={() => {
                  setSnapshot(null);
                  setExitState(null);
                  setMarketPositionPickerOpen(true);
                }}
                type="button"
              >
                <HandCoins aria-hidden="true" size={14} /> Request early exit
              </button>}
              <button
                className="icon-button"
                disabled={riskActionsDisabled}
                onClick={() => void refreshPortfolio()}
                title="Refresh"
              >
                ↻
              </button>
            </div>
            <div className="filter-row swipe-tabs" {...listingFilterSwipe}>
              {LISTING_FILTER_TABS.map(
                (filter) => (
                  <button
                    className={listingFilter === filter ? "active" : ""}
                    key={filter}
                    onClick={() => setListingFilter(filter)}
                  >
                    {filter}
                  </button>
                )
              )}
            </div>
            <div className="listing-list">
              {filteredListings.length === 0 ? (
                <div className="market-empty-list">
                  <Suspense fallback={<div className="trade-animation-fallback" />}>
                    <TradeCompletionAnimation />
                  </Suspense>
                  <strong>{marketView === "mine" ? "You have no open exit requests" : "No early withdrawals need funding right now"}</strong>
                  <span>{marketView === "mine" ? "Choose one of your active savings positions when you need to withdraw early." : "New saver requests will appear here at their contract-calculated payout."}</span>
                  {marketView === "mine" && <button
                    className="secondary compact"
                    disabled={riskActionsDisabled}
                    onClick={() => setMarketPositionPickerOpen(true)}
                    type="button"
                  >
                    Request early exit
                  </button>}
                </div>
              ) : (
                filteredListings.map(
                  (entry) =>
                    entry.listing && (
                      <button
                        className={
                          selectedListing?.id === entry.listing.id
                            ? "listing-card selected"
                            : "listing-card"
                        }
                        key={entry.listing.id.toString()}
                        onClick={() => {
                          setSnapshot(null);
                          setMarketPositionPickerOpen(false);
                          setExitState(entry);
                        }}
                      >
                        <div className={`listing-art ${entry.listing.isGroup ? "group" : "personal"}`}>
                          <div className="listing-art-top">
                            <span>{vaultType(entry.listing.isGroup)}</span>
                            <code>#{entry.listing.id.toString()}</code>
                          </div>
                          <span className="listing-art-mark">
                            {entry.listing.isGroup ? (
                              <UsersRound aria-hidden="true" size={30} />
                            ) : (
                              <Vault aria-hidden="true" size={30} />
                            )}
                          </span>
                          <div className="listing-art-value">
                            <small>Locked claim</small>
                            <strong>{entry.listing.currentClaimValue}</strong>
                            <b>mUSDT</b>
                          </div>
                        </div>
                        <div className="listing-card-copy">
                          <span className="listing-card-heading">
                            <strong>{vaultType(entry.listing.isGroup)} savings exit</strong>
                          </span>
                          <div className="buyer-listing-facts">
                            <span>
                              <small>Buy at a discount</small>
                              <strong>{entry.reference.discountPercent.toFixed(2)}% off</strong>
                              <em>{entry.listing.currentProviderPotentialReturn} mUSDT before fee</em>
                            </span>
                            <span>
                              <small>Unlocks in</small>
                              <strong>{daysUntil(entry.listing.maturity)} days</strong>
                              <em>{entry.listing.maturity.toLocaleDateString()}</em>
                            </span>
                          </div>
                          <b>Pay {entry.listing.currentTotalProviderPaid} mUSDT</b>
                          <code>{walletDisplayName(entry.listing.seller)}</code>
                        </div>
                      </button>
                    )
                )
              )}
            </div>
          </aside>
            </div>
            {(marketPositionPickerOpen ||
              canComposeListing ||
              ownActiveListing ||
              selectedListing?.active) && (
              <>
                <button
                  aria-label="Close market details"
                  className="market-sheet-backdrop"
                  onClick={() => {
                    setMarketPositionPickerOpen(false);
                    setSnapshot(null);
                    setExitState(null);
                  }}
                  type="button"
                />
                <article className="panel market-detail market-detail-sheet" role="dialog" aria-modal="true">
                  <div className="sheet-grabber" />
                  <button
                    className="mobile-detail-back"
                    onClick={() => {
                      setMarketPositionPickerOpen(false);
                      setSnapshot(null);
                      setExitState(null);
                    }}
                    type="button"
                  >
                    <X aria-hidden="true" size={16} /> Close details
                  </button>
            {marketPositionPickerOpen ? (
              <div className="market-position-sheet">
                <div className="section-title">
                  <div>
                    <h2>Choose a position to list</h2>
                    <p>The next screen shows the contract-calculated exit price.</p>
                  </div>
                </div>
                <div className="market-position-picker">
                  {marketEligibleVaults.length === 0 ? (
                    <div className="market-no-position">
                      <HandCoins aria-hidden="true" size={24} />
                      <strong>No position is ready to list</strong>
                      <span>Active listings and matured positions are excluded.</span>
                    </div>
                  ) : (
                    marketEligibleVaults.map((vault) => (
                      <button
                        key={`exit-${vault.address}-${vault.positionId.toString()}`}
                        onClick={() => {
                          void openVault(vault.address, vault.positionId)
                            .then(() => setMarketPositionPickerOpen(false))
                            .catch((error) =>
                              setTransaction({
                                status: "error",
                                message: describeContractError(error),
                              })
                            );
                        }}
                        type="button"
                      >
                        <span className={`tag ${vault.isGroup ? "group" : "personal"}`}>
                          {vaultType(vault.isGroup)}
                        </span>
                        <strong>{vault.deposited} mUSDT saved</strong>
                        <small>{vault.progressPercent.toFixed(0)}% of goal</small>
                        <ArrowRight aria-hidden="true" size={16} />
                      </button>
                    ))
                  )}
                </div>
              </div>
            ) : canComposeListing && snapshot ? (
              <ListingComposer
                snapshot={snapshot}
                exitState={exitState}
                expiration={exitExpiration}
                claim={projectedSaverPayout}
                fee={projectedFee}
                minimumPayout={minimumPayout}
                disabled={riskActionsDisabled}
                onExpiration={setExitExpiration}
                onMinimumPayout={setMinimumPayout}
                onSubmit={() =>
                  void transactAndRefresh(
                    exitState?.listing
                      ? "Relisting position…"
                      : "Creating early-exit request…",
                    () =>
                      createExitListing(
                        requireSession().signer,
                        snapshot,
                        exitExpiration,
                        minimumPayout
                      ),
                    exitState?.listing
                      ? "Position relisted."
                      : "Early-exit listing created."
                  )
                }
              />
            ) : ownActiveListing && snapshot && selectedListing ? (
              <div className="saver-listing-success">
                <div className="saver-listing-copy">
                  <span className={`tag ${snapshot.isGroup ? "group" : "personal"}`}>
                    {vaultType(snapshot.isGroup)} position is live
                  </span>
                  <blockquote>
                    Don&apos;t cry because it&apos;s over. Smile because it happened.
                  </blockquote>
                  <p>
                    The first provider to fund this listing receives the locked
                    claim. Until then, you can still cancel it.
                  </p>
                </div>
                <Suspense fallback={<div className="trade-animation-fallback" />}>
                  <SaverListingAnimation />
                </Suspense>
                <div className="saver-payout-ticket">
                  <span>Receive when funded</span>
                  <strong>{selectedListing.currentSaverPayout}</strong>
                  <b>mUSDT</b>
                </div>
                <div className="listing-streak-grid">
                  <span>
                    <small>Savings progress</small>
                    <strong>{progress.toFixed(0)}%</strong>
                  </span>
                  <span>
                    <small>Confirmed deposits</small>
                    <strong>{selectedVaultDeposits.length}</strong>
                  </span>
                  <span>
                    <small>Latest contribution</small>
                    <strong>
                      {selectedVaultDeposits[0]?.timestamp.toLocaleDateString() ?? "No history"}
                    </strong>
                  </span>
                </div>
                <button
                  className="secondary"
                  disabled={actionsDisabled}
                  onClick={() =>
                    void transactAndRefresh(
                      "Cancelling listing…",
                      () => cancelExitListing(requireSession().signer, selectedListing.id),
                      "Listing cancelled. You can relist this position."
                    )
                  }
                  type="button"
                >
                  Cancel listing
                </button>
              </div>
            ) : selectedListing?.active ? (
              <>
                <div className="segmented" aria-label="Claim payment asset">
                  <button
                    className={purchaseAsset === "nim" ? "active" : ""}
                    onClick={() => setPurchaseAsset("nim")}
                    type="button"
                  >
                    Pay with NIM
                  </button>
                  <button
                    className={purchaseAsset === "usdt" ? "active" : ""}
                    onClick={() => setPurchaseAsset("usdt")}
                    type="button"
                  >
                    Pay with USDT
                  </button>
                </div>
                <ListingDetail
                entry={exitState!}
                connectedAddress={connectedAddress}
                disabled={actionsDisabled}
                fundDisabled={riskActionsDisabled || purchaseAsset === "nim" || Boolean(listingFundingError)}
                fundError={listingFundingError}
                onCancel={() =>
                  void transactAndRefresh(
                    "Cancelling listing…",
                    () =>
                      cancelExitListing(
                        requireSession().signer,
                        selectedListing.id
                      ),
                    "Listing cancelled. You can relist this position."
                  )
                }
                onFund={() =>
                  void transactAndRefresh(
                    "Funding listing at the live system price…",
                    () =>
                      fundExitListing(
                        requireSession().signer,
                        selectedListing.id
                      ),
                    "Listing funded and locked claim transferred."
                  )
                }
                />
                {purchaseAsset === "nim" &&
                selectedListing.seller.toLowerCase() !== connectedAddress &&
                nimiqWallet && evmSession && (
                  <NimSwapFlow
                  adapter={swapAdapter}
                  flowKey={`purchase:${selectedListing.id}:${evmSession.address}`}
                  kind="PURCHASE_WITH_NIM"
                  nimiqAddress={nimiqWallet.address}
                  polygonAddress={evmSession.address}
                  nimiqNetwork={
                    nimiqWallet.network === "testnet" ? "testnet" : "mainnet"
                  }
                  polygonNetwork={polygonSwapNetwork}
                  nimBalanceLuna={nimBalanceLuna}
                  usdtBalance={mockTokenBalance}
                  exactUsdtRequired={parseAssetAmount(
                    selectedListing.currentTotalProviderPaid,
                    6
                  )}
                  onContractAction={async () => {
                    await assertWalletCanAffordTransaction();
                    const maximum = parseAssetAmount(
                      selectedListing.currentTotalProviderPaid,
                      6
                    );
                    await fundExitListing(
                      requireSession().signer,
                      selectedListing.id,
                      maximum
                    );
                    await refreshPortfolio();
                  }}
                  contractActionLabel="Refresh listing and purchase claim"
                  />
                )}
              </>
            ) : null}
                </article>
              </>
            )}
            </>
          ) : (
            <article className="panel recent-trades-panel">
              <div className="section-title">
                <div>
                  <h2>Recent savings exits</h2>
                  <p>
                    Completed early withdrawals, shown for transparency.
                  </p>
                </div>
                <button
                  className="secondary"
                  disabled={!deploymentReady}
                  onClick={() => void refreshPublicTradeHistory()}
                >
                  Refresh
                </button>
              </div>
              {publicTradesError && (
                <div className="notice error">
                  <strong>Recent exits unavailable</strong>
                  <span>{publicTradesError}</span>
                </div>
              )}
              <RecentTradeTable
                trades={completedTrades}
                explorerBaseUrl={explorerBaseUrl}
              />
            </article>
          )}
        </MarketRoute>
        </Suspense>
      )}

      {!deploymentBlocked && route === "activity" && (
        <Suspense fallback={<RouteLoading label="Loading history" />}>
        <ActivityRoute>
          <div className="panel view-switch swipe-tabs" aria-label="History view" {...historyTabSwipe}>
            <button
              className={historyView === "trades" ? "active" : ""}
              onClick={() => setHistoryView("trades")}
            >
              My completed exits
            </button>
            <button
              className={historyView === "events" ? "active" : ""}
              onClick={() => setHistoryView("events")}
            >
              Vault activity
            </button>
          </div>
          {historyView === "trades" && (
            <div className="trade-history-layout">
              <aside className="panel trade-history-list">
                <div className="section-title">
                  <div>
                    <h2>Your completed exits</h2>
                    <p>Early withdrawals you requested or helped fund.</p>
                  </div>
                  <button
                    className="icon-button"
                    disabled={actionsDisabled}
                    onClick={() => void refreshPortfolio()}
                    title="Refresh"
                  >
                    <RefreshCw aria-hidden="true" size={16} />
                  </button>
                </div>
                {myCompletedTrades.length === 0 ? (
                  <div className="empty-mini">You have no completed exits yet.</div>
                ) : (
                  myCompletedTrades.map((trade) => {
                    const role =
                      trade.seller.toLowerCase() === connectedAddress
                        ? "Saver"
                        : "Exit funder";
                    return (
                      <button
                        className={
                          selectedCompletedTrade?.listingId === trade.listingId
                            ? "trade-history-row selected"
                            : "trade-history-row"
                        }
                        key={trade.listingId.toString()}
                        onClick={() =>
                          setSelectedTradeId(trade.listingId.toString())
                        }
                      >
                        <span>
                          <span
                            className={`tag ${
                              trade.isGroup ? "group" : "personal"
                            }`}
                          >
                            {vaultType(trade.isGroup)}
                          </span>
                          <small>{role}</small>
                        </span>
                        <strong>Exit #{trade.listingId.toString()}</strong>
                        <small>{trade.timestamp.toLocaleString()}</small>
                      </button>
                    );
                  })
                )}
              </aside>
              <article className="panel trade-receipt-shell">
                {selectedCompletedTrade ? (
                  <TradeReceiptCard
                    trade={selectedCompletedTrade}
                    connectedAddress={connectedAddress!}
                    explorerBaseUrl={explorerBaseUrl}
                  />
                ) : (
                  <div className="empty-state">
                    Your completed savings exits will appear here.
                  </div>
                )}
              </article>
            </div>
          )}
          {historyView === "events" && (
          <article className="panel activity-panel">
            <div className="section-title">
              <div>
                <h2>On-chain activity</h2>
                <p>
                  Transactions involving vaults connected to this EVM account.
                </p>
              </div>
              <button
                className="secondary"
                disabled={actionsDisabled}
                onClick={() => void refreshPortfolio()}
              >
                Refresh
              </button>
            </div>
            {activity.length === 0 ? (
              <div className="empty-state compact-empty">
                No activity found.
              </div>
            ) : (
              <div className="timeline">
                {activity.map((item) => (
                  <div className="timeline-item" key={item.id}>
                    <span className="timeline-dot" />
                    <div>
                      <strong>{item.title}</strong>
                      <p>{item.detail}</p>
                      <small>
                        {item.timestamp.toLocaleString()} · Block{" "}
                        {item.blockNumber}
                      </small>
                      {item.vault && <code>{short(item.vault)}</code>}
                    </div>
                    {explorerBaseUrl ? (
                      <a
                        href={`${explorerBaseUrl}/tx/${item.transactionHash}`}
                        rel="noreferrer"
                        target="_blank"
                        title="Open transaction in the configured explorer"
                      >
                        {short(item.transactionHash)}
                      </a>
                    ) : (
                      <code title={item.transactionHash}>
                        {short(item.transactionHash)}
                      </code>
                    )}
                  </div>
                ))}
              </div>
            )}
          </article>
          )}
        </ActivityRoute>
        </Suspense>
      )}

      {!deploymentBlocked && route === "rewards" && (
        <Suspense fallback={<RouteLoading label="Loading rewards" />}>
          <RewardsRoute />
        </Suspense>
      )}

      {route === "wallet" && (
        <section className="panel route-page wallet-page">
          <div className="panel-heading">
            <div>
              <span className="step">05</span>
              <div>
                <h2>Wallet connections</h2>
                <p>Nimiq identity and EVM ownership are separate.</p>
              </div>
            </div>
          </div>
          <div className="wallet-details">
            <div>
              <small>Nimiq Pay</small>
              <strong>
                {nimiq.status === "connected"
                  ? nimiq.wallet.address
                  : "Not connected"}
              </strong>
              <span>Native Nimiq identity.</span>
            </div>
            <div>
              <small>EVM signer</small>
              <strong>{evmSession?.address ?? "Not connected"}</strong>
              <span>Owns vault positions and signs transactions.</span>
            </div>
            <div>
              <small>Network</small>
              <strong>{evmSession?.chainId ?? "Unavailable"}</strong>
              <span>
                {evmSession
                  ? `${networkName} · ${evmSession.source}`
                  : "No signer selected"}
              </span>
            </div>
          </div>
          {mockTokenFaucetEnabled && deploymentReady && evmSession && (
            <div className="test-token-card">
              <div>
                <small>Amoy test balance</small>
                <strong>{mockTokenBalance ?? "Loading…"} mUSDT</strong>
                <span>
                  MockUSDT has no real value. Your wallet pays only Amoy POL gas
                  for this mint transaction.
                </span>
              </div>
              <button
                className="secondary"
                disabled={actionsDisabled}
                onClick={requestTestFunds}
                type="button"
              >
                Get 250 test mUSDT
              </button>
            </div>
          )}
          {evmSession?.source === "hardhat-development" &&
            developmentAccounts.length > 0 && (
              <label className="dev-account">
                <span>Local test account</span>
                <select
                  value={developmentAccounts.findIndex(
                    (address) => address.toLowerCase() === connectedAddress
                  )}
                  onChange={(event) =>
                    void connectEvm(Number(event.target.value))
                  }
                >
                  {developmentAccounts.map((address, index) => (
                    <option key={address} value={index}>
                      Account #{index} · {short(address)}
                    </option>
                  ))}
                </select>
                <small>
                  Development only. This switches the unlocked signer without
                  using a private key in `.env`.
                </small>
              </label>
            )}
          {developmentFallbackEnabled &&
            evmSession?.source !== "hardhat-development" && (
              <button
                className="secondary"
                disabled={transaction.status === "pending"}
                onClick={() => void connectEvm(0)}
                type="button"
              >
                Use explicit local test account
              </button>
            )}
        </section>
      )}

      {celebration && (
        <div className="celebration-layer" role="dialog" aria-modal="true" aria-labelledby="celebration-title">
          <button aria-label="Close celebration" className="overlay-backdrop" onClick={() => setCelebration(null)} type="button" />
          <article className="celebration-card">
            <span className="celebration-watermark" aria-hidden="true"><Check /></span>
            <small>LockedIn milestone</small>
            <h2 id="celebration-title">{celebration.title}</h2>
            <p>{celebration.message}</p>
            <button className="primary full-width" onClick={() => setCelebration(null)} type="button">Keep saving</button>
          </article>
        </div>
      )}

      {transaction.status !== "idle" && (
        <div
          className={`transaction ${transaction.status}`}
          role={transaction.status === "error" ? "alert" : "status"}
        >
          {transaction.status === "success" && (
            <span className="transaction-watermark" aria-hidden="true">
              <Check />
            </span>
          )}
          <span>{transaction.status}</span>
          <p>{transaction.message}</p>
          {transaction.status === "error" && evmSession && deployment.status === "valid" && (
            <button
              className="secondary compact"
              onClick={() => void refreshPortfolio()}
              type="button"
            >
              Retry chain reads
            </button>
          )}
        </div>
      )}
      <nav className="bottom-nav" aria-label="Quick navigation">
        <button className={route === "discover" ? "active" : ""} onClick={() => navigate("discover")} type="button"><Home aria-hidden="true" />Discover</button>
        <button className={route === "position" || route === "groups" ? "active" : ""} onClick={() => navigate("position")} type="button"><Vault aria-hidden="true" />Vaults</button>
        <button className={route === "vaults" ? "active create" : "create"} onClick={() => navigate("vaults")} type="button"><Plus aria-hidden="true" />Create</button>
        <button className={route === "market" ? "active" : ""} onClick={() => navigate("market")} type="button"><HandCoins aria-hidden="true" />Exit</button>
        <button className={profileOpen ? "active" : ""} onClick={() => walletAccessReady ? setProfileOpen(true) : setConnectionSheetOpen(true)} type="button"><UserRound aria-hidden="true" />Profile</button>
      </nav>
      <aside className="testnet-banner" aria-label="Test deployment status">
        <span className="testnet-dot" aria-hidden="true" />
        <strong>Polygon Amoy</strong>
        <span>Mock USDT</span>
        <span>Simulated yield</span>
        <span>Unaudited test deployment</span>
      </aside>
    </main>
  );
}

function RecentTradeTable({
  trades,
  explorerBaseUrl,
}: {
  trades: CompletedTrade[];
  explorerBaseUrl?: string;
}) {
  if (trades.length === 0)
    return <div className="empty-state compact-empty">No completed savings exits yet.</div>;

  return (
    <div className="recent-trade-grid">
      {trades.map((trade) => (
        <article className="recent-trade-card" key={trade.listingId.toString()}>
          <header>
            <span className={`tag ${trade.isGroup ? "group" : "personal"}`}>
              {vaultType(trade.isGroup)} position
            </span>
            <strong>Exit #{trade.listingId.toString()}</strong>
            <time dateTime={trade.timestamp.toISOString()}>
              {trade.timestamp.toLocaleDateString()}
            </time>
          </header>
          <div className="trade-card-values">
            <span><small>Seller payout</small><strong>{trade.saverPayout} mUSDT</strong></span>
            <span><small>Discount</small><strong>{trade.systemDiscountPercent.toFixed(2)}%</strong></span>
            <span><small>Claim acquired</small><strong>{trade.claimValue} mUSDT</strong></span>
          </div>
          <div className="trade-card-wallets">
            <span><small>Seller</small><code>{walletDisplayName(trade.seller)}</code></span>
            <ArrowRight aria-hidden="true" size={14} />
            <span><small>Provider</small><code>{walletDisplayName(trade.provider)}</code></span>
          </div>
          {explorerBaseUrl ? (
            <a
              className="trade-explorer-link"
              href={`${explorerBaseUrl}/tx/${trade.transactionHash}`}
              rel="noreferrer"
              target="_blank"
            >
              View on PolygonScan ↗
            </a>
          ) : (
            <code>{short(trade.transactionHash)}</code>
          )}
        </article>
      ))}
    </div>
  );
}

function TradeReceiptCard({
  trade,
  connectedAddress,
  explorerBaseUrl,
}: {
  trade: CompletedTrade;
  connectedAddress: string;
  explorerBaseUrl?: string;
}) {
  const isSaver = trade.seller.toLowerCase() === connectedAddress.toLowerCase();
  return (
    <div className="trade-receipt">
      <header>
        <div>
            <span className="eyebrow">LockedIn Circle · Exit receipt</span>
          <h2>Savings exit #{trade.listingId.toString()}</h2>
          <p>Finalized on Polygon Amoy</p>
        </div>
        <span className="receipt-status">Completed</span>
      </header>
      <div className="receipt-summary">
        <div>
          <small>Your role</small>
          <strong>{isSaver ? "Saver" : "Exit funder"}</strong>
        </div>
        <div>
          <small>Position type</small>
          <strong>{vaultType(trade.isGroup)}</strong>
        </div>
        <div>
          <small>Completed</small>
          <strong>{trade.timestamp.toLocaleString()}</strong>
        </div>
      </div>
      <div className="trade-completion-visual" aria-label="Completed trade participants">
        <div className="receipt-trader">
          <span>{walletAvatarLabel(trade.seller)}</span>
          <small>Saver</small>
          <code>{walletDisplayName(trade.seller)}</code>
        </div>
        <Suspense fallback={<div className="trade-animation-fallback" />}>
          <TradeCompletionAnimation />
        </Suspense>
        <div className="receipt-trader">
          <span>{walletAvatarLabel(trade.provider)}</span>
          <small>Provider</small>
          <code>{walletDisplayName(trade.provider)}</code>
        </div>
      </div>
      <div className="receipt-amount">
        <span><b>Pay</b><em>Completed</em></span>
        <div><small>USDT</small><strong>{isSaver ? "+" : ""}{isSaver ? trade.saverPayout : trade.claimValue}</strong></div>
        <small>
          {isSaver
            ? "Paid directly to your connected wallet. Confirm it in your wallet activity or on the explorer."
            : `Acquired after a ${trade.systemDiscountPercent.toFixed(2)}% system discount.`}
        </small>
      </div>
      <div className="receipt-grid">
        <Metric label="Provider fee (0.9%)" value={`${trade.providerFee} mUSDT`} />
        <Metric
          label="Total provider paid"
          value={`${trade.totalProviderPaid} mUSDT`}
        />
        <Metric
          label="Provider potential return"
          value={`${trade.providerPotentialReturn} mUSDT`}
        />
        <Metric label="Position ID" value={`#${trade.positionId.toString()}`} />
      </div>
      <dl className="receipt-parties">
        <div>
          <dt>Saver</dt>
          <dd>{trade.seller}</dd>
        </div>
        <div>
          <dt>Exit funder</dt>
          <dd>{trade.provider}</dd>
        </div>
        <div>
          <dt>Vault</dt>
          <dd>{trade.vault}</dd>
        </div>
      </dl>
      <footer>
        <span>Block {trade.blockNumber}</span>
        {explorerBaseUrl ? (
          <a
            href={`${explorerBaseUrl}/tx/${trade.transactionHash}`}
            rel="noreferrer"
            target="_blank"
          >
            Verify on explorer ↗
          </a>
        ) : (
          <code>{trade.transactionHash}</code>
        )}
      </footer>
    </div>
  );
}

function WalletChip({ label, address }: { label: string; address: string }) {
  return (
    <div className="wallet-chip">
      <span className="status-dot" />
      <div>
        <small>{label}</small>
        <code>{address}</code>
      </div>
    </div>
  );
}

function RouteLoading({ label }: { label: string }) {
  return (
    <section className="route-page" aria-busy="true" aria-live="polite">
      <div className="panel empty-state">{label}…</div>
    </section>
  );
}

function Metric({ label, value }: { label: string; value: ReactNode }) {
  return (
    <div>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
  );
}

function expiryCountdown(expiresAt: Date, clock: number): string {
  const remaining = Math.max(0, expiresAt.getTime() - clock);
  if (remaining === 0) return "Expired";
  const totalSeconds = Math.floor(remaining / 1_000);
  const days = Math.floor(totalSeconds / 86_400);
  const hours = Math.floor((totalSeconds % 86_400) / 3_600);
  const minutes = Math.floor((totalSeconds % 3_600) / 60);
  const seconds = totalSeconds % 60;
  return `${days}d ${hours}h ${minutes}m ${seconds}s remaining`;
}

function GroupInvitationPanel({
  snapshot,
  clock,
  disabled,
  onAccept,
  onDecline,
  onCancel,
}: {
  snapshot: VaultSnapshot;
  clock: number;
  disabled: boolean;
  onAccept: () => void;
  onDecline: () => void;
  onCancel: () => void;
}) {
  const invitationExpired = Boolean(
    snapshot.invitationExpiresAt &&
      snapshot.invitationExpiresAt.getTime() <= clock
  );
  const canAnswer =
    snapshot.groupLifecycle === "pending" &&
    !invitationExpired &&
    !snapshot.connectedInvitationAccepted &&
    !snapshot.connectedInvitationDeclined;
  const isCreator =
    snapshot.groupCreator.toLowerCase() === snapshot.signerAddress.toLowerCase();
  const canCancel =
    isCreator &&
    (snapshot.groupLifecycle === "declined" ||
      snapshot.groupLifecycle === "expired" ||
      invitationExpired);

  return (
    <section className="group-invitation-panel">
      <div className="section-title">
        <div>
          <span className={`listing-status ${snapshot.groupLifecycle}`}>
            {invitationExpired && snapshot.groupLifecycle === "pending"
              ? "expired"
              : snapshot.groupLifecycle}
          </span>
          <h3>Group invitation</h3>
          <p>
            Review every member and the immutable savings terms below. Deposits,
            rewards and exits remain disabled until all invited wallets accept.
          </p>
        </div>
        {snapshot.invitationExpiresAt && (
          <strong>{expiryCountdown(snapshot.invitationExpiresAt, clock)}</strong>
        )}
      </div>
      <div className="metrics invitation-terms">
        <Metric label="Your target" value={`${snapshot.target} mUSDT`} />
        <Metric label="Maturity" value={snapshot.maturity.toLocaleString()} />
        <Metric label="Mode" value={snapshot.vaultMode === "earn" ? "Earn" : "Safe"} />
        <Metric
          label="Emergency allocation"
          value={`${snapshot.emergencyPercent}%`}
        />
      </div>
      <div className="invitation-members">
        {snapshot.members.map((member) => (
          <div key={member.member}>
            <code>{member.member}</code>
            <span>
              {member.invitationDeclined
                ? "Declined"
                : member.invitationAccepted
                  ? "Accepted"
                  : "Awaiting response"}
            </span>
          </div>
        ))}
      </div>
      <div className="group-exit-actions">
        {canAnswer && (
          <>
            <button className="primary" disabled={disabled} onClick={onAccept}>
              Accept complete terms
            </button>
            <button className="secondary" disabled={disabled} onClick={onDecline}>
              Decline
            </button>
          </>
        )}
        {canCancel && (
          <button className="secondary" disabled={disabled} onClick={onCancel}>
            Cancel unactivated group
          </button>
        )}
      </div>
    </section>
  );
}

function GroupExitPanel({
  requests,
  activeMemberCount,
  connectedAddress,
  connectedMemberStatus,
  connectedMemberProgress,
  maturity,
  ownsLockedPosition,
  lockedBalance,
  clock,
  disabled,
  onRequest,
  onApprove,
  onAuthorize,
  onRevoke,
  onCancel,
  onComplete,
  onMarket,
}: {
  requests: GroupExitRequestSnapshot[];
  activeMemberCount: number;
  connectedAddress: string;
  connectedMemberStatus: VaultSnapshot["members"][number]["status"];
  connectedMemberProgress: number;
  maturity: Date;
  ownsLockedPosition: boolean;
  lockedBalance: string;
  clock: number;
  disabled: boolean;
  onRequest: () => void;
  onApprove: (requestId: bigint) => void;
  onAuthorize: (requestId: bigint) => void;
  onRevoke: (requestId: bigint) => void;
  onCancel: (requestId: bigint) => void;
  onComplete: (requestId: bigint) => void;
  onMarket: () => void;
}) {
  const ownUnresolved = requests.some(
    (request) =>
      request.requester.toLowerCase() === connectedAddress &&
      (request.status === "pending" || request.status === "authorized")
  );
  const requestUnavailableReason = !ownsLockedPosition
    ? "Position already sold."
    : Number(lockedBalance) <= 0
      ? "You have no locked balance."
      : Date.now() >= maturity.getTime()
        ? "The vault has matured; use maturity withdrawal instead."
        : connectedMemberStatus !== "active"
          ? "Only active group members can request a cooperative exit."
          : ownUnresolved
            ? "Another request from this position is already pending."
            : activeMemberCount <= 4
              ? "The group would fall below four active members."
              : disabled
                ? "Finish the current wallet transaction before requesting an exit."
                : null;

  return (
    <section className="group-exit-panel">
      <div className="section-title">
        <div>
          <h3>Cooperative group exit</h3>
          <p>
            Leave without a market discount when every eligible group member
            approves within the approval period.
          </p>
        </div>
        <button
          className="secondary"
          disabled={
            Boolean(requestUnavailableReason)
          }
          onClick={onRequest}
          type="button"
        >
          Request group exit
        </button>
      </div>
      {requestUnavailableReason && <small className="action-unavailable-reason">{requestUnavailableReason}</small>}
      <details className="group-exit-explainer">
        <summary>How group exit works</summary>
        <ul>
          <li>Every other active member must approve within 24 hours.</li>
          <li>Each approver needs active principal equal to at least 25% of their own target.</li>
          <li>After authorization, the requester has 24 hours to complete the exit.</li>
          <li>At least four active members must remain in the circle.</li>
          <li>The exiting saver loses group reward eligibility.</li>
          <li>Emergency funds remain with the original saver.</li>
        </ul>
      </details>

      {requests.length === 0 ? (
        <div className="empty-mini">No group-exit requests yet.</div>
      ) : (
        <div className="group-exit-list">
          {requests.map((request) => {
            const isRequester =
              request.requester.toLowerCase() === connectedAddress;
            const canVote =
              request.status === "pending" &&
              !isRequester &&
              connectedMemberStatus === "active";
            const meetsApprovalThreshold = connectedMemberProgress >= 0.25;
            return (
              <article
                className="group-exit-request"
                key={request.id.toString()}
              >
                <div>
                  <span className={`listing-status ${request.status}`}>
                    {request.status}
                  </span>
                  <strong>
                    Request #{request.id.toString()} ·{" "}
                    {walletDisplayName(request.requester)}
                  </strong>
                  <small>
                    {request.completedApprovals}/{request.requiredApprovals}{" "}
                    approvals · {expiryCountdown(request.currentDeadline, clock)}
                  </small>
                </div>
                <div className="group-exit-actions">
                  {canVote && !request.connectedMemberApproved && (
                    <button
                      className="primary"
                      disabled={disabled || !meetsApprovalThreshold}
                      onClick={() => onApprove(request.id)}
                      type="button"
                    >
                      Approve
                    </button>
                  )}
                  {canVote &&
                    !request.connectedMemberApproved &&
                    !meetsApprovalThreshold && (
                      <small className="approval-requirement">
                        Save at least 25% of your target to approve.
                      </small>
                    )}
                  {canVote && request.connectedMemberApproved && (
                    <button
                      className="secondary"
                      disabled={disabled}
                      onClick={() => onRevoke(request.id)}
                      type="button"
                    >
                      Revoke
                    </button>
                  )}
                  {request.status === "pending" &&
                    request.completedApprovals === request.requiredApprovals &&
                    request.requiredApprovals > 0 && (
                      <button
                        className="secondary"
                        disabled={disabled}
                        onClick={() => onAuthorize(request.id)}
                        type="button"
                      >
                        Recheck 25% eligibility
                      </button>
                    )}
                  {isRequester && request.status === "pending" && (
                    <button
                      className="secondary"
                      disabled={disabled}
                      onClick={() => onCancel(request.id)}
                      type="button"
                    >
                      Cancel request
                    </button>
                  )}
                  {isRequester && request.status === "authorized" && (
                    <button
                      className="primary"
                      disabled={disabled}
                      onClick={() => onComplete(request.id)}
                      type="button"
                    >
                      Withdraw my locked claim
                    </button>
                  )}
                  {isRequester &&
                    (request.status === "cancelled" ||
                      request.status === "expired") && (
                      <button
                        className="secondary"
                        disabled={disabled}
                        onClick={onMarket}
                        type="button"
                      >
                        Continue to Early-Exit Market
                      </button>
                    )}
                </div>
              </article>
            );
          })}
        </div>
      )}
      <div className="warning compact market-fallback-card">
        <strong>Early-exit market</strong>
        <span>
          The system applies a 4.5%–8% discount. A sale permanently transfers
          the locked claim, keeps emergency funds with the saver, charges the
          provider a separate 0.9% fee and removes group reward eligibility.
        </span>
        <button
          className="secondary compact"
          disabled={disabled || !ownsLockedPosition || Date.now() >= maturity.getTime()}
          onClick={onMarket}
          type="button"
        >
          Request market exit
        </button>
      </div>
    </section>
  );
}

function ListingComposer({
  snapshot,
  exitState,
  expiration,
  claim,
  fee,
  minimumPayout,
  disabled,
  onExpiration,
  onMinimumPayout,
  onSubmit,
}: {
  snapshot: VaultSnapshot;
  exitState: ExitListingSnapshot | null;
  expiration: string;
  claim: number;
  fee: number;
  minimumPayout: string;
  disabled: boolean;
  onExpiration: (value: string) => void;
  onMinimumPayout: (value: string) => void;
  onSubmit: () => void;
}) {
  const pricing = exitState?.reference;
  return (
    <div className="listing-composer">
      <div className="section-title">
        <div>
          <span className={`tag ${snapshot.isGroup ? "group" : "personal"}`}>
            {vaultType(snapshot.isGroup)}
          </span>
          <h2>
            {exitState?.listing
              ? "Relist locked position"
              : "Request an early exit"}
          </h2>
          <p>
            The contract calculates the discount from objective on-chain
            history.
          </p>
        </div>
      </div>
      {pricing && (
        <div className="reference-card">
          <div>
            <span>Current system discount</span>
            <strong>{pricing.discountPercent.toFixed(2)}%</strong>
          </div>
          <p>
            Settlement recalculates this rate from remaining time, savings
            commitment, and adapter liquidity risk.
          </p>
          <div className="score-row">
            <span>Time +{pricing.remainingTimePenalty} bps</span>
            <span>Commitment +{pricing.commitmentPenalty} bps</span>
            <span>Liquidity +{pricing.liquidityRiskPenalty} bps</span>
          </div>
          <small>
            Commitment: expected savings {pricing.timeWeightedSavingsPenalty},
            goal {pricing.goalCompletionPenalty}, regularity{" "}
            {pricing.regularityPenalty}, recent activity{" "}
            {pricing.recencyPenalty} bps.
          </small>
        </div>
      )}
      <form
        className="exit-create"
        onSubmit={(event) => {
          event.preventDefault();
          onSubmit();
        }}
      >
        <label>
          <span>Listing expiration</span>
          <input
            onChange={(event) => onExpiration(event.target.value)}
            type="datetime-local"
            value={expiration}
          />
          <small>You control the listing window, not the discount.</small>
        </label>
        <label>
          <span>Minimum payout</span>
          <div className="input-unit">
            <input
              min="0.000001"
              onChange={(event) => onMinimumPayout(event.target.value)}
              required
              step="0.000001"
              type="number"
              value={minimumPayout}
              placeholder="Example: 95"
            />
            <b>mUSDT</b>
          </div>
          <small>
            Settlement reverts if the recalculated payout falls below this
            floor.
          </small>
        </label>
        <div className="quote">
          <span>Current system payout</span>
          <strong>{claim.toFixed(6)} mUSDT</strong>
          <small>
            The provider pays this amount plus a separate {fee.toFixed(6)} mUSDT
            protocol fee.
          </small>
        </div>
        <div className="warning">
          <strong>Permanent transfer</strong>
          <span>
            The first provider to fund successfully receives the full locked
            claim. Your emergency balance remains yours.
          </span>
        </div>
        <button className="primary" disabled={disabled}>
          {exitState?.listing ? "Relist at system price" : "Create listing"}
        </button>
      </form>
    </div>
  );
}

function ListingDetail({
  entry,
  connectedAddress,
  disabled,
  fundDisabled,
  fundError,
  onCancel,
  onFund,
}: {
  entry: ExitListingSnapshot;
  connectedAddress?: string;
  disabled: boolean;
  fundDisabled: boolean;
  fundError?: string | null;
  onCancel: () => void;
  onFund: () => void;
}) {
  const listing = entry.listing!;
  const isSeller = listing.seller.toLowerCase() === connectedAddress;
  const belowFloor =
    Number(listing.currentSaverPayout) < Number(listing.minimumPayout);
  const unlockDays = daysUntil(listing.maturity);
  return (
    <div className="listing-view">
      <div className="section-title">
        <div>
          <span className={`tag ${listing.isGroup ? "group" : "personal"}`}>
            {vaultType(listing.isGroup)}
          </span>
          <h2>Listing #{listing.id.toString()}</h2>
          <code>{listing.vault}</code>
        </div>
        <span className={`listing-status ${listing.status}`}>
          {listing.status}
        </span>
      </div>
      {!isSeller && (
        <div className="buyer-decision-strip" aria-label="Buyer decision summary">
          <div>
            <small>Your price advantage</small>
            <strong>{entry.reference.discountPercent.toFixed(2)}% off</strong>
            <span>{listing.currentProviderPotentialReturn} mUSDT gross discount before the 0.9% fee</span>
          </div>
          <div>
            <small>Time until unlock</small>
            <strong>{unlockDays} {unlockDays === 1 ? "day" : "days"}</strong>
            <span>Unlocks {listing.maturity.toLocaleDateString()}</span>
          </div>
        </div>
      )}
      <div className="listing-hero">
        <div>
          <small>Current claim value</small>
          <strong>{listing.currentClaimValue} mUSDT</strong>
        </div>
        <div>
          <small>Current system discount</small>
          <strong>{entry.reference.discountPercent.toFixed(2)}%</strong>
        </div>
        <div>
          <small>Listing expires</small>
          <strong>{listing.expiresAt.toLocaleString()}</strong>
        </div>
      </div>
      <div className="settlement-grid">
        <Metric
          label="Saver receives now"
          value={`${listing.currentSaverPayout} mUSDT`}
        />
        <Metric
          label="Provider potential return"
          value={`${listing.currentProviderPotentialReturn} mUSDT`}
        />
        <Metric
          label="Provider fee (0.9%)"
          value={`${listing.currentProviderFee} mUSDT`}
        />
        <Metric
          label="Total provider pays"
          value={`${listing.currentTotalProviderPaid} mUSDT`}
        />
        <Metric
          label="Saver minimum"
          value={`${listing.minimumPayout} mUSDT`}
        />
      </div>
      <div className="reference-card">
        <div>
          <span>Deterministic price</span>
          <strong>{entry.reference.discountPercent.toFixed(2)}%</strong>
        </div>
        <p>
          No provider chooses or negotiates this rate. The contract recalculates
          it in the funding transaction; only the first successful provider
          wins.
        </p>
        <div className="score-row">
          <span>Time +{entry.reference.remainingTimePenalty}</span>
          <span>Commitment +{entry.reference.commitmentPenalty}</span>
          <span>Liquidity +{entry.reference.liquidityRiskPenalty}</span>
        </div>
      </div>
      <TrustSummary />
      {belowFloor && (
        <div className="notice error">
          <strong>Below saver floor</strong>
          <span>
            This listing cannot settle unless the live payout recovers above{" "}
            {listing.minimumPayout} mUSDT.
          </span>
        </div>
      )}
      {fundError && !isSeller && (
        <div className="notice error" role="alert">
          <strong>Not enough funds</strong>
          <span>{fundError}</span>
        </div>
      )}
      <div className="offer-actions">
        {isSeller && listing.active && (
          <button className="secondary" disabled={disabled} onClick={onCancel}>
            Cancel listing
          </button>
        )}
        {!isSeller && listing.active && (
          <button
            className="primary"
            disabled={fundDisabled || belowFloor}
            onClick={onFund}
          >
            Fund at system price
          </button>
        )}
      </div>
      {!isSeller && listing.active && (
        <p className="provider-note">
          Funding pays {listing.currentSaverPayout} mUSDT to the saver plus{" "}
          {listing.currentProviderFee} mUSDT in protocol fees—{" "}
          {listing.currentTotalProviderPaid} mUSDT total—then permanently
          transfers the locked claim.
        </p>
      )}
    </div>
  );
}
