import { execFileSync } from 'node:child_process'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import { network } from 'hardhat'

const CHAIN_ID = 80_002
const TOKEN_DECIMALS = 6
const FIVE_PERCENT_RAY = 5n * 10n ** 25n

function requiredAddress(ethers, name) {
  const value = process.env[name]
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero public EVM address.`)
  }
  return ethers.getAddress(value)
}

function gitCommit() {
  const gitExecutable =
    process.env.GIT_EXECUTABLE ??
    (process.platform === 'win32'
      ? 'C:\\Program Files\\Git\\cmd\\git.exe'
      : 'git')
  try {
    const status = execFileSync(gitExecutable, ['status', '--porcelain=v1'], {
      encoding: 'utf8',
    }).trim()
    if (status) {
      throw new Error('The worktree is not clean.')
    }
    return execFileSync(gitExecutable, ['rev-parse', 'HEAD'], {
      encoding: 'utf8',
    }).trim()
  } catch {
    throw new Error(
      'Deployment requires a clean Git worktree and a working Git executable. Set GIT_EXECUTABLE only for a non-standard Git installation.'
    )
  }
}

async function deploymentRecord(contract) {
  const transaction = contract.deploymentTransaction()
  if (!transaction) throw new Error('Missing deployment transaction.')
  const receipt = await transaction.wait()
  return {
    address: await contract.getAddress(),
    transactionHash: transaction.hash,
    blockNumber: receipt.blockNumber,
  }
}

if (!process.env.AMOY_RPC_URL || !process.env.AMOY_DEPLOYER_PRIVATE_KEY) {
  throw new Error(
    'AMOY_RPC_URL and AMOY_DEPLOYER_PRIVATE_KEY are required in the process environment.'
  )
}

// Refuse before sending any transaction if the manifest cannot identify exact source.
const commit = gitCommit()

const { ethers } = await network.create('amoy')
const [deployer] = await ethers.getSigners()
if (!deployer) throw new Error('No Amoy deployer signer is configured.')
const chain = await ethers.provider.getNetwork()
if (Number(chain.chainId) !== CHAIN_ID)
  throw new Error(`Expected Amoy ${CHAIN_ID}, received ${chain.chainId}.`)

const riskReserve = requiredAddress(ethers, 'AMOY_RISK_RESERVE_ADDRESS')
const maintenanceTreasury = requiredAddress(
  ethers,
  'AMOY_MAINTENANCE_TREASURY_ADDRESS'
)
if (riskReserve === maintenanceTreasury)
  throw new Error('Test treasury addresses must be distinct.')

const token = await ethers.deployContract('MockUSDT')
await token.waitForDeployment()
const mockYieldAdapterFactory = await ethers.deployContract(
  'MockYieldAdapterFactory',
  [await token.getAddress(), CHAIN_ID, FIVE_PERCENT_RAY]
)
await mockYieldAdapterFactory.waitForDeployment()
const factory = await ethers.deployContract('VaultFactory', [
  await token.getAddress(),
  riskReserve,
  maintenanceTreasury,
  ethers.ZeroAddress,
  ethers.ZeroAddress,
  CHAIN_ID,
  await mockYieldAdapterFactory.getAddress(),
])
await factory.waitForDeployment()

const tokenRecord = await deploymentRecord(token)
const adapterFactoryRecord = await deploymentRecord(mockYieldAdapterFactory)
const factoryRecord = await deploymentRecord(factory)
const factoryReceipt = await factory.deploymentTransaction().wait()
const rewardPool = await factory.rewardPool()
const earlyExitMarket = await factory.earlyExitMarket()
const timestamp = new Date().toISOString()
const manifest = {
  schemaVersion: 1,
  network: 'polygon-amoy',
  chainId: CHAIN_ID,
  explorer: 'https://amoy.polygonscan.com',
  gitCommit: commit,
  deploymentTimestamp: timestamp,
  tokenDecimals: TOKEN_DECIMALS,
  contracts: {
    mockUsdt: tokenRecord,
    mockYieldAdapterFactory: adapterFactoryRecord,
    vaultFactory: factoryRecord,
    rewardPool: {
      address: rewardPool,
      transactionHash: factoryRecord.transactionHash,
      blockNumber: factoryReceipt.blockNumber,
    },
    earlyExitMarket: {
      address: earlyExitMarket,
      transactionHash: factoryRecord.transactionHash,
      blockNumber: factoryReceipt.blockNumber,
    },
  },
  factoryConfiguration: {
    savingsVaultDeployment: 'non-upgradeable-per-vault',
    yieldAdapter: 'MockYieldAdapter',
    riskReserve,
    maintenanceTreasury,
  },
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const outputDirectory = path.resolve(scriptDirectory, '../deployments/amoy')
await mkdir(outputDirectory, { recursive: true })
const version = `${timestamp.replace(/[:.]/g, '-')}-${commit.slice(0, 12)}`
const contents = `${JSON.stringify(manifest, null, 2)}\n`
await writeFile(path.join(outputDirectory, `${version}.json`), contents, {
  flag: 'wx',
})
await writeFile(path.join(outputDirectory, 'latest.json'), contents)

console.log(`Amoy deployment recorded as ${version}.`)
console.log(`VaultFactory: ${factoryRecord.address}`)
console.log(
  `Explorer: https://amoy.polygonscan.com/address/${factoryRecord.address}`
)
