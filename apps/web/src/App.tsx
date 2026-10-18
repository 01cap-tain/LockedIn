import { useEffect, useMemo, useState } from "react";

import {
  cancelExitListing,
  createExitListing,
  createVault,
  depositToVault,
  describeContractError,
  loadActivity,
  loadAllExitListings,
  loadExitListing,
  fundExitListing,
  loadExitMarket,
  loadVault,
  loadVaultsForSigner,
  withdrawEmergency,
  withdrawLocked,
  type ActivityItem,
  type CreateVaultInput,
  type ExitListingSnapshot,
  type VaultSnapshot,
  type VaultSummary,
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

type AppRoute = "vaults" | "position" | "market" | "activity" | "wallet";
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
type ListingFilter = "all" | "personal" | "group" | "mine";

const routes: Array<{ id: AppRoute; label: string }> = [
  { id: "vaults", label: "Create" },
  { id: "position", label: "My vaults" },
  { id: "market", label: "Early exit" },
  { id: "activity", label: "Activity" },
  { id: "wallet", label: "Wallet" },
];

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

  // Nimiq identity and EVM ownership are intentionally separate. Nimiq Pay
  // identifies the Mini App user, while only the EVM signer can own or move
  // an on-chain savings position.
  const [route, setRoute] = useState<AppRoute>(routeFromHash);
  const [nimiq, setNimiq] = useState<NimiqState>({ status: "idle" });
  const [evm, setEvm] = useState<EvmState>({ status: "idle" });
  const [transaction, setTransaction] = useState<TransactionState>({
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
  const [exitExpiration, setExitExpiration] = useState(() => futureInput(7));
  const [minimumPayout, setMinimumPayout] = useState("0");
  const [activity, setActivity] = useState<ActivityItem[]>([]);
  const [developmentAccounts, setDevelopmentAccounts] = useState<string[]>([]);

  const evmSession = evm.status === "connected" ? evm.session : null;
  const connectedAddress = evmSession?.address.toLowerCase();
  const actionsDisabled = !evmSession || transaction.status === "pending";
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

  useEffect(() => {
    const updateRoute = () => setRoute(routeFromHash());
    window.addEventListener("hashchange", updateRoute);
    return () => window.removeEventListener("hashchange", updateRoute);
  }, []);

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
    if (!evmSession) return;
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
    try {
      const session = await connectEvmWallet({
        // Supplying an index is an explicit local-only action. Production
        // connections must come from Nimiq Pay's injected EIP-1193 provider.
        provider:
          developmentAccountIndex === undefined && environment.isNimiqPay
            ? getInjectedEvmProvider()
            : undefined,
        developmentAccountIndex,
        forceDevelopmentFallback: developmentAccountIndex !== undefined,
      });
      setEvm({ status: "connected", session });
    } catch (error) {
      setEvm({
        status: "error",
        message:
          error instanceof Error ? error.message : "EVM connection failed.",
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
    const [nextListings, nextActivity] = await Promise.all([
      loadAllExitListings(session.signer),
      loadActivity(
        session.signer,
        nextVaults.map((vault) => vault.address)
      ),
    ]);
    setVaults(nextVaults);
    setListings(nextListings);
    setActivity(nextActivity);
    if (
      snapshot &&
      nextVaults.some((vault) => vault.address === snapshot.address)
    )
      await openVault(snapshot.address, session);
  }

  async function openVault(
    address: string,
    session = requireSession()
  ): Promise<void> {
    const next = await loadVault(session.signer, address);
    const nextExit = await loadExitMarket(session.signer, next);
    setSnapshot(next);
    setExitState(nextExit);
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
        if (snapshot) await openVault(snapshot.address);
        else if (selectedListing)
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
        await openVault(created, session);
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
      await openVault(snapshot.address);
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

      {route === "vaults" && (
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
                    Supplied to Aave V3. Variable yield and protocol risk.
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
                    I understand Aave yield is variable and not guaranteed,
                    withdrawals can temporarily fail, and smart-contract or
                    protocol losses are possible. Emergency funds remain outside
                    Aave.
                  </span>
                </label>
              )}
              {mode === "group" && (
                <label className="full-width">
                  <span>Participant EVM addresses</span>
                  <textarea
                    onChange={(event) => setMemberAddresses(event.target.value)}
                    placeholder="One 0x address per line"
                    required
                    value={memberAddresses}
                  />
                  <small>
                    Every listed participant receives an independent position.
                    Membership is fixed after creation.
                  </small>
                </label>
              )}
              <button
                className="primary full-width"
                disabled={
                  actionsDisabled || (yieldMode === "earn" && !earnRiskAccepted)
                }
                type="submit"
              >
                Create {mode} {yieldMode} vault
              </button>
            </form>
          </article>
        </section>
      )}

      {route === "position" && (
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
                      snapshot?.address === vault.address
                        ? "vault-row selected"
                        : "vault-row"
                    }
                    key={vault.address}
                    onClick={() =>
                      void runTransaction(
                        "Loading vault…",
                        () => openVault(vault.address),
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
                        ? "Earn · Aave V3"
                        : "Safe · no yield"}
                    </span>
                    <h2>
                      {snapshot.isGroup ? "Group savings" : "Personal savings"}
                    </h2>
                    <code>{snapshot.address}</code>
                  </div>
                  <span
                    className={
                      snapshot.goalComplete
                        ? "status-pill complete"
                        : "status-pill"
                    }
                  >
                    {snapshot.goalComplete ? "Target reached" : "In progress"}
                  </span>
                </div>
                <div className="progress-copy">
                  <span>Your goal progress</span>
                  <strong>{progress.toFixed(1)}%</strong>
                </div>
                <div className="progress-track">
                  <span style={{ width: `${progress}%` }} />
                </div>
                <div className="metrics">
                  <Metric
                    label="Deposited"
                    value={`${snapshot.deposited} mUSDT`}
                  />
                  <Metric
                    label="Emergency (outside Aave)"
                    value={`${snapshot.emergencyBalance} mUSDT`}
                  />
                  <Metric
                    label="Locked principal"
                    value={`${snapshot.lockedBalance} mUSDT`}
                  />
                  <Metric
                    label="Accrued yield"
                    value={`${snapshot.accruedYield} mUSDT`}
                  />
                  <Metric
                    label="Current position value"
                    value={`${snapshot.currentValue} mUSDT`}
                  />
                  <Metric
                    label="Variable APY"
                    value={
                      snapshot.variableApyPercent === null
                        ? "No yield"
                        : `${snapshot.variableApyPercent.toFixed(
                            2
                          )}% · not guaranteed`
                    }
                  />
                  <Metric
                    label="Aave supply"
                    value={
                      snapshot.vaultMode === "earn"
                        ? `Active · ${short(snapshot.yieldAdapter)}`
                        : "Not used"
                    }
                  />
                  <Metric
                    label="Maturity"
                    value={snapshot.maturity.toLocaleString()}
                  />
                </div>
                {snapshot.vaultMode === "earn" && (
                  <div className="notice">
                    <strong>Variable Aave position</strong>
                    <span>
                      Only the locked portion earns. Yield is not guaranteed and
                      redemption depends on Aave liquidity and protocol
                      conditions.
                    </span>
                  </div>
                )}
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
                <div className="action-grid">
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
                    <button className="primary" disabled={actionsDisabled}>
                      Deposit
                    </button>
                  </form>
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
                </div>
                {snapshot.isGroup && (
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
                            </div>
                            <span
                              className={
                                member.goalComplete
                                  ? "status-pill complete"
                                  : "status-pill"
                              }
                            >
                              {member.rewardDisqualified
                                ? "Exited"
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

      {route === "market" && (
        <section className="route-page market-layout">
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
                disabled={actionsDisabled}
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
                disabled={actionsDisabled}
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
        </section>
      )}

      {route === "activity" && (
        <section className="route-page">
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
        </section>
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
        </section>
      )}

      {transaction.status !== "idle" && (
        <div
          className={`transaction ${transaction.status}`}
          role={transaction.status === "error" ? "alert" : "status"}
        >
          <span>{transaction.status}</span>
          <p>{transaction.message}</p>
        </div>
      )}
      <footer>
        Local/test deployment · Mock USDT · Mock Aave · No guardian recovery ·
        Unaudited
      </footer>
    </main>
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
function Metric({ label, value }: { label: string; value: string }) {
  return (
    <div>
      <small>{label}</small>
      <strong>{value}</strong>
    </div>
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
            commitment, and Aave liquidity risk.
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
  onCancel,
  onFund,
}: {
  entry: ExitListingSnapshot;
  connectedAddress?: string;
  disabled: boolean;
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
            disabled={disabled || belowFloor}
            onClick={onFund}
          >
            Fund at system price
          </button>
        )}
      </div>
      {!isSeller && listing.active && (
        <p className="provider-note">
          Funding pays {listing.currentSaverPayout} mUSDT to the saver plus{" "}
          {listing.currentProviderFee} mUSDT in protocol fees, then permanently
          transfers the locked claim.
        </p>
      )}
    </div>
  );
}
