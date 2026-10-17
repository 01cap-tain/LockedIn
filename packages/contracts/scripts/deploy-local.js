import { network } from 'hardhat'

const { ethers } = await network.create('localhost')
const [deployer] = await ethers.getSigners()

const token = await ethers.deployContract('MockUSDT')
await token.waitForDeployment()

const factory = await ethers.deployContract('VaultFactory', [await token.getAddress(), ethers.ZeroAddress])
await factory.waitForDeployment()

const rewardPool = await factory.rewardPool()
const starterBalance = 1_000_000n * 10n ** 6n
await (await token.mint(await deployer.getAddress(), starterBalance)).wait()

console.log(`Deployer: ${await deployer.getAddress()}`)
console.log(`Mock USDT: ${await token.getAddress()}`)
console.log(`VaultFactory: ${await factory.getAddress()}`)
console.log(`RewardPool: ${rewardPool}`)
console.log('Set VITE_FACTORY_ADDRESS to the VaultFactory address before starting the frontend.')
