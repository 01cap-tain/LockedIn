import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { WalletAuthService } from '../auth/auth-service.js'
import type { DatabasePool } from '../db.js'

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7) : ''
}

async function authenticated(
  request: FastifyRequest,
  service: WalletAuthService,
): Promise<{ walletAddress: string; token: string }> {
  const token = bearer(request)
  const session = await service.authenticate(token)
  if (!session) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
  return { walletAddress: session.walletAddress, token }
}

export async function registerAuthRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  service: WalletAuthService,
): Promise<void> {
  app.post('/api/auth/nonce', async (request, reply) => {
    const body = z.object({ address: z.string() }).parse(request.body)
    return reply.code(201).send(await service.createChallenge(body.address))
  })

  app.post('/api/auth/verify', async (request, reply) => {
    const body = z.object({
      address: z.string(),
      nonce: z.string().length(64),
      signature: z.string().min(2),
    }).parse(request.body)
    return reply.code(201).send(
      await service.verifyChallenge(body.address, body.nonce, body.signature),
    )
  })

  app.post('/api/auth/logout', async (request, reply) => {
    const session = await authenticated(request, service)
    await service.logout(session.token)
    return reply.code(204).send()
  })

  app.get('/api/notifications', async (request) => {
    const session = await authenticated(request, service)
    const query = z.object({
      limit: z.coerce.number().int().min(1).max(100).default(25),
      beforeId: z.coerce.number().int().positive().optional(),
      unreadOnly: z.enum(['true', 'false'])
        .default('false')
        .transform((value) => value === 'true'),
    }).parse(request.query)
    const result = await pool.query(
      `SELECT id, kind, title, body, data, read_at, created_at
       FROM notifications
       WHERE wallet_address = $1
         AND ($2::bigint IS NULL OR id < $2)
         AND (NOT $3::boolean OR read_at IS NULL)
       ORDER BY id DESC LIMIT $4`,
      [session.walletAddress, query.beforeId ?? null, query.unreadOnly, query.limit],
    )
    return { items: result.rows, nextBeforeId: result.rows.at(-1)?.id ?? null }
  })

  app.post('/api/notifications/:id/read', async (request, reply) => {
    const session = await authenticated(request, service)
    const { id } = z.object({ id: z.coerce.number().int().positive() }).parse(request.params)
    await pool.query(
      'UPDATE notifications SET read_at = now() WHERE id = $1 AND wallet_address = $2',
      [id, session.walletAddress],
    )
    return reply.code(204).send()
  })

  app.get('/api/preferences', async (request) => {
    const session = await authenticated(request, service)
    const result = await pool.query(
      `SELECT in_app_enabled, web_push_enabled, updated_at
       FROM wallet_preferences WHERE wallet_address = $1`,
      [session.walletAddress],
    )
    return result.rows[0] ?? {
      in_app_enabled: true,
      web_push_enabled: false,
      web_push_available: false,
    }
  })

  app.patch('/api/preferences', async (request) => {
    const session = await authenticated(request, service)
    const body = z.object({ inAppEnabled: z.boolean() }).parse(request.body)
    const result = await pool.query(
      `INSERT INTO wallet_preferences (wallet_address, in_app_enabled)
       VALUES ($1, $2)
       ON CONFLICT (wallet_address) DO UPDATE SET
         in_app_enabled = EXCLUDED.in_app_enabled,
         updated_at = now()
       RETURNING in_app_enabled, web_push_enabled, updated_at`,
      [session.walletAddress, body.inAppEnabled],
    )
    return result.rows[0]
  })
}
