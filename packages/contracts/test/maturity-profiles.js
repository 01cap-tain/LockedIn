import { expect } from 'chai'
import { network } from 'hardhat'

import { assertProductionMaturityConfiguration } from '../scripts/production-profile.js'
import { deployFactory } from './helpers/deploy-factory.js'

describe('environment-specific maturity profiles', function () {
  async function fixture() {
    const { ethers, networkHelpers } = await network.connect()
    const [owner, maintenance] = await ethers.getSigners()
    const token = await ethers.deployContract('MockUSDT')
    const { factory } = await deployFactory(
      ethers,
      [await token.getAddress(), await owner.getAddress(), await maintenance.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress, 31_337],
      await owner.getAddress(),
      { minimumMaturityDuration: 25_200 },
    )
    return { ethers, networkHelpers, factory }
  }

  it('rejects a maturity one second below seven hours', async function () {
    const { ethers, networkHelpers, factory } = await fixture()
    const executionTime = BigInt(await networkHelpers.time.latest()) + 1n
    await networkHelpers.time.setNextBlockTimestamp(executionTime)
    const vaultErrors = await ethers.getContractAt('SavingsVault', await factory.getAddress())
    await expect(factory.createPersonalVault(10n ** 6n, executionTime + 25_199n, 1_000, 0))
      .to.be.revertedWithCustomError(vaultErrors, 'InvalidConfiguration')
  })

  it('accepts a maturity exactly seven hours after the creation block', async function () {
    const { networkHelpers, factory } = await fixture()
    const executionTime = BigInt(await networkHelpers.time.latest()) + 1n
    await networkHelpers.time.setNextBlockTimestamp(executionTime)
    await expect(factory.createPersonalVault(10n ** 6n, executionTime + 25_200n, 1_000, 0))
      .to.emit(factory, 'VaultCreated')
    const vault = await factory.vaultAt(0)
    expect(vault).to.not.equal(undefined)
  })

  it('rejects test durations and development profiles for production', function () {
    expect(() => assertProductionMaturityConfiguration({ chainId: 137, profile: 'production', minimumMaturityDuration: 25_199 })).to.throw('seven hours')
    expect(() => assertProductionMaturityConfiguration({ chainId: 137, profile: 'amoy-development', minimumMaturityDuration: 25_200 })).to.throw('development')
    expect(() => assertProductionMaturityConfiguration({ chainId: 80_002, profile: 'production', minimumMaturityDuration: 25_200 })).to.throw('chain 137')
    expect(() => assertProductionMaturityConfiguration({ chainId: 137, profile: 'production', minimumMaturityDuration: 25_200 })).not.to.throw()
  })

  it('enforces a configured seven-hour duration in factory creation', async function () {
    const { ethers, networkHelpers } = await network.connect()
    const [owner, maintenance] = await ethers.getSigners()
    const token = await ethers.deployContract('MockUSDT')
    const { factory } = await deployFactory(
      ethers,
      [await token.getAddress(), await owner.getAddress(), await maintenance.getAddress(), ethers.ZeroAddress, ethers.ZeroAddress, 31_337],
      await owner.getAddress(),
      { minimumMaturityDuration: 25_200 },
    )
    const vaultErrors = await ethers.getContractAt('SavingsVault', await factory.getAddress())
    const executionTime = BigInt(await networkHelpers.time.latest()) + 1n
    await networkHelpers.time.setNextBlockTimestamp(executionTime)
    await expect(factory.createPersonalVault(10n ** 6n, executionTime + 25_199n, 1_000, 0))
      .to.be.revertedWithCustomError(vaultErrors, 'InvalidConfiguration')

    const nextExecutionTime = BigInt(await networkHelpers.time.latest()) + 1n
    await networkHelpers.time.setNextBlockTimestamp(nextExecutionTime)
    await expect(factory.createPersonalVault(10n ** 6n, nextExecutionTime + 25_200n, 1_000, 0))
      .to.emit(factory, 'VaultCreated')
  })
})
