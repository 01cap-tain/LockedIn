import Fastify, { type FastifyInstance } from 'fastify'
import { ZodError } from 'zod'

import { PostgresAuthRepository } from './auth/postgres-auth-repository.js'
import { WalletAuthService } from './auth/auth-service.js'
import type { ApiConfig } from './config.js'
import type { DatabasePool } from './db.js'
import type { MultiDeploymentIndexer } from './indexer/multi-indexer.js'
import { registerAuthRoutes } from './routes/auth-routes.js'
import { registerReadRoutes } from './routes/read-routes.js'

export async function buildApp(
  config: ApiConfig,
  pool: DatabasePool,
  indexer: MultiDeploymentIndexer,
): Promise<FastifyInstance> {
  const app = Fastify({ logger: true })
  const auth = new WalletAuthService(
    new PostgresAuthRepository(pool),
    config.nonceMinutes,
    config.sessionMinutes,
  )

  app.setErrorHandler((error, _request, reply) => {
    if (error instanceof ZodError) {
      return reply.code(400).send({
        error: 'INVALID_REQUEST',
        message: 'The request failed validation.',
        details: error.issues,
      })
    }
    const normalized = error instanceof Error ? error : new Error(String(error))
    const statusCode = 'statusCode' in normalized && typeof normalized.statusCode === 'number'
      ? normalized.statusCode
      : 'code' in normalized && normalized.code === 'INVALID_ARGUMENT'
        ? 400
        : 500
    app.log.error(normalized)
    return reply.code(statusCode).send({
      error: statusCode === 401 ? 'UNAUTHORIZED' : 'REQUEST_FAILED',
      message: statusCode >= 500 ? 'The server could not complete the request.' : normalized.message,
    })
  })

  app.get('/health', async (_request, reply) => {
    try {
      const [database, status] = await Promise.all([
        pool.query<{ now: Date }>('SELECT now()'),
        indexer.status(),
      ])
      const degraded = status.lastError !== null
      return reply.code(degraded ? 503 : 200).send({
        status: degraded ? 'degraded' : 'ok',
        databaseTime: database.rows[0]?.now,
        indexer: status,
      })
    } catch (error) {
      app.log.error(error)
      return reply.code(503).send({ status: 'unavailable' })
    }
  })

  app.get('/api/indexer/status', async () => indexer.status())
  app.get('/api/indexer/errors', async (request) => {
    const limitValue = Number((request.query as { limit?: string }).limit ?? 25)
    const limit = Number.isSafeInteger(limitValue) ? Math.min(100, Math.max(1, limitValue)) : 25
    const result = await pool.query(
      `SELECT id, message, occurred_at
       FROM indexer_errors WHERE chain_id = $1
       ORDER BY occurred_at DESC LIMIT $2`,
      [config.manifest.chainId, limit],
    )
    return { items: result.rows }
  })

  await registerReadRoutes(app, pool)
  await registerAuthRoutes(app, pool, auth)
  return app
}
