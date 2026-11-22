import type { JsonRpcProvider } from 'ethers'
import { describe, expect, it, vi } from 'vitest'

import type { ApiConfig } from '../config.js'
import type { DatabasePool } from '../db.js'
import { BlockchainIndexer } from './indexer.js'

describe('indexer status', () => {
  it('reports a degraded RPC without throwing when the provider quota is unavailable', async () => {
    const pool = {
      query: vi.fn().mockImplementation((sql: string) => {
        if (sql.includes('FROM indexer_state')) {
          return Promise.resolve({
            rows: [{
              last_safe_block: '97068820',
              last_safe_hash: `0x${'1'.repeat(64)}`,
              last_error: null,
              last_error_at: null,
            }],
          })
        }
        return Promise.resolve({ rows: [{ count: '1' }] })
      }),
    } as unknown as DatabasePool
    const provider = {
      getBlockNumber: vi.fn().mockRejectedValue(new Error('429 quota exhausted')),
    } as unknown as JsonRpcProvider
    const config = {
      rpcUrl: 'https://polygon.example.invalid',
      confirmationDepth: 12,
      deploymentBlock: 97_068_820,
      manifest: {
        chainId: 137,
        deploymentId: 'lockedin-polygon-v1',
        protocolVersion: 'lockedin-circle/1.5.0-safe',
        contracts: {
          vaultFactory: { address: '0x0000000000000000000000000000000000000001' },
          earlyExitMarket: { address: '0x0000000000000000000000000000000000000002' },
        },
      },
    } as ApiConfig

    const indexer = new BlockchainIndexer(config, pool, provider)
    await expect(indexer.status()).resolves.toMatchObject({
      rpcStatus: 'degraded',
      latestRpcBlock: 97_068_820,
      lastError: 'Polygon RPC is temporarily unavailable.',
    })
  })
})
