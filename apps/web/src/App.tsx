import { useEffect, useMemo, useState } from 'react'

import {
  acceptExitOffer,
  cancelExitListing,
  cancelExitOffer,
  createExitListing,
  createVault,
  depositToVault,
  describeContractError,
  loadExitListing,
  loadExitMarket,
  loadVault,
  rejectExitOffer,
  submitExitOffer,
  withdrawEmergency,
  type CreateVaultInput,
  type ExitListingSnapshot,
  type OfferSnapshot,
  type VaultSnapshot,
} from './lib/contracts'
import {
  connectEvmWallet,
  getInjectedEvmProvider,
  watchEvmWallet,
  type EvmWalletSession,
} from './lib/evm-wallet'
import {
  connectNimiqWallet,
  describeWalletError,
  getNimiqEnvironment,
  type WalletConnection,
} from './lib/nimiq'

type NimiqState =
  | { status: 'idle' | 'connecting' }
  | { status: 'connected'; wallet: WalletConnection }
  | { status: 'error'; message: string }

type EvmState =
  | { status: 'idle' | 'connecting' }
  | { status: 'connected'; session: EvmWalletSession }
  | { status: 'error'; message: string }

type TransactionState =
  | { status: 'idle' }
  | { status: 'pending' | 'success' | 'error'; message: string }

type AppRoute = 'vaults' | 'position' | 'early-exit' | 'wallet'

const routes: Array<{ id: AppRoute; label: string }> = [
  { id: 'vaults', label: 'Create vault' },
  { id: 'position', label: 'My position' },
  { id: 'early-exit', label: 'Early exit' },
  { id: 'wallet', label: 'Wallet' },
]

function routeFromHash(): AppRoute {
  const value = window.location.hash.replace(/^#\/?/, '')
  return routes.some((route) => route.id === value) ? value as AppRoute : 'vaults'
}

function futureInput(days: number): string {
  const date = new Date(Date.now() + days * 24 * 60 * 60 * 1_000)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function short(value: string): string {
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

export function App() {
  const [route, setRoute] = useState<AppRoute>(routeFromHash)
  const [nimiq, setNimiq] = useState<NimiqState>({ status: 'idle' })
  const [evm, setEvm] = useState<EvmState>({ status: 'idle' })
  const [transaction, setTransaction] = useState<TransactionState>({ status: 'idle' })
  const [mode, setMode] = useState<'personal' | 'group'>('personal')
  const [target, setTarget] = useState('100')
  const [maturity, setMaturity] = useState(() => futureInput(30))
  const [emergencyPercent, setEmergencyPercent] = useState(10)
  const [memberAddresses, setMemberAddresses] = useState('')
  const [vaultAddress, setVaultAddress] = useState('')
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null)
  const [depositAmount, setDepositAmount] = useState('25')
  const [withdrawAmount, setWithdrawAmount] = useState('1')
  const [exitState, setExitState] = useState<ExitListingSnapshot | null>(null)
  const [listingLookup, setListingLookup] = useState('')
  const [exitDiscount, setExitDiscount] = useState(6)
  const [exitExpiration, setExitExpiration] = useState(() => futureInput(7))
  const [offerDiscount, setOfferDiscount] = useState(5.5)
  const [offerExpiration, setOfferExpiration] = useState(() => futureInput(2))
  const environment = getNimiqEnvironment()
  const evmSession = evm.status === 'connected' ? evm.session : null
  const actionsDisabled = !evmSession || transaction.status === 'pending'

  useEffect(() => {
    const updateRoute = () => setRoute(routeFromHash())
    window.addEventListener('hashchange', updateRoute)
    return () => window.removeEventListener('hashchange', updateRoute)
  }, [])

  useEffect(() => {
    if (evm.status !== 'connected' || evm.session.source !== 'nimiq-pay') return
    const provider = getInjectedEvmProvider()
    if (!provider) return
    return watchEvmWallet(provider, {
      onAccountsChanged: (accounts) => {
        setSnapshot(null)
        setExitState(null)
        if (accounts.length === 0) setEvm({ status: 'error', message: 'The EVM wallet disconnected.' })
        else void connectEvm(provider)
      },
      onChainChanged: () => {
        setSnapshot(null)
        setExitState(null)
        void connectEvm(provider)
      },
    })
  }, [evm.status === 'connected' ? evm.session.source : null])

  const progress = useMemo(() => {
    if (!snapshot) return 0
    return Math.min(100, (Number(snapshot.deposited) / Number(snapshot.target)) * 100)
  }, [snapshot])

  const projectedClaim = snapshot ? Number(snapshot.lockedBalance) * (1 - exitDiscount / 100) : 0
  const projectedFee = projectedClaim * 0.009

  async function connectNimiq(): Promise<void> {
    setNimiq({ status: 'connecting' })
    try {
      setNimiq({ status: 'connected', wallet: await connectNimiqWallet() })
    } catch (error) {
      setNimiq({ status: 'error', message: describeWalletError(error).message })
    }
  }

  async function connectEvm(
    provider = environment.isNimiqPay ? getInjectedEvmProvider() : undefined,
  ): Promise<void> {
    setEvm({ status: 'connecting' })
    try {
      setEvm({ status: 'connected', session: await connectEvmWallet({ provider }) })
    } catch (error) {
      setEvm({ status: 'error', message: error instanceof Error ? error.message : 'EVM connection failed.' })
    }
  }

  function requireSession(): EvmWalletSession {
    if (!evmSession) throw new Error('Connect a supported EVM wallet before using contracts.')
    return evmSession
  }

  async function refreshVault(address = vaultAddress): Promise<void> {
    const session = requireSession()
    const next = await loadVault(session.signer, address.trim())
    setVaultAddress(next.address)
    setSnapshot(next)
    setExitState(await loadExitMarket(session.signer, next))
  }

  async function refreshExit(): Promise<void> {
    const session = requireSession()
    if (exitState?.listing) setExitState(await loadExitListing(session.signer, exitState.listing.id))
    else if (snapshot) setExitState(await loadExitMarket(session.signer, snapshot))
  }

  async function runTransaction(message: string, action: () => Promise<void>, success: string) {
    setTransaction({ status: 'pending', message })
    try {
      await action()
      setTransaction({ status: 'success', message: success })
    } catch (error) {
      setTransaction({ status: 'error', message: describeContractError(error) })
    }
  }

  function createVaultSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    void runTransaction('Creating vault...', async () => {
      const session = requireSession()
      const input: CreateVaultInput = {
        mode,
        target,
        maturity,
        emergencyPercent,
        additionalMembers: memberAddresses.split(/[\n,]/).map((value) => value.trim()).filter(Boolean),
      }
      const created = await createVault(session.signer, input)
      await refreshVault(created)
      window.location.hash = '/position'
    }, 'Vault created and loaded.')
  }

  const connectedAddress = evmSession?.address.toLowerCase()
  const isSeller = exitState?.listing?.seller.toLowerCase() === connectedAddress

  async function offerAction(label: string, action: () => Promise<void>) {
    await runTransaction(label, async () => {
      await action()
      await refreshExit()
    }, 'Early-exit transaction confirmed.')
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <div><span className="kicker">Nimiq Pay Mini App · Phase 2A</span><h1>LockedIn Circle</h1></div>
        <div className="wallet-actions">
          {nimiq.status === 'connected' ? (
            <div className="wallet-chip"><span className="status-dot" /><div><small>Nimiq address</small><code>{nimiq.wallet.address}</code></div></div>
          ) : <button className="secondary compact" disabled={nimiq.status === 'connecting'} onClick={() => void connectNimiq()}>{nimiq.status === 'connecting' ? 'Connecting...' : 'Connect Nimiq'}</button>}
          {evm.status === 'connected' ? (
            <div className="wallet-chip"><span className="status-dot" /><div><small>EVM owner · {evm.session.source}</small><code>{evm.session.address}</code></div></div>
          ) : <button className="primary compact" disabled={evm.status === 'connecting'} onClick={() => void connectEvm()}>{evm.status === 'connecting' ? 'Connecting...' : 'Connect EVM wallet'}</button>}
        </div>
      </header>

      <nav className="app-nav" aria-label="Primary navigation">
        {routes.map((item) => (
          <a
            aria-current={route === item.id ? 'page' : undefined}
            className={route === item.id ? 'active' : ''}
            href={`#/${item.id}`}
            key={item.id}
          >
            {item.label}
          </a>
        ))}
      </nav>

      {(nimiq.status === 'error' || evm.status === 'error') && (
        <div className="notice error" role="alert">
          {nimiq.status === 'error' && <span>{nimiq.message}</span>}
          {evm.status === 'error' && <span>{evm.message}</span>}
        </div>
      )}
      <div className="identity-note">
        <strong>{environment.isNimiqPay ? 'Nimiq Pay detected' : 'Browser preview'}</strong>
        <span>The EVM address—not the Nimiq address—owns vault positions on-chain.</span>
        <code>{evmSession ? `Chain ${evmSession.chainId}` : 'Contract actions disabled'}</code>
      </div>

      {route === 'vaults' && <section className="route-page">
        <article className="panel">
          <div className="panel-heading"><div><span className="step">01</span><h2>Create a vault</h2></div><div className="segmented"><button className={mode === 'personal' ? 'active' : ''} onClick={() => setMode('personal')} type="button">Personal</button><button className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')} type="button">Group</button></div></div>
          <form className="form-grid" onSubmit={createVaultSubmit}>
            <label><span>Target per member</span><div className="input-unit"><input min="0.000001" onChange={(event) => setTarget(event.target.value)} required step="0.000001" type="number" value={target} /><b>mUSDT</b></div></label>
            <label><span>Maturity</span><input onChange={(event) => setMaturity(event.target.value)} required type="datetime-local" value={maturity} /></label>
            <label className="range-field"><span>Emergency allocation <strong>{emergencyPercent}%</strong></span><input max="15" min="10" onChange={(event) => setEmergencyPercent(Number(event.target.value))} type="range" value={emergencyPercent} /><small>Available anytime; never transfers with an early exit.</small></label>
            {mode === 'group' && <label className="full-width"><span>Other member EVM addresses</span><textarea onChange={(event) => setMemberAddresses(event.target.value)} placeholder="One 0x address per line" required value={memberAddresses} /></label>}
            <button className="primary full-width" disabled={actionsDisabled} type="submit">Create {mode} vault</button>
          </form>
        </article>
      </section>}

      {route === 'position' && <section className="route-page">
        <article className="panel">
          <div className="panel-heading"><div><span className="step">02</span><h2>Manage position</h2></div></div>
          <form className="load-row" onSubmit={(event) => { event.preventDefault(); void runTransaction('Loading vault...', () => refreshVault(), 'Vault loaded.') }}><input onChange={(event) => setVaultAddress(event.target.value)} placeholder="Vault contract address" value={vaultAddress} /><button className="secondary" disabled={actionsDisabled} type="submit">Load</button></form>
          {snapshot ? <div className="vault-details">
            <div className="progress-copy"><span>Goal progress</span><strong>{progress.toFixed(1)}%</strong></div><div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
            <div className="metrics"><div><small>Deposited</small><strong>{snapshot.deposited} mUSDT</strong></div><div><small>Emergency</small><strong>{snapshot.emergencyBalance} mUSDT</strong></div><div><small>Locked claim</small><strong>{snapshot.lockedBalance} mUSDT</strong></div><div><small>Maturity</small><strong>{snapshot.maturity.toLocaleString()}</strong></div></div>
            <div className="action-grid">
              <form onSubmit={(event) => { event.preventDefault(); void runTransaction('Approving and depositing...', async () => { const session = requireSession(); await depositToVault(session.signer, snapshot.address, snapshot.positionId, depositAmount); await refreshVault(snapshot.address) }, 'Deposit confirmed.') }}><label><span>Deposit mUSDT</span><input onChange={(event) => setDepositAmount(event.target.value)} type="number" value={depositAmount} /></label><button className="primary" disabled={actionsDisabled}>Deposit</button></form>
              <form onSubmit={(event) => { event.preventDefault(); void runTransaction('Withdrawing emergency funds...', async () => { const session = requireSession(); await withdrawEmergency(session.signer, snapshot.address, snapshot.positionId, withdrawAmount); await refreshVault(snapshot.address) }, 'Emergency withdrawal confirmed.') }}><label><span>Withdraw emergency</span><input onChange={(event) => setWithdrawAmount(event.target.value)} type="number" value={withdrawAmount} /></label><button className="secondary" disabled={actionsDisabled}>Withdraw</button></form>
            </div>
          </div> : <div className="empty-state">Connect an EVM wallet, then create or load a vault.</div>}
        </article>
      </section>}

      {route === 'early-exit' && <section className="panel exit-panel route-page">
        <div className="panel-heading"><div><span className="step">03</span><h2>Early exit market</h2></div></div>
        <form className="load-row listing-lookup" onSubmit={(event) => { event.preventDefault(); void runTransaction('Loading listing...', async () => setExitState(await loadExitListing(requireSession().signer, BigInt(listingLookup))), 'Listing loaded.') }}><input min="0" onChange={(event) => setListingLookup(event.target.value)} placeholder="Listing ID for provider view" type="number" value={listingLookup} /><button className="secondary" disabled={actionsDisabled}>Load listing</button></form>

        {exitState ? <>
          <div className="reference-card">
            <div><span>Reference discount</span><strong>{exitState.reference.discountPercent.toFixed(2)}%</strong></div>
            <p>Calculated on-chain from remaining days, time-weighted goal progress, deposit consistency and current position value.</p>
            <div className="score-row"><span>Time {exitState.reference.remainingDaysScore}</span><span>Progress {exitState.reference.timeWeightedProgressScore}</span><span>Consistency {exitState.reference.consistencyScore}</span><span>Value {exitState.reference.positionValueScore}</span></div>
          </div>

          {!exitState.listing && snapshot ? (
            <form className="exit-create" onSubmit={(event) => { event.preventDefault(); void offerAction('Creating early-exit request...', async () => { await createExitListing(requireSession().signer, snapshot, exitDiscount, exitExpiration) }) }}>
              <label><span>Maximum asking discount <strong>{exitDiscount.toFixed(1)}%</strong></span><input max="8" min="4.5" onChange={(event) => setExitDiscount(Number(event.target.value))} step="0.1" type="range" value={exitDiscount} /></label>
              <label><span>Listing expiration</span><input onChange={(event) => setExitExpiration(event.target.value)} type="datetime-local" value={exitExpiration} /></label>
              <div className="quote"><span>Estimated saver receipt</span><strong>{projectedClaim.toFixed(6)} mUSDT</strong><small>Provider pays an additional {projectedFee.toFixed(6)} mUSDT fee.</small></div>
              <div className="warning"><strong>Permanent transfer</strong><span>Accepting an offer permanently transfers the entire locked claim. Your emergency balance stays yours.</span></div>
              <button className="primary" disabled={actionsDisabled}>Request early exit</button>
            </form>
          ) : exitState.listing ? (
            <div className="listing-view">
              <div className="listing-summary"><span>Listing #{exitState.listing.id.toString()}</span><strong>{exitState.listing.positionValue} mUSDT locked</strong><small>Asking discount up to {exitState.listing.askingDiscountPercent}% · expires {exitState.listing.expiresAt.toLocaleString()}</small></div>
              {isSeller && exitState.listing.active && <button className="secondary" disabled={actionsDisabled} onClick={() => void offerAction('Cancelling listing...', () => cancelExitListing(requireSession().signer, exitState.listing!.id))}>Cancel listing</button>}
              {!isSeller && exitState.listing.active && <form className="offer-form" onSubmit={(event) => { event.preventDefault(); void offerAction('Approving funds and submitting offer...', () => submitExitOffer(requireSession().signer, exitState.listing!.id, offerDiscount, offerExpiration)) }}><label><span>Your discount</span><input max="8" min="4.5" onChange={(event) => setOfferDiscount(Number(event.target.value))} step="0.1" type="number" value={offerDiscount} /></label><label><span>Offer expiration</span><input onChange={(event) => setOfferExpiration(event.target.value)} type="datetime-local" value={offerExpiration} /></label><button className="primary" disabled={actionsDisabled}>Submit competing offer</button></form>}
              <div className="offers"><h3>Provider offers</h3>{exitState.listing.offers.length === 0 ? <p>No offers yet.</p> : exitState.listing.offers.map((offer) => <OfferCard key={offer.id.toString()} offer={offer} isSeller={isSeller} connectedAddress={connectedAddress} disabled={actionsDisabled} onAccept={() => void offerAction('Accepting offer atomically...', () => acceptExitOffer(requireSession().signer, exitState.listing!.id, offer))} onReject={() => void offerAction('Rejecting offer...', () => rejectExitOffer(requireSession().signer, exitState.listing!.id, offer.id))} onCancel={() => void offerAction('Cancelling offer...', () => cancelExitOffer(requireSession().signer, exitState.listing!.id, offer.id))} />)}</div>
              <div className="warning"><strong>Permanent transfer</strong><span>An accepted sale cannot be reversed. The provider receives the full locked claim; the original saver retains emergency funds.</span></div>
            </div>
          ) : null}
        </> : <div className="empty-state compact-empty">Load a vault as its saver or enter a listing ID as a liquidity provider.</div>}
      </section>}

      {route === 'wallet' && <section className="panel route-page wallet-page">
        <div className="panel-heading"><div><span className="step">04</span><h2>Wallet connections</h2></div></div>
        <div className="wallet-details">
          <div><small>Nimiq Pay</small><strong>{nimiq.status === 'connected' ? nimiq.wallet.address : 'Not connected'}</strong><span>Used for the native Nimiq identity.</span></div>
          <div><small>EVM signer</small><strong>{evmSession?.address ?? 'Not connected'}</strong><span>Owns vaults and signs contract transactions.</span></div>
          <div><small>Network</small><strong>{evmSession?.chainId ?? 'Unavailable'}</strong><span>Contract actions remain disabled until a supported signer is connected.</span></div>
        </div>
      </section>}

      {transaction.status !== 'idle' && <div className={`transaction ${transaction.status}`} role={transaction.status === 'error' ? 'alert' : 'status'}><span>{transaction.status}</span><p>{transaction.message}</p></div>}
      <footer>Local/test deployments only · Mock USDT · No Aave or guardian recovery · Unaudited</footer>
    </main>
  )
}

function OfferCard({ offer, isSeller, connectedAddress, disabled, onAccept, onReject, onCancel }: {
  offer: OfferSnapshot
  isSeller: boolean
  connectedAddress?: string
  disabled: boolean
  onAccept: () => void
  onReject: () => void
  onCancel: () => void
}) {
  const isProvider = offer.provider.toLowerCase() === connectedAddress
  return <article className={`offer-card ${offer.active ? '' : 'inactive'}`}>
    <div><span>{short(offer.provider)}</span><strong>{offer.discountPercent}% discount</strong></div>
    <dl><div><dt>Saver receives</dt><dd>{offer.sellerReceives} mUSDT</dd></div><div><dt>Provider fee</dt><dd>{offer.providerFee} mUSDT</dd></div><div><dt>Expires</dt><dd>{offer.expiresAt.toLocaleString()}</dd></div></dl>
    {offer.active && <div className="offer-actions">{isSeller && <><button className="primary" disabled={disabled} onClick={onAccept}>Accept</button><button className="secondary" disabled={disabled} onClick={onReject}>Reject</button></>}{isProvider && <button className="secondary" disabled={disabled} onClick={onCancel}>Cancel offer</button>}</div>}
  </article>
}
