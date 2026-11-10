import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { network } from 'hardhat'
import { deploySafeV1Graph } from './deploy-safe-v1-graph.js'
import { polygonAaveConfig } from './polygon-aave-config.js'
import { assertProductionMaturityConfiguration } from './production-profile.js'

const CHAIN_ID = 137
const APPROVAL_PHRASE = 'I_APPROVE_THE_EXACT_MANIFEST'
const GRAPH_GAS_CEILING = 15_000_000n
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))

function required(name) {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is required.`)
  return value
}

function positive(name) {
  const value = BigInt(required(name))
  if (value <= 0n) throw new Error(`${name} must be positive.`)
  return value
}

function cleanCommit() {
  const git = process.env.GIT_EXECUTABLE ?? (process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git')
  if (execFileSync(git, ['status', '--porcelain=v1'], { encoding: 'utf8' }).trim()) {
    throw new Error('Polygon deployment requires a clean Git worktree at the approved commit.')
  }
  return execFileSync(git, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

if (process.env.POLYGON_DEPLOYMENT_APPROVED !== APPROVAL_PHRASE) {
  throw new Error(`Broadcast is locked. Set POLYGON_DEPLOYMENT_APPROVED=${APPROVAL_PHRASE} only after approving the exact manifest.`)
}
const commit = cleanCommit()
const { ethers } = await network.create('polygon')
const deployerAddress = ethers.getAddress(required('POLYGON_DEPLOYER_ADDRESS'))
const identity = await ethers.provider.getNetwork()
if (Number(identity.chainId) !== CHAIN_ID) throw new Error('The configured RPC is not Polygon mainnet chain 137.')
const approvedNonce = Number(required('POLYGON_APPROVED_DEPLOYER_NONCE'))
const pendingNonce = await ethers.provider.getTransactionCount(deployerAddress, 'pending')
if (!Number.isSafeInteger(approvedNonce) || approvedNonce !== pendingNonce) {
  throw new Error(`The deployer nonce changed. Approved ${approvedNonce}; pending ${pendingNonce}. Regenerate and reapprove the manifest.`)
}
const safetyCouncil = ethers.getAddress(required('POLYGON_SAFETY_COUNCIL_ADDRESS'))
const riskReserve = ethers.getAddress(required('POLYGON_RISK_RESERVE_ADDRESS'))
const maintenanceTreasury = ethers.getAddress(required('POLYGON_MAINTENANCE_TREASURY_ADDRESS'))
if ([safetyCouncil, riskReserve, maintenanceTreasury].some((address) => address === ethers.ZeroAddress)
  || safetyCouncil.toLowerCase() === riskReserve.toLowerCase()
  || safetyCouncil.toLowerCase() === maintenanceTreasury.toLowerCase()) {
  throw new Error('Safety, risk-reserve and maintenance destinations must be nonzero, and the Safety Council must be distinct from the fee destination.')
}
const minimumMaturityDuration = Number(process.env.POLYGON_MIN_MATURITY_SECONDS ?? 25_200)
assertProductionMaturityConfiguration({ chainId: CHAIN_ID, profile: 'safe-only-v1-production', minimumMaturityDuration })
const caps = {
  position: positive('POLYGON_MAX_POSITION_PRINCIPAL'),
  vault: positive('POLYGON_MAX_VAULT_PRINCIPAL'),
  protocol: positive('POLYGON_MAX_PROTOCOL_PRINCIPAL'),
}
if (!(caps.position <= caps.vault && caps.vault <= caps.protocol)) throw new Error('Production caps are inconsistent.')
if (caps.position > 5_000n * 10n ** 6n || caps.vault > 25_000n * 10n ** 6n || caps.protocol > 50_000n * 10n ** 6n) {
  throw new Error('Safe-only V1 caps exceed the reviewed launch ceilings.')
}
const usdt = await ethers.getContractAt(['function decimals() view returns (uint8)'], polygonAaveConfig.usdt)
if (await ethers.provider.getCode(polygonAaveConfig.usdt) === '0x' || Number(await usdt.decimals()) !== 6) {
  throw new Error('Official Polygon USDT failed the live bytecode or decimal check.')
}
const approvedMaximum = positive('POLYGON_MAX_DEPLOYMENT_COST_WEI')
const deploymentMaxFeePerGas = approvedMaximum / GRAPH_GAS_CEILING
if (deploymentMaxFeePerGas === 0n) throw new Error('The approved deployment maximum is too low.')
const estimatedCeiling = GRAPH_GAS_CEILING * deploymentMaxFeePerGas
if (await ethers.provider.getBalance(deployerAddress) < estimatedCeiling) {
  throw new Error('The deployer POL balance is below the approved deployment ceiling.')
}

// Hardhat resolves the encrypted keystore while creating the network, before
// this script can run its read-only checks. Derive an immutable per-gas ceiling
// from the owner-approved graph total instead of accepting a second, mutable
// RPC quote after the password prompt. The sum of all transaction gas limits
// multiplied by this value can never exceed approvedMaximum.
const [deployer] = await ethers.getSigners()
if (ethers.getAddress(await deployer.getAddress()) !== deployerAddress) {
  throw new Error('The configured signer does not match POLYGON_DEPLOYER_ADDRESS.')
}
const feeData = await ethers.provider.getFeeData()
const latestBlock = await ethers.provider.getBlock('latest')
if (latestBlock?.baseFeePerGas && latestBlock.baseFeePerGas > deploymentMaxFeePerGas) {
  throw new Error(
    `Polygon base fee ${latestBlock.baseFeePerGas} wei exceeds the approved per-gas ceiling ${deploymentMaxFeePerGas} wei. Retry later without increasing the approved total.`,
  )
}
const priorityFeeLimit = 50_000_000_000n
const suggestedPriorityFee = feeData.maxPriorityFeePerGas ?? 30_000_000_000n
const maxPriorityFeePerGas = suggestedPriorityFee > priorityFeeLimit
  ? priorityFeeLimit
  : suggestedPriorityFee
const transactionOverrides = {
  maxFeePerGas: deploymentMaxFeePerGas,
  maxPriorityFeePerGas: maxPriorityFeePerGas > deploymentMaxFeePerGas
    ? deploymentMaxFeePerGas
    : maxPriorityFeePerGas,
}

const deployment = await deploySafeV1Graph({
  ethers,
  deployer,
  asset: polygonAaveConfig.usdt,
  riskReserve,
  maintenanceTreasury,
  safetyCouncil,
  chainId: CHAIN_ID,
  timelockDelay: 86_400,
  maxPositionPrincipal: caps.position,
  maxVaultPrincipal: caps.vault,
  maxProtocolPrincipal: caps.protocol,
  minimumMaturityDuration,
  transactionOverrides,
})
for (const [name, record] of Object.entries(deployment.records)) {
  if (await ethers.provider.getCode(record.address) === '0x') throw new Error(`${name} has no deployed bytecode.`)
}
const protocolVersion = await deployment.factory.PROTOCOL_VERSION()
const deploymentId = await deployment.factory.deploymentId()
const timestamp = new Date().toISOString()
const manifest = {
  schemaVersion: 6,
  profile: 'safe-only-v1',
  network: 'polygon',
  chainId: CHAIN_ID,
  protocolVersion,
  deploymentId,
  deploymentBlock: deployment.records.vaultFactory.blockNumber,
  explorer: 'https://polygonscan.com',
  gitCommit: commit,
  deploymentTimestamp: timestamp,
  tokenDecimals: 6,
  contracts: { usdt: { address: polygonAaveConfig.usdt }, ...deployment.records },
  constructorArguments: deployment.constructorArguments,
  factoryConfiguration: {
    savingsVaultDeployment: 'non-upgradeable-per-vault',
    vaultMode: 'Safe-only',
    earnEnabled: false,
    rewardsEnabled: false,
    minimumMaturitySeconds: minimumMaturityDuration,
    testConfiguration: false,
    feeDistribution: { rewardPoolBps: 0, riskReserveBps: 0, maintenanceTreasuryBps: 10_000 },
    rewardPool: deployment.records.rewardPool.address,
    riskReserve,
    maintenanceTreasury,
    safety: {
      authority: safetyCouncil,
      authorityType: 'reviewed-production-authority',
      timelockSeconds: 86_400,
      maxPositionPrincipal: caps.position.toString(),
      maxVaultPrincipal: caps.vault.toString(),
      maxProtocolPrincipal: caps.protocol.toString(),
    },
  },
}
const outputDirectory = path.resolve(scriptDirectory, '../deployments/polygon')
await mkdir(outputDirectory, { recursive: true })
const version = `${timestamp.replace(/[:.]/g, '-')}-${commit.slice(0, 12)}`
const contents = `${JSON.stringify(manifest, (_key, value) => typeof value === 'bigint' ? value.toString() : value, 2)}\n`
await writeFile(path.join(outputDirectory, `${version}.json`), contents, { flag: 'wx' })
await writeFile(path.join(outputDirectory, 'latest.json'), contents, { flag: 'wx' })
console.log(JSON.stringify({ version, deploymentId, contracts: deployment.records }, null, 2))
