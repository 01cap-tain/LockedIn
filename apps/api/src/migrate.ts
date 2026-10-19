import { loadConfig } from './config.js'
import { createDatabasePool } from './db.js'
import { runMigrations } from './migrations.js'

const config = loadConfig()
const pool = createDatabasePool(config.databaseUrl)

try {
  const applied = await runMigrations(pool)
  console.log(applied.length === 0 ? 'Database is current.' : `Applied: ${applied.join(', ')}`)
} finally {
  await pool.end()
}
