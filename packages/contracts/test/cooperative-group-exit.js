import { expect } from 'chai'
import { network } from 'hardhat'

const UNIT = 10n ** 6n
const DAY = 24n * 60n * 60n

describe('Cooperative group exits', function () {
  let ethers
  let networkHelpers
  let deployer
  let members
  let provider
  let outsider
  let riskReserve
  let maintenanceTreasury
  let token
  let factory
  let market
  let rewardPool
  let maturity

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    const signers = await ethers.getSigners()
    deployer = signers[0]
    members = signers.slice(1, 6)
    provider = signers[6]
    outsider = signers[7]
    riskReserve = signers[8]
    maintenanceTreasury = signers[9]
    token = await ethers.deployContract('MockUSDT')
    factory = await ethers.deployContract('VaultFactory', [
      await token.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ])
    market = await ethers.getContractAt('EarlyExitMarket', await factory.earlyExitMarket())
    rewardPool = await ethers.getContractAt('RewardPool', await factory.rewardPool())
    maturity = BigInt(await networkHelpers.time.latest()) + 60n * DAY
  })

  async function createGroup(count = 5, mode = 0, selectedFactory = factory) {
    const selectedMembers = members.slice(0, count)
    const addresses = await Promise.all(selectedMembers.map((member) => member.getAddress()))
    await selectedFactory.connect(selectedMembers[0]).createGroupVault(
      addresses,
      addresses.map(() => 100n * UNIT),
      addresses.map(() => 1_000),
      maturity,
      mode,
    )
    return ethers.getContractAt(
      'SavingsVault',
      await selectedFactory.vaultAt((await selectedFactory.vaultCount()) - 1n),
    )
  }

  async function deposit(vault, member, positionId, value = 100n * UNIT) {
    await token.mint(await member.getAddress(), value)
    await token.connect(member).approve(await vault.getAddress(), value)
    await vault.connect(member).deposit(positionId, value)
  }

  async function completeGoals(vault, count = 5) {
    for (let index = 0; index < count; index += 1) {
      await deposit(vault, members[index], index)
    }
  }

  async function authorize(vault, requestId = 0n, count = 5) {
    for (let index = 1; index < count; index += 1) {
      await vault.connect(members[index]).approveGroupExit(requestId)
    }
  }

  async function listingQuote(vault, positionId = 0n) {
    const value = await vault.positionValue(positionId)
    const pricing = await market.referenceDiscount(await vault.getAddress(), positionId)
    return market.payoutFor(value, pricing.discountBps)
  }

  it('requires N-1 unanimous approvals and makes final authorization irreversible', async function () {
    const vault = await createGroup()
    await completeGoals(vault)
    await expect(vault.connect(members[0]).requestGroupExit())
      .to.emit(vault, 'GroupExitRequested')

    await expect(vault.connect(members[0]).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'SelfApproval')
    await expect(vault.connect(outsider).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'MemberOnly')

    await vault.connect(members[1]).approveGroupExit(0)
    await vault.connect(members[2]).approveGroupExit(0)
    await expect(vault.connect(members[2]).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'DuplicateApproval')
    expect((await vault.groupExitRequests(0)).status).to.equal(1n)
    expect(await vault.groupExitApprovalProgress(0)).to.deep.equal([4n, 2n])

    await expect(vault.connect(members[1]).revokeGroupExitApproval(0))
      .to.emit(vault, 'GroupExitApprovalRevoked')
    expect(await vault.groupExitApprovalProgress(0)).to.deep.equal([4n, 1n])
    await vault.connect(members[1]).approveGroupExit(0)
    await vault.connect(members[3]).approveGroupExit(0)
    await expect(vault.connect(members[4]).approveGroupExit(0))
      .to.emit(vault, 'GroupExitAuthorized')
      .withArgs(0, 4, 4)

    expect((await vault.groupExitRequests(0)).status).to.equal(2n)
    await expect(vault.connect(deployer).completeGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'MemberOnly')
    await expect(vault.connect(members[1]).revokeGroupExitApproval(0))
      .to.be.revertedWithCustomError(vault, 'GroupExitUnavailable')
  })

  it('pays only the requester locked value and leaves every emergency balance isolated', async function () {
    const vault = await createGroup()
    await completeGoals(vault)
    await vault.connect(members[0]).requestGroupExit()
    await authorize(vault)

    const requesterBefore = await token.balanceOf(await members[0].getAddress())
    const otherBefore = await vault.position(1)
    const vaultAddress = await vault.getAddress()
    const vaultBalanceBefore = await token.balanceOf(vaultAddress)
    await expect(vault.connect(members[0]).completeGroupExit(0))
      .to.emit(vault, 'GroupExitCompleted')
      .withArgs(0, 0, await members[0].getAddress(), 90n * UNIT)

    const requester = await vault.position(0)
    const otherAfter = await vault.position(1)
    expect(await token.balanceOf(await members[0].getAddress())).to.equal(requesterBefore + 90n * UNIT)
    expect(await token.balanceOf(vaultAddress)).to.equal(vaultBalanceBefore - 90n * UNIT)
    expect(requester.emergencyBalance).to.equal(10n * UNIT)
    expect(requester.lockedBalance).to.equal(0n)
    expect(requester.lockedWithdrawn).to.equal(true)
    expect(otherAfter).to.deep.equal(otherBefore)
    expect(await vault.memberStatus(0)).to.equal(1n)
    expect(await vault.rewardDisqualified(0)).to.equal(true)
    expect(await vault.activeMemberCount()).to.equal(4n)

    await vault.connect(members[0]).withdrawEmergency(0, 10n * UNIT)
    expect((await vault.position(0)).emergencyBalance).to.equal(0n)
  })

  it('redeems an Earn requester share of accrued yield without touching other shares', async function () {
    const adapterFactory = await ethers.deployContract('MockYieldAdapterFactory', [
      await token.getAddress(),
      31_337,
      5n * 10n ** 25n,
    ])
    const earnFactory = await ethers.deployContract('VaultFactory', [
      await token.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      await adapterFactory.getAddress(),
    ])
    const vault = await createGroup(5, 1, earnFactory)
    await completeGoals(vault)
    const adapter = await ethers.getContractAt('MockYieldAdapter', await vault.yieldAdapter())
    await token.mint(await outsider.getAddress(), 50n * UNIT)
    await token.connect(outsider).approve(await adapter.getAddress(), 50n * UNIT)
    await adapter.connect(outsider).fundYield(50n * UNIT)

    const claim = await vault.positionValue(0)
    const otherShares = (await vault.position(1)).lockedShares
    await vault.connect(members[0]).requestGroupExit()
    await authorize(vault)
    const balanceBefore = await token.balanceOf(await members[0].getAddress())
    await vault.connect(members[0]).completeGroupExit(0)

    expect(claim).to.equal(100n * UNIT)
    expect(await token.balanceOf(await members[0].getAddress())).to.equal(balanceBefore + claim)
    expect((await vault.position(1)).lockedShares).to.equal(otherShares)
    expect(await vault.positionValue(1)).to.equal(100n * UNIT)
  })

  it('keeps cooperative requests and market listings mutually exclusive', async function () {
    const vault = await createGroup()
    await completeGoals(vault)
    const payout = await listingQuote(vault)
    await vault.connect(members[0]).requestGroupExit()
    await expect(vault.connect(members[0]).requestGroupExit())
      .to.be.revertedWithCustomError(vault, 'GroupExitUnresolved')
    await expect(
      market.connect(members[0]).createListing(await vault.getAddress(), 0, maturity, payout),
    ).to.be.revertedWithCustomError(vault, 'GroupExitUnresolved')

    await expect(vault.connect(members[0]).cancelGroupExit(0))
      .to.emit(vault, 'GroupExitCancelled')
    await expect(vault.connect(members[0]).completeGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'GroupExitNotAuthorized')
    await market.connect(members[0]).createListing(await vault.getAddress(), 0, maturity, payout)
    await expect(vault.connect(members[0]).requestGroupExit())
      .to.be.revertedWithCustomError(vault, 'PositionListed')
  })

  it('expires after seven days and permits the market fallback', async function () {
    const vault = await createGroup()
    await completeGoals(vault)
    const now = BigInt(await networkHelpers.time.latest())
    await vault.connect(members[0]).requestGroupExit()
    const request = await vault.groupExitRequests(0)
    expect(request.expiresAt).to.equal(request.createdAt + 7n * DAY)
    await networkHelpers.time.increaseTo(now + 7n * DAY + 2n)
    await expect(vault.connect(members[1]).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'GroupExitExpiredRequest')

    const payout = await listingQuote(vault)
    await expect(
      market.connect(members[0]).createListing(await vault.getAddress(), 0, maturity, payout),
    ).to.emit(vault, 'GroupExitExpired')
    expect((await vault.groupExitRequests(0)).status).to.equal(4n)
    await expect(vault.connect(members[0]).completeGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'GroupExitNotAuthorized')
  })

  it('requires all active goals before an authorized cooperative payout', async function () {
    const vault = await createGroup()
    await deposit(vault, members[0], 0)
    for (let index = 1; index < members.length; index += 1) {
      await deposit(vault, members[index], index, 50n * UNIT)
    }
    await vault.connect(members[0]).requestGroupExit()
    await authorize(vault)
    await expect(vault.connect(members[0]).completeGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'GroupGoalsIncomplete')

    for (let index = 1; index < members.length; index += 1) {
      await deposit(vault, members[index], index, 50n * UNIT)
    }
    await vault.connect(members[0]).completeGroupExit(0)
    expect(await vault.memberStatus(0)).to.equal(1n)
  })

  it('never gives a market buyer membership, voting power, or reward eligibility', async function () {
    const vault = await createGroup()
    await completeGoals(vault)
    const payout = await listingQuote(vault)
    await market.connect(members[0]).createListing(await vault.getAddress(), 0, maturity, payout)
    const fee = await market.feeFor(payout)
    await token.mint(await provider.getAddress(), payout + fee)
    await token.connect(provider).approve(await market.getAddress(), payout + fee)
    await market.connect(provider).fundListing(0)

    expect(await vault.positionOwner(0)).to.equal(await provider.getAddress())
    expect(await vault.memberAt(0)).to.equal(await members[0].getAddress())
    expect(await vault.memberStatus(0)).to.equal(2n)
    expect(await vault.rewardDisqualified(0)).to.equal(true)

    await vault.connect(members[1]).requestGroupExit()
    await expect(vault.connect(provider).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'MemberOnly')
    await expect(vault.connect(members[0]).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'ApprovalUnavailable')
    await expect(vault.connect(deployer).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'MemberOnly')
  })

  it('disables further early unlocks and group rewards below four eligible members', async function () {
    const vault = await createGroup(4)
    await completeGoals(vault, 4)
    await vault.connect(members[0]).requestGroupExit()
    await authorize(vault, 0n, 4)
    await vault.connect(members[0]).completeGroupExit(0)
    expect(await vault.activeMemberCount()).to.equal(3n)
    await expect(vault.connect(members[1]).requestGroupExit())
      .to.be.revertedWithCustomError(vault, 'GroupEarlyUnlockDisabled')

    await token.mint(await outsider.getAddress(), 30n * UNIT)
    await token.connect(outsider).approve(await rewardPool.getAddress(), 30n * UNIT)
    await rewardPool.connect(outsider).fundVault(await vault.getAddress(), 30n * UNIT)
    await networkHelpers.time.increaseTo(maturity)
    expect(await vault.rewardsReady()).to.equal(false)
    await expect(vault.activateRewards()).to.be.revertedWithCustomError(vault, 'RewardsNotReady')
  })

  it('allows maturity withdrawals without approval and leaves personal vault behavior unchanged', async function () {
    const group = await createGroup()
    await deposit(group, members[0], 0)
    await factory.connect(outsider).createPersonalVault(100n * UNIT, maturity, 1_000, 0)
    const personal = await ethers.getContractAt(
      'SavingsVault',
      await factory.vaultAt((await factory.vaultCount()) - 1n),
    )
    await token.mint(await outsider.getAddress(), 100n * UNIT)
    await token.connect(outsider).approve(await personal.getAddress(), 100n * UNIT)
    await personal.connect(outsider).deposit(0, 100n * UNIT)
    await expect(personal.connect(outsider).requestGroupExit())
      .to.be.revertedWithCustomError(personal, 'GroupOnly')

    await networkHelpers.time.increaseTo(maturity)
    await group.connect(members[0]).withdrawLocked(0)
    await personal.connect(outsider).withdrawLocked(0)
    expect(await group.memberStatus(0)).to.equal(3n)
    expect(await personal.memberStatus(0)).to.equal(3n)
  })
})
