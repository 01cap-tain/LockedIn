import { afterEach, describe, expect, it } from 'vitest'
import type { FastifyInstance } from 'fastify'

import { buildApp } from './app.js'
import type { ApiConfig } from './config.js'
import type { DatabasePool } from './db.js'
import type { MultiDeploymentIndexer } from './indexer/multi-indexer.js'
import type { IndexerEventStream } from './realtime/event-stream.js'

let app: FastifyInstance | undefined
afterEach(async () => { await app?.close(); app = undefined })

describe('API browser access', () => {
  it('answers an allowed JSON/authorization CORS preflight', async () => {
    const config = {
      corsOrigins: ['https://lockedin.example'],
      nonceMinutes: 5,
      sessionMinutes: 30,
      rpcUrl: 'https://polygon.example.invalid',
      manifest: { chainId: 137 },
    } as ApiConfig
    app = await buildApp(
      config,
      {} as DatabasePool,
      {} as MultiDeploymentIndexer,
      {} as IndexerEventStream,
    )

    const response = await app.inject({
      method: 'OPTIONS',
      url: '/api/profile/username',
      headers: {
        origin: 'https://lockedin.example',
        'access-control-request-method': 'PUT',
        'access-control-request-headers': 'authorization,content-type',
      },
    })

    expect(response.statusCode).toBe(204)
    expect(response.headers['access-control-allow-origin']).toBe('https://lockedin.example')
    expect(response.headers['access-control-allow-methods']).toContain('PUT')
    expect(response.headers['access-control-allow-headers']).toContain('Authorization')
  })
})
