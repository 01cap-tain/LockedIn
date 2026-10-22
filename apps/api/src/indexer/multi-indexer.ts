import type { ApiConfig } from '../config.js'
import type { DatabasePool } from '../db.js'
import { BlockchainIndexer } from './indexer.js'
import type { IndexerStatus } from './types.js'

export interface MultiIndexerStatus {
  chainId: number
  deploymentCount: number
  lastError: string | null
  deployments: IndexerStatus[]
}

/** Runs one independent cursor per immutable deployment on the same chain. */
export class MultiDeploymentIndexer {
  private readonly indexers: BlockchainIndexer[]

  constructor(config: ApiConfig, pool: DatabasePool) {
    this.indexers = config.deployments.map((deployment) => new BlockchainIndexer({
      ...config,
      manifestPath: deployment.manifestPath,
      manifest: deployment.manifest,
      deploymentBlock: deployment.deploymentBlock,
    }, pool))
  }

  async run(): Promise<void> {
    await Promise.all(this.indexers.map((indexer) => indexer.run()))
  }

  stop(): void {
    this.indexers.forEach((indexer) => indexer.stop())
  }

  async indexOnce(): Promise<number> {
    const counts = await Promise.all(this.indexers.map((indexer) => indexer.indexOnce()))
    return counts.reduce((sum, count) => sum + count, 0)
  }

  async status(): Promise<MultiIndexerStatus> {
    const deployments = await Promise.all(this.indexers.map((indexer) => indexer.status()))
    return {
      chainId: deployments[0]?.chainId ?? 0,
      deploymentCount: deployments.length,
      lastError: deployments.find((deployment) => deployment.lastError)?.lastError ?? null,
      deployments,
    }
  }
}
