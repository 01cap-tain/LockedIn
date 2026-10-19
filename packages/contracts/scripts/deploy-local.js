import { network } from 'hardhat'
import { mkdir, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const { ethers } = await network.create('localhost')
const [deployer, riskReserve, maintenanceTreasury] = await ethers.getSigners()

const token = await ethers.deployContract('MockUSDT')
await token.waitForDeployment()
const aToken = await ethers.deployContract('MockAToken', [await token.getAddress()])
await aToken.waitForDeployment()
const aavePool = await ethers.deployContract('MockAavePool', [await token.getAddress(), await aToken.getAddress()])
await aavePool.waitForDeployment()
await (await aToken.bindPool(await aavePool.getAddress())).wait()

const factory = await ethers.deployContract('VaultFactory', [
  await token.getAddress(),
  await riskReserve.getAddress(),
  await maintenanceTreasury.getAddress(),
  await aavePool.getAddress(),
  await aToken.getAddress(),
  31_337,
  ethers.ZeroAddress,
])
await factory.waitForDeployment()

const rewardPool = await factory.rewardPool()
const earlyExitMarket = await factory.earlyExitMarket()
const vaultDeployer = await factory.vaultDeployer()
const starterBalance = 1_000_000n * 10n ** 6n
await (await token.mint(await deployer.getAddress(), starterBalance)).wait()

console.log(`Deployer: ${await deployer.getAddress()}`)
console.log(`Mock USDT: ${await token.getAddress()}`)
console.log(`Mock Aave Pool: ${await aavePool.getAddress()}`)
console.log(`Mock aUSDT: ${await aToken.getAddress()}`)
console.log(`VaultFactory: ${await factory.getAddress()}`)
console.log(`RewardPool: ${rewardPool}`)
console.log(`EarlyExitMarket: ${earlyExitMarket}`)
console.log(`SavingsVaultDeployer: ${vaultDeployer}`)
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
      chainId: 31_337,
      contracts: {
        mockUsdt: await token.getAddress(),
        vaultFactory: await factory.getAddress(),
        rewardPool,
        earlyExitMarket,
        savingsVaultDeployer: vaultDeployer,
      },
    },
    null,
    2
  )}\n`
)
