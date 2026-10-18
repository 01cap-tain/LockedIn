import { expect } from 'chai'
import { network } from 'hardhat'

const UNIT = 10n ** 6n

describe('LockedIn Circle Phase 1', function () {
  let ethers
  let networkHelpers
  let creator
  let memberTwo
  let outsider
  let riskReserve
  let maintenanceTreasury
  let token
  let factory
  let maturity

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    ;[creator, memberTwo, outsider, riskReserve, maintenanceTreasury] = await ethers.getSigners()
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
    maturity = BigInt(await networkHelpers.time.latest()) + 3_600n
  })

  async function personalVault({ target = 100n * UNIT, bps = 1_000, owner = creator } = {}) {
    await factory.connect(owner).createPersonalVault(target, maturity, bps, 0)
    const address = await factory.vaultAt((await factory.vaultCount()) - 1n)
    return ethers.getContractAt('SavingsVault', address)
  }

  async function groupVault(targets = [100n * UNIT, 100n * UNIT], bps = [1_000, 1_000]) {
    const members = [await creator.getAddress(), await memberTwo.getAddress()]
    await factory.createGroupVault(members, targets, bps, maturity, 0)
    return ethers.getContractAt('SavingsVault', await factory.vaultAt((await factory.vaultCount()) - 1n))
  }

  async function fundAndApprove(signer, spender, amount) {
    await token.mint(await signer.getAddress(), amount)
    await token.connect(signer).approve(spender, amount)
  }

  it('creates and records personal and group vaults', async function () {
    const personal = await personalVault()
    const group = await groupVault()

    expect(await personal.isGroup()).to.equal(false)
    expect(await group.isGroup()).to.equal(true)
    expect(await group.memberCount()).to.equal(2n)
    expect(await factory.vaultCount()).to.equal(2n)
    expect(await factory.isVault(await personal.getAddress())).to.equal(true)
    expect(await factory.vaultsOf(await memberTwo.getAddress())).to.deep.equal([await group.getAddress()])
  })

  for (const [percent, bps] of [[10, 1_000], [12, 1_200], [15, 1_500]]) {
    it(`splits deposits at ${percent}% emergency allocation`, async function () {
      const vault = await personalVault({ bps })
      await fundAndApprove(creator, await vault.getAddress(), 100n * UNIT)
      await vault.deposit(0, 100n * UNIT)

      const position = await vault.position(0)
      expect(position.emergencyBalance).to.equal(BigInt(percent) * UNIT)
      expect(position.lockedBalance).to.equal(BigInt(100 - percent) * UNIT)
      expect(position.deposited).to.equal(100n * UNIT)
    })
  }

  it('rejects emergency allocations below 10% or above 15%', async function () {
    await expect(factory.createPersonalVault(UNIT, maturity, 999, 0)).to.revert(ethers)
    await expect(factory.createPersonalVault(UNIT, maturity, 1_501, 0)).to.revert(ethers)
  })

  it('allows emergency withdrawals without reversing goal completion', async function () {
    const vault = await personalVault()
    await fundAndApprove(creator, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    await vault.withdrawEmergency(0, 7n * UNIT)

    const position = await vault.position(0)
    expect(position.emergencyBalance).to.equal(3n * UNIT)
    expect(position.deposited).to.equal(100n * UNIT)
    expect(await vault.goalComplete(0)).to.equal(true)
  })

  it('marks a goal complete only at or above its target', async function () {
    const vault = await personalVault()
    await fundAndApprove(creator, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 99n * UNIT)
    expect(await vault.goalComplete(0)).to.equal(false)
    await vault.deposit(0, 1n * UNIT)
    expect(await vault.goalComplete(0)).to.equal(true)
  })

  it('returns an incomplete position locked balance at maturity without rewards', async function () {
    const vault = await personalVault()
    await fundAndApprove(creator, await vault.getAddress(), 40n * UNIT)
    await vault.deposit(0, 40n * UNIT)
    await networkHelpers.time.increaseTo(maturity)
    await vault.withdrawLocked(0)

    const position = await vault.position(0)
    expect(position.lockedBalance).to.equal(0n)
    expect(position.lockedWithdrawn).to.equal(true)
    expect(await vault.goalComplete(0)).to.equal(false)
    expect(await (await ethers.getContractAt('RewardPool', await factory.rewardPool())).claimable(await creator.getAddress())).to.equal(0n)
  })

  it('activates equal group rewards only after every member completes', async function () {
    const vault = await groupVault()
    await fundAndApprove(creator, await vault.getAddress(), 100n * UNIT)
    await fundAndApprove(memberTwo, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)

    const pool = await ethers.getContractAt('RewardPool', await factory.rewardPool())
    await token.mint(await outsider.getAddress(), 20n * UNIT)
    await token.connect(outsider).approve(await pool.getAddress(), 20n * UNIT)
    await pool.connect(outsider).fundVault(await vault.getAddress(), 20n * UNIT)
    await expect(vault.activateRewards()).to.be.revertedWithCustomError(vault, 'RewardsNotReady')

    await vault.connect(memberTwo).deposit(1, 100n * UNIT)
    await networkHelpers.time.increaseTo(maturity)
    await vault.activateRewards()
    expect(await pool.claimable(await creator.getAddress())).to.equal(10n * UNIT)
    expect(await pool.claimable(await memberTwo.getAddress())).to.equal(10n * UNIT)
    expect(await pool.rewardEligible(await vault.getAddress(), await creator.getAddress())).to.equal(true)
    await expect(pool.connect(outsider).activateRewards()).to.be.revertedWithCustomError(pool, 'VaultNotRegistered')
    await expect(vault.activateRewards()).to.revert(ethers)
  })

  it('rejects unauthorized emergency and locked withdrawals', async function () {
    const vault = await personalVault()
    await fundAndApprove(creator, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)

    await expect(vault.connect(outsider).withdrawEmergency(0, UNIT)).to.be.revertedWithCustomError(vault, 'MemberOnly')
    await networkHelpers.time.increaseTo(maturity)
    await expect(vault.connect(outsider).withdrawLocked(0)).to.be.revertedWithCustomError(vault, 'PositionOwnerOnly')
  })

  it('prevents double locked-balance withdrawals', async function () {
    const vault = await personalVault()
    await fundAndApprove(creator, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    await networkHelpers.time.increaseTo(maturity)
    await vault.withdrawLocked(0)
    await expect(vault.withdrawLocked(0)).to.be.revertedWithCustomError(vault, 'NothingToWithdraw')
  })

  it('prevents withdrawing the same emergency balance twice', async function () {
    const vault = await personalVault()
    await fundAndApprove(creator, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    await vault.withdrawEmergency(0, 10n * UNIT)
    await expect(vault.withdrawEmergency(0, 1)).to.be.revertedWithCustomError(vault, 'InsufficientEmergencyBalance')
  })

  it('blocks reentrant emergency withdrawals', async function () {
    const callbackToken = await ethers.deployContract('CallbackUSDT')
    const attacker = await ethers.deployContract('ReentrantMember')
    const callbackFactory = await ethers.deployContract('VaultFactory', [
      await callbackToken.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      ethers.ZeroAddress,
    ])
    const members = [await creator.getAddress(), await attacker.getAddress()]
    await callbackFactory.createGroupVault(members, [UNIT, 100n * UNIT], [1_000, 1_000], maturity, 0)
    const vault = await ethers.getContractAt('SavingsVault', await callbackFactory.vaultAt(0))

    await attacker.configure(await vault.getAddress(), await callbackToken.getAddress(), 1)
    await callbackToken.mint(await attacker.getAddress(), 100n * UNIT)
    await attacker.deposit(100n * UNIT)
    await callbackToken.setCallbacksEnabled(true)
    await attacker.withdrawWithReentry(5n * UNIT)

    expect(await attacker.reentrySucceeded()).to.equal(false)
    expect((await vault.position(1)).emergencyBalance).to.equal(5n * UNIT)
  })

  it('records position ownership and rejects unauthorized transfers', async function () {
    const vault = await personalVault()
    expect(await vault.positionOwner(0)).to.equal(await creator.getAddress())
    await expect(
      vault.transferPosition(0, await creator.getAddress(), await outsider.getAddress()),
    ).to.be.revertedWithCustomError(vault, 'MarketOnly')
  })

  it('configures the factory-created market as the sole transfer authority', async function () {
    const vault = await personalVault()
    expect(await vault.earlyExitMarket()).to.equal(await factory.earlyExitMarket())
    await expect(
      vault.connect(outsider).transferPosition(0, await creator.getAddress(), await memberTwo.getAddress()),
    ).to.be.revertedWithCustomError(vault, 'MarketOnly')
  })

  it('enforces the maturity boundary timestamp', async function () {
    const vault = await personalVault()
    await fundAndApprove(creator, await vault.getAddress(), 10n * UNIT)
    await vault.deposit(0, 10n * UNIT)

    await networkHelpers.time.setNextBlockTimestamp(maturity - 1n)
    await expect(vault.withdrawLocked(0)).to.be.revertedWithCustomError(vault, 'NotMatured')
    await networkHelpers.time.setNextBlockTimestamp(maturity)
    await (await vault.withdrawLocked(0)).wait()
  })

  it('closes deposits at the maturity boundary', async function () {
    const vault = await personalVault()
    await fundAndApprove(creator, await vault.getAddress(), 10n * UNIT)
    await networkHelpers.time.setNextBlockTimestamp(maturity)
    await expect(vault.deposit(0, 10n * UNIT)).to.be.revertedWithCustomError(vault, 'DepositsClosed')
  })

  it('isolates different deposits and balances across multiple members', async function () {
    const vault = await groupVault([100n * UNIT, 200n * UNIT], [1_000, 1_500])
    await fundAndApprove(creator, await vault.getAddress(), 120n * UNIT)
    await fundAndApprove(memberTwo, await vault.getAddress(), 80n * UNIT)
    await vault.deposit(0, 120n * UNIT)
    await vault.connect(memberTwo).deposit(1, 80n * UNIT)

    const first = await vault.position(0)
    const second = await vault.position(1)
    expect(first.emergencyBalance).to.equal(12n * UNIT)
    expect(first.lockedBalance).to.equal(108n * UNIT)
    expect(second.emergencyBalance).to.equal(12n * UNIT)
    expect(second.lockedBalance).to.equal(68n * UNIT)
    expect(await vault.goalComplete(0)).to.equal(true)
    expect(await vault.goalComplete(1)).to.equal(false)
  })
})
