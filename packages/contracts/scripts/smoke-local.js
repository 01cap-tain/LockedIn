import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { network } from 'hardhat'

const UNIT = 10n ** 6n
const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../deployments/local'
)
const deployment = JSON.parse(
  await readFile(path.join(directory, 'latest.json'), 'utf8')
)
const { ethers } = await network.create('localhost')
const [creator, memberTwo, memberThree, memberFour, memberFive] = await ethers.getSigners()
const members = [creator, memberTwo, memberThree, memberFour, memberFive]
const addresses = await Promise.all(members.map((member) => member.getAddress()))
const token = await ethers.getContractAt('MockUSDT', deployment.contracts.mockUsdt.address)
const factory = await ethers.getContractAt(
  'VaultFactory',
  deployment.contracts.vaultFactory.address,
  creator
)
const latestBlock = await ethers.provider.getBlock('latest')
const maturity = BigInt(latestBlock.timestamp) + 30n * 24n * 60n * 60n

await (
  await factory.createGroupVault(
    addresses,
    addresses.map(() => 100n * UNIT),
    addresses.map(() => 1_000),
    maturity,
    0
  )
).wait()
const vault = await ethers.getContractAt(
  'SavingsVault',
  await factory.vaultAt((await factory.vaultCount()) - 1n)
)
for (const member of members.slice(1)) {
  await (await vault.connect(member).acceptGroupInvitation()).wait()
}
for (const [index, member] of members.entries()) {
  await (await token.mint(await member.getAddress(), 100n * UNIT)).wait()
  await (await token.connect(member).approve(await vault.getAddress(), 100n * UNIT)).wait()
  await (await vault.connect(member).deposit(index, 100n * UNIT)).wait()
}

await (await vault.connect(creator).requestGroupExit()).wait()
for (const member of members.slice(1)) {
  await (await vault.connect(member).approveGroupExit(0)).wait()
}
assert.equal((await vault.groupExitRequests(0)).status, 2n)
await (await vault.connect(creator).completeGroupExit(0)).wait()
assert.equal((await vault.position(0)).emergencyBalance, 10n * UNIT)
assert.equal((await vault.position(0)).lockedBalance, 0n)
assert.equal(await vault.memberStatus(0), 1n)
assert.equal(await vault.activeMemberCount(), 4n)
console.log('Local cooperative group-exit deployment smoke test passed.')
