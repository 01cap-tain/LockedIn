import { expect } from 'chai'
import { network } from 'hardhat'

import { deployFactory } from './helpers/deploy-factory.js'

const UNIT = 10n ** 6n
const DAY = 24n * 60n * 60n

describe('Protocol safety controls and exposure caps', function () {
  let ethers
  let networkHelpers
  let accounts
  let deployer
  let safetyCouncil
  let token
  let factory
  let safety
  let market
  let rewardPool
  let maturity

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    accounts = await ethers.getSigners()
    ;[deployer, safetyCouncil] = accounts
    token = await ethers.deployContract('MockUSDT')
    ;({ factory, safetyController: safety } = await deployFactory(
      ethers,
      [
        await token.getAddress(),
        await accounts[8].getAddress(),
        await accounts[9].getAddress(),
        ethers.ZeroAddress,
        ethers.ZeroAddress,
        31_337,
        ethers.ZeroAddress,
      ],
      await safetyCouncil.getAddress(),
      {
        timelockDelay: 100,
        maxPositionPrincipal: 100n * UNIT,
        maxVaultPrincipal: 150n * UNIT,
        maxProtocolPrincipal: 250n * UNIT,
      },
    ))
    market = await ethers.getContractAt('EarlyExitMarket', await factory.earlyExitMarket())
    rewardPool = await ethers.getContractAt('RewardPool', await factory.rewardPool())
    maturity = BigInt(await networkHelpers.time.latest()) + 10n * DAY
  })

  async function personalVault(owner = deployer, target = 100n * UNIT) {
    await factory.connect(owner).createPersonalVault(target, maturity, 1_000, 0)
    return ethers.getContractAt(
      'SavingsVault',
      await factory.vaultAt((await factory.vaultCount()) - 1n),
    )
  }

  async function fund(account, spender, amount) {
    await token.mint(await account.getAddress(), amount)
    await token.connect(account).approve(spender, amount)
  }

  async function activeGroup(count = 5) {
    const members = accounts.slice(2, 2 + count)
    const addresses = await Promise.all(members.map((member) => member.getAddress()))
    await factory.connect(members[0]).createGroupVault(
      addresses,
      addresses.map(() => 100n * UNIT),
      addresses.map(() => 1_000),
      maturity,
      0,
    )
    const vault = await ethers.getContractAt(
      'SavingsVault',
      await factory.vaultAt((await factory.vaultCount()) - 1n),
    )
    return { vault, members }
  }

  it('lets only the safety council pause and requires the timelock to unpause', async function () {
    await expect(safety.pause())
      .to.be.revertedWithCustomError(safety, 'SafetyCouncilOnly')
    await expect(safety.connect(safetyCouncil).pause())
      .to.emit(safety, 'ProtocolPaused')
    await expect(factory.createPersonalVault(UNIT, maturity, 1_000, 0))
      .to.be.revertedWithCustomError(safety, 'ProtocolIsPaused')
    await expect(safety.executeUnpause())
      .to.be.revertedWithCustomError(safety, 'NoPendingChange')
    await safety.connect(safetyCouncil).scheduleUnpause()
    await expect(safety.executeUnpause())
      .to.be.revertedWithCustomError(safety, 'TimelockNotReady')
    await networkHelpers.time.increase(100)
    await safety.executeUnpause()
    expect(await safety.paused()).to.equal(false)
  })

  it('blocks deposits, listings and purchases while preserving cancellation and withdrawals', async function () {
    const vault = await personalVault()
    const depositProbe = await personalVault(accounts[3])
    await fund(deployer, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    const quote = await market.referenceDiscount(await vault.getAddress(), 0)
    const payout = await market.payoutFor(await vault.positionValue(0), quote.discountBps)
    await market.createListing(await vault.getAddress(), 0, maturity, payout)
    const fee = await market.feeFor(payout)
    await fund(accounts[2], await market.getAddress(), payout + fee)
    await fund(accounts[3], await depositProbe.getAddress(), UNIT)

    await safety.connect(safetyCouncil).pause()
    await expect(depositProbe.connect(accounts[3]).deposit(0, UNIT))
      .to.be.revertedWithCustomError(safety, 'ProtocolIsPaused')
    await expect(market.connect(accounts[2]).fundListing(0))
      .to.be.revertedWithCustomError(safety, 'ProtocolIsPaused')
    await market.cancelListing(0)
    await vault.withdrawEmergency(0, 10n * UNIT)
    await networkHelpers.time.increaseTo(maturity)
    await vault.withdrawLocked(0)
    expect(await safety.totalOutstandingPrincipal()).to.equal(0n)
  })

  it('blocks only final group activation while paused and allows cooperative execution', async function () {
    const members = accounts.slice(2, 7)
    const enrollmentDeadline = BigInt(await networkHelpers.time.latest()) + 2n * DAY
    await factory.connect(members[0]).createPublicGroupVault(
      'Safety circle',
      20n * UNIT,
      1_000,
      5,
      enrollmentDeadline,
      maturity,
      0,
      true,
    )
    const vault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
    for (let index = 1; index < members.length; index += 1) {
      await vault.connect(members[index]).joinPublicGroup(20n * UNIT, 1_000)
    }
    await safety.connect(safetyCouncil).pause()
    await expect(vault.connect(members[4]).activateGroup())
      .to.be.revertedWithCustomError(safety, 'ProtocolIsPaused')
    await safety.connect(safetyCouncil).scheduleUnpause()
    await networkHelpers.time.increase(100)
    await safety.executeUnpause()
    await vault.connect(members[4]).activateGroup()

    for (let index = 0; index < members.length; index += 1) {
      await fund(members[index], await vault.getAddress(), 20n * UNIT)
      await vault.connect(members[index]).deposit(index, 20n * UNIT)
    }
    await vault.connect(members[0]).requestGroupExit()
    for (let index = 1; index < members.length; index += 1) {
      await vault.connect(members[index]).approveGroupExit(0)
    }
    await safety.connect(safetyCouncil).pause()
    await vault.connect(members[0]).completeGroupExit(0)
    expect(await vault.activeMemberCount()).to.equal(4n)
  })

  it('keeps already allocated reward claims available while paused', async function () {
    const vault = await personalVault()
    await fund(deployer, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    await fund(accounts[3], await rewardPool.getAddress(), 10n * UNIT)
    await rewardPool.connect(accounts[3]).fundVault(await vault.getAddress(), 10n * UNIT)
    await networkHelpers.time.increaseTo(maturity)
    await vault.activateRewards()
    await safety.connect(safetyCouncil).pause()
    await expect(rewardPool.claim()).to.emit(rewardPool, 'RewardClaimed')
  })

  it('prevents a paused Earn vault from supplying new locked funds', async function () {
    const adapterFactory = await ethers.deployContract('MockYieldAdapterFactory', [
      await token.getAddress(),
      31_337,
      0,
    ])
    const { factory: earnFactory, safetyController: earnSafety } =
      await deployFactory(
        ethers,
        [
          await token.getAddress(),
          await accounts[8].getAddress(),
          await accounts[9].getAddress(),
          ethers.ZeroAddress,
          ethers.ZeroAddress,
          31_337,
          await adapterFactory.getAddress(),
        ],
        await safetyCouncil.getAddress(),
      )
    await earnFactory.createPersonalVault(100n * UNIT, maturity, 1_000, 1)
    const vault = await ethers.getContractAt(
      'SavingsVault',
      await earnFactory.vaultAt(0),
    )
    const adapter = await ethers.getContractAt(
      'MockYieldAdapter',
      await vault.yieldAdapter(),
    )
    await fund(deployer, await vault.getAddress(), 20n * UNIT)
    await vault.deposit(0, 10n * UNIT)
    const suppliedBeforePause = await adapter.totalAssets()

    await earnSafety.connect(safetyCouncil).pause()
    await expect(vault.deposit(0, 10n * UNIT))
      .to.be.revertedWithCustomError(earnSafety, 'ProtocolIsPaused')
    expect(await adapter.totalAssets()).to.equal(suppliedBeforePause)
  })

  it('accepts exposure updates only from factory-registered vaults', async function () {
    await expect(safety.recordDeposit(0, UNIT))
      .to.be.revertedWithCustomError(safety, 'VaultOnly')
    await expect(safety.recordWithdrawal(UNIT))
      .to.be.revertedWithCustomError(safety, 'VaultOnly')
  })

  it('enforces position, vault and protocol caps from net outstanding principal', async function () {
    const first = await personalVault(deployer, 200n * UNIT)
    await fund(deployer, await first.getAddress(), 101n * UNIT)
    await first.deposit(0, 100n * UNIT)
    await expect(first.deposit(0, UNIT))
      .to.be.revertedWithCustomError(safety, 'ExposureCapExceeded')

    const { vault: group, members } = await activeGroup(4)
    await fund(members[0], await group.getAddress(), 100n * UNIT)
    await fund(members[1], await group.getAddress(), 51n * UNIT)
    await group.connect(members[0]).deposit(0, 100n * UNIT)
    await group.connect(members[1]).deposit(1, 50n * UNIT)
    await expect(group.connect(members[1]).deposit(1, UNIT))
      .to.be.revertedWithCustomError(safety, 'ExposureCapExceeded')
    expect(await safety.totalOutstandingPrincipal()).to.equal(250n * UNIT)

    const finalVault = await personalVault(accounts[7])
    await fund(accounts[7], await finalVault.getAddress(), UNIT)
    await expect(finalVault.connect(accounts[7]).deposit(0, UNIT))
      .to.be.revertedWithCustomError(safety, 'ExposureCapExceeded')
  })

  it('timelocks cap changes and lets withdrawals reduce exposure below a lowered cap', async function () {
    const vault = await personalVault()
    await fund(deployer, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    await expect(safety.scheduleCaps(50n * UNIT, 100n * UNIT, 150n * UNIT))
      .to.be.revertedWithCustomError(safety, 'SafetyCouncilOnly')
    await safety
      .connect(safetyCouncil)
      .scheduleCaps(40n * UNIT, 50n * UNIT, 50n * UNIT)
    await expect(safety.executeCaps())
      .to.be.revertedWithCustomError(safety, 'TimelockNotReady')
    await networkHelpers.time.increase(100)
    await safety.executeCaps()
    await expect(vault.deposit(0, 1n))
      .to.be.revertedWithCustomError(safety, 'ExposureCapExceeded')
    await vault.withdrawEmergency(0, 10n * UNIT)
    expect(await safety.totalOutstandingPrincipal()).to.equal(90n * UNIT)
  })

  it('does not change principal exposure when a market claim changes owner', async function () {
    const vault = await personalVault()
    await fund(deployer, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    const before = await safety.totalOutstandingPrincipal()
    const quote = await market.referenceDiscount(await vault.getAddress(), 0)
    const payout = await market.payoutFor(await vault.positionValue(0), quote.discountBps)
    await market.createListing(await vault.getAddress(), 0, maturity, payout)
    const fee = await market.feeFor(payout)
    await fund(accounts[2], await market.getAddress(), payout + fee)
    await market.connect(accounts[2]).fundListing(0)
    expect(await safety.totalOutstandingPrincipal()).to.equal(before)
  })

  it('maintains exposure invariants across repeated deposits and both withdrawal paths', async function () {
    const owners = [deployer, accounts[2], accounts[3]]
    const vaults = []
    for (const owner of owners) {
      const vault = await personalVault(owner)
      vaults.push(vault)
      await fund(owner, await vault.getAddress(), 80n * UNIT)
    }

    for (let round = 0; round < 8; round += 1) {
      for (let index = 0; index < vaults.length; index += 1) {
        await vaults[index].connect(owners[index]).deposit(0, 10n * UNIT)
        if (round % 2 === 1) {
          await vaults[index]
            .connect(owners[index])
            .withdrawEmergency(0, 2n * UNIT)
        }
      }
      const principals = await Promise.all(
        vaults.map((vault) => vault.activePrincipalSavings(0)),
      )
      for (let index = 0; index < vaults.length; index += 1) {
        expect(
          await safety.vaultOutstandingPrincipal(await vaults[index].getAddress()),
        ).to.equal(principals[index])
      }
      expect(await safety.totalOutstandingPrincipal()).to.equal(
        principals.reduce((total, value) => total + value, 0n),
      )
    }

    await networkHelpers.time.increaseTo(maturity)
    for (let index = 0; index < vaults.length; index += 1) {
      await vaults[index].connect(owners[index]).withdrawLocked(0)
      const emergency = (await vaults[index].position(0)).emergencyBalance
      if (emergency > 0n) {
        await vaults[index]
          .connect(owners[index])
          .withdrawEmergency(0, emergency)
      }
    }
    expect(await safety.totalOutstandingPrincipal()).to.equal(0n)
  })
})
