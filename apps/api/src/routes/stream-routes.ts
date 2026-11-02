import type { FastifyInstance } from 'fastify'

import type { IndexerEventStream } from '../realtime/event-stream.js'

export async function registerStreamRoutes(
  app: FastifyInstance,
  stream: IndexerEventStream,
): Promise<void> {
  app.get('/api/events', async (request, reply) => {
    reply.hijack()
    const allowedOrigin = reply.getHeader('Access-Control-Allow-Origin')
    reply.raw.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...(allowedOrigin ? { 'Access-Control-Allow-Origin': String(allowedOrigin), Vary: 'Origin' } : {}),
    })
    reply.raw.write(`event: ready\ndata: ${JSON.stringify({ connected: true })}\n\n`)

    const unsubscribe = stream.subscribe((batch) => {
      if (!reply.raw.destroyed) {
        reply.raw.write(`event: indexed\ndata: ${JSON.stringify(batch)}\n\n`)
      }
    })
    const heartbeat = setInterval(() => {
      if (!reply.raw.destroyed) reply.raw.write(': keep-alive\n\n')
    }, 20_000)
    request.raw.once('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
    })
  })
}
