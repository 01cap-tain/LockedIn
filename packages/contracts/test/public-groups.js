import { expect } from 'chai'
import { network } from 'hardhat'
import { deployFactory } from './helpers/deploy-factory.js'

const UNIT = 10n ** 6n
const DAY = 24n * 60n * 60n

describe('Public group enrollment', function () {
  let ethers
  let networkHelpers
  let creator
  let joiners
  let token
  let factory
  let maturity

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    const signers = await ethers.getSigners()
    ;[creator, ...joiners] = signers
    token = await ethers.deployContract('MockUSDT')
    ;({ factory } = await deployFactory(ethers, [
      await token.getAddress(),
      await signers[7].getAddress(),
      await signers[8].getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ], await signers[9].getAddress()))
    maturity = BigInt(await networkHelpers.time.latest()) + 30n * DAY
  })

  async function createPublicGroup(maxMembers = 4) {
    await factory.createPublicGroupVault(100n * UNIT, 1_200, maxMembers, maturity, 0)
    return ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
  }

  it('publishes capacity and gives each public joiner the same terms', async function () {
    const vault = await createPublicGroup(6)
    expect(await vault.publicJoining()).to.equal(true)
    expect(await vault.maxMemberCount()).to.equal(6n)
    expect(await vault.memberCount()).to.equal(1n)
    expect(await vault.groupLifecycle()).to.equal(2n)

    await expect(vault.connect(joiners[0]).joinPublicGroup())
      .to.emit(vault, 'PublicGroupJoined')
      .withArgs(await joiners[0].getAddress(), 1n, 2n)
    const position = await vault.position(1)
    expect(position.target).to.equal(100n * UNIT)
    expect(position.emergencyBps).to.equal(1_200n)
    expect(await factory.vaultsOf(await joiners[0].getAddress()))
      .to.deep.equal([await vault.getAddress()])
  })

  it('rejects duplicate joins and joins beyond the advertised capacity', async function () {
    const vault = await createPublicGroup(4)
    await vault.connect(joiners[0]).joinPublicGroup()
    await expect(vault.connect(joiners[0]).joinPublicGroup())
      .to.be.revertedWithCustomError(vault, 'PublicJoiningUnavailable')
    await vault.connect(joiners[1]).joinPublicGroup()
    await vault.connect(joiners[2]).joinPublicGroup()
    await expect(vault.connect(joiners[3]).joinPublicGroup())
      .to.be.revertedWithCustomError(vault, 'PublicJoiningUnavailable')
  })

  it('freezes membership permanently when the first contribution is made', async function () {
    const vault = await createPublicGroup(6)
    await vault.connect(joiners[0]).joinPublicGroup()
    await token.mint(await creator.getAddress(), 10n * UNIT)
    await token.approve(await vault.getAddress(), 10n * UNIT)
    await expect(vault.deposit(0, 10n * UNIT))
      .to.emit(vault, 'PublicGroupJoiningClosed')
      .withArgs(2n)
    expect(await vault.publicJoinClosed()).to.equal(true)
    await expect(vault.connect(joiners[1]).joinPublicGroup())
      .to.be.revertedWithCustomError(vault, 'PublicJoiningUnavailable')
  })

  it('rejects invalid public capacities', async function () {
    await expect(factory.createPublicGroupVault(100n * UNIT, 1_200, 3, maturity, 0))
      .to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
    await expect(factory.createPublicGroupVault(100n * UNIT, 1_200, 51, maturity, 0))
      .to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
  })
})
