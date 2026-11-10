import path from 'node:path'

import { describe, expect, it } from 'vitest'

import { loadConfig, repositoryRoot } from './config.js'

describe('production API configuration', () => {
  it('accepts the committed Polygon manifest and its existing USDT asset', () => {
    const config = loadConfig({
      DATABASE_URL: 'postgres://user:password@database/lockedin',
      INDEXER_RPC_URL: 'https://polygon.example.invalid',
      INDEXER_MANIFEST_PATH: path.join(
        repositoryRoot,
        'packages/contracts/deployments/polygon/latest.json',
      ),
      API_HOST: '0.0.0.0',
      API_CORS_ORIGINS: 'https://lockedin.example',
    })

    expect(config.manifest.chainId).toBe(137)
    expect(config.manifest.contracts.usdt?.address.toLowerCase()).toBe(
      '0xc2132d05d31c914a87c6611c10748aeb04b58e8f',
    )
    expect(config.deploymentBlock).toBe(97_068_820)
  })
})
