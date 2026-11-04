import { expect } from 'chai'
import { network } from 'hardhat'
import { createSecureGroupInvitation, deployFactory } from './helpers/deploy-factory.js'

const UNIT = 10n ** 6n
const DAY = 24n * 60n * 60n

describe('Secure invite-only circle admission', function () {
  let ethers, networkHelpers, creator, invitees, outsider, factory, vault, maturity, enrollmentDeadline

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    const signers = await ethers.getSigners()
    creator = signers[0]
    invitees = signers.slice(1, 6)
    outsider = signers[6]
    const token = await ethers.deployContract('MockUSDT')
    ;({ factory } = await deployFactory(ethers, [
      await token.getAddress(), await signers[7].getAddress(), await signers[8].getAddress(),
      ethers.ZeroAddress, ethers.ZeroAddress, 31_337, ethers.ZeroAddress,
    ], await signers[9].getAddress()))
    const now = BigInt(await networkHelpers.time.latest())
    maturity = now + 30n * DAY
    enrollmentDeadline = now + 7n * DAY
    await factory.createPublicGroupVault(
      'Private circle', 100n * UNIT, 1_000, 6, enrollmentDeadline, maturity, 0, false,
    )
    vault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
  })

  async function invite(invitee, nonce = 1n, expiry = enrollmentDeadline) {
    return createSecureGroupInvitation(ethers, vault, creator, invitee, expiry, nonce)
  }

  async function accept(invitation, signer, target = 250n * UNIT, emergencyBps = 1_500) {
    return vault.connect(signer).joinInviteOnlyGroup(
      invitation.invitee, invitation.secret, invitation.expiry, invitation.nonce, target, emergencyBps,
    )
  }

  it('accepts a valid wallet-bound invitation with independent member terms', async function () {
    const invitation = await invite(invitees[0])
    await expect(accept(invitation, invitees[0]))
      .to.emit(vault, 'GroupInvitationConsumed')
      .withArgs(invitation.commitment, invitation.invitee, 1n)
    const position = await vault.position(1)
    expect(position.target).to.equal(250n * UNIT)
    expect(position.emergencyBps).to.equal(1_500n)
    expect(await vault.invitationStatus(invitation.commitment)).to.equal(2n)
  })

  it('rejects forwarding and front-running from the wrong wallet', async function () {
    const invitation = await invite(invitees[0])
    await expect(accept(invitation, outsider))
      .to.be.revertedWithCustomError(vault, 'InvitationWrongWallet')
    expect(await vault.invitationStatus(invitation.commitment)).to.equal(1n)
  })

  it('rejects an invitation submitted to a different circle', async function () {
    await factory.createPublicGroupVault(
      'Other circle', 100n * UNIT, 1_000, 6, enrollmentDeadline, maturity, 0, false,
    )
    const other = await ethers.getContractAt('SavingsVault', await factory.vaultAt(1))
    const invitation = await invite(invitees[0])
    await expect(other.connect(invitees[0]).joinInviteOnlyGroup(
      invitation.invitee, invitation.secret, invitation.expiry, invitation.nonce, UNIT, 1_000,
    )).to.be.revertedWithCustomError(other, 'InvitationInvalid')
  })

  it('binds commitments to the current chain and deployment', async function () {
    const invitee = await invitees[0].getAddress()
    const secret = ethers.hexlify(ethers.randomBytes(32))
    const nonce = 91n
    const { chainId } = await ethers.provider.getNetwork()
    const wrongChainCommitment = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
      ['address', 'address', 'bytes32', 'uint64', 'uint256', 'uint256'],
      [await vault.getAddress(), invitee, secret, enrollmentDeadline, nonce, chainId + 1n],
    ))
    await vault.createGroupInvitation(invitee, wrongChainCommitment, enrollmentDeadline, nonce)
    await expect(vault.connect(invitees[0]).joinInviteOnlyGroup(
      invitee, secret, enrollmentDeadline, nonce, UNIT, 1_000,
    )).to.be.revertedWithCustomError(vault, 'InvitationInvalid')
  })

  it('rejects replay after an invitation is consumed', async function () {
    const invitation = await invite(invitees[0])
    await accept(invitation, invitees[0])
    await expect(accept(invitation, invitees[0]))
      .to.be.revertedWithCustomError(vault, 'InvitationAlreadyUsed')
  })

  it('rejects expired invitations', async function () {
    const now = BigInt(await networkHelpers.time.latest())
    const invitation = await invite(invitees[0], 2n, now + 60n)
    await networkHelpers.time.increaseTo(now + 60n)
    await expect(accept(invitation, invitees[0]))
      .to.be.revertedWithCustomError(vault, 'InvitationExpired')
    await expect(vault.revokeGroupInvitation(invitation.commitment))
      .to.be.revertedWithCustomError(vault, 'InvitationExpired')
    expect(await vault.invitationStatus(invitation.commitment)).to.equal(4n)
  })

  it('lets only the creator revoke an unused invitation', async function () {
    const invitation = await invite(invitees[0])
    await expect(vault.connect(outsider).revokeGroupInvitation(invitation.commitment))
      .to.be.revertedWithCustomError(vault, 'InvitationUnavailable')
    await expect(vault.revokeGroupInvitation(invitation.commitment))
      .to.emit(vault, 'GroupInvitationRevoked')
      .withArgs(invitation.commitment, invitation.invitee)
    await expect(accept(invitation, invitees[0]))
      .to.be.revertedWithCustomError(vault, 'InvitationRevoked')
    expect(await vault.invitationStatus(invitation.commitment)).to.equal(3n)
  })

  it('rejects unauthorized creation and duplicate invitations or members', async function () {
    const invitation = await invite(invitees[0])
    await expect(vault.connect(outsider).createGroupInvitation(
      await invitees[1].getAddress(), ethers.keccak256('0x1234'), enrollmentDeadline, 7n,
    )).to.be.revertedWithCustomError(vault, 'InvitationUnavailable')
    await expect(invite(invitees[0], 3n))
      .to.be.revertedWithCustomError(vault, 'InvitationAlreadyAvailable')
    await accept(invitation, invitees[0])
    await expect(invite(invitees[0], 4n))
      .to.be.revertedWithCustomError(vault, 'InvitationUnavailable')
  })

  it('invalidates all remaining invitations when the circle becomes full', async function () {
    await factory.createPublicGroupVault(
      'Capacity circle', 100n * UNIT, 1_000, 4, enrollmentDeadline, maturity, 0, false,
    )
    vault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(1))
    const invitations = []
    for (let index = 0; index < 4; index += 1) invitations.push(await invite(invitees[index], BigInt(index + 10)))
    for (let index = 0; index < 3; index += 1) await accept(invitations[index], invitees[index], UNIT, 1_000)
    expect(await vault.memberCount()).to.equal(4n)
    expect(await vault.invitationStatus(invitations[3].commitment)).to.equal(4n)
    await expect(accept(invitations[3], invitees[3], UNIT, 1_000))
      .to.be.revertedWithCustomError(vault, 'CircleFull')
  })

  it('invalidates unused invitations and rejects joining after activation', async function () {
    const invitations = []
    for (let index = 0; index < 4; index += 1) invitations.push(await invite(invitees[index], BigInt(index + 20)))
    for (let index = 0; index < 3; index += 1) await accept(invitations[index], invitees[index], UNIT, 1_000)
    await vault.connect(invitees[0]).activateGroup()
    expect(await vault.invitationStatus(invitations[3].commitment)).to.equal(4n)
    await expect(accept(invitations[3], invitees[3], UNIT, 1_000))
      .to.be.revertedWithCustomError(vault, 'InvitationExpired')
    await expect(vault.createGroupInvitation(
      await invitees[4].getAddress(), ethers.keccak256('0x5678'), enrollmentDeadline, 99n,
    )).to.be.revertedWithCustomError(vault, 'InvitationUnavailable')
  })

  it('keeps public admission separate from private invitation admission', async function () {
    await expect(vault.connect(invitees[0]).joinPublicGroup(UNIT, 1_000))
      .to.be.revertedWithCustomError(vault, 'PublicJoiningUnavailable')
  })
})
