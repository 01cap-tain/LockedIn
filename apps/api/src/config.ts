import { existsSync, readFileSync } from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { getAddress } from 'ethers'
import { z } from 'zod'

const sourceDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(sourceDirectory, '../../..')

const environmentSchema = z.object({
  DATABASE_URL: z.string().min(1),
  INDEXER_RPC_URL: z.string().url().default('http://127.0.0.1:8545'),
  INDEXER_MANIFEST_PATH: z.string().min(1).default(
    'packages/contracts/deployments/local/latest.json',
  ),
  INDEXER_MANIFEST_PATHS: z.string().optional(),
  INDEXER_CONFIRMATION_DEPTH: z.coerce.number().int().min(0).max(1_000).default(12),
  INDEXER_LOG_RANGE: z.coerce.number().int().min(1).max(2_000).default(100),
  INDEXER_POLL_INTERVAL_MS: z.coerce.number().int().min(500).default(5_000),
  AUTH_SESSION_MINUTES: z.coerce.number().int().min(1).max(1_440).default(30),
  AUTH_NONCE_MINUTES: z.coerce.number().int().min(1).max(30).default(5),
  API_HOST: z.string().default('127.0.0.1'),
  API_PORT: z.coerce.number().int().min(1).max(65_535).default(3_001),
})

export interface DeploymentManifest {
  chainId: number
  deploymentId: string
  protocolVersion: string
  deploymentBlock: number
  explorer: string
  deploymentTimestamp?: string
  contracts: {
    vaultFactory: { address: string; blockNumber: number }
    earlyExitMarket: { address: string; blockNumber: number }
    rewardPool: { address: string; blockNumber: number }
    safetyController?: { address: string; blockNumber: number }
    mockUsdt: { address: string; blockNumber: number }
  }
}

export interface ApiConfig {
  databaseUrl: string
  rpcUrl: string
  manifestPath: string
  manifest: DeploymentManifest
  deploymentBlock: number
  deployments: Array<{
    manifestPath: string
    manifest: DeploymentManifest
    deploymentBlock: number
    active: boolean
  }>
  confirmationDepth: number
  logRange: number
  pollIntervalMs: number
  sessionMinutes: number
  nonceMinutes: number
  host: string
  port: number
}

function resolveManifestPath(value: string): string {
  if (path.isAbsolute(value)) return value
  const fromProcess = path.resolve(process.cwd(), value)
  if (existsSync(fromProcess)) return fromProcess
  return path.resolve(repositoryRoot, value)
}

export function loadConfig(environment: NodeJS.ProcessEnv = process.env): ApiConfig {
  // Local development may keep secrets in the ignored repository .env. Existing
  // process variables retain precedence; no value is ever logged or returned.
  const localEnvironmentPath = path.join(repositoryRoot, '.env')
  if (environment === process.env && !environment.DATABASE_URL && existsSync(localEnvironmentPath)) {
    process.loadEnvFile(localEnvironmentPath)
  }
  const parsed = environmentSchema.parse(environment)
  const manifestPaths = (parsed.INDEXER_MANIFEST_PATHS?.split(',') ?? [parsed.INDEXER_MANIFEST_PATH])
    .map((value) => resolveManifestPath(value.trim()))
  const deployments = manifestPaths.map((manifestPath, index) => {
    const manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as DeploymentManifest
    const required = [manifest.contracts.vaultFactory, manifest.contracts.earlyExitMarket, manifest.contracts.rewardPool, manifest.contracts.mockUsdt]
    if (!Number.isSafeInteger(manifest.chainId) || manifest.chainId <= 0 || !manifest.deploymentId || !manifest.protocolVersion || !Number.isSafeInteger(manifest.deploymentBlock) || manifest.deploymentBlock < 0) {
      throw new Error('Deployment manifest has an invalid immutable identity.')
    }
    for (const contract of required) {
      getAddress(contract.address)
      if (!Number.isSafeInteger(contract.blockNumber) || contract.blockNumber < 0) throw new Error('Deployment manifest has an invalid deployment block.')
    }
    return { manifestPath, manifest, deploymentBlock: manifest.deploymentBlock, active: index === manifestPaths.length - 1 }
  })
  const active = deployments.at(-1)
  if (!active) throw new Error('At least one deployment manifest is required.')
  if (deployments.some((deployment) => deployment.manifest.chainId !== active.manifest.chainId)) {
    throw new Error('All configured deployments must use the same indexer RPC chain.')
  }
  return {
    databaseUrl: parsed.DATABASE_URL,
    rpcUrl: parsed.INDEXER_RPC_URL,
    manifestPath: active.manifestPath,
    manifest: active.manifest,
    deploymentBlock: active.deploymentBlock,
    deployments,
    confirmationDepth: parsed.INDEXER_CONFIRMATION_DEPTH,
    logRange: parsed.INDEXER_LOG_RANGE,
    pollIntervalMs: parsed.INDEXER_POLL_INTERVAL_MS,
    sessionMinutes: parsed.AUTH_SESSION_MINUTES,
    nonceMinutes: parsed.AUTH_NONCE_MINUTES,
    host: parsed.API_HOST,
    port: parsed.API_PORT,
  }
}

export { repositoryRoot }
