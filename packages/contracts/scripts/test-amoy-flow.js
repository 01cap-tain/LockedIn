import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { network } from 'hardhat'

const UNIT = 10n ** 6n
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../deployments/amoy')
const manifest = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'))
assert.equal(manifest.profile, 'safe-only-v1')
const { ethers } = await network.create('amoy')
const signers = await ethers.getSigners()
if (signers.length < 3) throw new Error('Configure distinct deployer, wallet A and wallet B test keys.')
const [deployer, walletA, walletB] = signers
const addresses = await Promise.all([deployer, walletA, walletB].map((signer) => signer.getAddress()))
assert.equal(new Set(addresses.map((address) => address.toLowerCase())).size, 3, 'Test wallets must be distinct.')

const token = await ethers.getContractAt('MockUSDT', manifest.contracts.mockUsdt.address, deployer)
const factory = await ethers.getContractAt('VaultFactory', manifest.contracts.vaultFactory.address, walletA)
const market = await ethers.getContractAt('EarlyExitMarket', manifest.contracts.earlyExitMarket.address, walletA)
const head = await ethers.provider.getBlock('latest')
const maturity = BigInt(head.timestamp) + 30n * 24n * 60n * 60n
await (await token.mint(await walletA.getAddress(), 250n * UNIT)).wait()
await (await token.mint(await walletB.getAddress(), 250n * UNIT)).wait()

const creation = await (await factory.createPersonalVault(100n * UNIT, maturity, 1_000, 0)).wait()
const created = creation.logs.map((log) => {
  try { return factory.interface.parseLog(log) } catch { return null }
}).find((event) => event?.name === 'VaultCreated')
assert(created, 'VaultCreated event missing.')
const vaultAddress = String(created.args.vault)
const vault = await ethers.getContractAt('SavingsVault', vaultAddress, walletA)
await (await token.connect(walletA).approve(vaultAddress, 100n * UNIT)).wait()
const deposit = await (await vault.connect(walletA).deposit(0, 100n * UNIT)).wait()
assert.equal((await vault.position(0)).emergencyBalance, 10n * UNIT)
assert.equal((await vault.position(0)).lockedBalance, 90n * UNIT)

// Exercise the emergency path without reducing the transferable locked claim.
const emergencyWithdrawal = await (await vault.connect(walletA).withdrawEmergency(0, 1n * UNIT)).wait()
assert.equal((await vault.position(0)).emergencyBalance, 9n * UNIT)

const reference = await market.referenceDiscount(vaultAddress, 0)
assert(reference.discountBps >= 450n && reference.discountBps <= 800n)
const claimValue = await vault.positionValue(0)
const payout = await market.payoutFor(claimValue, reference.discountBps)
const fee = await market.feeFor(payout)
const current = await ethers.provider.getBlock('latest')
const expiresAt = BigInt(current.timestamp) + 7n * 24n * 60n * 60n
const listingId = await market.nextListingId()
const listing = await (await market.connect(walletA).createListing(vaultAddress, 0, expiresAt, payout)).wait()
const maintenance = manifest.factoryConfiguration.maintenanceTreasury
const balancesBefore = {
  seller: await token.balanceOf(await walletA.getAddress()),
  provider: await token.balanceOf(await walletB.getAddress()),
  maintenance: await token.balanceOf(maintenance),
}
await (await token.connect(walletB).approve(await market.getAddress(), payout + fee)).wait()
const funding = await (await market.connect(walletB).fundListing(listingId)).wait()
const balancesAfter = {
  seller: await token.balanceOf(await walletA.getAddress()),
  provider: await token.balanceOf(await walletB.getAddress()),
  maintenance: await token.balanceOf(maintenance),
}
assert.equal(balancesAfter.seller - balancesBefore.seller, payout)
assert.equal(balancesBefore.provider - balancesAfter.provider, payout + fee)
assert.equal(balancesAfter.maintenance - balancesBefore.maintenance, fee)
assert.equal(await vault.positionOwner(0), await walletB.getAddress())
assert.equal((await vault.position(0)).member, await walletA.getAddress())

const result = {
  schemaVersion: 2,
  deploymentId: manifest.deploymentId,
  checkedAt: new Date().toISOString(),
  wallets: { walletA: await walletA.getAddress(), walletB: await walletB.getAddress() },
  vault: vaultAddress,
  transactions: {
    creation: creation.hash, deposit: deposit.hash, emergencyWithdrawal: emergencyWithdrawal.hash,
    listing: listing.hash, settlement: funding.hash,
  },
  listingId: listingId.toString(), discountBps: Number(reference.discountBps),
  claimValue: claimValue.toString(), saverPayout: payout.toString(), providerFee: fee.toString(),
  maintenanceTreasury: maintenance,
  balancesBefore: Object.fromEntries(Object.entries(balancesBefore).map(([key, value]) => [key, value.toString()])),
  balancesAfter: Object.fromEntries(Object.entries(balancesAfter).map(([key, value]) => [key, value.toString()])),
}
await writeFile(path.join(directory, 'latest-flow.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log('Amoy Safe-only personal, emergency and two-wallet settlement flow passed.')
