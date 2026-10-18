import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { network } from 'hardhat'

const UNIT = 10n ** 6n
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const deploymentDirectory = path.resolve(scriptDirectory, '../deployments/amoy')
const manifest = JSON.parse(
  await readFile(path.join(deploymentDirectory, 'latest.json'), 'utf8')
)

const { ethers } = await network.create('amoy')
const signers = await ethers.getSigners()
if (signers.length < 3) {
  throw new Error(
    'Configure distinct AMOY_DEPLOYER_PRIVATE_KEY, AMOY_WALLET_A_PRIVATE_KEY and AMOY_WALLET_B_PRIVATE_KEY values.'
  )
}
const [deployer, walletA, walletB] = signers
const addresses = await Promise.all(
  [deployer, walletA, walletB].map((signer) => signer.getAddress())
)
assert.equal(
  new Set(addresses.map((value) => value.toLowerCase())).size,
  3,
  'Test wallets must be distinct.'
)

const token = await ethers.getContractAt(
  'MockUSDT',
  manifest.contracts.mockUsdt.address,
  deployer
)
const factory = await ethers.getContractAt(
  'VaultFactory',
  manifest.contracts.vaultFactory.address,
  walletA
)
const market = await ethers.getContractAt(
  'EarlyExitMarket',
  manifest.contracts.earlyExitMarket.address,
  walletA
)
const rewardPool = await ethers.getContractAt(
  'RewardPool',
  manifest.contracts.rewardPool.address,
  deployer
)
const latestBlock = await ethers.provider.getBlock('latest')
const maturity = BigInt(latestBlock.timestamp) + 30n * 24n * 60n * 60n

await (await token.mint(await walletA.getAddress(), 250n * UNIT)).wait()
await (await token.mint(await walletB.getAddress(), 250n * UNIT)).wait()
await (await token.mint(await deployer.getAddress(), 8n * UNIT)).wait()

// Safe vault and full two-wallet early-exit settlement.
const safeCreation = await (
  await factory.createPersonalVault(100n * UNIT, maturity, 1_000, 0)
).wait()
const safeCreated = safeCreation.logs
  .map((log) => {
    try {
      return factory.interface.parseLog(log)
    } catch {
      return null
    }
  })
  .find((event) => event?.name === 'VaultCreated')
const safeVaultAddress = safeCreated.args.vault
const safeVault = await ethers.getContractAt(
  'SavingsVault',
  safeVaultAddress,
  walletA
)
await (
  await token.connect(walletA).approve(safeVaultAddress, 100n * UNIT)
).wait()
await (await safeVault.connect(walletA).deposit(0, 100n * UNIT)).wait()
const positionBefore = await safeVault.position(0)
assert.equal(positionBefore.emergencyBalance, 10n * UNIT)
assert.equal(positionBefore.lockedBalance, 90n * UNIT)

const reference = await market.referenceDiscount(safeVaultAddress, 0)
assert(reference.discountBps >= 450n && reference.discountBps <= 800n)
const claimValue = await safeVault.positionValue(0)
const saverPayout = await market.payoutFor(claimValue, reference.discountBps)
const providerFee = await market.feeFor(saverPayout)
const expiration = BigInt(latestBlock.timestamp) + 7n * 24n * 60n * 60n
const listingId = await market.nextListingId()
await (
  await market
    .connect(walletA)
    .createListing(safeVaultAddress, 0, expiration, saverPayout)
).wait()

const riskBefore = await token.balanceOf(
  manifest.factoryConfiguration.riskReserve
)
const maintenanceBefore = await token.balanceOf(
  manifest.factoryConfiguration.maintenanceTreasury
)
const revenueBefore = await rewardPool.protocolRevenue()
await (
  await token
    .connect(walletB)
    .approve(await market.getAddress(), saverPayout + providerFee)
).wait()
const fundingReceipt = await (
  await market.connect(walletB).fundListing(listingId)
).wait()

assert.equal(await safeVault.positionOwner(0), await walletB.getAddress())
assert.equal((await safeVault.position(0)).member, await walletA.getAddress())
assert.equal((await safeVault.position(0)).emergencyBalance, 10n * UNIT)
const rewardShare = (providerFee * 60n) / 100n
const riskShare = (providerFee * 20n) / 100n
assert.equal((await rewardPool.protocolRevenue()) - revenueBefore, rewardShare)
assert.equal(
  (await token.balanceOf(manifest.factoryConfiguration.riskReserve)) -
    riskBefore,
  riskShare
)
assert.equal(
  (await token.balanceOf(manifest.factoryConfiguration.maintenanceTreasury)) -
    maintenanceBefore,
  providerFee - rewardShare - riskShare
)

// Earn vault uses an isolated MockYieldAdapter and actual token-funded yield.
const earnCreation = await (
  await factory.createPersonalVault(100n * UNIT, maturity, 1_200, 1)
).wait()
const earnCreated = earnCreation.logs
  .map((log) => {
    try {
      return factory.interface.parseLog(log)
    } catch {
      return null
    }
  })
  .find((event) => event?.name === 'VaultCreated')
const earnVaultAddress = earnCreated.args.vault
const earnVault = await ethers.getContractAt(
  'SavingsVault',
  earnVaultAddress,
  walletA
)
await (
  await token.connect(walletA).approve(earnVaultAddress, 100n * UNIT)
).wait()
await (await earnVault.connect(walletA).deposit(0, 100n * UNIT)).wait()
const earnPosition = await earnVault.position(0)
assert.equal(earnPosition.emergencyBalance, 12n * UNIT)
assert.equal(earnPosition.lockedBalance, 88n * UNIT)
const adapterAddress = await earnVault.yieldAdapter()
const adapter = await ethers.getContractAt(
  'MockYieldAdapter',
  adapterAddress,
  deployer
)
assert.equal(await adapter.totalAssets(), 88n * UNIT)
await (await token.approve(adapterAddress, 8n * UNIT)).wait()
await (await adapter.fundYield(8n * UNIT)).wait()
assert.equal(await earnVault.positionValue(0), 96n * UNIT)

const result = {
  schemaVersion: 1,
  chainId: manifest.chainId,
  checkedAt: new Date().toISOString(),
  wallets: {
    walletA: await walletA.getAddress(),
    walletB: await walletB.getAddress(),
  },
  safeVault: safeVaultAddress,
  earnVault: earnVaultAddress,
  mockYieldAdapter: adapterAddress,
  listingId: listingId.toString(),
  fundingTransactionHash: fundingReceipt.hash,
  discountBps: Number(reference.discountBps),
  saverPayout: saverPayout.toString(),
  providerFee: providerFee.toString(),
}
await writeFile(
  path.join(deploymentDirectory, 'latest-flow.json'),
  `${JSON.stringify(result, null, 2)}\n`
)
console.log(
  'Amoy two-wallet Safe/Earn flow passed. Run test:amoy:persistence from a fresh process to re-query it.'
)
