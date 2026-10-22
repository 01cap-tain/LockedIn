import { Contract, JsonRpcProvider } from 'ethers'

import { loadConfig } from './config.js'
import { createDatabasePool } from './db.js'
import { MultiDeploymentIndexer } from './indexer/multi-indexer.js'
import { runMigrations } from './migrations.js'

const factoryAbi = ['function vaultCount() view returns (uint256)']
const config = loadConfig()
const pool = createDatabasePool(config.databaseUrl)
await runMigrations(pool)
const indexer = new MultiDeploymentIndexer(config, pool)
const maximumBatches = Number(process.env.INDEXER_BACKFILL_MAX_BATCHES ?? 200)
const started = performance.now()
let batches = 0
try {
  while (batches < maximumBatches) {
    const processed = await indexer.indexOnce()
    batches += 1
    const status = await indexer.status()
    if (status.deployments.every((deployment) => deployment.lag === 0)) break
    if (processed === 0) break
  }
  const elapsedMs = performance.now() - started
  const provider = new JsonRpcProvider(config.rpcUrl, config.manifest.chainId, { staticNetwork: true })
  const directStarted = performance.now()
  const directCounts = await Promise.all(config.deployments.map(async (deployment) => Number(
    await new Contract(deployment.manifest.contracts.vaultFactory.address, factoryAbi, provider).getFunction('vaultCount')(),
  )))
  const directMs = performance.now() - directStarted
  const databaseStarted = performance.now()
  const indexed = await pool.query<{ deployment_id: string; count: string }>(
    'SELECT deployment_id, count(*)::text AS count FROM vaults GROUP BY deployment_id',
  )
  const databaseMs = performance.now() - databaseStarted
  console.log(JSON.stringify({
    batches,
    backfillMs: Math.round(elapsedMs),
    directRpcMs: Number(directMs.toFixed(2)),
    indexedDatabaseMs: Number(databaseMs.toFixed(2)),
    directVaultCounts: directCounts,
    indexedVaultCounts: Object.fromEntries(indexed.rows.map((row) => [row.deployment_id, Number(row.count)])),
    status: await indexer.status(),
  }, null, 2))
} finally {
  await pool.end()
}
