import { Contract, JsonRpcProvider, type Log } from 'ethers'

import type { ApiConfig } from '../config.js'
import type { DatabaseClient, DatabasePool } from '../db.js'
import { inTransaction } from '../db.js'
import { rewardReadAbi, vaultReadAbi, type ContractKind } from './abis.js'
import { decodeLog } from './decoder.js'
import {
  insertCanonicalEvent,
  projectEvent,
  rebuildProjections,
} from './projector.js'
import type { CanonicalEvent, IndexerStatus, StoredEvent } from './types.js'

interface CursorRow {
  last_safe_block: string
  last_safe_hash: string
  last_error: string | null
  last_error_at: Date | null
}

function eventOrder(left: CanonicalEvent, right: CanonicalEvent): number {
  return left.blockNumber - right.blockNumber ||
    left.transactionIndex - right.transactionIndex ||
    left.logIndex - right.logIndex
}

function lower(value: string): string {
  return value.toLowerCase()
}

function requiredHash(value: string | null): string {
  if (!value) throw new Error('RPC block is missing its hash.')
  return lower(value)
}

export class BlockchainIndexer {
  readonly provider: JsonRpcProvider
  private readonly coreKinds = new Map<string, ContractKind>()
  private stopped = false

  constructor(
    private readonly config: ApiConfig,
    private readonly pool: DatabasePool,
    provider?: JsonRpcProvider,
  ) {
    this.provider = provider ?? new JsonRpcProvider(config.rpcUrl, config.manifest.chainId, {
      staticNetwork: true,
    })
    this.coreKinds.set(lower(config.manifest.contracts.vaultFactory.address), 'factory')
    this.coreKinds.set(lower(config.manifest.contracts.earlyExitMarket.address), 'market')
    this.coreKinds.set(lower(config.manifest.contracts.rewardPool.address), 'reward')
    const safety = config.manifest.contracts.safetyController
    if (safety) this.coreKinds.set(lower(safety.address), 'safety')
  }

  async run(): Promise<void> {
    this.stopped = false
    while (!this.stopped) {
      try {
        await this.indexOnce()
      } catch (error) {
        // A database outage can prevent recording its own error; the poller must
        // still remain alive and retry instead of terminating silently.
        await this.recordError(error).catch(() => undefined)
      }
      if (!this.stopped) {
        await new Promise((resolve) => setTimeout(resolve, this.config.pollIntervalMs))
      }
    }
  }

  stop(): void {
    this.stopped = true
  }

  async indexOnce(): Promise<number> {
    const network = await this.provider.getNetwork()
    if (Number(network.chainId) !== this.config.manifest.chainId) {
      throw new Error(
        `Indexer RPC chain ${network.chainId} does not match manifest ${this.config.manifest.chainId}.`,
      )
    }
    await this.registerDeployment()
    let cursor = await this.loadCursor()
    cursor = await this.reconcileReorganization(cursor)
    const latest = await this.provider.getBlockNumber()
    const confirmed = latest - this.config.confirmationDepth
    if (confirmed <= cursor.blockNumber) return 0

    const fromBlock = cursor.blockNumber + 1
    const toBlock = Math.min(confirmed, fromBlock + this.config.logRange - 1)
    const events = await this.fetchEvents(fromBlock, toBlock)
    // Persist event blocks plus the batch checkpoint. Fetching every empty
    // block made initial Amoy backfills needlessly RPC-bound while adding no
    // projection data; sparse canonical checkpoints retain reorg recovery.
    const blockNumbers = [...new Set([...events.map((event) => event.blockNumber), toBlock])]
    const blocks = await Promise.all(blockNumbers.map((blockNumber) => this.provider.getBlock(blockNumber)))
    if (blocks.some((block) => !block)) throw new Error('RPC omitted a confirmed block.')

    await inTransaction(this.pool, async (client) => {
      for (const block of blocks) {
        if (!block) continue
        await client.query(
          `INSERT INTO indexed_blocks (chain_id, block_number, block_hash, parent_hash)
           VALUES ($1, $2, $3, $4)
           ON CONFLICT (chain_id, block_number) DO UPDATE SET
             block_hash = EXCLUDED.block_hash,
             parent_hash = EXCLUDED.parent_hash`,
          [this.config.manifest.chainId, block.number, requiredHash(block.hash), lower(block.parentHash)],
        )
      }
      for (const event of events) {
        const stored = await insertCanonicalEvent(client, event)
        if (!stored) continue
        await projectEvent(client, stored)
        await this.enrichNotifications(client, stored)
      }
      const finalBlock = blocks.find((block) => block?.number === toBlock)
      if (!finalBlock) throw new Error('Confirmed block range was empty.')
      await client.query(
        `INSERT INTO indexer_state
           (chain_id, deployment_id, last_safe_block, last_safe_hash, last_error, last_error_at, updated_at)
         VALUES ($1, $2, $3, $4, NULL, NULL, now())
         ON CONFLICT (chain_id, deployment_id) DO UPDATE SET
           last_safe_block = EXCLUDED.last_safe_block,
           last_safe_hash = EXCLUDED.last_safe_hash,
           last_error = NULL,
           last_error_at = NULL,
           updated_at = now()`,
        [this.config.manifest.chainId, this.config.manifest.deploymentId, finalBlock.number, requiredHash(finalBlock.hash)],
      )
    })
    return toBlock - fromBlock + 1
  }

  async status(): Promise<IndexerStatus> {
    const [cursor, latest] = await Promise.all([this.loadCursor(), this.provider.getBlockNumber()])
    return {
      chainId: this.config.manifest.chainId,
      deploymentId: this.config.manifest.deploymentId,
      protocolVersion: this.config.manifest.protocolVersion,
      factoryAddress: this.config.manifest.contracts.vaultFactory.address,
      deploymentBlock: this.config.deploymentBlock,
      lastSafeBlock: cursor.blockNumber,
      lastSafeHash: cursor.blockHash,
      latestRpcBlock: latest,
      confirmationDepth: this.config.confirmationDepth,
      lag: Math.max(0, latest - this.config.confirmationDepth - cursor.blockNumber),
      lastError: cursor.lastError,
      lastErrorAt: cursor.lastErrorAt,
    }
  }

  private async loadCursor(): Promise<{
    blockNumber: number
    blockHash: string
    lastError: string | null
    lastErrorAt: string | null
  }> {
    const result = await this.pool.query<CursorRow>(
      'SELECT last_safe_block, last_safe_hash, last_error, last_error_at FROM indexer_state WHERE chain_id = $1 AND deployment_id = $2',
      [this.config.manifest.chainId, this.config.manifest.deploymentId],
    )
    const row = result.rows[0]
    const deploymentParent = Math.max(0, this.config.deploymentBlock - 1)
    if (row && Number(row.last_safe_block) >= deploymentParent) {
      return {
        blockNumber: Number(row.last_safe_block),
        blockHash: lower(row.last_safe_hash),
        lastError: row.last_error,
        lastErrorAt: row.last_error_at?.toISOString() ?? null,
      }
    }
    const blockNumber = deploymentParent
    const block = await this.provider.getBlock(blockNumber)
    if (!block) throw new Error(`RPC cannot load deployment parent block ${blockNumber}.`)
    return {
      blockNumber,
      blockHash: requiredHash(block.hash),
      lastError: null,
      lastErrorAt: null,
    }
  }

  private async reconcileReorganization(cursor: {
    blockNumber: number
    blockHash: string
    lastError: string | null
    lastErrorAt: string | null
  }): Promise<typeof cursor> {
    const live = await this.provider.getBlock(cursor.blockNumber)
    if (live && requiredHash(live.hash) === cursor.blockHash) return cursor

    const candidates = await this.pool.query<{
      block_number: string
      block_hash: string
    }>(
      `SELECT block_number, block_hash FROM indexed_blocks
       WHERE chain_id = $1 AND block_number <= $2
       ORDER BY block_number DESC`,
      [this.config.manifest.chainId, cursor.blockNumber],
    )
    let ancestorNumber = Math.max(0, this.config.deploymentBlock - 1)
    let ancestor = await this.provider.getBlock(ancestorNumber)
    for (const candidate of candidates.rows) {
      const candidateNumber = Number(candidate.block_number)
      const block = await this.provider.getBlock(candidateNumber)
      if (block && requiredHash(block.hash) === lower(candidate.block_hash)) {
        ancestorNumber = candidateNumber
        ancestor = block
        break
      }
    }
    if (!ancestor) throw new Error('Unable to find a canonical reorganization ancestor.')

    await inTransaction(this.pool, async (client) => {
      await client.query(
        'DELETE FROM chain_events WHERE chain_id = $1 AND deployment_id = $2 AND block_number > $3',
        [this.config.manifest.chainId, this.config.manifest.deploymentId, ancestorNumber],
      )
      await client.query(
        'DELETE FROM indexed_blocks WHERE chain_id = $1 AND block_number > $2',
        [this.config.manifest.chainId, ancestorNumber],
      )
      await rebuildProjections(client)
      await client.query(
        `INSERT INTO indexer_state
           (chain_id, deployment_id, last_safe_block, last_safe_hash, updated_at)
         VALUES ($1, $2, $3, $4, now())
         ON CONFLICT (chain_id, deployment_id) DO UPDATE SET
           last_safe_block = EXCLUDED.last_safe_block,
           last_safe_hash = EXCLUDED.last_safe_hash,
           updated_at = now()`,
        [this.config.manifest.chainId, this.config.manifest.deploymentId, ancestorNumber, requiredHash(ancestor.hash)],
      )
    })
    return {
      blockNumber: ancestorNumber,
      blockHash: requiredHash(ancestor.hash),
      lastError: cursor.lastError,
      lastErrorAt: cursor.lastErrorAt,
    }
  }

  private async fetchEvents(fromBlock: number, toBlock: number): Promise<CanonicalEvent[]> {
    const coreAddresses = [...this.coreKinds.keys()]
    const coreLogs = await this.fetchLogs(coreAddresses, fromBlock, toBlock)
    const coreEvents = coreLogs.flatMap((log) => {
      const kind = this.coreKinds.get(lower(log.address))
      if (!kind) return []
      const decoded = decodeLog(this.config.manifest.chainId, this.config.manifest.deploymentId, kind, log)
      return decoded ? [decoded] : []
    })
    const existing = await this.pool.query<{ address: string }>('SELECT address FROM vaults WHERE deployment_id = $1', [this.config.manifest.deploymentId])
    const vaultAddresses = new Set(existing.rows.map(({ address }) => lower(address)))
    for (const event of coreEvents) {
      if (event.eventName === 'VaultCreated') {
        vaultAddresses.add(String(event.payload.vault).toLowerCase())
      }
    }
    const vaultLogs = await this.fetchLogs([...vaultAddresses], fromBlock, toBlock)
    const vaultEvents = vaultLogs.flatMap((log) => {
      const decoded = decodeLog(this.config.manifest.chainId, this.config.manifest.deploymentId, 'vault', log)
      return decoded ? [decoded] : []
    })
    const unique = new Map<string, CanonicalEvent>()
    for (const event of [...coreEvents, ...vaultEvents]) {
      unique.set(`${event.transactionHash}:${event.logIndex}`, event)
    }
    return [...unique.values()].sort(eventOrder)
  }

  private async fetchLogs(
    addresses: string[],
    fromBlock: number,
    toBlock: number,
  ): Promise<Log[]> {
    if (addresses.length === 0) return []
    const logs: Log[] = []
    for (let index = 0; index < addresses.length; index += 50) {
      logs.push(...await this.provider.getLogs({
        address: addresses.slice(index, index + 50),
        fromBlock,
        toBlock,
      }))
    }
    return logs
  }

  private async enrichNotifications(
    client: DatabaseClient,
    event: StoredEvent,
  ): Promise<void> {
    if (event.eventName === 'GroupExitRequested') {
      const vault = new Contract(event.contractAddress, vaultReadAbi, this.provider)
      const positionCount = Number(
        await vault.getFunction('memberCount')({ blockTag: event.blockNumber }),
      )
      const requester = String(event.payload.requester).toLowerCase()
      for (let positionId = 0; positionId < positionCount; positionId += 1) {
        const [position, activePrincipal, status] = await Promise.all([
          vault.getFunction('position')(positionId, { blockTag: event.blockNumber }),
          vault.getFunction('activePrincipalSavings')(positionId, { blockTag: event.blockNumber }),
          vault.getFunction('memberStatus')(positionId, { blockTag: event.blockNumber }),
        ])
        const member = String(position.member).toLowerCase()
        if (member === requester || Number(status) !== 0) continue
        if (BigInt(activePrincipal) * 4n >= BigInt(position.target)) continue
        await client.query(
          `INSERT INTO notifications
             (wallet_address, kind, title, body, data, source_event_id)
           VALUES ($1, 'GROUP_EXIT_APPROVER_BELOW_THRESHOLD', $2, $3, $4, $5)
           ON CONFLICT (wallet_address, kind, source_event_id) DO NOTHING`,
          [
            member,
            'Save more before approving',
            'Your active principal is below the independent 25% approval requirement.',
            { vault: event.contractAddress, positionId },
            event.id,
          ],
        )
      }
    }
    if (event.eventName === 'ProtocolGroupAllocated') {
      const reward = new Contract(
        this.config.manifest.contracts.rewardPool.address,
        rewardReadAbi,
        this.provider,
      )
      const epochId = event.payload.epochId
      const vaultAddress = String(event.payload.vault)
      const count = Number(
        await reward.getFunction('protocolRecipientCount')(epochId, vaultAddress),
      )
      for (let index = 0; index < count; index += 1) {
        const recipient = String(
          await reward.getFunction('protocolRecipientAt')(epochId, vaultAddress, index),
        ).toLowerCase()
        await client.query(
          `INSERT INTO notifications
             (wallet_address, kind, title, body, data, source_event_id)
           VALUES ($1, 'REWARD_AVAILABLE', $2, $3, $4, $5)
           ON CONFLICT (wallet_address, kind, source_event_id) DO NOTHING`,
          [
            recipient,
            'Protocol reward available',
            'A variable, funded epoch reward is now claimable on-chain.',
            event.payload,
            event.id,
          ],
        )
      }
    }
    if (event.eventName === 'RewardsActivated') {
      const vaultAddress = String(event.payload.vault).toLowerCase()
      const vault = new Contract(vaultAddress, vaultReadAbi, this.provider)
      const count = Number(
        await vault.getFunction('rewardEligibleCount')({ blockTag: event.blockNumber }),
      )
      for (let index = 0; index < count; index += 1) {
        const recipient = String(
          await vault.getFunction('rewardRecipientAt')(index, { blockTag: event.blockNumber }),
        ).toLowerCase()
        await client.query(
          `INSERT INTO notifications
             (wallet_address, kind, title, body, data, source_event_id)
           VALUES ($1, 'REWARD_AVAILABLE', $2, $3, $4, $5)
           ON CONFLICT (wallet_address, kind, source_event_id) DO NOTHING`,
          [
            recipient,
            'Sponsored reward available',
            'A funded vault-specific reward is now claimable on-chain.',
            event.payload,
            event.id,
          ],
        )
      }
    }
  }

  private async recordError(error: unknown): Promise<void> {
    const message = error instanceof Error ? error.message : String(error)
    const blockNumber = Math.max(0, this.config.deploymentBlock - 1)
    const block = await this.provider.getBlock(blockNumber).catch(() => null)
    await this.pool.query(
      `INSERT INTO indexer_state
         (chain_id, deployment_id, last_safe_block, last_safe_hash, last_error, last_error_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, now(), now())
       ON CONFLICT (chain_id, deployment_id) DO UPDATE SET
         last_error = EXCLUDED.last_error,
         last_error_at = now(),
         updated_at = now()`,
      [
        this.config.manifest.chainId,
        this.config.manifest.deploymentId,
        blockNumber,
        block?.hash ? lower(block.hash) : 'unknown',
        message,
      ],
    )
    await this.pool.query(
      `INSERT INTO indexer_errors (chain_id, deployment_id, message) VALUES ($1, $2, $3)`,
      [this.config.manifest.chainId, this.config.manifest.deploymentId, message],
    )
  }

  private async registerDeployment(): Promise<void> {
    await this.pool.query(
      `INSERT INTO protocol_deployments
         (deployment_id, chain_id, protocol_version, factory_address, deployment_block, manifest_path, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (deployment_id) DO UPDATE SET
         protocol_version = EXCLUDED.protocol_version,
         factory_address = EXCLUDED.factory_address,
         deployment_block = EXCLUDED.deployment_block,
         manifest_path = EXCLUDED.manifest_path,
         active = EXCLUDED.active`,
      [
        this.config.manifest.deploymentId,
        this.config.manifest.chainId,
        this.config.manifest.protocolVersion,
        lower(this.config.manifest.contracts.vaultFactory.address),
        this.config.deploymentBlock,
        this.config.manifestPath,
        this.config.deployments.find((deployment) => deployment.manifest.deploymentId === this.config.manifest.deploymentId)?.active ?? false,
      ],
    )
  }
}
