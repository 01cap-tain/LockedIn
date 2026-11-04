import { expect } from 'chai'
import { network } from 'hardhat'

import { createActivatedGroup, deployFactory } from './helpers/deploy-factory.js'

const UNIT = 10n ** 6n
const DAY = 24n * 60n * 60n
const MIN_DURATION = 10n * 60n
const MAX_DURATION = 5n * 365n * DAY

describe('Immutable Safe-only V1 production boundaries', function () {
  let ethers
  let time
  let accounts
  let token
  let factory

  beforeEach(async function () {
    ;({ ethers, networkHelpers: { time } } = await network.create())
    accounts = await ethers.getSigners()
    token = await ethers.deployContract('MockUSDT')
    ;({ factory } = await deployFactory(ethers, [
      await token.getAddress(),
      await accounts[8].getAddress(),
      await accounts[9].getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ], await accounts[7].getAddress()))
  })

  async function createAt(duration) {
    const creationTime = BigInt(await time.latest()) + 100n
    await time.setNextBlockTimestamp(creationTime)
    return factory.createPersonalVault(100n * UNIT, creationTime + duration, 1_000, 0)
  }

  it('rejects past and current timestamps', async function () {
    let creationTime = BigInt(await time.latest()) + 100n
    await time.setNextBlockTimestamp(creationTime)
    await expect(factory.createPersonalVault(UNIT, creationTime - 1n, 1_000, 0))
      .to.be.revertedWithCustomError(factory, 'InvalidConfiguration')

    creationTime = BigInt(await time.latest()) + 100n
    await time.setNextBlockTimestamp(creationTime)
    await expect(factory.createPersonalVault(UNIT, creationTime, 1_000, 0))
      .to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
  })

  it('enforces the exact ten-minute testnet minimum boundary', async function () {
    await expect(createAt(MIN_DURATION - 1n))
      .to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
    await expect(createAt(MIN_DURATION)).to.emit(factory, 'VaultCreated')
    await expect(createAt(MIN_DURATION + 1n)).to.emit(factory, 'VaultCreated')
  })

  it('enforces the exact five-year maximum boundary', async function () {
    await expect(createAt(MAX_DURATION)).to.emit(factory, 'VaultCreated')
    await expect(createAt(MAX_DURATION + 1n))
      .to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
  })

  it('rejects Earn for personal and group creation with a clear error', async function () {
    const now = BigInt(await time.latest())
    const maturity = now + 30n * DAY
    await expect(factory.createPersonalVault(UNIT, maturity, 1_000, 1))
      .to.be.revertedWithCustomError(factory, 'EarnDisabled')
    await expect(factory.createPublicGroupVault(
      'Safe circle', UNIT, 1_000, 4, now + 10n * DAY, maturity, 1, true,
    )).to.be.revertedWithCustomError(factory, 'EarnDisabled')
  })

  it('keeps reward reads and activation explicitly disabled', async function () {
    await createAt(MIN_DURATION)
    const vault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
    expect(await vault.rewardsReady()).to.equal(false)
    expect(await vault.rewardEligibleCount()).to.equal(0n)
    await expect(vault.activateRewards()).to.be.revertedWithCustomError(vault, 'RewardsDisabled')
  })

  it('allows the requester to cancel an authorized cooperative exit before execution', async function () {
    const members = accounts.slice(0, 5)
    const now = BigInt(await time.latest())
    const maturity = now + 30n * DAY
    const vault = await createActivatedGroup(
      ethers,
      factory,
      members,
      members.map(() => 100n * UNIT),
      members.map(() => 1_000),
      maturity,
    )
    for (const [index, member] of members.entries()) {
      await token.mint(await member.getAddress(), 100n * UNIT)
      await token.connect(member).approve(await vault.getAddress(), 100n * UNIT)
      await vault.connect(member).deposit(index, 100n * UNIT)
    }

    await vault.connect(members[0]).requestGroupExit()
    for (let index = 1; index < members.length; index += 1) {
      await vault.connect(members[index]).approveGroupExit(0)
    }
    expect((await vault.groupExitRequests(0)).status).to.equal(2n)
    await expect(vault.connect(members[0]).cancelGroupExit(0))
      .to.emit(vault, 'GroupExitCancelled')
    await expect(vault.connect(members[0]).completeGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'GroupExitNotAuthorized')
  })

  it('emits enough data to confirm creation, deposits and maturity withdrawals', async function () {
    const creationTime = BigInt(await time.latest()) + 100n
    const maturity = creationTime + MIN_DURATION
    await time.setNextBlockTimestamp(creationTime)
    await expect(factory.createPersonalVault(100n * UNIT, maturity, 1_000, 0))
      .to.emit(factory, 'VaultCreated')
    const vault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
    await token.mint(await accounts[0].getAddress(), 100n * UNIT)
    await token.approve(await vault.getAddress(), 100n * UNIT)
    await expect(vault.deposit(0, 100n * UNIT))
      .to.emit(vault, 'Deposited')
      .withArgs(0, await accounts[0].getAddress(), 100n * UNIT, 10n * UNIT, 90n * UNIT)
    await time.increaseTo(maturity)
    await expect(vault.withdrawLocked(0))
      .to.emit(vault, 'LockedWithdrawn')
      .withArgs(0, await accounts[0].getAddress(), 90n * UNIT)
  })
})
