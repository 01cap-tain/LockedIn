import type { DatabasePool } from '../db.js'

const SIX_HOURS_SECONDS = 6 * 60 * 60
const SEVEN_DAYS_SECONDS = 7 * 24 * 60 * 60

async function insertScheduled(
  pool: DatabasePool,
  wallet: string,
  kind: string,
  title: string,
  body: string,
  dedupeKey: string,
  data: Record<string, string>,
): Promise<void> {
  await pool.query(
    `INSERT INTO notifications
       (wallet_address, kind, title, body, data, dedupe_key)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (dedupe_key) DO NOTHING`,
    [wallet.toLowerCase(), kind, title, body, data, dedupeKey],
  )
}

/// Creates advisory notifications from indexed state. Missing a sweep never changes chain state.
export async function runNotificationSweep(
  pool: DatabasePool,
  nowSeconds = Math.floor(Date.now() / 1_000),
): Promise<void> {
  const pending = await pool.query<{
    vault_address: string
    request_id: string
    requester: string
    pending_expires_at: string | null
    authorization_expires_at: string | null
    status: string
  }>(
    `SELECT vault_address, request_id, requester, pending_expires_at,
            authorization_expires_at, status
     FROM cooperative_exit_requests
     WHERE (status = 'PENDING' AND pending_expires_at BETWEEN $1 AND $2)
        OR (status = 'AUTHORIZED' AND authorization_expires_at BETWEEN $1 AND $2)`,
    [nowSeconds, nowSeconds + SIX_HOURS_SECONDS],
  )
  for (const request of pending.rows) {
    const authorized = request.status === 'AUTHORIZED'
    await insertScheduled(
      pool,
      request.requester,
      authorized ? 'AUTHORIZED_EXIT_EXPIRING' : 'PENDING_EXIT_EXPIRING',
      authorized ? 'Authorized exit expires soon' : 'Exit approvals expire soon',
      authorized
        ? 'Execute on-chain before the separate 24-hour authorization window closes.'
        : 'Unanimous eligible approvals must arrive before the pending window closes.',
      `${authorized ? 'authorized' : 'pending'}:${request.vault_address}:${request.request_id}`,
      { vault: request.vault_address, requestId: request.request_id },
    )
  }

  const maturities = await pool.query<{
    address: string
    creator: string
    maturity: string
    member_address: string | null
  }>(
    `SELECT v.address, v.creator, v.maturity, i.member_address
     FROM vaults v
     LEFT JOIN group_invitations i ON i.vault_address = v.address
     WHERE v.maturity BETWEEN $1 AND $2 AND v.lifecycle = 'ACTIVE'`,
    [nowSeconds, nowSeconds + SEVEN_DAYS_SECONDS],
  )
  for (const vault of maturities.rows) {
    const wallet = vault.member_address ?? vault.creator
    await insertScheduled(
      pool,
      wallet,
      'VAULT_APPROACHING_MATURITY',
      'Vault approaching maturity',
      'Review your position and current withdrawal conditions on-chain.',
      `maturity:${vault.address}:${wallet}`,
      { vault: vault.address, maturity: vault.maturity },
    )
  }
}
