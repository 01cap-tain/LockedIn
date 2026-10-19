import { getAddress } from 'ethers'
import type { FastifyInstance } from 'fastify'
import { z } from 'zod'

import type { DatabasePool } from '../db.js'

const pageSchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  beforeBlock: z.coerce.number().int().nonnegative().optional(),
})

function address(value: string): string {
  return getAddress(value).toLowerCase()
}

export async function registerReadRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
): Promise<void> {
  app.get('/api/vaults', async (request) => {
    const query = pageSchema.extend({
      type: z.enum(['personal', 'group']).optional(),
    }).parse(request.query)
    const result = await pool.query(
      `SELECT * FROM vaults
       WHERE ($1::boolean IS NULL OR is_group = $1)
         AND ($2::bigint IS NULL OR creation_block_number < $2)
       ORDER BY creation_block_number DESC, address
       LIMIT $3`,
      [
        query.type ? query.type === 'group' : null,
        query.beforeBlock ?? null,
        query.limit,
      ],
    )
    return { items: result.rows, nextBeforeBlock: result.rows.at(-1)?.creation_block_number ?? null }
  })

  app.get('/api/market/listings', async (request) => {
    const query = pageSchema.extend({
      type: z.enum(['personal', 'group']).optional(),
      status: z.enum(['ACTIVE', 'FUNDED', 'CANCELLED', 'EXPIRED']).default('ACTIVE'),
    }).parse(request.query)
    const result = await pool.query(
      `SELECT l.*, v.is_group
       FROM market_listings l JOIN vaults v ON v.address = l.vault_address
       WHERE l.status = $1
         AND ($2::boolean IS NULL OR v.is_group = $2)
         AND ($3::bigint IS NULL OR l.updated_block_number < $3)
       ORDER BY l.updated_block_number DESC, l.listing_id DESC
       LIMIT $4`,
      [
        query.status,
        query.type ? query.type === 'group' : null,
        query.beforeBlock ?? null,
        query.limit,
      ],
    )
    return { items: result.rows, nextBeforeBlock: result.rows.at(-1)?.updated_block_number ?? null }
  })

  app.get('/api/market/trades', async (request) => {
    const query = pageSchema.extend({
      type: z.enum(['personal', 'group']).optional(),
      wallet: z.string().optional(),
    }).parse(request.query)
    const wallet = query.wallet ? address(query.wallet) : null
    const result = await pool.query(
      `SELECT t.*, v.is_group
       FROM completed_trades t JOIN vaults v ON v.address = t.vault_address
       WHERE ($1::boolean IS NULL OR v.is_group = $1)
         AND ($2::text IS NULL OR t.seller = $2 OR t.provider = $2)
         AND ($3::bigint IS NULL OR t.block_number < $3)
       ORDER BY t.block_number DESC, t.listing_id DESC
       LIMIT $4`,
      [
        query.type ? query.type === 'group' : null,
        wallet,
        query.beforeBlock ?? null,
        query.limit,
      ],
    )
    return { items: result.rows, nextBeforeBlock: result.rows.at(-1)?.block_number ?? null }
  })

  app.get('/api/wallets/:wallet/history', async (request) => {
    const parameters = z.object({ wallet: z.string() }).parse(request.params)
    const query = pageSchema.parse(request.query)
    const wallet = address(parameters.wallet)
    const result = await pool.query(
      `SELECT id, block_number, transaction_hash, log_index, contract_address,
              event_name, payload
       FROM chain_events
       WHERE payload::text ILIKE $1
         AND ($2::bigint IS NULL OR block_number < $2)
       ORDER BY block_number DESC, transaction_index DESC, log_index DESC
       LIMIT $3`,
      [`%${wallet.slice(2)}%`, query.beforeBlock ?? null, query.limit],
    )
    return { items: result.rows, nextBeforeBlock: result.rows.at(-1)?.block_number ?? null }
  })

  app.get('/api/groups/invitations', async (request) => {
    const query = pageSchema.extend({ wallet: z.string() }).parse(request.query)
    const result = await pool.query(
      `SELECT i.*, v.creator, v.maturity, v.mode, v.lifecycle
       FROM group_invitations i JOIN vaults v ON v.address = i.vault_address
       WHERE i.member_address = $1
         AND ($2::bigint IS NULL OR i.updated_block_number < $2)
       ORDER BY i.updated_block_number DESC
       LIMIT $3`,
      [address(query.wallet), query.beforeBlock ?? null, query.limit],
    )
    return { items: result.rows, nextBeforeBlock: result.rows.at(-1)?.updated_block_number ?? null }
  })

  app.get('/api/groups/exits', async (request) => {
    const query = pageSchema.extend({
      wallet: z.string().optional(),
      vault: z.string().optional(),
    }).parse(request.query)
    const result = await pool.query(
      `SELECT r.*,
              (SELECT count(*) FROM cooperative_exit_approvals a
               WHERE a.vault_address = r.vault_address
                 AND a.request_id = r.request_id AND a.approved) AS approval_count
       FROM cooperative_exit_requests r
       WHERE ($1::text IS NULL OR r.requester = $1 OR EXISTS (
                SELECT 1 FROM group_invitations i
                WHERE i.vault_address = r.vault_address AND i.member_address = $1
              ))
         AND ($2::text IS NULL OR r.vault_address = $2)
         AND ($3::bigint IS NULL OR r.updated_block_number < $3)
       ORDER BY r.updated_block_number DESC
       LIMIT $4`,
      [
        query.wallet ? address(query.wallet) : null,
        query.vault ? address(query.vault) : null,
        query.beforeBlock ?? null,
        query.limit,
      ],
    )
    return { items: result.rows, nextBeforeBlock: result.rows.at(-1)?.updated_block_number ?? null }
  })

  app.get('/api/rewards/history', async (request) => {
    const query = pageSchema.extend({ wallet: z.string().optional() }).parse(request.query)
    const wallet = query.wallet ? address(query.wallet) : null
    const claims = await pool.query(
      `SELECT * FROM reward_claims
       WHERE ($1::text IS NULL OR recipient = $1)
         AND ($2::bigint IS NULL OR block_number < $2)
       ORDER BY block_number DESC LIMIT $3`,
      [wallet, query.beforeBlock ?? null, query.limit],
    )
    const epochs = wallet ? [] : (await pool.query(
      `SELECT * FROM reward_epoch_events
       WHERE ($1::bigint IS NULL OR block_number < $1)
       ORDER BY block_number DESC LIMIT $2`,
      [query.beforeBlock ?? null, query.limit],
    )).rows
    return { claims: claims.rows, epochs }
  })

  app.get('/api/activity', async (request) => {
    const query = pageSchema.parse(request.query)
    const result = await pool.query(
      `SELECT id, block_number, transaction_hash, log_index, contract_address,
              event_name, payload
       FROM chain_events
       WHERE ($1::bigint IS NULL OR block_number < $1)
       ORDER BY block_number DESC, transaction_index DESC, log_index DESC
       LIMIT $2`,
      [query.beforeBlock ?? null, query.limit],
    )
    return { items: result.rows, nextBeforeBlock: result.rows.at(-1)?.block_number ?? null }
  })
}
