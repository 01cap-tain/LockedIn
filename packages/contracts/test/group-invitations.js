import { expect } from 'chai'
import { network } from 'hardhat'
import { deployFactory } from './helpers/deploy-factory.js'

const UNIT = 10n ** 6n
const DAY = 24n * 60n * 60n

describe('Invite-only open circles', function () {
  let ethers, networkHelpers, invitees, outsider, factory, maturity, enrollmentDeadline

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    const signers = await ethers.getSigners()
    invitees = signers.slice(1)
    outsider = invitees[5]
    const token = await ethers.deployContract('MockUSDT')
    ;({ factory } = await deployFactory(ethers, [
      await token.getAddress(), await signers[7].getAddress(), await signers[8].getAddress(),
      ethers.ZeroAddress, ethers.ZeroAddress, 31_337, ethers.ZeroAddress,
    ], await signers[9].getAddress()))
    const now = BigInt(await networkHelpers.time.latest())
    maturity = now + 30n * DAY
    enrollmentDeadline = now + 7n * DAY
    await factory.createPublicGroupVault('Private circle', 100n * UNIT, 1_000, 6, enrollmentDeadline, maturity, 0, false)
  })

  it('allows only invited wallets to join with their own financial terms', async function () {
    const vault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
    await expect(vault.connect(outsider).joinPublicGroup(50n * UNIT, 1_200))
      .to.be.revertedWithCustomError(vault, 'PublicJoiningUnavailable')
    await vault.inviteGroupMember(await invitees[0].getAddress())
    await vault.connect(invitees[0]).joinPublicGroup(250n * UNIT, 1_500)
    const position = await vault.position(1)
    expect(position.target).to.equal(250n * UNIT)
    expect(position.emergencyBps).to.equal(1_500n)
  })

  it('removes creator invitation authority after activation', async function () {
    const vault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
    for (let index = 0; index < 3; index += 1) {
      await vault.inviteGroupMember(await invitees[index].getAddress())
      await vault.connect(invitees[index]).joinPublicGroup((BigInt(index) + 1n) * 100n * UNIT, 1_000 + index * 100)
    }
    await vault.connect(invitees[0]).activateGroup()
    await expect(vault.inviteGroupMember(await invitees[3].getAddress()))
      .to.be.revertedWithCustomError(vault, 'InvitationUnavailable')
  })
})
