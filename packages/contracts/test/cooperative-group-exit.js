import { expect } from 'chai'
import { network } from 'hardhat'
import { createActivatedGroup, deployFactory } from './helpers/deploy-factory.js'

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
    maturity = BigInt(await networkHelpers.time.latest()) + 60n * DAY
  })

  async function createGroup(count = 5, mode = 0, selectedFactory = factory) {
    const selectedMembers = members.slice(0, count)
    return createActivatedGroup(
      ethers,
      selectedFactory,
      selectedMembers,
      selectedMembers.map(() => 100n * UNIT),
      selectedMembers.map(() => 1_000),
      maturity,
      mode,
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

    const authorized = await vault.groupExitRequests(0)
    expect(authorized.status).to.equal(2n)
    expect(authorized.authorizationExpiresAt).to.equal(
      BigInt(await networkHelpers.time.latest()) + DAY,
    )
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

  it.skip('legacy V2: redeems an Earn requester share of accrued yield without touching other shares', async function () {
    const adapterFactory = await ethers.deployContract('MockYieldAdapterFactory', [
      await token.getAddress(),
      31_337,
      5n * 10n ** 25n,
    ])
    const { factory: earnFactory } = await deployFactory(ethers, [
      await token.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      await adapterFactory.getAddress(),
    ], await riskReserve.getAddress())
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

  it('allows only one unresolved cooperative request per group', async function () {
    const vault = await createGroup()
    await completeGoals(vault)
    await vault.connect(members[0]).requestGroupExit()
    await expect(vault.connect(members[1]).requestGroupExit())
      .to.be.revertedWithCustomError(vault, 'GroupExitUnresolved')

    await vault.connect(members[0]).cancelGroupExit(0)
    await expect(vault.connect(members[1]).requestGroupExit())
      .to.emit(vault, 'GroupExitRequested')
    expect(await vault.activeGroupExitRequestIdPlusOne()).to.equal(2n)
  })

  it('expires after 24 hours and permits the market fallback', async function () {
    const vault = await createGroup()
    await completeGoals(vault)
    await vault.connect(members[0]).requestGroupExit()
    const request = await vault.groupExitRequests(0)
    expect(request.expiresAt).to.equal(request.createdAt + DAY)

    // The request remains usable immediately before expiry, but not at the
    // exact expiry timestamp. This mirrors the contract's `< expiresAt` rule.
    await networkHelpers.time.setNextBlockTimestamp(request.expiresAt - 1n)
    await vault.connect(members[1]).approveGroupExit(0)
    await networkHelpers.time.setNextBlockTimestamp(request.expiresAt)
    await expect(vault.connect(members[2]).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'GroupExitExpiredRequest')

    const payout = await listingQuote(vault)
    await expect(
      market.connect(members[0]).createListing(await vault.getAddress(), 0, maturity, payout),
    ).to.emit(vault, 'GroupExitExpired')
    expect((await vault.groupExitRequests(0)).status).to.equal(4n)
    await expect(vault.connect(members[0]).completeGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'GroupExitNotAuthorized')
  })

  it('requires each approver to have deposited at least 25% of their own target', async function () {
    const vault = await createGroup(4)
    await deposit(vault, members[0], 0)
    await deposit(vault, members[1], 1, 25n * UNIT - 1n)
    await deposit(vault, members[2], 2, 25n * UNIT)
    await vault.connect(members[0]).requestGroupExit()

    await expect(vault.connect(members[1]).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'InsufficientApprovalProgress')
    await expect(vault.connect(members[2]).approveGroupExit(0))
      .to.emit(vault, 'GroupExitApproved')

    // Another member's pending request does not freeze this approver's own
    // deposits, so they can become eligible during the 24-hour window.
    await deposit(vault, members[1], 1, 1n)
    await expect(vault.connect(members[1]).approveGroupExit(0))
      .to.emit(vault, 'GroupExitApproved')
  })

  it('uses active principal, revalidates withdrawn emergency funds, and permits restoring eligibility', async function () {
    const vault = await createGroup(5)
    await deposit(vault, members[0], 0)
    for (let index = 1; index < 5; index += 1) {
      await deposit(vault, members[index], index, 25n * UNIT)
    }
    expect(await vault.activePrincipalSavings(1)).to.equal(25n * UNIT)
    await vault.connect(members[1]).withdrawEmergency(1, UNIT)
    expect(await vault.activePrincipalSavings(1)).to.equal(24n * UNIT)

    await vault.connect(members[0]).requestGroupExit()
    await expect(vault.connect(members[1]).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'InsufficientApprovalProgress')
    await deposit(vault, members[1], 1, UNIT)
    for (let index = 1; index < 5; index += 1) {
      await vault.connect(members[index]).approveGroupExit(0)
    }

    // Previously recorded approval cannot be used after an emergency withdrawal
    // drops this member's active principal below the independent 25% threshold.
    await vault.connect(members[1]).withdrawEmergency(1, UNIT)
    await expect(vault.connect(members[0]).completeGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'InsufficientApprovalProgress')
    await deposit(vault, members[1], 1, 74n * UNIT)
    for (let index = 2; index < 5; index += 1) {
      await deposit(vault, members[index], index, 75n * UNIT)
    }
    await vault.connect(members[0]).completeGroupExit(0)
    expect(await vault.memberStatus(0)).to.equal(1n)
  })

  it.skip('legacy V2: does not count generated Earn yield toward the 25% approval threshold', async function () {
    const adapterFactory = await ethers.deployContract('MockYieldAdapterFactory', [
      await token.getAddress(),
      31_337,
      0,
    ])
    const { factory: earnFactory } = await deployFactory(ethers, [
      await token.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      await adapterFactory.getAddress(),
    ], await riskReserve.getAddress())
    const vault = await createGroup(5, 1, earnFactory)
    await deposit(vault, members[0], 0)
    await deposit(vault, members[1], 1, 20n * UNIT)
    const adapter = await ethers.getContractAt('MockYieldAdapter', await vault.yieldAdapter())
    await token.mint(await outsider.getAddress(), 100n * UNIT)
    await token.connect(outsider).approve(await adapter.getAddress(), 100n * UNIT)
    await adapter.connect(outsider).fundYield(100n * UNIT)
    expect(await vault.positionValue(1)).to.be.greaterThan(20n * UNIT)
    expect(await vault.activePrincipalSavings(1)).to.equal(20n * UNIT)

    await vault.connect(members[0]).requestGroupExit()
    await expect(vault.connect(members[1]).approveGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'InsufficientApprovalProgress')
  })

  it('expires an authorized exit after its separate 24-hour execution window', async function () {
    const vault = await createGroup(5)
    await completeGoals(vault)
    await vault.connect(members[0]).requestGroupExit()
    await authorize(vault)
    const request = await vault.groupExitRequests(0)

    await networkHelpers.time.setNextBlockTimestamp(request.authorizationExpiresAt)
    await expect(vault.connect(members[0]).completeGroupExit(0))
      .to.be.revertedWithCustomError(vault, 'GroupExitAuthorizationWindowExpired')
    await expect(vault.expireGroupExit(0))
      .to.emit(vault, 'GroupExitAuthorizationExpired')
    expect((await vault.groupExitRequests(0)).status).to.equal(4n)
    await expect(vault.connect(members[0]).requestGroupExit())
      .to.emit(vault, 'GroupExitRequested')
  })

  it('allows an authorized cooperative payout before every active goal is complete', async function () {
    const vault = await createGroup()
    await deposit(vault, members[0], 0)
    for (let index = 1; index < members.length; index += 1) {
      await deposit(vault, members[index], index, 50n * UNIT)
    }
    await vault.connect(members[0]).requestGroupExit()
    await authorize(vault)
    await vault.connect(members[0]).completeGroupExit(0)
    expect(await vault.memberStatus(0)).to.equal(1n)
    expect(await vault.activeMemberCount()).to.equal(4n)
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

  it('lets a group-position buyer claim the locked position at maturity', async function () {
    const vault = await createGroup()
    await completeGoals(vault)
    const payout = await listingQuote(vault)
    await market.connect(members[0]).createListing(await vault.getAddress(), 0, maturity, payout)
    const fee = await market.feeFor(payout)
    await token.mint(await provider.getAddress(), payout + fee)
    await token.connect(provider).approve(await market.getAddress(), payout + fee)
    await market.connect(provider).fundListing(0)

    const providerBefore = await token.balanceOf(await provider.getAddress())
    const claim = await vault.positionValue(0)
    await networkHelpers.time.increaseTo(maturity)
    await expect(vault.connect(members[0]).withdrawLocked(0))
      .to.be.revertedWithCustomError(vault, 'PositionOwnerOnly')
    await expect(vault.connect(provider).withdrawLocked(0))
      .to.emit(vault, 'LockedWithdrawn')
      .withArgs(0, await provider.getAddress(), claim)
    expect(await token.balanceOf(await provider.getAddress())).to.equal(providerBefore + claim)
    expect((await vault.position(0)).emergencyBalance).to.equal(10n * UNIT)
  })

  it('allows exits from four to three and three to two, then enforces the two-member floor', async function () {
    const vault = await createGroup(4)
    await completeGoals(vault, 4)
    await vault.connect(members[0]).requestGroupExit()
    await authorize(vault, 0n, 4)
    await vault.connect(members[0]).completeGroupExit(0)
    expect(await vault.activeMemberCount()).to.equal(3n)

    await vault.connect(members[1]).requestGroupExit()
    await vault.connect(members[2]).approveGroupExit(1)
    await vault.connect(members[3]).approveGroupExit(1)
    await vault.connect(members[1]).completeGroupExit(1)
    expect(await vault.activeMemberCount()).to.equal(2n)

    await expect(vault.connect(members[2]).requestGroupExit())
      .to.be.revertedWithCustomError(vault, 'GroupEarlyUnlockDisabled')
  })

  it('allows sequential cooperative exits while two active members remain', async function () {
    const vault = await createGroup(5)
    await completeGoals(vault, 5)
    await vault.connect(members[0]).requestGroupExit()
    await authorize(vault, 0n, 5)
    await vault.connect(members[0]).completeGroupExit(0)
    expect(await vault.activeMemberCount()).to.equal(4n)

    await vault.connect(members[1]).requestGroupExit()
    for (let index = 2; index < 5; index += 1) {
      await vault.connect(members[index]).approveGroupExit(1)
    }
    await vault.connect(members[1]).completeGroupExit(1)
    expect(await vault.activeMemberCount()).to.equal(3n)
  })

  it('allows four cooperative exits from a six-member group, leaving two', async function () {
    const sixth = outsider
    members.push(sixth)
    const vault = await createGroup(6)
    await completeGoals(vault, 6)
    await vault.connect(members[0]).requestGroupExit()
    await authorize(vault, 0n, 6)
    await vault.connect(members[0]).completeGroupExit(0)
    await vault.connect(members[1]).requestGroupExit()
    for (let index = 2; index < 6; index += 1) {
      await vault.connect(members[index]).approveGroupExit(1)
    }
    await vault.connect(members[1]).completeGroupExit(1)
    for (let requester = 2; requester < 4; requester += 1) {
      await vault.connect(members[requester]).requestGroupExit()
      for (let approver = requester + 1; approver < 6; approver += 1) {
        await vault.connect(members[approver]).approveGroupExit(BigInt(requester))
      }
      await vault.connect(members[requester]).completeGroupExit(BigInt(requester))
    }
    expect(await vault.activeMemberCount()).to.equal(2n)
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
