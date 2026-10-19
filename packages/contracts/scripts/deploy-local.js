import { network } from 'hardhat'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { ethers } = await network.create('localhost')
const [deployer, riskReserve, maintenanceTreasury] = await ethers.getSigners()

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

const token = await ethers.deployContract('MockUSDT')
await token.waitForDeployment()
const aToken = await ethers.deployContract('MockAToken', [await token.getAddress()])
await aToken.waitForDeployment()
const aavePool = await ethers.deployContract('MockAavePool', [await token.getAddress(), await aToken.getAddress()])
await aavePool.waitForDeployment()
await (await aToken.bindPool(await aavePool.getAddress())).wait()

const deployerAddress = await deployer.getAddress()
const safetyNonce = await ethers.provider.getTransactionCount(deployerAddress)
const predictedFactory = ethers.getCreateAddress({
  from: deployerAddress,
  nonce: safetyNonce + 2,
})
const safetyControllerContract = await ethers.deployContract('SafetyController', [
  predictedFactory,
  deployerAddress, // Test-only local safety council.
  60 * 60,
  1_000_000n * 10n ** 6n,
  10_000_000n * 10n ** 6n,
  100_000_000n * 10n ** 6n,
])
await safetyControllerContract.waitForDeployment()

const rewardPoolContract = await ethers.deployContract('RewardPool', [
  await token.getAddress(),
  predictedFactory,
  7 * 24 * 60 * 60, // Test-only seven-day epochs.
  24 * 60 * 60,
  1n * 10n ** 6n,
  24 * 60 * 60,
])
await rewardPoolContract.waitForDeployment()

const factory = await ethers.deployContract('VaultFactory', [
  await token.getAddress(),
  await riskReserve.getAddress(),
  await maintenanceTreasury.getAddress(),
  await aavePool.getAddress(),
  await aToken.getAddress(),
  31_337,
  ethers.ZeroAddress,
  await safetyControllerContract.getAddress(),
  await rewardPoolContract.getAddress(),
])
await factory.waitForDeployment()

const rewardPool = await factory.rewardPool()
const earlyExitMarket = await factory.earlyExitMarket()
const vaultDeployer = await factory.vaultDeployer()
const safetyController = await safetyControllerContract.getAddress()
const protocolVersion = await factory.PROTOCOL_VERSION()
const deploymentId = await factory.deploymentId()
const starterBalance = 1_000_000n * 10n ** 6n
await (await token.mint(await deployer.getAddress(), starterBalance)).wait()
const tokenRecord = await deploymentRecord(token)
const factoryRecord = await deploymentRecord(factory)
const rewardPoolRecord = await deploymentRecord(rewardPoolContract)
const safetyControllerRecord = await deploymentRecord(safetyControllerContract)

console.log(`Deployer: ${await deployer.getAddress()}`)
console.log(`Mock USDT: ${await token.getAddress()}`)
console.log(`Mock Aave Pool: ${await aavePool.getAddress()}`)
console.log(`Mock aUSDT: ${await aToken.getAddress()}`)
console.log(`VaultFactory: ${await factory.getAddress()}`)
console.log(`RewardPool: ${rewardPool}`)
console.log(`EarlyExitMarket: ${earlyExitMarket}`)
console.log(`SavingsVaultDeployer: ${vaultDeployer}`)
console.log(`SafetyController: ${safetyController} (deployer-controlled, test only)`)
console.log(`Risk reserve: ${await riskReserve.getAddress()}`)
console.log(`Maintenance treasury: ${await maintenanceTreasury.getAddress()}`)
console.log('Set VITE_FACTORY_ADDRESS to the VaultFactory address before starting the frontend.')

const outputDirectory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../deployments/local'
)
await mkdir(outputDirectory, { recursive: true })
await writeFile(
  path.join(outputDirectory, 'latest.json'),
  `${JSON.stringify(
    {
      schemaVersion: 5,
      network: 'hardhat-localhost',
      chainId: 31_337,
      protocolVersion,
      deploymentId,
      deploymentBlock: factoryRecord.blockNumber,
      explorer: 'http://127.0.0.1:8545',
      deploymentTimestamp: new Date().toISOString(),
      contracts: {
        mockUsdt: tokenRecord,
        vaultFactory: factoryRecord,
        rewardPool: rewardPoolRecord,
        earlyExitMarket: {
          address: earlyExitMarket,
          transactionHash: factoryRecord.transactionHash,
          blockNumber: factoryRecord.blockNumber,
        },
        savingsVaultDeployer: {
          address: vaultDeployer,
          transactionHash: factoryRecord.transactionHash,
          blockNumber: factoryRecord.blockNumber,
        },
        safetyController: safetyControllerRecord,
      },
      rewardConfiguration: {
        epochSeconds: 7 * 24 * 60 * 60,
        registrationGraceSeconds: 24 * 60 * 60,
        minimumRewardTarget: (1n * 10n ** 6n).toString(),
        minimumSavingDurationSeconds: 24 * 60 * 60,
        environment: 'test-only-local',
      },
    },
    null,
    2
  )}\n`
)
