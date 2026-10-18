import assert from 'node:assert/strict'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { network } from 'hardhat'

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../deployments/amoy'
)
const result = JSON.parse(
  await readFile(path.join(directory, 'latest-flow.json'), 'utf8')
)
const { ethers } = await network.create('amoy')
const vault = await ethers.getContractAt('SavingsVault', result.safeVault)
const listingFactory = JSON.parse(
  await readFile(path.join(directory, 'latest.json'), 'utf8')
)
const market = await ethers.getContractAt(
  'EarlyExitMarket',
  listingFactory.contracts.earlyExitMarket.address
)

assert.equal(
  (await vault.positionOwner(0)).toLowerCase(),
  result.wallets.walletB.toLowerCase()
)
assert.equal(
  (await vault.position(0)).member.toLowerCase(),
  result.wallets.walletA.toLowerCase()
)
assert.equal((await market.listings(result.listingId)).active, false)
console.log(
  'Persistent Amoy ownership and settled-listing state verified from a fresh process.'
)
