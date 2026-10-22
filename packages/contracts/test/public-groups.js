import { expect } from 'chai'
import { network } from 'hardhat'
import { deployFactory } from './helpers/deploy-factory.js'

const UNIT = 10n ** 6n
const DAY = 24n * 60n * 60n

describe('Open group enrollment with independent positions', function () {
  let ethers, networkHelpers, creator, joiners, token, factory, maturity, enrollmentDeadline

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    const signers = await ethers.getSigners()
    ;[creator, ...joiners] = signers
    token = await ethers.deployContract('MockUSDT')
    ;({ factory } = await deployFactory(ethers, [
      await token.getAddress(), await signers[7].getAddress(), await signers[8].getAddress(),
      ethers.ZeroAddress, ethers.ZeroAddress, 31_337, ethers.ZeroAddress,
    ], await signers[9].getAddress()))
    const now = BigInt(await networkHelpers.time.latest())
    maturity = now + 30n * DAY
    enrollmentDeadline = now + 7n * DAY
  })

  async function createPublicGroup(maxMembers = 6) {
    await factory.createPublicGroupVault('Builders Circle', 100n * UNIT, 1_200, maxMembers, enrollmentDeadline, maturity, 0, true)
    return ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
  }

  it('persists shared metadata while each member chooses target and emergency allocation', async function () {
    const vault = await createPublicGroup()
    expect(await factory.groupName(await vault.getAddress())).to.equal('Builders Circle')
    expect(await vault.publicJoining()).to.equal(true)
    expect(await vault.groupLifecycle()).to.equal(1n)
    await vault.connect(joiners[0]).joinPublicGroup(250n * UNIT, 1_000)
    await vault.connect(joiners[1]).joinPublicGroup(75n * UNIT, 1_500)
    expect((await vault.position(0)).target).to.equal(100n * UNIT)
    expect((await vault.position(1)).target).to.equal(250n * UNIT)
    expect((await vault.position(2)).target).to.equal(75n * UNIT)
    expect((await vault.position(1)).emergencyBps).to.equal(1_000n)
    expect((await vault.position(2)).emergencyBps).to.equal(1_500n)
  })

  it('cannot activate below four members and permanently freezes membership after activation', async function () {
    const vault = await createPublicGroup()
    await vault.connect(joiners[0]).joinPublicGroup(120n * UNIT, 1_000)
    await vault.connect(joiners[1]).joinPublicGroup(140n * UNIT, 1_100)
    await expect(vault.activateGroup()).to.be.revertedWithCustomError(vault, 'GroupNotActive')
    await vault.connect(joiners[2]).joinPublicGroup(160n * UNIT, 1_500)
    expect(await vault.acceptedMemberCount()).to.equal(4n)
    await expect(vault.connect(joiners[1]).activateGroup()).to.emit(vault, 'GroupActivated')
    expect(await vault.groupLifecycle()).to.equal(2n)
    await expect(vault.connect(joiners[3]).joinPublicGroup(90n * UNIT, 1_200))
      .to.be.revertedWithCustomError(vault, 'PublicJoiningUnavailable')
  })

  it('blocks deposits until activation and keeps goal completion position-specific', async function () {
    const vault = await createPublicGroup()
    await vault.connect(joiners[0]).joinPublicGroup(50n * UNIT, 1_000)
    await token.mint(await creator.getAddress(), 100n * UNIT)
    await token.approve(await vault.getAddress(), 100n * UNIT)
    await expect(vault.deposit(0, 100n * UNIT)).to.be.revertedWithCustomError(vault, 'GroupNotActive')
    await vault.connect(joiners[1]).joinPublicGroup(200n * UNIT, 1_200)
    await vault.connect(joiners[2]).joinPublicGroup(300n * UNIT, 1_500)
    await vault.activateGroup()
    await vault.deposit(0, 100n * UNIT)
    expect(await vault.goalComplete(0)).to.equal(true)
    expect(await vault.goalComplete(1)).to.equal(false)
    expect(await vault.goalComplete(2)).to.equal(false)
    expect(await vault.goalComplete(3)).to.equal(false)
    expect(await vault.rewardsReady()).to.equal(false)
  })

  it('applies the 25% approval threshold to each approver own target', async function () {
    const vault = await createPublicGroup(5)
    const targets = [40n, 200n, 80n, 120n]
    for (let index = 0; index < 4; index += 1) {
      await vault.connect(joiners[index]).joinPublicGroup(targets[index] * UNIT, 1_000 + index * 100)
    }
    await vault.activateGroup()
    await token.mint(await joiners[1].getAddress(), 50n * UNIT)
    await token.connect(joiners[1]).approve(await vault.getAddress(), 50n * UNIT)
    await vault.connect(joiners[1]).deposit(2, 49n * UNIT)
    expect(await vault.groupExitApprovalEligible(2)).to.equal(false)
    await vault.connect(joiners[1]).deposit(2, 1n * UNIT)
    expect(await vault.groupExitApprovalEligible(2)).to.equal(true)
  })

  it('keeps group membership distinct from transferable market ownership', async function () {
    const vault = await createPublicGroup(4)
    await vault.connect(joiners[0]).joinPublicGroup(90n * UNIT, 1_000)
    await vault.connect(joiners[1]).joinPublicGroup(110n * UNIT, 1_200)
    await vault.connect(joiners[2]).joinPublicGroup(130n * UNIT, 1_500)
    await vault.activateGroup()
    expect(await vault.memberAt(1)).to.equal(await joiners[0].getAddress())
    expect(await vault.positionOwner(1)).to.equal(await joiners[0].getAddress())
    expect(await vault.memberCount()).to.equal(4n)
  })

  it('rejects invalid capacity, allocation and expired enrollment', async function () {
    await expect(factory.createPublicGroupVault('Small', 100n * UNIT, 1_200, 3, enrollmentDeadline, maturity, 0, true))
      .to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
    const vault = await createPublicGroup()
    await expect(vault.connect(joiners[0]).joinPublicGroup(100n * UNIT, 999))
      .to.be.revertedWithCustomError(vault, 'PublicJoiningUnavailable')
    await networkHelpers.time.increaseTo(enrollmentDeadline)
    await expect(vault.connect(joiners[0]).joinPublicGroup(100n * UNIT, 1_200))
      .to.be.revertedWithCustomError(vault, 'PublicJoiningUnavailable')
  })
})
