import { expect } from 'chai'
import { network } from 'hardhat'
import { polygonAaveConfig } from '../scripts/polygon-aave-config.js'
import { createActivatedGroup, deployFactory } from './helpers/deploy-factory.js'

const UNIT = 10n ** 6n
const RAY = 10n ** 27n

describe('LockedIn Circle Phase 2B', function () {
  let ethers
  let networkHelpers
  let saver
  let memberTwo
  let buyer
  let outsider
  let riskReserve
  let maintenanceTreasury
  let token
  let aToken
  let pool
  let factory
  let market
  let maturity

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    ;[saver, memberTwo, buyer, outsider, riskReserve, maintenanceTreasury] =
      await ethers.getSigners()
    token = await ethers.deployContract('MockUSDT')
    aToken = await ethers.deployContract('MockAToken', [
      await token.getAddress(),
    ])
    pool = await ethers.deployContract('MockAavePool', [
      await token.getAddress(),
      await aToken.getAddress(),
    ])
    await aToken.bindPool(await pool.getAddress())
    ;({ factory } = await deployFactory(ethers, [
      await token.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      await pool.getAddress(),
      await aToken.getAddress(),
      31_337,
      ethers.ZeroAddress,
    ], await riskReserve.getAddress()))
    market = await ethers.getContractAt(
      'EarlyExitMarket',
      await factory.earlyExitMarket()
    )
    maturity =
      BigInt(await networkHelpers.time.latest()) + 365n * 24n * 60n * 60n
  })

  async function createVault(
    mode = 1,
    target = 100n * UNIT,
    emergencyBps = 1_000
  ) {
    await factory.createPersonalVault(target, maturity, emergencyBps, mode)
    return ethers.getContractAt(
      'SavingsVault',
      await factory.vaultAt((await factory.vaultCount()) - 1n)
    )
  }

  async function createGroupVault() {
    const groupSigners = [saver, memberTwo, buyer, outsider]
    return createActivatedGroup(
      ethers, factory, groupSigners, groupSigners.map(() => 100n * UNIT),
      groupSigners.map(() => 1_000), maturity, 1,
    )
  }

  async function fundAndApprove(account, spender, amount) {
    await token.mint(await account.getAddress(), amount)
    await token.connect(account).approve(spender, amount)
  }

  async function accrue(adapter, amount) {
    await token.mint(await pool.getAddress(), amount)
    await aToken.accrueYield(adapter, amount)
  }

  it('loads Polygon Pool, USDT and aUSDT from the maintained Aave address book', async function () {
    expect(polygonAaveConfig).to.deep.equal({
      chainId: 137,
      pool: '0x794a61358D6845594F94dc1DB02A252b5b4814aD',
      usdt: '0xc2132D05D31c914a87C6611C10748AEb04B58e8F',
      aUsdt: '0x6ab707Aca953eDAeFBc4fD23bA73294241490620',
      decimals: 6,
    })
  })

  it('creates immutable Safe and Earn vault modes with one isolated adapter per Earn vault', async function () {
    const safe = await createVault(0)
    const earn = await createVault(1)
    const secondEarn = await createVault(1)
    expect(await safe.mode()).to.equal(0n)
    expect(await safe.yieldAdapter()).to.equal(ethers.ZeroAddress)
    expect(await earn.mode()).to.equal(1n)
    expect(await earn.yieldAdapter()).not.to.equal(ethers.ZeroAddress)
    expect(await secondEarn.yieldAdapter()).not.to.equal(
      await earn.yieldAdapter()
    )
    const adapter = await ethers.getContractAt(
      'AaveYieldAdapter',
      await earn.yieldAdapter()
    )
    expect(await adapter.vault()).to.equal(await earn.getAddress())
  })

  it('binds an immutable deployment fingerprint to the complete protocol graph', async function () {
    const version = await factory.PROTOCOL_VERSION()
    const expected = ethers.keccak256(
      ethers.AbiCoder.defaultAbiCoder().encode(
        ['string', 'uint256', 'address', 'address', 'address', 'address', 'address'],
        [
          version,
          31_337,
          await factory.getAddress(),
          await factory.asset(),
          await factory.earlyExitMarket(),
          await factory.rewardPool(),
          await factory.safetyController(),
        ]
      )
    )
    expect(await factory.deploymentChainId()).to.equal(31_337n)
    expect(await factory.deploymentId()).to.equal(expected)
  })

  it('rejects a factory configured for a different chain', async function () {
    await expect(
      deployFactory(ethers, [
        await token.getAddress(),
        await riskReserve.getAddress(),
        await maintenanceTreasury.getAddress(),
        await pool.getAddress(),
        await aToken.getAddress(),
        137,
        ethers.ZeroAddress,
      ], await riskReserve.getAddress())
    ).to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
  })

  it('never supplies emergency funds to Aave and disables collateral use', async function () {
    const vault = await createVault(1, 100n * UNIT, 1_200)
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    const adapterAddress = await vault.yieldAdapter()
    const position = await vault.position(0)
    expect(position.emergencyBalance).to.equal(12n * UNIT)
    expect(await token.balanceOf(await vault.getAddress())).to.equal(12n * UNIT)
    expect(await aToken.balanceOf(adapterAddress)).to.equal(88n * UNIT)
    expect(await pool.collateralEnabled(adapterAddress)).to.equal(false)
  })

  it('mints shares and handles deposits at different exchange rates', async function () {
    const vault = await createVault(1, 200n * UNIT)
    await fundAndApprove(saver, await vault.getAddress(), 200n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    const adapterAddress = await vault.yieldAdapter()
    const adapter = await ethers.getContractAt(
      'AaveYieldAdapter',
      adapterAddress
    )
    expect((await vault.position(0)).lockedShares).to.equal(90n * UNIT)
    await accrue(adapterAddress, 9n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    const position = await vault.position(0)
    expect(position.lockedShares).to.equal(90n * UNIT + 81_818_181n)
    expect(await vault.positionValue(0)).to.be.closeTo(189n * UNIT, 2n)
    expect(await vault.accruedYield(0)).to.be.closeTo(9n * UNIT, 2n)
    expect(await adapter.totalShares()).to.equal(position.lockedShares)
  })

  it('distributes yield proportionally between group members', async function () {
    const vault = await createGroupVault()
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await fundAndApprove(memberTwo, await vault.getAddress(), 50n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    await vault.connect(memberTwo).deposit(1, 50n * UNIT)
    await accrue(await vault.yieldAdapter(), 27n * UNIT)
    expect(await vault.positionValue(0)).to.equal(108n * UNIT)
    expect(await vault.positionValue(1)).to.equal(54n * UNIT)
    expect(await vault.accruedYield(0)).to.equal(18n * UNIT)
    expect(await vault.accruedYield(1)).to.equal(9n * UNIT)
  })

  it('floors accrued yield at zero when assets fall below principal without arithmetic underflow', async function () {
    const vault = await createVault()
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    const adapter = await vault.yieldAdapter()
    await aToken.slash(adapter, 9n * UNIT)
    expect(await vault.positionValue(0)).to.equal(81n * UNIT)
    expect(await vault.accruedYield(0)).to.equal(0n)
  })

  it('rejects new shares if an external loss makes an outstanding adapter insolvent', async function () {
    const vault = await createVault()
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    await aToken.slash(await vault.yieldAdapter(), 90n * UNIT)
    await token.mint(await saver.getAddress(), 10n * UNIT)
    await token.approve(await vault.getAddress(), 10n * UNIT)
    await expect(vault.deposit(0, 10n * UNIT)).to.revert(ethers)
  })

  it('prices early exit from current assets and transfers shares plus future yield to the buyer', async function () {
    const vault = await createVault()
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    const adapter = await vault.yieldAdapter()
    await accrue(adapter, 9n * UNIT)
    const listingReference = await market.referenceDiscount(
      await vault.getAddress(),
      0
    )
    const listingPayout = await market.payoutFor(
      await vault.positionValue(0),
      listingReference.discountBps
    )
    await market.createListing(
      await vault.getAddress(),
      0,
      maturity,
      listingPayout
    )
    const listing = await market.listings(0)
    await accrue(adapter, 9n * UNIT)
    const currentValue = await vault.positionValue(0)
    const settlementReference = await market.referenceDiscount(
      await vault.getAddress(),
      0
    )
    const receipt = await market.payoutFor(
      currentValue,
      settlementReference.discountBps
    )
    const fee = await market.feeFor(receipt)
    await fundAndApprove(buyer, await market.getAddress(), receipt + fee)
    await market.connect(buyer).fundListing(0)
    expect(await token.balanceOf(await saver.getAddress())).to.equal(receipt)
    expect(await vault.positionOwner(0)).to.equal(await buyer.getAddress())
    expect(currentValue).to.be.greaterThan(listing.claimValue)

    await accrue(adapter, 9n * UNIT)
    const buyerValue = await vault.positionValue(0)
    await networkHelpers.time.increaseTo(maturity)
    const before = await token.balanceOf(await buyer.getAddress())
    await vault.connect(buyer).withdrawLocked(0)
    expect((await token.balanceOf(await buyer.getAddress())) - before).to.equal(
      buyerValue
    )
  })

  it('redeems principal and yield at maturity and prevents a double withdrawal', async function () {
    const vault = await createVault()
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    await accrue(await vault.yieldAdapter(), 9n * UNIT)
    await networkHelpers.time.increaseTo(maturity)
    const before = await token.balanceOf(await saver.getAddress())
    await vault.withdrawLocked(0)
    expect((await token.balanceOf(await saver.getAddress())) - before).to.equal(
      99n * UNIT
    )
    expect((await vault.position(0)).lockedShares).to.equal(0n)
    await expect(vault.withdrawLocked(0)).to.be.revertedWithCustomError(
      vault,
      'NothingToWithdraw'
    )
  })

  it('preserves shares and withdrawal state when Aave redemption fails, then allows retry', async function () {
    const vault = await createVault()
    await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
    const shares = (await vault.position(0)).lockedShares
    await networkHelpers.time.increaseTo(maturity)
    await pool.setFailWithdrawals(true)
    await expect(vault.withdrawLocked(0)).to.be.revertedWithCustomError(
      pool,
      'WithdrawalUnavailable'
    )
    expect((await vault.position(0)).lockedShares).to.equal(shares)
    expect((await vault.position(0)).lockedWithdrawn).to.equal(false)
    await pool.setFailWithdrawals(false)
    await vault.withdrawLocked(0)
    expect((await vault.position(0)).lockedWithdrawn).to.equal(true)
  })

  it('rejects unauthorized adapter deposits, withdrawals and rebinding', async function () {
    const vault = await createVault()
    const adapter = await ethers.getContractAt(
      'AaveYieldAdapter',
      await vault.yieldAdapter()
    )
    await expect(
      adapter.connect(outsider).deposit(UNIT)
    ).to.be.revertedWithCustomError(adapter, 'VaultOnly')
    await expect(
      adapter.connect(outsider).withdraw(UNIT, await outsider.getAddress())
    ).to.be.revertedWithCustomError(adapter, 'VaultOnly')
    await expect(
      adapter.bindVault(await outsider.getAddress())
    ).to.be.revertedWithCustomError(adapter, 'FactoryOnly')
  })

  for (const state of ['paused', 'frozen']) {
    it(`safely reverts an Earn deposit when the Aave reserve is ${state}`, async function () {
      const vault = await createVault()
      await fundAndApprove(saver, await vault.getAddress(), 100n * UNIT)
      if (state === 'paused') await pool.setPaused(true)
      else await pool.setFrozen(true)
      await expect(vault.deposit(0, 100n * UNIT)).to.revert(ethers)
      const position = await vault.position(0)
      expect(position.deposited).to.equal(0n)
      expect(position.emergencyBalance).to.equal(0n)
      expect(await token.balanceOf(await vault.getAddress())).to.equal(0n)
    })
  }

  it('validates chain, Pool, token, aToken underlying and six-decimal assumptions', async function () {
    await expect(
      ethers.deployContract('AaveYieldAdapter', [
        await token.getAddress(),
        await pool.getAddress(),
        await aToken.getAddress(),
        await saver.getAddress(),
        1,
      ])
    ).to.be.revertedWithCustomError(factory, 'InvalidConfiguration')
    await expect(
      ethers.deployContract('AaveYieldAdapter', [
        await token.getAddress(),
        await outsider.getAddress(),
        await aToken.getAddress(),
        await saver.getAddress(),
        31_337,
      ])
    ).to.revert(ethers)

    const wrongToken = await ethers.deployContract('WrongDecimalsToken')
    await expect(
      ethers.deployContract('AaveYieldAdapter', [
        await wrongToken.getAddress(),
        await pool.getAddress(),
        await aToken.getAddress(),
        await saver.getAddress(),
        31_337,
      ])
    ).to.revert(ethers)
    const wrongUnderlying = await ethers.deployContract(
      'WrongUnderlyingAToken',
      [await outsider.getAddress()]
    )
    await expect(
      ethers.deployContract('AaveYieldAdapter', [
        await token.getAddress(),
        await pool.getAddress(),
        await wrongUnderlying.getAddress(),
        await saver.getAddress(),
        31_337,
      ])
    ).to.revert(ethers)
    const wrongDecimals = await ethers.deployContract('WrongDecimalsAToken', [
      await token.getAddress(),
    ])
    await expect(
      ethers.deployContract('AaveYieldAdapter', [
        await token.getAddress(),
        await pool.getAddress(),
        await wrongDecimals.getAddress(),
        await saver.getAddress(),
        31_337,
      ])
    ).to.revert(ethers)
  })

  it('fuzzes share coverage across deposits and yield changes', async function () {
    const vault = await createVault(1, 1_000_000n * UNIT, 1_000)
    const adapter = await ethers.getContractAt(
      'AaveYieldAdapter',
      await vault.yieldAdapter()
    )
    const deposits = [
      1n * UNIT,
      7n * UNIT,
      31n * UNIT,
      101n * UNIT,
      997n * UNIT,
    ]
    await fundAndApprove(
      saver,
      await vault.getAddress(),
      deposits.reduce((sum, value) => sum + value, 0n)
    )
    for (const [index, amount] of deposits.entries()) {
      await vault.deposit(0, amount)
      if (index % 2 === 0)
        await accrue(await adapter.getAddress(), BigInt(index + 1) * UNIT)
      const shares = await adapter.totalShares()
      expect(await adapter.convertToAssets(shares)).to.equal(
        await adapter.totalAssets()
      )
      expect(await vault.totalLockedShares()).to.equal(shares)
      expect(await vault.isSolvent()).to.equal(true)
    }
  })

  it('exposes the current variable liquidity rate without representing it as guaranteed yield', async function () {
    await pool.setLiquidityRate((35n * RAY) / 1_000n)
    const vault = await createVault()
    expect(await vault.currentLiquidityRate()).to.equal((35n * RAY) / 1_000n)
  })

  it('exposes live Aave reserve controls without granting protocol authority', async function () {
    const vault = await createVault()
    const adapter = await ethers.getContractAt(
      'AaveYieldAdapter',
      await vault.yieldAdapter()
    )
    let status = await adapter.reserveStatus()
    expect(status.active).to.equal(true)
    expect(status.frozen).to.equal(false)
    expect(status.paused).to.equal(false)
    expect(status.supplyCap).to.equal(1_000_000n)

    await pool.setFrozen(true)
    await pool.setPaused(true)
    status = await adapter.reserveStatus()
    expect(status.frozen).to.equal(true)
    expect(status.paused).to.equal(true)
  })
})

describe('Polygon Amoy mock-yield configuration', function () {
  it('creates Safe and Earn vaults without deploying a fictitious Aave adapter', async function () {
    const { ethers, networkHelpers } = await network.create()
    const [saver, riskReserve, maintenanceTreasury, yieldFunder] =
      await ethers.getSigners()
    const token = await ethers.deployContract('MockUSDT')
    const adapterFactory = await ethers.deployContract(
      'MockYieldAdapterFactory',
      [await token.getAddress(), 31_337, (5n * RAY) / 100n]
    )
    const { factory } = await deployFactory(ethers, [
      await token.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress,
      ethers.ZeroAddress,
      31_337,
      await adapterFactory.getAddress(),
    ], await riskReserve.getAddress())
    const maturity =
      BigInt(await networkHelpers.time.latest()) + 30n * 24n * 60n * 60n

    await factory.createPersonalVault(100n * UNIT, maturity, 1_000, 0)
    await factory.createPersonalVault(100n * UNIT, maturity, 1_200, 1)
    const safeVault = await ethers.getContractAt(
      'SavingsVault',
      await factory.vaultAt(0)
    )
    const earnVault = await ethers.getContractAt(
      'SavingsVault',
      await factory.vaultAt(1)
    )
    expect(await safeVault.yieldAdapter()).to.equal(ethers.ZeroAddress)

    const adapter = await ethers.getContractAt(
      'MockYieldAdapter',
      await earnVault.yieldAdapter()
    )
    expect(await adapter.vault()).to.equal(await earnVault.getAddress())
    expect(await adapter.currentLiquidityRate()).to.equal((5n * RAY) / 100n)
    await token.mint(await saver.getAddress(), 100n * UNIT)
    await token.approve(await earnVault.getAddress(), 100n * UNIT)
    await earnVault.deposit(0, 100n * UNIT)
    expect((await earnVault.position(0)).emergencyBalance).to.equal(12n * UNIT)
    expect(await adapter.totalAssets()).to.equal(88n * UNIT)

    await token.mint(await yieldFunder.getAddress(), 8n * UNIT)
    await token
      .connect(yieldFunder)
      .approve(await adapter.getAddress(), 8n * UNIT)
    await adapter.connect(yieldFunder).fundYield(8n * UNIT)
    expect(await earnVault.positionValue(0)).to.equal(96n * UNIT)
    expect(await earnVault.accruedYield(0)).to.equal(8n * UNIT)
  })

  it('keeps mock adapter value movement vault-only and validates its chain', async function () {
    const { ethers } = await network.create()
    const [saver] = await ethers.getSigners()
    const token = await ethers.deployContract('MockUSDT')
    const wrongChainFactory = await ethers.deployContract(
      'MockYieldAdapterFactory',
      [await token.getAddress(), 80_002, 0]
    )
    await expect(wrongChainFactory.createAdapter()).to.revert(ethers)

    const adapterFactory = await ethers.deployContract(
      'MockYieldAdapterFactory',
      [await token.getAddress(), 31_337, 0]
    )
    await adapterFactory.createAdapter()
    const events = await adapterFactory.queryFilter(
      adapterFactory.filters.AdapterCreated
    )
    expect(events.length).to.equal(1)
    // A directly created unbound adapter rejects value movement from arbitrary callers.
    const adapterAddress = events[0].args.adapter
    const adapter = await ethers.getContractAt(
      'MockYieldAdapter',
      adapterAddress
    )
    await expect(
      adapter.connect(saver).deposit(UNIT)
    ).to.be.revertedWithCustomError(adapter, 'VaultOnly')
  })
})
