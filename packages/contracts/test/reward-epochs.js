import { expect } from 'chai'
import { network } from 'hardhat'

import { createActivatedGroup, deployFactory } from './helpers/deploy-factory.js'

const UNIT = 10n ** 6n
const DAY = 24n * 60n * 60n
const EPOCH_DURATION = 10n * DAY
const REGISTRATION_GRACE = DAY

describe('Deterministic protocol-revenue epochs', function () {
  let ethers
  let networkHelpers
  let accounts
  let token
  let factory
  let rewardPool
  let market
  let epochStart
  let maturity

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    accounts = await ethers.getSigners()
    token = await ethers.deployContract('MockUSDT')

    // Align the test deployment to a fresh absolute epoch so a four-day vault
    // always matures and registers inside the same deterministic epoch.
    const now = BigInt(await networkHelpers.time.latest())
    epochStart = (now / EPOCH_DURATION + 1n) * EPOCH_DURATION + 1n
    await networkHelpers.time.increaseTo(epochStart)
    maturity = epochStart + 4n * DAY

    ;({ factory, rewardPool } = await deployFactory(
      ethers,
      [
        await token.getAddress(),
        await accounts[18].getAddress(),
        await accounts[19].getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        31_337,
        ethers.ZeroAddress,
      ],
      await accounts[17].getAddress(),
      {
        epochDuration: Number(EPOCH_DURATION),
        registrationGrace: Number(REGISTRATION_GRACE),
        minimumRewardTarget: 10n * UNIT,
        minimumSavingDuration: Number(DAY),
      },
    ))
    market = await ethers.getContractAt('EarlyExitMarket', await factory.earlyExitMarket())
  })

  async function createCompletedGroup(members, targets, vaultMaturity = maturity) {
    const vault = await createActivatedGroup(
      ethers, factory, members, targets, targets.map(() => 1_000), vaultMaturity,
    )
    for (let index = 0; index < members.length; index += 1) {
      await token.mint(await members[index].getAddress(), targets[index])
      await token.connect(members[index]).approve(await vault.getAddress(), targets[index])
      await vault.connect(members[index]).deposit(index, targets[index])
    }
    return vault
  }

  async function fundProtocolRevenue(amount, payer = accounts[16]) {
    await token.mint(await payer.getAddress(), amount)
    await token.connect(payer).approve(await rewardPool.getAddress(), amount)
    await rewardPool.connect(payer).receiveProtocolRevenue(amount)
  }

  async function moveToFinalization(epochId) {
    await networkHelpers.time.increaseTo(
      (epochId + 1n) * EPOCH_DURATION + REGISTRATION_GRACE,
    )
  }

  it('weights groups by completed target principal and divides each allocation equally', async function () {
    const firstMembers = accounts.slice(0, 4)
    const secondMembers = accounts.slice(4, 8)
    const first = await createCompletedGroup(firstMembers, firstMembers.map(() => 10n * UNIT))
    const second = await createCompletedGroup(secondMembers, secondMembers.map(() => 20n * UNIT))
    // A completed target cannot be exceeded, so epoch weight cannot be inflated.
    await token.mint(await firstMembers[0].getAddress(), 10n * UNIT)
    await token.connect(firstMembers[0]).approve(await first.getAddress(), 10n * UNIT)
    await expect(first.connect(firstMembers[0]).deposit(0, 10n * UNIT))
      .to.be.revertedWithCustomError(first, 'TargetExceeded')
    await fundProtocolRevenue(120n * UNIT)

    await networkHelpers.time.increaseTo(maturity)
    await rewardPool.connect(accounts[15]).registerCompletedGroup(await first.getAddress())
    await rewardPool.connect(accounts[14]).registerCompletedGroup(await second.getAddress())
    const epochId = maturity / EPOCH_DURATION
    expect((await rewardPool.groupRegistration(epochId, await first.getAddress())).weight)
      .to.equal(40n * UNIT)
    expect((await rewardPool.groupRegistration(epochId, await second.getAddress())).weight)
      .to.equal(80n * UNIT)

    await moveToFinalization(epochId)
    await rewardPool.connect(accounts[13]).finalizeEpoch(epochId)
    await rewardPool.connect(accounts[12]).allocateEpochGroup(epochId, await first.getAddress())
    await rewardPool.connect(accounts[11]).allocateEpochGroup(epochId, await second.getAddress())

    for (const member of firstMembers) {
      expect(await rewardPool.claimable(await member.getAddress())).to.equal(10n * UNIT)
    }
    for (const member of secondMembers) {
      expect(await rewardPool.claimable(await member.getAddress())).to.equal(20n * UNIT)
    }
    expect(await rewardPool.totalClaimable()).to.equal(120n * UNIT)
    expect(await rewardPool.protocolRevenue()).to.equal(0n)
  })

  it('excludes a market-exited saver and buyer while emergency withdrawal does not disqualify others', async function () {
    const members = accounts.slice(0, 5)
    const targets = members.map(() => 10n * UNIT)
    const vault = await createCompletedGroup(members, targets)
    const quote = await market.referenceDiscount(await vault.getAddress(), 0)
    const payout = await market.payoutFor(await vault.positionValue(0), quote.discountBps)
    await market.connect(members[0]).createListing(await vault.getAddress(), 0, maturity, payout)
    const fee = await market.feeFor(payout)
    const buyer = accounts[10]
    await token.mint(await buyer.getAddress(), payout + fee)
    await token.connect(buyer).approve(await market.getAddress(), payout + fee)
    await market.connect(buyer).fundListing(0)
    const revenueEpoch = await rewardPool.currentEpoch()
    expect((await rewardPool.epochs(revenueEpoch)).revenue).to.equal(fee * 60n / 100n)
    await vault.connect(members[1]).withdrawEmergency(1, UNIT)

    await networkHelpers.time.increaseTo(maturity)
    await rewardPool.registerCompletedGroup(await vault.getAddress())
    const epochId = maturity / EPOCH_DURATION
    const registration = await rewardPool.groupRegistration(epochId, await vault.getAddress())
    expect(registration.memberCount).to.equal(4n)
    expect(registration.weight).to.equal(40n * UNIT)
    expect(await rewardPool.protocolRecipientCount(epochId, await vault.getAddress())).to.equal(4n)
    for (let index = 0; index < 4; index += 1) {
      expect(await rewardPool.protocolRecipientAt(epochId, await vault.getAddress(), index))
        .to.not.equal(await members[0].getAddress())
      expect(await rewardPool.protocolRecipientAt(epochId, await vault.getAddress(), index))
        .to.not.equal(await buyer.getAddress())
    }
  })

  it('enforces group-only, minimum-target and minimum-duration farming boundaries', async function () {
    await factory.createPersonalVault(10n * UNIT, maturity, 1_000, 0)
    const personal = await ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
    await networkHelpers.time.increaseTo(maturity)
    await expect(rewardPool.registerCompletedGroup(await personal.getAddress()))
      .to.be.revertedWithCustomError(rewardPool, 'GroupOnly')

    async function strictGroup(minimumTarget, minimumDuration) {
      const strict = await deployFactory(
        ethers,
        [
          await token.getAddress(),
          await accounts[18].getAddress(),
          await accounts[19].getAddress(),
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          31_337,
          ethers.ZeroAddress,
        ],
        await accounts[17].getAddress(),
        {
          epochDuration: Number(EPOCH_DURATION),
          registrationGrace: Number(REGISTRATION_GRACE),
          minimumRewardTarget: minimumTarget,
          minimumSavingDuration: Number(minimumDuration),
        },
      )
      const members = accounts.slice(4, 8)
      const shortMaturity = BigInt(await networkHelpers.time.latest()) + 4n * DAY
      const vault = await createActivatedGroup(
        ethers, strict.factory, members, members.map(() => 10n * UNIT),
        members.map(() => 1_000), shortMaturity,
      )
      for (let index = 0; index < members.length; index += 1) {
        await token.mint(await members[index].getAddress(), 10n * UNIT)
        await token.connect(members[index]).approve(await vault.getAddress(), 10n * UNIT)
        await vault.connect(members[index]).deposit(index, 10n * UNIT)
      }
      await networkHelpers.time.increaseTo(shortMaturity)
      return { pool: strict.rewardPool, vault }
    }

    const targetFailure = await strictGroup(11n * UNIT, DAY)
    await expect(targetFailure.pool.registerCompletedGroup(await targetFailure.vault.getAddress()))
      .to.be.revertedWithCustomError(targetFailure.pool, 'MinimumQualificationNotMet')

    const durationFailure = await strictGroup(10n * UNIT, 5n * DAY)
    await expect(durationFailure.pool.registerCompletedGroup(await durationFailure.vault.getAddress()))
      .to.be.revertedWithCustomError(durationFailure.pool, 'MinimumQualificationNotMet')
  })

  it('closes registration at the exact boundary and rolls allocation dust forward', async function () {
    const members = accounts.slice(0, 4)
    const lateMembers = accounts.slice(4, 8)
    const vault = await createCompletedGroup(members, members.map(() => 10n * UNIT))
    const lateVault = await createCompletedGroup(
      lateMembers,
      lateMembers.map(() => 10n * UNIT),
    )
    await fundProtocolRevenue(101n)
    await networkHelpers.time.increaseTo(maturity)
    await rewardPool.registerCompletedGroup(await vault.getAddress())
    await expect(rewardPool.registerCompletedGroup(await vault.getAddress()))
      .to.be.revertedWithCustomError(rewardPool, 'GroupAlreadyRegistered')

    const epochId = maturity / EPOCH_DURATION
    const deadline = (epochId + 1n) * EPOCH_DURATION + REGISTRATION_GRACE
    await networkHelpers.time.setNextBlockTimestamp(deadline - 1n)
    await expect(rewardPool.finalizeEpoch(epochId))
      .to.be.revertedWithCustomError(rewardPool, 'EpochNotReady')
    await networkHelpers.time.setNextBlockTimestamp(deadline)
    await expect(rewardPool.registerCompletedGroup(await lateVault.getAddress()))
      .to.be.revertedWithCustomError(rewardPool, 'RegistrationClosed')
    await rewardPool.finalizeEpoch(epochId)
    await rewardPool.allocateEpochGroup(epochId, await vault.getAddress())

    expect(await rewardPool.totalClaimable()).to.equal(100n)
    expect((await rewardPool.epochs(epochId + 1n)).revenue).to.equal(1n)
    expect(await rewardPool.protocolRevenue()).to.equal(1n)
  })

  it('rolls all revenue through an empty epoch and preserves solvency', async function () {
    await fundProtocolRevenue(17n * UNIT)
    const epochId = await rewardPool.currentEpoch()
    await moveToFinalization(epochId)
    await rewardPool.finalizeEpoch(epochId)
    expect((await rewardPool.epochs(epochId)).complete).to.equal(true)
    expect((await rewardPool.epochs(epochId + 1n)).revenue).to.equal(17n * UNIT)
    expect(await rewardPool.protocolRevenue()).to.equal(17n * UNIT)
    expect(await rewardPool.totalClaimable()).to.equal(0n)
    expect(await rewardPool.isSolvent()).to.equal(true)
  })

  it('fuzzes weighted integer allocation while keeping claims within funded revenue', async function () {
    const targetValues = [10n, 17n, 31n]
    const vaults = []
    for (let groupIndex = 0; groupIndex < targetValues.length; groupIndex += 1) {
      const members = accounts.slice(groupIndex * 4, groupIndex * 4 + 4)
      vaults.push(
        await createCompletedGroup(
          members,
          members.map(() => targetValues[groupIndex] * UNIT),
        ),
      )
    }
    const revenue = 123_457n
    await fundProtocolRevenue(revenue)
    await networkHelpers.time.increaseTo(maturity)
    for (const vault of vaults) {
      await rewardPool.registerCompletedGroup(await vault.getAddress())
    }

    const epochId = maturity / EPOCH_DURATION
    await moveToFinalization(epochId)
    await rewardPool.finalizeEpoch(epochId)
    const totalWeight = targetValues.reduce((sum, value) => sum + value * 4n, 0n)
    let expectedDistributed = 0n
    for (let index = 0; index < vaults.length; index += 1) {
      await rewardPool.allocateEpochGroup(epochId, await vaults[index].getAddress())
      const groupWeight = targetValues[index] * UNIT * 4n
      const gross = revenue * groupWeight / (totalWeight * UNIT)
      expectedDistributed += gross / 4n * 4n
    }

    expect(await rewardPool.totalClaimable()).to.equal(expectedDistributed)
    expect(expectedDistributed).to.be.lte(revenue)
    expect((await rewardPool.epochs(epochId + 1n)).revenue)
      .to.equal(revenue - expectedDistributed)
    expect(await rewardPool.totalLiability()).to.equal(revenue)
    expect(await rewardPool.isSolvent()).to.equal(true)
  })
})
