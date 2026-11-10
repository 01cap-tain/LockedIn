import { expect } from 'chai'
import { network } from 'hardhat'
import { createActivatedGroup, deployFactory } from './helpers/deploy-factory.js'

const UNIT = 10n ** 6n

describe('Phase 1 and 2A checkpoint invariants', function () {
  let ethers
  let networkHelpers
  let saver
  let memberTwo
  let memberThree
  let memberFour
  let memberFive
  let provider
  let outsider
  let riskReserve
  let maintenanceTreasury
  let token
  let factory
  let market
  let maturity

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    ;[
      saver,
      memberTwo,
      memberThree,
      memberFour,
      memberFive,
      provider,
      outsider,
      riskReserve,
      maintenanceTreasury,
    ] = await ethers.getSigners()
    token = await ethers.deployContract('MockUSDT')
    ;({ factory } = await deployFactory(ethers, [
      await token.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ], await riskReserve.getAddress()))
    market = await ethers.getContractAt('EarlyExitMarket', await factory.earlyExitMarket())
    maturity = BigInt(await networkHelpers.time.latest()) + 30n * 24n * 60n * 60n
  })

  async function personalVault(target = 100n * UNIT, emergencyBps = 1_000) {
    await factory.createPersonalVault(target, maturity, emergencyBps, 0)
    return ethers.getContractAt('SavingsVault', await factory.vaultAt((await factory.vaultCount()) - 1n))
  }

  async function fundAndApprove(account, spender, amount, selectedToken = token) {
    await selectedToken.mint(await account.getAddress(), amount)
    await selectedToken.connect(account).approve(spender, amount)
  }

  async function sellPosition(vault, positionId = 0n) {
    const claim = await vault.positionValue(positionId)
    const reference = await market.referenceDiscount(await vault.getAddress(), positionId)
    const receipt = await market.payoutFor(claim, reference.discountBps)
    await market.connect(saver).createListing(await vault.getAddress(), positionId, maturity, receipt)
    const listingId = (await market.nextListingId()) - 1n
    const locked = (await vault.position(positionId)).lockedBalance
    const fee = await market.feeFor(receipt)
    await fundAndApprove(provider, await market.getAddress(), receipt + fee)
    await market.connect(provider).fundListing(listingId)
    return { listingId, locked, receipt, fee }
  }

  it('fuzzes deposit splits and maintains exact principal solvency through both withdrawal paths', async function () {
    const vault = await personalVault(1_000_000n * UNIT, 1_200)
    const values = [1n, 2n, 3n, 7n, 11n, 97n, 999n, 10_001n, 999_999n, 25n * UNIT]
    const total = values.reduce((sum, value) => sum + value, 0n)
    await fundAndApprove(saver, await vault.getAddress(), total)

    let expectedEmergency = 0n
    let expectedLocked = 0n
    for (const value of values) {
      await vault.deposit(0, value)
      expectedEmergency += value * 1_200n / 10_000n
      expectedLocked += value - value * 1_200n / 10_000n
      expect(await vault.totalEmergencyLiability()).to.equal(expectedEmergency)
      expect(await vault.totalLockedLiability()).to.equal(expectedLocked)
      expect(await token.balanceOf(await vault.getAddress())).to.equal(expectedEmergency + expectedLocked)
      expect(await vault.isSolvent()).to.equal(true)
    }

    const lockedBefore = (await vault.position(0)).lockedBalance
    const emergencyWithdrawal = expectedEmergency / 2n
    await vault.withdrawEmergency(0, emergencyWithdrawal)
    expect((await vault.position(0)).lockedBalance).to.equal(lockedBefore)
    expect(await vault.totalEmergencyLiability()).to.equal(expectedEmergency - emergencyWithdrawal)

    await networkHelpers.time.increaseTo(maturity)
    await vault.withdrawLocked(0)
    expect(await vault.totalLockedLiability()).to.equal(0n)
    await expect(vault.withdrawLocked(0)).to.be.revertedWithCustomError(vault, 'NothingToWithdraw')
    expect(await vault.isSolvent()).to.equal(true)
  })

  it('freezes deposits during a live listing and permits them again after expiry', async function () {
    const vault = await personalVault()
    await fundAndApprove(saver, await vault.getAddress(), 101n * UNIT)
    await vault.deposit(0, 99n * UNIT)
    const expires = BigInt(await networkHelpers.time.latest()) + 100n
    const reference = await market.referenceDiscount(await vault.getAddress(), 0)
    const payout = await market.payoutFor(await vault.positionValue(0), reference.discountBps)
    await market.createListing(await vault.getAddress(), 0, expires, payout)

    await expect(vault.deposit(0, UNIT)).to.be.revertedWithCustomError(vault, 'PositionListed')
    await networkHelpers.time.increaseTo(expires + 1n)
    await vault.deposit(0, UNIT)
    expect((await vault.position(0)).deposited).to.equal(100n * UNIT)
  })

  it('revokes the compatibility eligibility marker while V1 rewards remain disabled', async function () {
    const groupMembers = [saver, memberTwo, memberThree, memberFour, memberFive]
    const vault = await createActivatedGroup(
      ethers, factory, groupMembers, groupMembers.map(() => 100n * UNIT),
      groupMembers.map(() => 1_000), maturity,
    )
    for (const [index, member] of groupMembers.entries()) {
      await fundAndApprove(member, await vault.getAddress(), 100n * UNIT)
      await vault.connect(member).deposit(index, 100n * UNIT)
    }

    await sellPosition(vault)

    expect(await vault.rewardDisqualified(0)).to.equal(true)
    expect(await vault.rewardEligibleCount()).to.equal(0n)
    expect(await vault.rewardsReady()).to.equal(false)
    await networkHelpers.time.increaseTo(maturity)
    expect(await vault.rewardsReady()).to.equal(false)
    await expect(vault.activateRewards()).to.be.revertedWithCustomError(vault, 'RewardsDisabled')
  })

  it('does not let emergency withdrawals change reward eligibility or goal completion', async function () {
    const vault = await personalVault(100n * UNIT)
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    await vault.withdrawEmergency(0, 10n * UNIT)
    expect(await vault.goalComplete(0)).to.equal(true)
    expect(await vault.rewardDisqualified(0)).to.equal(false)
    await networkHelpers.time.increaseTo(maturity)
    expect(await vault.rewardsReady()).to.equal(false)
  })

  it('keeps reward campaigns unavailable before and after maturity', async function () {
    const vault = await personalVault(100n * UNIT)
    await fundAndApprove(saver, await vault.getAddress(), 50n * UNIT)
    await vault.deposit(0, 50n * UNIT)
    await expect(vault.activateRewards()).to.be.revertedWithCustomError(vault, 'RewardsDisabled')

    await networkHelpers.time.increaseTo(maturity)
    await vault.withdrawLocked(0)
    await expect(vault.activateRewards()).to.be.revertedWithCustomError(vault, 'RewardsDisabled')
  })

  it('does not expose a V1 reward activation path', async function () {
    const vault = await personalVault(100n * UNIT)
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    expect(await vault.rewardEligibleCount()).to.equal(0n)
    await expect(vault.rewardRecipientAt(0)).to.be.revertedWithCustomError(vault, 'RewardsDisabled')
    await expect(vault.rewardTargetAt(0)).to.be.revertedWithCustomError(vault, 'RewardsDisabled')
    await expect(vault.activateRewards()).to.be.revertedWithCustomError(vault, 'RewardsDisabled')
    await networkHelpers.time.increaseTo(maturity)
    await expect(vault.activateRewards()).to.be.revertedWithCustomError(vault, 'RewardsDisabled')
  })

  it('safely reverts funding after a provider revokes allowance', async function () {
    const vault = await personalVault()
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    const reference = await market.referenceDiscount(await vault.getAddress(), 0)
    const receipt = await market.payoutFor(90n * UNIT, reference.discountBps)
    await market.createListing(await vault.getAddress(), 0, maturity, receipt)
    const fee = await market.feeFor(receipt)
    await fundAndApprove(provider, await market.getAddress(), receipt + fee)
    await token.connect(provider).approve(await market.getAddress(), 0)

    await expect(market.connect(provider).fundListing(0)).to.revert(ethers)
    expect(await vault.positionOwner(0)).to.equal(await saver.getAddress())
    expect((await market.listings(0)).active).to.equal(true)
    expect(await market.positionSold(await vault.getAddress(), 0)).to.equal(false)
  })

  it('fuzzes the 0.9% fee calculation and exact maintenance allocation', async function () {
    const values = [1n, 2n, 10n, 111n, 112n, 999n, UNIT, 17n * UNIT, 999_999n * UNIT]
    for (let discount = 450; discount <= 800; discount += 7) {
      for (const positionValue of values) {
        const receipt = await market.payoutFor(positionValue, discount)
        const fee = await market.feeFor(receipt)
        expect(fee).to.equal(receipt * 90n / 10_000n)
        const allocation = await market.feeAllocations(fee)
        expect(allocation.rewardAllocation + allocation.riskAllocation + allocation.maintenanceAllocation)
          .to.equal(fee)
        expect(allocation.rewardAllocation).to.equal(0n)
        expect(allocation.riskAllocation).to.equal(0n)
        expect(allocation.maintenanceAllocation).to.equal(fee)
      }
    }
  })

  it('fuzzes listing and sale settlement while preserving ownership and solvency invariants', async function () {
    const cases = [
      { amount: 2n * UNIT, emergency: 1_000 },
      { amount: 17n * UNIT + 13n, emergency: 1_200 },
      { amount: 99n * UNIT, emergency: 1_500 },
      { amount: 1_001n * UNIT + 99n, emergency: 1_333 },
    ]

    for (const entry of cases) {
      const vault = await personalVault(entry.amount, entry.emergency)
      await fundAndApprove(saver, await vault.getAddress(), entry.amount)
      await vault.deposit(0, entry.amount)
      const position = await vault.position(0)
      const reference = await market.referenceDiscount(await vault.getAddress(), 0)
      const receipt = await market.payoutFor(position.lockedBalance, reference.discountBps)
      await market.createListing(await vault.getAddress(), 0, maturity, receipt)
      const listingId = (await market.nextListingId()) - 1n
      const fee = await market.feeFor(receipt)
      await fundAndApprove(provider, await market.getAddress(), receipt + fee)
      await market.connect(provider).fundListing(listingId)

      expect(await vault.positionOwner(0)).to.equal(await provider.getAddress())
      expect((await vault.position(0)).emergencyBalance).to.equal(position.emergencyBalance)
      expect(await vault.rewardDisqualified(0)).to.equal(true)
      expect(await vault.isSolvent()).to.equal(true)
      expect(await token.balanceOf(await vault.getAddress())).to.equal(await vault.totalPrincipalLiability())
      expect(await token.balanceOf(await market.getAddress())).to.equal(0n)
      expect(await market.positionSold(await vault.getAddress(), 0)).to.equal(true)
    }

  })

  it('rejects wrong-decimal, fee-on-transfer and negatively rebasing accounting', async function () {
    const wrong = await ethers.deployContract('WrongDecimalsToken')
    await expect(
      deployFactory(ethers, [
        await wrong.getAddress(),
        await riskReserve.getAddress(),
        await maintenanceTreasury.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        31_337,
        ethers.ZeroAddress,
      ], await riskReserve.getAddress()),
    ).to.be.revertedWithCustomError(factory, 'UnsupportedToken')

    const feeToken = await ethers.deployContract('FeeOnTransferUSDT')
    const { factory: feeFactory } = await deployFactory(ethers, [
      await feeToken.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ], await riskReserve.getAddress())
    await feeFactory.createPersonalVault(100n * UNIT, maturity, 1_000, 0)
    const feeVault = await ethers.getContractAt('SavingsVault', await feeFactory.vaultAt(0))
    await fundAndApprove(saver, await feeVault.getAddress(), 100n * UNIT, feeToken)
    await feeToken.setFeesEnabled(true)
    await expect(feeVault.deposit(0, 100n * UNIT)).to.be.revertedWithCustomError(feeVault, 'TokenAccountingMismatch')
    expect((await feeVault.position(0)).deposited).to.equal(0n)

    const slashToken = await ethers.deployContract('SlashableUSDT')
    const { factory: slashFactory } = await deployFactory(ethers, [
      await slashToken.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ], await riskReserve.getAddress())
    await slashFactory.createPersonalVault(100n * UNIT, maturity, 1_000, 0)
    const slashVault = await ethers.getContractAt('SavingsVault', await slashFactory.vaultAt(0))
    await fundAndApprove(saver, await slashVault.getAddress(), 100n * UNIT, slashToken)
    await slashVault.deposit(0, 100n * UNIT)
    await slashToken.slash(await slashVault.getAddress(), UNIT)
    expect(await slashVault.isSolvent()).to.equal(false)
    await expect(slashVault.withdrawEmergency(0, UNIT)).to.be.revertedWithCustomError(slashVault, 'Insolvent')
  })

  it('supports exact-transfer tokens that omit ERC-20 return values', async function () {
    const noReturn = await ethers.deployContract('NoReturnUSDT')
    const { factory: noReturnFactory } = await deployFactory(ethers, [
      await noReturn.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ], await riskReserve.getAddress())
    await noReturnFactory.createPersonalVault(100n * UNIT, maturity, 1_000, 0)
    const vault = await ethers.getContractAt('SavingsVault', await noReturnFactory.vaultAt(0))
    await noReturn.mint(await saver.getAddress(), 100n * UNIT)
    await noReturn.connect(saver).approve(await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    expect(await vault.isSolvent()).to.equal(true)
    expect(await vault.totalPrincipalLiability()).to.equal(100n * UNIT)
  })

  it('rolls back a market sale if the asset begins charging transfer fees', async function () {
    const feeToken = await ethers.deployContract('FeeOnTransferUSDT')
    const { factory: feeFactory } = await deployFactory(ethers, [
      await feeToken.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ], await riskReserve.getAddress())
    const feeMarket = await ethers.getContractAt('EarlyExitMarket', await feeFactory.earlyExitMarket())
    await feeFactory.createPersonalVault(100n * UNIT, maturity, 1_000, 0)
    const feeVault = await ethers.getContractAt('SavingsVault', await feeFactory.vaultAt(0))
    await fundAndApprove(saver, await feeVault.getAddress(), 100n * UNIT, feeToken)
    await feeVault.deposit(0, 100n * UNIT)
    const reference = await feeMarket.referenceDiscount(await feeVault.getAddress(), 0)
    const receipt = await feeMarket.payoutFor(90n * UNIT, reference.discountBps)
    await feeMarket.createListing(await feeVault.getAddress(), 0, maturity, receipt)
    const fee = await feeMarket.feeFor(receipt)
    await fundAndApprove(provider, await feeMarket.getAddress(), receipt + fee, feeToken)
    await feeToken.setFeesEnabled(true)

    await expect(feeMarket.connect(provider).fundListing(0)).to.be.revertedWithCustomError(feeMarket, 'TokenAccountingMismatch')
    expect(await feeVault.positionOwner(0)).to.equal(await saver.getAddress())
    expect((await feeMarket.listings(0)).active).to.equal(true)
    expect(await feeMarket.positionSold(await feeVault.getAddress(), 0)).to.equal(false)
  })

  it('allows one inactive risk and maintenance destination while rejecting invalid treasury and group inputs', async function () {
    const sharedFeeDestination = await maintenanceTreasury.getAddress()
    const sharedDeployment = await deployFactory(ethers, [
      await token.getAddress(),
      sharedFeeDestination,
      sharedFeeDestination,
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ], await riskReserve.getAddress())
    expect(await sharedDeployment.factory.riskReserve()).to.equal(sharedFeeDestination)
    expect(await sharedDeployment.factory.maintenanceTreasury()).to.equal(sharedFeeDestination)

    await expect(
      deployFactory(ethers, [
        await outsider.getAddress(),
        await riskReserve.getAddress(),
        await maintenanceTreasury.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        31_337,
        ethers.ZeroAddress,
      ], await riskReserve.getAddress()),
    ).to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
    await expect(
      deployFactory(ethers, [
        await token.getAddress(),
        await riskReserve.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        31_337,
        ethers.ZeroAddress,
      ], await riskReserve.getAddress()),
    ).to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
    await expect(
      deployFactory(ethers, [
        await token.getAddress(),
        await riskReserve.getAddress(),
        await token.getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        31_337,
        ethers.ZeroAddress,
      ], await riskReserve.getAddress()),
    ).to.be.revertedWithCustomError(factory, 'InvalidConfiguration')

    const now = BigInt(await networkHelpers.time.latest())
    await expect(factory.createPublicGroupVault(
      'Too small', UNIT, 1_000, 3, now + 1_000n, maturity, 0, true,
    )).to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
  })

  it('binds immutable deployment authorities and gives none of them principal-withdrawal access', async function () {
    expect(await factory.asset()).to.equal(await token.getAddress())
    expect(await market.asset()).to.equal(await token.getAddress())
    expect(await market.factory()).to.equal(await factory.getAddress())
    expect(await market.maintenanceTreasury()).to.equal(await maintenanceTreasury.getAddress())

    const vault = await personalVault()
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    for (const account of [riskReserve, maintenanceTreasury, outsider]) {
      await expect(vault.connect(account).withdrawEmergency(0, UNIT)).to.be.revertedWithCustomError(vault, 'MemberOnly')
      await expect(vault.connect(account).withdrawLocked(0)).to.be.revertedWithCustomError(vault, 'PositionOwnerOnly')
    }

    const safetyCouncil = riskReserve
    const ownerBefore = await vault.positionOwner(0)
    const quote = await market.referenceDiscount(await vault.getAddress(), 0)
    const payout = await market.payoutFor(await vault.positionValue(0), quote.discountBps)
    await expect(
      market.connect(safetyCouncil).createListing(await vault.getAddress(), 0, maturity, payout),
    ).to.be.revertedWithCustomError(market, 'PositionOwnerOnly')
    await expect(
      vault.connect(safetyCouncil).transferPosition(0, ownerBefore, await safetyCouncil.getAddress()),
    ).to.be.revertedWithCustomError(vault, 'MarketOnly')
    expect(await vault.positionOwner(0)).to.equal(ownerBefore)

    await market.connect(saver).createListing(await vault.getAddress(), 0, maturity, payout)
    await expect(market.connect(safetyCouncil).fundListing(0)).to.revert(ethers)
    expect(await vault.positionOwner(0)).to.equal(ownerBefore)

    for (const address of [await factory.getAddress(), await market.getAddress()]) {
      await networkHelpers.setBalance(address, 10n ** 18n)
      await networkHelpers.impersonateAccount(address)
      const authority = await ethers.getSigner(address)
      await expect(vault.connect(authority).withdrawEmergency(0, UNIT)).to.be.revertedWithCustomError(vault, 'MemberOnly')
      await expect(vault.connect(authority).withdrawLocked(0)).to.be.revertedWithCustomError(vault, 'PositionOwnerOnly')
      await networkHelpers.stopImpersonatingAccount(address)
    }
  })
})
