import { useEffect, useMemo, useState } from 'react'

import {
  createVault,
  depositToVault,
  describeContractError,
  getLocalSignerAddress,
  loadVault,
  withdrawEmergency,
  type CreateVaultInput,
  type VaultSnapshot,
} from './lib/contracts'
import {
  connectNimiqWallet,
  describeWalletError,
  getNimiqEnvironment,
  type WalletConnection,
} from './lib/nimiq'

type WalletState =
  | { status: 'idle' }
  | { status: 'connecting' }
  | { status: 'connected'; wallet: WalletConnection }
  | { status: 'error'; message: string }

type TransactionState =
  | { status: 'idle' }
  | { status: 'pending'; message: string }
  | { status: 'success'; message: string }
  | { status: 'error'; message: string }

function defaultMaturity(): string {
  const date = new Date(Date.now() + 7 * 24 * 60 * 60 * 1_000)
  date.setMinutes(date.getMinutes() - date.getTimezoneOffset())
  return date.toISOString().slice(0, 16)
}

function shorten(value: string): string {
  return `${value.slice(0, 8)}...${value.slice(-6)}`
}

export function App() {
  const [wallet, setWallet] = useState<WalletState>({ status: 'idle' })
  const [transaction, setTransaction] = useState<TransactionState>({ status: 'idle' })
  const [localSigner, setLocalSigner] = useState<string | null>(null)
  const [mode, setMode] = useState<'personal' | 'group'>('personal')
  const [target, setTarget] = useState('100')
  const [maturity, setMaturity] = useState(defaultMaturity)
  const [emergencyPercent, setEmergencyPercent] = useState(10)
  const [memberAddresses, setMemberAddresses] = useState('')
  const [vaultAddress, setVaultAddress] = useState('')
  const [snapshot, setSnapshot] = useState<VaultSnapshot | null>(null)
  const [depositAmount, setDepositAmount] = useState('25')
  const [withdrawAmount, setWithdrawAmount] = useState('1')
  const environment = getNimiqEnvironment()

  useEffect(() => {
    void getLocalSignerAddress().then(setLocalSigner).catch(() => setLocalSigner(null))
  }, [])

  const progress = useMemo(() => {
    if (!snapshot) return 0
    const targetValue = Number(snapshot.target)
    return targetValue === 0 ? 0 : Math.min(100, (Number(snapshot.deposited) / targetValue) * 100)
  }, [snapshot])

  async function connectWallet(): Promise<void> {
    setWallet({ status: 'connecting' })
    try {
      setWallet({ status: 'connected', wallet: await connectNimiqWallet() })
    } catch (error) {
      setWallet({ status: 'error', message: describeWalletError(error).message })
    }
  }

  async function refreshVault(address = vaultAddress): Promise<void> {
    const next = await loadVault(address.trim())
    setVaultAddress(next.address)
    setSnapshot(next)
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

  function submitCreate(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    const input: CreateVaultInput = {
      mode,
      target,
      maturity,
      emergencyPercent,
      additionalMembers: memberAddresses
        .split(/[\n,]/)
        .map((address) => address.trim())
        .filter(Boolean),
    }
    void runTransaction(
      'Creating vault on local Hardhat...',
      async () => {
        const created = await createVault(input)
        await refreshVault(created)
      },
      'Vault created and loaded.',
    )
  }

  return (
    <main className="page-shell">
      <header className="topbar">
        <div>
          <span className="kicker">Nimiq Pay Mini App · Phase 1</span>
          <h1>LockedIn Circle</h1>
        </div>
        <div className="wallet-area">
          {wallet.status === 'connected' ? (
            <div className="wallet-chip">
              <span className="status-dot" />
              <div><small>Nimiq wallet</small><strong>{shorten(wallet.wallet.address)}</strong></div>
            </div>
          ) : (
            <button className="primary compact" disabled={wallet.status === 'connecting'} onClick={() => void connectWallet()}>
              {wallet.status === 'connecting' ? 'Connecting...' : 'Connect Nimiq wallet'}
            </button>
          )}
        </div>
      </header>

      {wallet.status === 'error' && <div className="notice error" role="alert">{wallet.message}</div>}
      <div className="identity-note">
        <strong>{environment.isNimiqPay ? 'Nimiq Pay detected' : 'Browser preview'}</strong>
        <span>Nimiq identity and the local Hardhat signer are separate in this prototype.</span>
        <code>{localSigner ? `Local EVM: ${shorten(localSigner)}` : 'Local Hardhat node unavailable'}</code>
      </div>

      <section className="workspace">
        <article className="panel">
          <div className="panel-heading">
            <div><span className="step">01</span><h2>Create a vault</h2></div>
            <div className="segmented" aria-label="Vault type">
              <button className={mode === 'personal' ? 'active' : ''} onClick={() => setMode('personal')} type="button">Personal</button>
              <button className={mode === 'group' ? 'active' : ''} onClick={() => setMode('group')} type="button">Group</button>
            </div>
          </div>

          <form className="form-grid" onSubmit={submitCreate}>
            <label>
              <span>Target per member</span>
              <div className="input-unit"><input min="0.000001" onChange={(event) => setTarget(event.target.value)} required step="0.000001" type="number" value={target} /><b>mUSDT</b></div>
            </label>
            <label>
              <span>Maturity</span>
              <input onChange={(event) => setMaturity(event.target.value)} required type="datetime-local" value={maturity} />
            </label>
            <label className="range-field">
              <span>Emergency allocation <strong>{emergencyPercent}%</strong></span>
              <input max="15" min="10" onChange={(event) => setEmergencyPercent(Number(event.target.value))} step="1" type="range" value={emergencyPercent} />
              <small>Available anytime. The remainder stays locked until maturity.</small>
            </label>
            {mode === 'group' && (
              <label className="full-width">
                <span>Other member EVM addresses</span>
                <textarea onChange={(event) => setMemberAddresses(event.target.value)} placeholder="One 0x address per line" required value={memberAddresses} />
                <small>Your local EVM address is included automatically.</small>
              </label>
            )}
            <button className="primary full-width" disabled={transaction.status === 'pending'} type="submit">Create {mode} vault</button>
          </form>
        </article>

        <article className="panel">
          <div className="panel-heading"><div><span className="step">02</span><h2>Manage a position</h2></div></div>
          <form className="load-row" onSubmit={(event) => { event.preventDefault(); void runTransaction('Loading vault...', () => refreshVault(), 'Vault loaded.') }}>
            <input onChange={(event) => setVaultAddress(event.target.value)} placeholder="Vault contract address" value={vaultAddress} />
            <button className="secondary" type="submit">Load</button>
          </form>

          {snapshot ? (
            <div className="vault-details">
              <div className="progress-copy"><span>Goal progress</span><strong>{progress.toFixed(1)}%</strong></div>
              <div className="progress-track"><span style={{ width: `${progress}%` }} /></div>
              <div className="metrics">
                <div><small>Deposited</small><strong>{snapshot.deposited} mUSDT</strong></div>
                <div><small>Emergency</small><strong>{snapshot.emergencyBalance} mUSDT</strong></div>
                <div><small>Locked</small><strong>{snapshot.lockedBalance} mUSDT</strong></div>
                <div><small>Maturity</small><strong>{snapshot.maturity.toLocaleString()}</strong></div>
              </div>
              <div className="action-grid">
                <form onSubmit={(event) => { event.preventDefault(); void runTransaction('Approving and depositing...', async () => { await depositToVault(snapshot.address, snapshot.positionId, depositAmount); await refreshVault(snapshot.address) }, 'Deposit confirmed.') }}>
                  <label><span>Deposit mUSDT</span><input min="0.000001" onChange={(event) => setDepositAmount(event.target.value)} step="0.000001" type="number" value={depositAmount} /></label>
                  <button className="primary" type="submit">Deposit</button>
                </form>
                <form onSubmit={(event) => { event.preventDefault(); void runTransaction('Withdrawing emergency funds...', async () => { await withdrawEmergency(snapshot.address, snapshot.positionId, withdrawAmount); await refreshVault(snapshot.address) }, 'Emergency withdrawal confirmed.') }}>
                  <label><span>Withdraw emergency</span><input min="0.000001" onChange={(event) => setWithdrawAmount(event.target.value)} step="0.000001" type="number" value={withdrawAmount} /></label>
                  <button className="secondary" type="submit">Withdraw</button>
                </form>
              </div>
            </div>
          ) : (
            <div className="empty-state">Create a vault or enter an existing local vault address.</div>
          )}
        </article>
      </section>

      {transaction.status !== 'idle' && (
        <div className={`transaction ${transaction.status}`} role={transaction.status === 'error' ? 'alert' : 'status'}>
          <span>{transaction.status === 'pending' ? 'Working' : transaction.status === 'success' ? 'Confirmed' : 'Transaction error'}</span>
          <p>{transaction.message}</p>
        </div>
      )}

      <footer>Local Hardhat prototype · Mock USDT only · Contracts are unaudited</footer>
    </main>
  )
}
