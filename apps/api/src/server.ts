import { buildApp } from './app.js'
import { loadConfig } from './config.js'
import { createDatabasePool } from './db.js'
import { BlockchainIndexer } from './indexer/indexer.js'
import { runMigrations } from './migrations.js'
import { runNotificationSweep } from './notifications/sweep.js'

const config = loadConfig()
const pool = createDatabasePool(config.databaseUrl)
await runMigrations(pool)
const indexer = new BlockchainIndexer(config, pool)
const app = await buildApp(config, pool, indexer)
const indexerTask = indexer.run()

const sweepTimer = setInterval(() => {
  void runNotificationSweep(pool).catch((error: unknown) => app.log.error(error))
}, 60_000)

let shuttingDown = false
async function shutdown(): Promise<void> {
  if (shuttingDown) return
  shuttingDown = true
  clearInterval(sweepTimer)
  indexer.stop()
  await app.close()
  await indexerTask
  await pool.end()
}

process.once('SIGINT', () => void shutdown())
process.once('SIGTERM', () => void shutdown())

try {
  await app.listen({ host: config.host, port: config.port })
  app.log.info(
    { chainId: config.manifest.chainId, deploymentBlock: config.deploymentBlock },
    'LockedIn Circle read-only indexer API started.',
  )
} catch (error) {
  app.log.error(error)
  await shutdown()
  process.exitCode = 1
}
