import { getAddress } from 'ethers'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { WalletAuthService } from '../auth/auth-service.js'
import type { DatabasePool } from '../db.js'

const CAMPAIGN_ID = 'lockedin-nim-booster-001'

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7) : ''
}

async function wallet(request: FastifyRequest, service: WalletAuthService): Promise<string> {
  const session = await service.authenticate(bearer(request))
  if (!session) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
  return getAddress(session.walletAddress).toLowerCase()
}

function campaignResponse(row: Record<string, unknown>) {
  const winners = Number(row.winner_count)
  const rewardPerWinner = Number(row.reward_per_winner_nim)
  return {
    id: String(row.id),
    name: String(row.name),
    status: String(row.status),
    winnerCount: winners,
    rewardPerWinnerNim: rewardPerWinner,
    totalRewardNim: winners * rewardPerWinner,
    rulesVersion: Number(row.rules_version),
    payoutEnabled: false,
  }
}

export async function registerBoosterRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  auth: WalletAuthService,
): Promise<void> {
  app.get('/api/booster/campaign', async () => {
    const result = await pool.query(
      'SELECT * FROM booster_campaigns WHERE id = $1',
      [CAMPAIGN_ID],
    )
    const campaign = result.rows[0]
    if (!campaign) throw Object.assign(new Error('The Booster campaign is not configured.'), { statusCode: 503 })
    return { campaign: campaignResponse(campaign) }
  })

  app.get('/api/booster/entry', async (request) => {
    const address = await wallet(request, auth)
    const result = await pool.query(
      `SELECT campaign_id, wallet_address, nimiq_address, nimiq_address_verified,
              status, joined_at, updated_at
       FROM booster_entries WHERE campaign_id = $1 AND wallet_address = $2`,
      [CAMPAIGN_ID, address],
    )
    return { entry: result.rows[0] ?? null }
  })

  app.get('/api/booster/status/:address', async (request) => {
    const parameters = z.object({ address: z.string() }).parse(request.params)
    const address = getAddress(parameters.address).toLowerCase()
    const result = await pool.query(
      `SELECT campaign_id, wallet_address, status, joined_at, updated_at
       FROM booster_entries WHERE campaign_id = $1 AND wallet_address = $2`,
      [CAMPAIGN_ID, address],
    )
    return { entry: result.rows[0] ?? null }
  })

  app.post('/api/booster/entry', async (request, reply) => {
    const address = await wallet(request, auth)
    const body = z.object({
      nimiqAddress: z.string().trim().toUpperCase().min(30).max(48)
        .refine((value) => /^NQ[0-9A-Z ]+$/.test(value), 'Enter a valid Nimiq wallet address.'),
    }).parse(request.body)
    const campaignResult = await pool.query(
      'SELECT * FROM booster_campaigns WHERE id = $1',
      [CAMPAIGN_ID],
    )
    const campaign = campaignResult.rows[0]
    if (!campaign || campaign.status !== 'REGISTRATION') {
      throw Object.assign(new Error('Booster registration is not open.'), { statusCode: 409 })
    }
    const result = await pool.query(
      `INSERT INTO booster_entries
         (campaign_id, wallet_address, nimiq_address, nimiq_address_verified)
       VALUES ($1, $2, $3, false)
       ON CONFLICT (campaign_id, wallet_address) DO UPDATE SET
         nimiq_address = EXCLUDED.nimiq_address,
         nimiq_address_verified = false,
         updated_at = now()
       RETURNING campaign_id, wallet_address, nimiq_address, nimiq_address_verified,
                 status, joined_at, updated_at`,
      [CAMPAIGN_ID, address, body.nimiqAddress],
    )
    return reply.code(201).send({ entry: result.rows[0] })
  })
}
