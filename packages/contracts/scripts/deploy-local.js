import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { network } from 'hardhat'
import { deploySafeV1Graph } from './deploy-safe-v1-graph.js'

const { ethers } = await network.create('localhost')
const [deployer, riskReserve, maintenanceTreasury] = await ethers.getSigners()
const token = await ethers.deployContract('MockUSDT')
await token.waitForDeployment()
const tokenTransaction = token.deploymentTransaction()
const tokenReceipt = await tokenTransaction.wait()
const tokenRecord = {
  address: await token.getAddress(),
  transactionHash: tokenTransaction.hash,
  blockNumber: tokenReceipt.blockNumber,
}
const unit = 10n ** 6n
const deployment = await deploySafeV1Graph({
  ethers,
  deployer,
  asset: tokenRecord.address,
  riskReserve: await riskReserve.getAddress(),
  maintenanceTreasury: await maintenanceTreasury.getAddress(),
  safetyCouncil: await deployer.getAddress(),
  chainId: 31_337,
  timelockDelay: 60 * 60,
  maxPositionPrincipal: 1_000_000n * unit,
  maxVaultPrincipal: 10_000_000n * unit,
  maxProtocolPrincipal: 100_000_000n * unit,
  minimumMaturityDuration: 7 * 60 * 60,
})
await (await token.mint(await deployer.getAddress(), 1_000_000n * unit)).wait()
const protocolVersion = await deployment.factory.PROTOCOL_VERSION()
const deploymentId = await deployment.factory.deploymentId()
const manifest = {
  schemaVersion: 6,
  profile: 'safe-only-v1',
  network: 'hardhat-localhost',
  chainId: 31_337,
  protocolVersion,
  deploymentId,
  deploymentBlock: deployment.records.vaultFactory.blockNumber,
  explorer: 'http://127.0.0.1:8545',
  deploymentTimestamp: new Date().toISOString(),
  tokenDecimals: 6,
  contracts: { mockUsdt: tokenRecord, ...deployment.records },
  constructorArguments: deployment.constructorArguments,
  factoryConfiguration: {
    vaultMode: 'Safe-only', earnEnabled: false, rewardsEnabled: false,
    minimumMaturitySeconds: 25_200, testConfiguration: true,
    maintenanceTreasury: await maintenanceTreasury.getAddress(),
    riskReserve: await riskReserve.getAddress(),
    rewardPool: deployment.records.rewardPool.address,
    feeDistribution: { maintenanceTreasuryBps: 10_000, rewardPoolBps: 0, riskReserveBps: 0 },
  },
}
const outputDirectory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../deployments/local')
await mkdir(outputDirectory, { recursive: true })
const contents = `${JSON.stringify(
  manifest,
  (_key, value) => typeof value === 'bigint' ? value.toString() : value,
  2,
)}\n`
await writeFile(path.join(outputDirectory, 'latest.json'), contents)
console.log(JSON.stringify({ deploymentId, contracts: manifest.contracts }, null, 2))
