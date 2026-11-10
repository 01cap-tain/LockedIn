import { execFileSync } from 'node:child_process'
import { mkdir, readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { network } from 'hardhat'
import { deploySafeV1Graph } from './deploy-safe-v1-graph.js'

const CHAIN_ID = 80_002
const UNIT = 10n ** 6n
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))

function requiredAddress(ethers, name) {
  const value = process.env[name]
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero EVM address.`)
  }
  return ethers.getAddress(value)
}

function cleanCommit() {
  const git = process.env.GIT_EXECUTABLE ?? (process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git')
  if (execFileSync(git, ['status', '--porcelain=v1'], { encoding: 'utf8' }).trim()) {
    throw new Error('Amoy deployment requires a clean Git worktree.')
  }
  return execFileSync(git, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
}

if (!process.env.AMOY_RPC_URL || !process.env.AMOY_DEPLOYER_PRIVATE_KEY) {
  throw new Error('AMOY_RPC_URL and AMOY_DEPLOYER_PRIVATE_KEY are required.')
}
const commit = cleanCommit()
const { ethers } = await network.create('amoy')
const [deployer] = await ethers.getSigners()
const networkIdentity = await ethers.provider.getNetwork()
if (Number(networkIdentity.chainId) !== CHAIN_ID) throw new Error('The configured RPC is not Polygon Amoy.')

// Fail before the first broadcast if the whole immutable graph cannot be paid
// for. This deliberately uses the explicit deployment ceilings, not optimistic
// estimates from public RPC gateways.
const feeData = await ethers.provider.getFeeData()
const deploymentGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice
if (!deploymentGasPrice) throw new Error('The Amoy RPC did not return a usable gas price.')
const graphGasCeiling = 1_500_000n + 6_500_000n + 2_500_000n + 4_500_000n
const requiredBalance = graphGasCeiling * deploymentGasPrice
const deployerBalance = await ethers.provider.getBalance(await deployer.getAddress())
if (deployerBalance < requiredBalance) {
  throw new Error(
    `The Amoy deployer is underfunded for the complete Safe-only V1 graph. ` +
    `Current balance: ${ethers.formatEther(deployerBalance)} POL; ` +
    `required ceiling at the current gas price: ${ethers.formatEther(requiredBalance)} POL.`
  )
}

const maintenanceTreasury = requiredAddress(ethers, 'AMOY_MAINTENANCE_TREASURY_ADDRESS')
const riskReserve = requiredAddress(ethers, 'AMOY_RISK_RESERVE_ADDRESS')
const prerequisite = JSON.parse(await readFile(path.resolve(scriptDirectory, '../deployments/amoy-prerequisites.json'), 'utf8'))
const tokenRecord = prerequisite.contracts.mockUsdt
const token = await ethers.getContractAt('MockUSDT', tokenRecord.address)
if (
  prerequisite.chainId !== CHAIN_ID ||
  await ethers.provider.getCode(tokenRecord.address) === '0x' ||
  Number(await token.decimals()) !== 6
) throw new Error('The recorded Amoy MockUSDT prerequisite is invalid.')

const deployment = await deploySafeV1Graph({
  ethers,
  deployer,
  asset: tokenRecord.address,
  riskReserve,
  maintenanceTreasury,
  safetyCouncil: await deployer.getAddress(), // testnet only
  chainId: CHAIN_ID,
  timelockDelay: 24 * 60 * 60,
  maxPositionPrincipal: 1_000_000n * UNIT,
  maxVaultPrincipal: 10_000_000n * UNIT,
  maxProtocolPrincipal: 100_000_000n * UNIT,
  minimumMaturityDuration: 7 * 60 * 60,
})
const protocolVersion = await deployment.factory.PROTOCOL_VERSION()
const deploymentId = await deployment.factory.deploymentId()
const timestamp = new Date().toISOString()
const manifest = {
  schemaVersion: 6,
  profile: 'safe-only-v1',
  network: 'polygon-amoy',
  chainId: CHAIN_ID,
  protocolVersion,
  deploymentId,
  deploymentBlock: deployment.records.vaultFactory.blockNumber,
  explorer: 'https://amoy.polygonscan.com',
  gitCommit: commit,
  deploymentTimestamp: timestamp,
  tokenDecimals: 6,
  contracts: { mockUsdt: tokenRecord, ...deployment.records },
  constructorArguments: deployment.constructorArguments,
  factoryConfiguration: {
    savingsVaultDeployment: 'non-upgradeable-per-vault',
    vaultMode: 'Safe-only',
    earnEnabled: false,
    rewardsEnabled: false,
    minimumMaturitySeconds: 25_200,
    testConfiguration: true,
    feeDistribution: { maintenanceTreasuryBps: 10_000, rewardPoolBps: 0, riskReserveBps: 0 },
    rewardPool: deployment.records.rewardPool.address,
    riskReserve,
    maintenanceTreasury,
    safety: {
      authority: await deployer.getAddress(),
      authorityType: 'test-only-deployer',
      timelockSeconds: 86_400,
      maxPositionPrincipal: (1_000_000n * UNIT).toString(),
      maxVaultPrincipal: (10_000_000n * UNIT).toString(),
      maxProtocolPrincipal: (100_000_000n * UNIT).toString(),
    },
  },
}
const outputDirectory = path.resolve(scriptDirectory, '../deployments/amoy')
await mkdir(outputDirectory, { recursive: true })
const version = `${timestamp.replace(/[:.]/g, '-')}-${commit.slice(0, 12)}`
const contents = `${JSON.stringify(
  manifest,
  (_key, value) => typeof value === 'bigint' ? value.toString() : value,
  2,
)}\n`
await writeFile(path.join(outputDirectory, `${version}.json`), contents, { flag: 'wx' })
await writeFile(path.join(outputDirectory, 'latest.json'), contents)
console.log(JSON.stringify({ version, deploymentId, contracts: deployment.records }, null, 2))
