import { lazy, Suspense, useEffect, useMemo, useState, type ReactNode } from "react";

import {
  acceptGroupInvitation,
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
  loadExitListing,
  fundExitListing,
  loadExitMarket,
  loadGroupExitRequests,
  loadMockUsdtBalance,
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
  type DeploymentVerification,
} from "./lib/contracts";
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
  getNimiqEnvironment,
  type WalletConnection,
} from "./lib/nimiq";

type AppRoute = "vaults" | "position" | "market" | "rewards" | "activity" | "wallet";
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
type DeploymentState =
  | { status: "idle" | "checking" }
  | { status: "valid"; value: DeploymentVerification }
  | { status: "error"; message: string };
type ListingFilter = "all" | "personal" | "group" | "mine";
type MarketView = "listings" | "recent";
type HistoryView = "trades" | "events";

const routes: Array<{ id: AppRoute; label: string }> = [
  { id: "vaults", label: "Create" },
  { id: "position", label: "My vaults" },
  { id: "market", label: "Early exit" },
  { id: "rewards", label: "Rewards" },
  { id: "activity", label: "History" },
  { id: "wallet", label: "Wallet" },
];

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

function routeFromHash(): AppRoute {
  const value = window.location.hash.replace(/^#\/?/, "");
  return routes.some((route) => route.id === value)
    ? (value as AppRoute)
    : "position";
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

export function App() {
  const environment = getNimiqEnvironment();
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
  const [earnRiskAccepted, setEarnRiskAccepted] = useState(false);
  const [withdrawalNeedsRetry, setWithdrawalNeedsRetry] = useState(false);
  const [target, setTarget] = useState("100");
  const [maturity, setMaturity] = useState(() => futureInput(30));
  const [emergencyPercent, setEmergencyPercent] = useState(10);
  const [memberAddresses, setMemberAddresses] = useState("");
  const [vaults, setVaults] = useState<VaultSummary[]>([]);
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null);
  const [depositAmount, setDepositAmount] = useState("25");
  const [withdrawAmount, setWithdrawAmount] = useState("1");
  const [listings, setListings] = useState<ExitListingSnapshot[]>([]);
  const [exitState, setExitState] = useState<ExitListingSnapshot | null>(null);
  const [listingFilter, setListingFilter] = useState<ListingFilter>("all");
  const [marketView, setMarketView] = useState<MarketView>("listings");
  const [exitExpiration, setExitExpiration] = useState(() => futureInput(7));
  const [minimumPayout, setMinimumPayout] = useState("0");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [completedTrades, setCompletedTrades] = useState<CompletedTrade[]>([]);
  const [publicTradesError, setPublicTradesError] = useState<string | null>(null);
  const [historyView, setHistoryView] = useState<HistoryView>("trades");
  const [selectedTradeId, setSelectedTradeId] = useState<string | null>(null);
  const [developmentAccounts, setDevelopmentAccounts] = useState<string[]>([]);
  const [mockTokenBalance, setMockTokenBalance] = useState<string | null>(null);
  const [groupExitRequests, setGroupExitRequests] = useState<
    GroupExitRequestSnapshot[]
  >([]);
  const [clock, setClock] = useState(Date.now());

  const evmSession = evm.status === "connected" ? evm.session : null;
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
  const progress = snapshot
    ? Math.min(
        100,
        (Number(snapshot.deposited) / Number(snapshot.target)) * 100
      )
    : 0;
  // These projections are display-only. EarlyExitMarket independently reads
  // live chain state and recalculates the quote inside the funding transaction.
  const systemDiscount = exitState?.reference.discountPercent ?? 4.5;
  const projectedSaverPayout = snapshot
    ? Number(snapshot.currentValue) * (1 - systemDiscount / 100)
    : 0;
  const projectedFee = projectedSaverPayout * 0.009;
  const selectedListing = exitState?.listing;
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
        if (!listing) return false;
        if (listingFilter === "personal") return !listing.isGroup;
        if (listingFilter === "group") return listing.isGroup;
        if (listingFilter === "mine")
          return listing.seller.toLowerCase() === connectedAddress;
        return true;
      }),
    [listings, listingFilter, connectedAddress]
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

  useEffect(() => {
    const updateRoute = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

  useEffect(() => {
    const timer = window.setInterval(() => setClock(Date.now()), 1_000);
    return () => window.clearInterval(timer);
  }, []);

  useEffect(() => {
    if (!deploymentReady) return;
    void refreshPublicTradeHistory();
  }, [deploymentReady]);

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
    if (!evmSession || !deploymentReady) return;
    void refreshPortfolio(evmSession).catch((error) =>
      setTransaction({ status: "error", message: describeContractError(error) })
    );
    if (evmSession.source === "hardhat-development") {
      void listDevelopmentAccounts()
        .then(setDevelopmentAccounts)
        .catch(() => setDevelopmentAccounts([]));
    }
  }, [evmSession?.address, evmSession?.chainId]);

  function clearPortfolio() {
    setVaults([]);
    setSnapshot(null);
    setListings([]);
    setExitState(null);
    setActivity([]);
    setSelectedTradeId(null);
    setMockTokenBalance(null);
    setGroupExitRequests([]);
  }

  async function connectNimiq(): Promise<void> {
    setNimiq({ status: "connecting" });
    try {
      setNimiq({ status: "connected", wallet: await connectNimiqWallet() });
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
    setDeployment({ status: deploymentReady ? "checking" : "idle" });
    try {
      const session = await connectEvmWallet({
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
        allowDevelopmentFallback: false,
        forceDevelopmentFallback: developmentAccountIndex !== undefined,
      });
      if (deploymentReady) {
        const verified = await verifyDeployment(session.signer);
        setDeployment({ status: "valid", value: verified });
      }
      setEvm({ status: "connected", session });
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "EVM connection failed.";
      setDeployment({ status: "error", message });
      setEvm({
        status: "error",
        message,
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
    const nextVaults = await loadVaultsForSigner(session.signer);
    setVaults(nextVaults);

    // Market history, activity and faucet balances are secondary projections.
    // A temporary RPC/indexing failure must never make a confirmed transaction
    // look reverted or prevent the newly created vault from opening.
    const [listingsResult, activityResult, balanceResult] =
      await Promise.allSettled([
        loadAllExitListings(session.signer),
        loadActivity(
          session.signer,
          nextVaults.map((vault) => vault.address)
        ),
        mockTokenFaucetEnabled
          ? loadMockUsdtBalance(session.signer)
          : Promise.resolve(null),
      ]);
    if (listingsResult.status === "fulfilled")
      setListings(listingsResult.value);
    if (activityResult.status === "fulfilled")
      setActivity(activityResult.value);
    if (balanceResult.status === "fulfilled")
      setMockTokenBalance(balanceResult.value);
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
  }

  async function refreshPublicTradeHistory(): Promise<void> {
    try {
      setCompletedTrades(await loadPublicCompletedTrades());
      setPublicTradesError(null);
    } catch (error) {
      setPublicTradesError(describeContractError(error));
    }
  }

  async function openVault(
    address: string,
    positionId?: bigint,
    session = requireSession()
  ): Promise<void> {
    const next = await loadVault(session.signer, address, positionId);
    const [nextExit, nextGroupExits] = await Promise.all([
      loadExitMarket(session.signer, next),
      loadGroupExitRequests(session.signer, address),
    ]);
    setSnapshot(next);
    setExitState(nextExit);
    setGroupExitRequests(nextGroupExits);
    // Start at the current system payout. The saver may lower this protection
    // floor, but neither the saver nor a provider can choose the discount.
    const defaultFloor =
      nextExit.listing?.minimumPayout ??
      (
        Number(next.currentValue) *
        (1 - nextExit.reference.discountPercent / 100)
      ).toFixed(6);
    setMinimumPayout(defaultFloor);
  }

  async function runTransaction(
    message: string,
    action: () => Promise<void>,
    success: string
  ) {
    setTransaction({ status: "pending", message });
    try {
      await action();
      setTransaction({ status: "success", message: success });
    } catch (error) {
      setTransaction({
        status: "error",
        message: describeContractError(error),
      });
    }
  }

  async function transactAndRefresh(
    label: string,
    action: () => Promise<void>,
    success: string
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
      success
    );
  }

  function createVaultSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (yieldMode === "earn" && !earnRiskAccepted) {
      setTransaction({
        status: "error",
        message:
          "Acknowledge the variable-yield risks before creating an Earn vault.",
      });
      return;
    }
    void runTransaction(
      "Creating vault…",
      async () => {
        const session = requireSession();
        const input: CreateVaultInput = {
          groupMode: mode,
          yieldMode,
          target,
          maturity,
          emergencyPercent,
          additionalMembers: memberAddresses
            .split(/[\n,]/)
            .map((value) => value.trim())
            .filter(Boolean),
        };
        const created = await createVault(session.signer, input);
        await refreshPortfolio(session);
        await openVault(created, undefined, session);
        window.location.hash = "/position";
      },
      "Vault created and added to your portfolio."
    );
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
    } catch (error) {
      setWithdrawalNeedsRetry(snapshot.vaultMode === "earn");
      setTransaction({
        status: "error",
        message: describeContractError(error),
      });
    }
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

  return (
    <main className="page-shell">
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
      <div className="identity-note">
        <strong>
          {environment.isNimiqPay ? "Nimiq Pay detected" : "Browser preview"}
        </strong>
        <span>
          The selected EVM account owns positions and signs contract
          transactions.
        </span>
        <code>
          {evmSession
            ? `${networkName} · ${evmSession.chainId}`
            : "Contract actions disabled"}
        </code>
      </div>
      {!deploymentReady && (
        <div className="notice" role="status">
          <strong>Deployment verification unavailable.</strong>{" "}
          {import.meta.env.VITE_DEPLOYMENT_BLOCK_REASON ??
            "Wallet connection is available, but contract actions remain disabled until a current deployment manifest is installed."}
        </div>
      )}
      {deployment.status === "error" && (
        <div className="notice error" role="alert">
          <strong>Contract deployment mismatch.</strong>
          <span>{deployment.message}</span>
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

      {deploymentBlocked && route !== "wallet" && (
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
          <article className="panel narrow-panel">
            <div className="panel-heading">
              <div>
                <span className="step">01</span>
                <div>
                  <h2>Create a savings vault</h2>
                  <p>Choose who saves and define the target.</p>
                </div>
              </div>
              <div className="segmented">
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
              <fieldset className="mode-picker full-width">
                <legend>How should the locked balance be held?</legend>
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
              </fieldset>
              <label>
                <span>Target per member</span>
                <div className="input-unit">
                  <input
                    min="0.000001"
                    onChange={(event) => setTarget(event.target.value)}
                    required
                    step="0.000001"
                    type="number"
                    value={target}
                  />
                  <b>mUSDT</b>
                </div>
              </label>
              <label>
                <span>Maturity</span>
                <input
                  onChange={(event) => setMaturity(event.target.value)}
                  required
                  type="datetime-local"
                  value={maturity}
                />
              </label>
              <label className="range-field">
                <span>
                  Emergency allocation <strong>{emergencyPercent}%</strong>
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
              </label>
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
              {mode === "group" && (
                <label className="full-width">
                  <span>Participant EVM addresses</span>
                  <textarea
                    onChange={(event) => setMemberAddresses(event.target.value)}
                    placeholder="At least 3 additional 0x addresses, one per line"
                    required
                    value={memberAddresses}
                  />
                  <small>
                    Every listed participant receives an independent position.
                    Membership is fixed after creation. Cooperative exits and
                    group rewards require at least four active members. Rewards
                    depend on funded protocol epochs and are variable, not guaranteed.
                  </small>
                </label>
              )}
              <button
                className="primary full-width"
                disabled={
                  riskActionsDisabled || (yieldMode === "earn" && !earnRiskAccepted)
                }
                type="submit"
              >
                Create {mode} {yieldMode} vault
              </button>
            </form>
          </article>
        </section>
      )}

      {!deploymentBlocked && route === "position" && (
        <section className="route-page dashboard-grid">
          <aside className="panel vault-sidebar">
            <div className="section-title">
              <div>
                <h2>My vaults</h2>
                <p>Discovered from your EVM address.</p>
              </div>
              <button
                className="icon-button"
                disabled={actionsDisabled}
                onClick={() => void refreshPortfolio()}
                title="Refresh"
              >
                ↻
              </button>
            </div>
            {vaults.length === 0 ? (
              <div className="empty-mini">
                No vaults found for this account.
              </div>
            ) : (
              <div className="vault-list">
                {vaults.map((vault) => (
                  <button
                    className={
                      snapshot?.address === vault.address &&
                      snapshot.positionId === vault.positionId
                        ? "vault-row selected"
                        : "vault-row"
                    }
                    key={`${vault.address}-${vault.positionId.toString()}`}
                    onClick={() =>
                      void runTransaction(
                        "Loading vault…",
                        () => openVault(vault.address, vault.positionId),
                        "Vault loaded."
                      )
                    }
                  >
                    <span
                      className={`tag ${vault.isGroup ? "group" : "personal"}`}
                    >
                      {vaultType(vault.isGroup)}
                    </span>
                    <strong>{short(vault.address)}</strong>
                    <small>
                      {vault.access === "emergency-only"
                        ? "Emergency funds only · "
                        : `Position #${vault.positionId.toString()} · `}
                      {vault.memberCount} member
                      {vault.memberCount === 1 ? "" : "s"} ·{" "}
                      {vault.maturity.toLocaleDateString()}
                    </small>
                  </button>
                ))}
              </div>
            )}
          </aside>
          <article className="panel vault-main">
            {snapshot ? (
              <>
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
                      {snapshot.isGroup ? "Group savings" : "Personal savings"}
                    </h2>
                    <code>{snapshot.address}</code>
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
                      : !snapshot.isOriginalMember
                        ? "Purchased claim"
                        : snapshot.goalComplete
                          ? "Target reached"
                          : "In progress"}
                  </span>
                </div>
                {snapshot.isGroup && snapshot.groupLifecycle !== "active" && (
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
                {snapshot.isOriginalMember && snapshot.ownsLockedPosition && (
                  <>
                <div className="progress-copy">
                  <span>Your goal progress</span>
                  <strong>{progress.toFixed(1)}%</strong>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${progress}%` }} />
                </div>
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
                  {snapshot.ownsLockedPosition && (
                  <Metric
                    label="Accrued yield"
                    value={`${snapshot.accruedYield} mUSDT`}
                  />
                  )}
                  {snapshot.ownsLockedPosition && (
                  <Metric
                    label="Current position value"
                    value={`${snapshot.currentValue} mUSDT`}
                  />
                  )}
                  {snapshot.ownsLockedPosition && (
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
                  {snapshot.ownsLockedPosition && (
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
                {snapshot.ownsLockedPosition && (
                  <div className="maturity-action">
                  <div>
                    <strong>Maturity withdrawal</strong>
                    <span>
                      {Date.now() >= snapshot.maturity.getTime()
                        ? "Available now."
                        : `Available ${snapshot.maturity.toLocaleString()}.`}
                    </span>
                    {withdrawalNeedsRetry && (
                      <small>
                        Redemption failed without burning your shares. You can
                        retry safely.
                      </small>
                    )}
                  </div>
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
                      : "Withdraw position"}
                  </button>
                  </div>
                )}
                <div className="action-grid">
                  {snapshot.ownsLockedPosition &&
                    snapshot.isOriginalMember &&
                    (!snapshot.isGroup || snapshot.groupLifecycle === "active") && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void transactAndRefresh(
                        "Approving and depositing…",
                        () =>
                          depositToVault(
                            requireSession().signer,
                            snapshot.address,
                            snapshot.positionId,
                            depositAmount
                          ),
                        "Deposit confirmed."
                      );
                    }}
                  >
                    <label>
                      <span>Deposit mUSDT</span>
                      <input
                        min="0.000001"
                        onChange={(event) =>
                          setDepositAmount(event.target.value)
                        }
                        step="0.000001"
                        type="number"
                        value={depositAmount}
                      />
                    </label>
                    <button className="primary" disabled={riskActionsDisabled}>
                      Deposit
                    </button>
                  </form>
                  )}
                  {snapshot.isOriginalMember &&
                    Number(snapshot.emergencyBalance) > 0 && (
                  <form
                    onSubmit={(event) => {
                      event.preventDefault();
                      void transactAndRefresh(
                        "Withdrawing emergency funds…",
                        () =>
                          withdrawEmergency(
                            requireSession().signer,
                            snapshot.address,
                            snapshot.positionId,
                            withdrawAmount
                          ),
                        "Emergency withdrawal confirmed."
                      );
                    }}
                  >
                    <label>
                      <span>Withdraw emergency</span>
                      <input
                        min="0.000001"
                        onChange={(event) =>
                          setWithdrawAmount(event.target.value)
                        }
                        step="0.000001"
                        type="number"
                        value={withdrawAmount}
                      />
                    </label>
                    <button className="secondary" disabled={actionsDisabled}>
                      Withdraw
                    </button>
                  </form>
                  )}
                </div>
                {snapshot.isGroup &&
                  snapshot.groupLifecycle === "active" &&
                  snapshot.ownsLockedPosition &&
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
                {snapshot.isGroup && snapshot.ownsLockedPosition && (
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
                              <strong>{short(member.member)}</strong>
                              {member.member.toLowerCase() ===
                                connectedAddress && (
                                <span className="you">You</span>
                              )}
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
        <Suspense fallback={<RouteLoading label="Loading market" />}>
        <MarketRoute>
          <div className="panel view-switch" aria-label="Market view">
            <button
              className={marketView === "listings" ? "active" : ""}
              onClick={() => setMarketView("listings")}
            >
              Open listings
            </button>
            <button
              className={marketView === "recent" ? "active" : ""}
              onClick={() => setMarketView("recent")}
            >
              Recent trades
            </button>
          </div>
          {marketView === "listings" ? (
            <div className="market-layout">
          <aside className="panel market-browser">
            <div className="section-title">
              <div>
                <h2>Early-exit listings</h2>
                <p>
                  Full locked-position sales at a contract-calculated price.
                </p>
              </div>
              <button
                className="icon-button"
                disabled={riskActionsDisabled}
                onClick={() => void refreshPortfolio()}
                title="Refresh"
              >
                ↻
              </button>
            </div>
            <div className="filter-row">
              {(["all", "personal", "group", "mine"] as ListingFilter[]).map(
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
                <div className="empty-mini">No listings match this filter.</div>
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
                        onClick={() => setExitState(entry)}
                      >
                        <div>
                          <span
                            className={`tag ${
                              entry.listing.isGroup ? "group" : "personal"
                            }`}
                          >
                            {vaultType(entry.listing.isGroup)}
                          </span>
                          <span
                            className={`listing-status ${entry.listing.status}`}
                          >
                            {entry.listing.status}
                          </span>
                        </div>
                        <strong>{entry.listing.currentClaimValue} mUSDT</strong>
                        <span>
                          Listing #{entry.listing.id.toString()} ·{" "}
                          {entry.reference.discountPercent.toFixed(2)}% live
                          discount
                        </span>
                        <small>Seller {short(entry.listing.seller)}</small>
                      </button>
                    )
                )
              )}
            </div>
          </aside>
          <article className="panel market-detail">
            {canComposeListing && snapshot ? (
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
            ) : selectedListing ? (
              <ListingDetail
                entry={exitState!}
                connectedAddress={connectedAddress}
                disabled={actionsDisabled}
                fundDisabled={riskActionsDisabled}
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
            ) : (
              <div className="empty-state">
                Select a listing, or open one of your vaults to request an early
                exit.
              </div>
            )}
          </article>
            </div>
          ) : (
            <article className="panel recent-trades-panel">
              <div className="section-title">
                <div>
                  <h2>Recent market trades</h2>
                  <p>
                    Public, finalized saver-to-provider position transfers.
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
                  <strong>Recent trades unavailable</strong>
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
          <div className="panel view-switch" aria-label="History view">
            <button
              className={historyView === "trades" ? "active" : ""}
              onClick={() => setHistoryView("trades")}
            >
              My completed trades
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
                    <h2>Completed trades</h2>
                    <p>Trades where you were the saver or provider.</p>
                  </div>
                  <button
                    className="icon-button"
                    disabled={actionsDisabled}
                    onClick={() => void refreshPortfolio()}
                    title="Refresh"
                  >
                    ↻
                  </button>
                </div>
                {myCompletedTrades.length === 0 ? (
                  <div className="empty-mini">No completed trades yet.</div>
                ) : (
                  myCompletedTrades.map((trade) => {
                    const role =
                      trade.seller.toLowerCase() === connectedAddress
                        ? "Saver"
                        : "Liquidity provider";
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
                        <strong>Trade #{trade.listingId.toString()}</strong>
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
                    Your completed market trades will appear here.
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

      {transaction.status !== "idle" && (
        <div
          className={`transaction ${transaction.status}`}
          role={transaction.status === "error" ? "alert" : "status"}
        >
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
      <footer>
        {networkName} · {mockTokenFaucetEnabled ? "Mock USDT" : "USDT"} ·{" "}
        {usesMockYieldAdapter
          ? "Mock yield adapter · Not Aave"
          : "Aave V3 Earn adapter"}{" "}
        · No guardian recovery · Unaudited
      </footer>
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
    return <div className="empty-state compact-empty">No completed trades yet.</div>;

  return (
    <div className="recent-trade-table">
      <div className="recent-trade-head">
        <span>Trade</span>
        <span>Transfer</span>
        <span>Settlement</span>
        <span>Time</span>
        <span>Transaction</span>
      </div>
      {trades.map((trade) => (
        <div className="recent-trade-row" key={trade.listingId.toString()}>
          <div>
            <strong>#{trade.listingId.toString()}</strong>
            <span className={`tag ${trade.isGroup ? "group" : "personal"}`}>
              {vaultType(trade.isGroup)}
            </span>
          </div>
          <div>
            <span>{short(trade.seller)}</span>
            <small>to {short(trade.provider)}</small>
          </div>
          <div>
            <strong>{trade.saverPayout} mUSDT</strong>
            <small>{trade.systemDiscountPercent.toFixed(2)}% discount</small>
          </div>
          <time dateTime={trade.timestamp.toISOString()}>
            {trade.timestamp.toLocaleString()}
          </time>
          {explorerBaseUrl ? (
            <a
              href={`${explorerBaseUrl}/tx/${trade.transactionHash}`}
              rel="noreferrer"
              target="_blank"
            >
              View transaction ↗
            </a>
          ) : (
            <code>{short(trade.transactionHash)}</code>
          )}
        </div>
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
          <span className="eyebrow">LockedIn Circle · Trade receipt</span>
          <h2>Early-exit trade #{trade.listingId.toString()}</h2>
          <p>Finalized on Polygon Amoy</p>
        </div>
        <span className="receipt-status">Completed</span>
      </header>
      <div className="receipt-summary">
        <div>
          <small>Your role</small>
          <strong>{isSaver ? "Saver" : "Liquidity provider"}</strong>
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
      <div className="receipt-amount">
        <span>{isSaver ? "Liquidity received" : "Locked claim acquired"}</span>
        <strong>
          {isSaver ? "+" : ""}
          {isSaver ? trade.saverPayout : trade.claimValue} mUSDT
        </strong>
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
          <dt>Liquidity provider</dt>
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

  return (
    <section className="group-exit-panel">
      <div className="section-title">
        <div>
          <h3>Cooperative group exit</h3>
          <p>
            Unlock your own claim without a discount after every other active
            member approves within 24 hours and all active goals are complete.
            Approvers must have saved at least 25% of their own target.
            {activeMemberCount <= 4 && (
              <> An exit cannot proceed because it would leave fewer than four active members.</>
            )}
          </p>
        </div>
        <button
          className="secondary"
          disabled={
            disabled ||
            connectedMemberStatus !== "active" ||
            ownUnresolved ||
            activeMemberCount <= 4
          }
          onClick={onRequest}
          type="button"
        >
          Request group exit
        </button>
      </div>

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
                    {short(request.requester)}
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
      <div className="warning compact">
        <strong>Market fallback</strong>
        <span>
          After cancellation or expiry, the market is available—but it applies
          the contract-calculated 4.5%–8% discount and separate provider fee.
        </span>
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
  onCancel,
  onFund,
}: {
  entry: ExitListingSnapshot;
  connectedAddress?: string;
  disabled: boolean;
  fundDisabled: boolean;
  onCancel: () => void;
  onFund: () => void;
}) {
  const listing = entry.listing!;
  const isSeller = listing.seller.toLowerCase() === connectedAddress;
  const belowFloor =
    Number(listing.currentSaverPayout) < Number(listing.minimumPayout);
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
          <small>Expires</small>
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
      {belowFloor && (
        <div className="notice error">
          <strong>Below saver floor</strong>
          <span>
            This listing cannot settle unless the live payout recovers above{" "}
            {listing.minimumPayout} mUSDT.
          </span>
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
