import assert from 'node:assert/strict'
import { readFile, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { network } from 'hardhat'

const directory = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../deployments/amoy')
const manifest = JSON.parse(await readFile(path.join(directory, 'latest.json'), 'utf8'))
const { ethers } = await network.create('amoy')
const factory = await ethers.getContractAt('VaultFactory', manifest.contracts.vaultFactory.address)
const vaultCount = await factory.vaultCount()
assert(vaultCount > 0n, 'The active factory has no vaults.')
const vaultAddress = await factory.vaultAt(vaultCount - 1n)
const vault = await ethers.getContractAt('SavingsVault', vaultAddress)
assert.equal(await vault.isGroup(), true)
assert.equal(await vault.memberCount(), 4n)
assert.equal(await vault.acceptedMemberCount(), 4n)
assert.equal(await vault.groupLifecycle(), 2n)

const positions = await Promise.all(Array.from({ length: 4 }, (_, index) => vault.position(index)))
assert.equal(new Set(positions.map((position) => position.member.toLowerCase())).size, 4)
assert.deepEqual(positions.map((position) => position.target), [100n, 125n, 150n, 175n].map((value) => value * 10n ** 6n))
assert.deepEqual(positions.map((position) => position.emergencyBps), [1_000n, 1_100n, 1_200n, 1_500n])

const result = {
  schemaVersion: 1,
  deploymentId: manifest.deploymentId,
  protocolVersion: manifest.protocolVersion,
  checkedAt: new Date().toISOString(),
  groupVault: vaultAddress,
  members: positions.map((position) => position.member),
  independentTargets: positions.map((position) => ethers.formatUnits(position.target, 6)),
  independentEmergencyBps: positions.map((position) => Number(position.emergencyBps)),
  active: true,
  note: 'Creation, three independent joins and activation confirmed. The optional first deposit was not completed because its temporary wallet lacked enough Amoy gas.',
}
await writeFile(path.join(directory, 'latest-group-flow.json'), `${JSON.stringify(result, null, 2)}\n`)
console.log(`Confirmed active four-wallet Amoy group at ${vaultAddress}.`)
