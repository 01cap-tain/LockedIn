import { expect } from 'chai'
import { network } from 'hardhat'
import { deployFactory } from './helpers/deploy-factory.js'

const UNIT = 10n ** 6n
const DAY = 24n * 60n * 60n

describe('Group invitation activation', function () {
  let ethers
  let networkHelpers
  let creator
  let invitees
  let outsider
  let token
  let factory
  let market
  let maturity

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    const signers = await ethers.getSigners()
    creator = signers[0]
    invitees = signers.slice(1, 4)
    outsider = signers[4]
    token = await ethers.deployContract('MockUSDT')
    ;({ factory } = await deployFactory(ethers, [
      await token.getAddress(),
      await signers[5].getAddress(),
      await signers[6].getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ], await signers[7].getAddress()))
    market = await ethers.getContractAt('EarlyExitMarket', await factory.earlyExitMarket())
    maturity = BigInt(await networkHelpers.time.latest()) + 30n * DAY
  })

  async function createPendingGroup() {
    const members = [creator, ...invitees]
    const addresses = await Promise.all(members.map((member) => member.getAddress()))
    await factory.createGroupVault(
      addresses,
      [100n, 200n, 300n, 400n].map((value) => value * UNIT),
      [1_000, 1_100, 1_200, 1_300],
      maturity,
      0,
    )
    return ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
  }

  it('requires every invited wallet to accept the inspectable immutable terms', async function () {
    const vault = await createPendingGroup()
    expect(await vault.groupLifecycle()).to.equal(1n)
    expect(await vault.acceptedMemberCount()).to.equal(1n)
    expect(await vault.groupInvitationAccepted(await creator.getAddress())).to.equal(true)
    expect((await vault.position(2)).target).to.equal(300n * UNIT)
    expect((await vault.position(2)).emergencyBps).to.equal(1_200n)
    expect(await vault.maturity()).to.equal(maturity)
    expect(await vault.mode()).to.equal(0n)

    await token.mint(await creator.getAddress(), 100n * UNIT)
    await token.approve(await vault.getAddress(), 100n * UNIT)
    await expect(vault.deposit(0, 100n * UNIT))
      .to.be.revertedWithCustomError(vault, 'GroupNotActive')
    await expect(market.createListing(await vault.getAddress(), 0, maturity, 1))
      .to.be.revertedWithCustomError(vault, 'GroupNotActive')
    expect(await vault.rewardsReady()).to.equal(false)

    for (let index = 0; index < invitees.length; index += 1) {
      const action = vault.connect(invitees[index]).acceptGroupInvitation()
      if (index === invitees.length - 1) await expect(action).to.emit(vault, 'GroupActivated')
      else await action
    }
    expect(await vault.groupLifecycle()).to.equal(2n)
    await vault.deposit(0, 100n * UNIT)
  })

  it('lets an invitee decline and only the creator cancel the unfunded group', async function () {
    const vault = await createPendingGroup()
    await expect(vault.connect(invitees[0]).declineGroupInvitation())
      .to.emit(vault, 'GroupInvitationDeclined')
    expect(await vault.groupLifecycle()).to.equal(3n)
    await expect(vault.connect(invitees[1]).acceptGroupInvitation())
      .to.be.revertedWithCustomError(vault, 'InvitationUnavailable')
    await expect(vault.connect(outsider).cancelUnactivatedGroup())
      .to.be.revertedWithCustomError(vault, 'CreatorOnly')
    await expect(vault.cancelUnactivatedGroup())
      .to.emit(vault, 'UnactivatedGroupCancelled')
    expect(await vault.groupLifecycle()).to.equal(5n)
    expect(await token.balanceOf(await vault.getAddress())).to.equal(0n)
  })

  it('enforces the exact 72-hour invitation boundary and supports expiry cancellation', async function () {
    const vault = await createPendingGroup()
    const expiresAt = await vault.invitationExpiresAt()
    expect(expiresAt).to.equal((await vault.createdAt()) + 72n * 60n * 60n)
    await networkHelpers.time.setNextBlockTimestamp(expiresAt)
    await expect(vault.connect(invitees[0]).acceptGroupInvitation())
      .to.be.revertedWithCustomError(vault, 'InvitationExpired')
    await expect(vault.expireGroupInvitation())
      .to.emit(vault, 'GroupInvitationExpired')
    expect(await vault.groupLifecycle()).to.equal(4n)
    await vault.cancelUnactivatedGroup()
    expect(await vault.groupLifecycle()).to.equal(5n)
  })

  it('rejects fewer than four, zero, and duplicate proposed members', async function () {
    const addresses = await Promise.all(
      [creator, ...invitees].map((member) => member.getAddress()),
    )
    await expect(
      factory.createGroupVault(
        addresses.slice(0, 3),
        [UNIT, UNIT, UNIT],
        [1_000, 1_000, 1_000],
        maturity,
        0,
      ),
    ).to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
    await expect(
      factory.createGroupVault(
        [addresses[0], addresses[1], addresses[2], ethers.ZeroAddress],
        [UNIT, UNIT, UNIT, UNIT],
        [1_000, 1_000, 1_000, 1_000],
        maturity,
        0,
      ),
    ).to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
    await expect(
      factory.createGroupVault(
        [addresses[0], addresses[1], addresses[2], addresses[1]],
        [UNIT, UNIT, UNIT, UNIT],
        [1_000, 1_000, 1_000, 1_000],
        maturity,
        0,
      ),
    ).to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
  })
})
