import Fastify from 'fastify'
import { afterEach, describe, expect, it, vi } from 'vitest'

import type { WalletAuthService } from '../auth/auth-service.js'
import type { DatabasePool } from '../db.js'
import { registerBoosterRoutes } from './booster-routes.js'

const campaign = {
  id: 'lockedin-nim-booster-001',
  name: 'Stay LockedIn',
  status: 'REGISTRATION',
  winner_count: 5,
  reward_per_winner_nim: 10000,
  rules_version: 1,
}

let app = Fastify()
afterEach(async () => { await app.close(); app = Fastify() })

describe('LockedIn NIM Booster routes', () => {
  it('publishes the fixed five-winner campaign without enabling payout', async () => {
    const pool = { query: vi.fn().mockResolvedValue({ rows: [campaign] }) } as unknown as DatabasePool
    await registerBoosterRoutes(app, pool, {} as WalletAuthService)
    const response = await app.inject({ method: 'GET', url: '/api/booster/campaign' })
    expect(response.statusCode).toBe(200)
    expect(response.json().campaign).toMatchObject({
      winnerCount: 5,
      rewardPerWinnerNim: 10000,
      totalRewardNim: 50000,
      payoutEnabled: false,
    })
  })

  it('requires wallet authentication before enrollment', async () => {
    const pool = { query: vi.fn() } as unknown as DatabasePool
    const auth = { authenticate: vi.fn().mockResolvedValue(null) } as unknown as WalletAuthService
    await registerBoosterRoutes(app, pool, auth)
    const response = await app.inject({
      method: 'POST',
      url: '/api/booster/entry',
      payload: { nimiqAddress: 'NQ00 0000 0000 0000 0000 0000 0000 0000 0000' },
    })
    expect(response.statusCode).toBe(401)
  })
})
