import { loadConfig } from './config.js'
import { createDatabasePool } from './db.js'
import { BlockchainIndexer } from './indexer/indexer.js'
import { runMigrations } from './migrations.js'

const config = loadConfig()
const pool = createDatabasePool(config.databaseUrl)
await runMigrations(pool)
const indexer = new BlockchainIndexer(config, pool)

function shutdown(): void {
  indexer.stop()
}

process.once('SIGINT', shutdown)
process.once('SIGTERM', shutdown)

try {
  await indexer.run()
} finally {
  await pool.end()
}
