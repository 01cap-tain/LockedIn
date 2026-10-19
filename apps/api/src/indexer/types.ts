import type { ContractKind } from './abis.js'

export interface CanonicalEvent {
  chainId: number
  blockNumber: number
  blockHash: string
  transactionHash: string
  transactionIndex: number
  logIndex: number
  contractAddress: string
  contractKind: ContractKind
  eventName: string
  payload: Record<string, string | number | boolean>
}

export interface StoredEvent extends CanonicalEvent {
  id: string
}

export interface IndexerStatus {
  chainId: number
  deploymentBlock: number
  lastSafeBlock: number
  lastSafeHash: string
  latestRpcBlock: number
  confirmationDepth: number
  lag: number
  lastError: string | null
  lastErrorAt: string | null
}
