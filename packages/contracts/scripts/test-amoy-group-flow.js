import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { network } from 'hardhat'

const UNIT = 10n ** 6n
const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../deployments/amoy')
const manifest = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'))
assert.equal(manifest.protocolVersion, 'lockedin-circle/0.8.0')

const { ethers } = await network.create('amoy')
const [deployer] = await ethers.getSigners()
const provider = ethers.provider
const joiners = Array.from({ length: 3 }, () => ethers.Wallet.createRandom().connect(provider))
const gasGrant = ethers.parseEther('0.025')
const required = gasGrant * BigInt(joiners.length)
assert((await provider.getBalance(await deployer.getAddress())) > required, 'Deployer lacks test POL for group-flow wallets.')

for (const joiner of joiners) {
  await (await deployer.sendTransaction({ to: await joiner.getAddress(), value: gasGrant })).wait()
}

const factory = await ethers.getContractAt('VaultFactory', manifest.contracts.vaultFactory.address, deployer)
const token = await ethers.getContractAt('MockUSDT', manifest.contracts.mockUsdt.address, deployer)
const latest = await provider.getBlock('latest')
const enrollmentDeadline = BigInt(latest.timestamp) + 7n * 24n * 60n * 60n
const maturity = BigInt(latest.timestamp) + 30n * 24n * 60n * 60n
const creation = await (await factory.createPublicGroupVault(
  'Independent goals test circle', 100n * UNIT, 1_000, 4,
  enrollmentDeadline, maturity, 0, true, { gasLimit: 6_000_000n },
)).wait()
const created = creation.logs.map((log) => {
  try { return factory.interface.parseLog(log) } catch { return null }
}).find((event) => event?.name === 'VaultCreated')
assert(created, 'VaultCreated event missing.')
const vaultAddress = String(created.args.vault)
const vault = await ethers.getContractAt('SavingsVault', vaultAddress, deployer)
const targets = [125n * UNIT, 150n * UNIT, 175n * UNIT]
const allocations = [1_100, 1_200, 1_500]

for (let index = 0; index < joiners.length; index += 1) {
  await (await vault.connect(joiners[index]).joinPublicGroup(
    targets[index], allocations[index], { gasLimit: 500_000n },
  )).wait()
}
await (await vault.connect(joiners[0]).activateGroup({ gasLimit: 300_000n })).wait()

assert.equal(await vault.memberCount(), 4n)
assert.equal(await vault.acceptedMemberCount(), 4n)
assert.equal(await vault.groupLifecycle(), 2n)
for (let index = 0; index < joiners.length; index += 1) {
  const position = await vault.position(index + 1)
  assert.equal(position.member.toLowerCase(), (await joiners[index].getAddress()).toLowerCase())
  assert.equal(position.target, targets[index])
  assert.equal(position.emergencyBps, BigInt(allocations[index]))
}

// Prove balances remain position-specific after activation.
await (await token.mint(await joiners[0].getAddress(), 25n * UNIT)).wait()
await (await token.connect(joiners[0]).approve(vaultAddress, 25n * UNIT)).wait()
await (await vault.connect(joiners[0]).deposit(1, 25n * UNIT, { gasLimit: 500_000n })).wait()
assert.equal((await vault.position(1)).deposited, 25n * UNIT)
assert.equal((await vault.position(0)).deposited, 0n)

const result = {
  schemaVersion: 1,
  deploymentId: manifest.deploymentId,
  protocolVersion: manifest.protocolVersion,
  checkedAt: new Date().toISOString(),
  groupVault: vaultAddress,
  creationTransactionHash: creation.hash,
  members: [await deployer.getAddress(), ...await Promise.all(joiners.map((wallet) => wallet.getAddress()))],
  independentTargets: ['100', '125', '150', '175'],
  independentEmergencyBps: [1000, ...allocations],
  active: true,
}
await writeFile(path.join(directory, 'latest-group-flow.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(`Amoy four-wallet creator-first group flow passed at ${vaultAddress}.`)
