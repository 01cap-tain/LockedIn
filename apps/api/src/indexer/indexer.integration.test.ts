import { type Block, type JsonRpcProvider, type Log } from 'ethers'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import type { ApiConfig } from '../config.js'
import type { DatabasePool } from '../db.js'
import { runMigrations } from '../migrations.js'
import { createIsolatedDatabase, type IsolatedDatabase } from '../test-database.js'
import { contractInterfaces } from './abis.js'
import { BlockchainIndexer } from './indexer.js'

const databaseConfigured = Boolean(
  process.env.TEST_DATABASE_URL ?? process.env.DATABASE_URL,
)
const describeDatabase = databaseConfigured ? describe : describe.skip

const factory = '0x1000000000000000000000000000000000000001'
const market = '0x1000000000000000000000000000000000000002'
const reward = '0x1000000000000000000000000000000000000003'
const token = '0x1000000000000000000000000000000000000004'
const firstVault = '0x2000000000000000000000000000000000000001'
const secondVault = '0x2000000000000000000000000000000000000002'
const creator = '0x3000000000000000000000000000000000000001'
const zero = '0x0000000000000000000000000000000000000000'

function hash(character: string): string {
  return `0x${character.repeat(64)}`
}

function block(number: number, blockHash: string, parentHash: string): Block {
  return {
    number,
    hash: blockHash,
    parentHash,
  } as Block
}

function vaultCreatedLog(vault: string, blockHash: string, transactionHash: string): Log {
  const encoded = contractInterfaces.factory.encodeEventLog('VaultCreated', [
    vault,
    creator,
    true,
    0,
    zero,
    2_000_000_000,
  ])
  return {
    address: factory,
    topics: encoded.topics,
    data: encoded.data,
    blockNumber: 100,
    blockHash,
    transactionHash,
    transactionIndex: 0,
    index: 0,
    removed: false,
  } as unknown as Log
}

class FakeProvider {
  latest = 100
  block100 = block(100, hash('b'), hash('a'))
  logs: Log[] = [vaultCreatedLog(firstVault, hash('b'), hash('1'))]

  async getNetwork(): Promise<{ chainId: bigint }> {
    return { chainId: 31_337n }
  }

  async getBlockNumber(): Promise<number> {
    return this.latest
  }

  async getBlock(blockNumber: number): Promise<Block | null> {
    if (blockNumber === 99) return block(99, hash('a'), hash('9'))
    if (blockNumber === 100) return this.block100
    return null
  }

  async getLogs(filter: { address?: string | string[] }): Promise<Log[]> {
    const addresses = new Set(
      (Array.isArray(filter.address) ? filter.address : [filter.address])
        .filter((value): value is string => Boolean(value))
        .map((value) => value.toLowerCase()),
    )
    return this.logs.filter((log) => addresses.has(log.address.toLowerCase()))
  }
}

const config: ApiConfig = {
  databaseUrl: 'unused-in-injected-test-pool',
  rpcUrl: 'http://127.0.0.1:8545',
  manifestPath: 'test',
  manifest: {
    chainId: 31_337,
    deploymentId: 'test-deployment',
    protocolVersion: 'lockedin-circle/test',
    deploymentBlock: 100,
    explorer: 'http://example.test',
    contracts: {
      vaultFactory: { address: factory, blockNumber: 100 },
      earlyExitMarket: { address: market, blockNumber: 100 },
      rewardPool: { address: reward, blockNumber: 100 },
      mockUsdt: { address: token, blockNumber: 100 },
    },
  },
  deploymentBlock: 100,
  deployments: [],
  confirmationDepth: 0,
  logRange: 10,
  pollIntervalMs: 1_000,
  sessionMinutes: 30,
  nonceMinutes: 5,
  host: '127.0.0.1',
  port: 3_001,
}
config.deployments = [{
  manifestPath: config.manifestPath,
  manifest: config.manifest,
  deploymentBlock: config.deploymentBlock,
  active: true,
}]

describeDatabase('PostgreSQL indexer persistence and reorganization recovery', () => {
  let database: IsolatedDatabase
  let pool: DatabasePool

  beforeAll(async () => {
    database = await createIsolatedDatabase()
    pool = database.pool
    await runMigrations(pool)
  })

  afterAll(async () => {
    await database.close()
  })

  it('applies migrations idempotently', async () => {
    expect(await runMigrations(pool)).toEqual([])
    const tables = await pool.query<{ table_name: string }>(
      `SELECT table_name FROM information_schema.tables
       WHERE table_schema = current_schema()`,
    )
    expect(tables.rows.map(({ table_name }) => table_name)).toContain('chain_events')
    expect(tables.rows.map(({ table_name }) => table_name)).toContain('auth_sessions')
  })

  it('indexes idempotently, resumes after restart and replaces orphaned projections', async () => {
    const provider = new FakeProvider()
    const first = new BlockchainIndexer(
      config,
      pool,
      provider as unknown as JsonRpcProvider,
    )
    expect(await first.indexOnce()).toBe(1)
    expect((await pool.query('SELECT * FROM chain_events')).rowCount).toBe(1)
    expect((await pool.query('SELECT * FROM vaults WHERE address = $1', [firstVault.toLowerCase()])).rowCount)
      .toBe(1)

    const restarted = new BlockchainIndexer(
      config,
      pool,
      provider as unknown as JsonRpcProvider,
    )
    expect(await restarted.indexOnce()).toBe(0)
    expect((await pool.query('SELECT * FROM chain_events')).rowCount).toBe(1)

    provider.block100 = block(100, hash('c'), hash('a'))
    provider.logs = [vaultCreatedLog(secondVault, hash('c'), hash('2'))]
    expect(await restarted.indexOnce()).toBe(1)
    expect((await pool.query('SELECT * FROM chain_events')).rowCount).toBe(1)
    expect((await pool.query('SELECT * FROM vaults WHERE address = $1', [firstVault.toLowerCase()])).rowCount)
      .toBe(0)
    expect((await pool.query('SELECT * FROM vaults WHERE address = $1', [secondVault.toLowerCase()])).rowCount)
      .toBe(1)
  })
})
