import { expect } from 'chai'
import { network } from 'hardhat'

const UNIT = 10n ** 6n
const RAY = 10n ** 27n

describe('EarlyExitMarket deterministic pricing', function () {
  let ethers
  let networkHelpers
  let saver
  let providerOne
  let providerTwo
  let outsider
  let riskReserve
  let maintenanceTreasury
  let token
  let factory
  let vault
  let market
  let rewardPool
  let maturity

  beforeEach(async function () {
    ;({ ethers, networkHelpers } = await network.create())
    ;[saver, providerOne, providerTwo, outsider, riskReserve, maintenanceTreasury] = await ethers.getSigners()
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
    maturity = BigInt(await networkHelpers.time.latest()) + 365n * 24n * 60n * 60n
    await factory.createPersonalVault(100n * UNIT, maturity, 1_000, 0)
    vault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
    market = await ethers.getContractAt('EarlyExitMarket', await factory.earlyExitMarket())
    rewardPool = await ethers.getContractAt('RewardPool', await factory.rewardPool())
    await token.mint(await saver.getAddress(), 100n * UNIT)
    await token.approve(await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
  })

  async function currentQuote(targetMarket = market, targetVault = vault) {
    const claimValue = await targetVault.positionValue(0)
    const reference = await targetMarket.referenceDiscount(await targetVault.getAddress(), 0)
    const saverPayout = await targetMarket.payoutFor(claimValue, reference.discountBps)
    const providerFee = await targetMarket.feeFor(saverPayout)
    return { claimValue, reference, saverPayout, providerFee }
  }

  async function createListing(minimumPayout, expiresAt = maturity) {
    const quote = await currentQuote()
    await market.createListing(
      await vault.getAddress(),
      0,
      expiresAt,
      minimumPayout ?? quote.saverPayout,
    )
    return quote
  }

  async function fundProvider(account, payout, fee) {
    await token.mint(await account.getAddress(), payout + fee)
    await token.connect(account).approve(await market.getAddress(), payout + fee)
  }

  it('clamps deterministic discounts to 4.5% through 8%', async function () {
    const result = await market.referenceDiscount(await vault.getAddress(), 0)
    expect(result.discountBps).to.be.gte(450)
    expect(result.discountBps).to.be.lte(800)
    await expect(market.payoutFor(UNIT, 449)).to.revert(ethers)
    await expect(market.payoutFor(UNIT, 801)).to.revert(ethers)
  })

  it('records every required listing quote field and no provider-selected price', async function () {
    const quote = await currentQuote()
    await expect(market.createListing(await vault.getAddress(), 0, maturity, quote.saverPayout))
      .to.emit(market, 'ListingCreated')

    const listing = await market.listings(0)
    expect(listing.claimValue).to.equal(quote.claimValue)
    expect(listing.systemDiscountBps).to.equal(quote.reference.discountBps)
    expect(listing.saverPayout).to.equal(quote.saverPayout)
    expect(listing.providerPotentialReturn).to.equal(quote.claimValue - quote.saverPayout)
    expect(listing.providerFee).to.equal(quote.providerFee)
    expect(listing.minimumPayout).to.equal(quote.saverPayout)
    expect(listing.expiresAt).to.equal(maturity)
  })

  it('rejects a saver minimum above the current system payout', async function () {
    const quote = await currentQuote()
    await expect(
      market.createListing(await vault.getAddress(), 0, maturity, quote.saverPayout + 1n),
    ).to.be.revertedWithCustomError(market, 'InvalidMinimumPayout')
  })

  it('gives a consistent near-maturity saver a rate close to the 4.5% base', async function () {
    const now = BigInt(await networkHelpers.time.latest())
    const regularMaturity = now + 365n * 24n * 60n * 60n
    await factory.createPersonalVault(120n * UNIT, regularMaturity, 1_000, 0)
    const regularVault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(1))
    await token.mint(await saver.getAddress(), 120n * UNIT)
    await token.approve(await regularVault.getAddress(), 120n * UNIT)

    // Twelve evenly spaced contributions provide objective regularity history.
    for (let month = 0; month < 12; month += 1) {
      await regularVault.deposit(0, 10n * UNIT)
      if (month < 11) await networkHelpers.time.increase(30n * 24n * 60n * 60n)
    }
    await networkHelpers.time.increaseTo(regularMaturity - 24n * 60n * 60n)
    const result = await market.referenceDiscount(await regularVault.getAddress(), 0)
    expect(result.discountBps).to.be.gte(450)
    expect(result.discountBps).to.be.lte(455)
    expect(result.commitmentPenalty).to.be.lte(5)
  })

  it('charges a higher commitment penalty for under-saving, irregularity and inactivity', async function () {
    const now = BigInt(await networkHelpers.time.latest())
    const poorMaturity = now + 365n * 24n * 60n * 60n
    await factory.createPersonalVault(100n * UNIT, poorMaturity, 1_000, 0)
    const poorVault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(1))
    await token.mint(await saver.getAddress(), UNIT)
    await token.approve(await poorVault.getAddress(), UNIT)
    await poorVault.deposit(0, UNIT)
    const initial = await market.referenceDiscount(await poorVault.getAddress(), 0)

    await networkHelpers.time.increase(120n * 24n * 60n * 60n)
    const overdue = await market.referenceDiscount(await poorVault.getAddress(), 0)
    expect(overdue.timeWeightedSavingsPenalty).to.be.greaterThan(0)
    expect(overdue.goalCompletionPenalty).to.be.greaterThan(0)
    expect(overdue.regularityPenalty).to.be.greaterThan(0)
    expect(overdue.recencyPenalty).to.be.greaterThan(0)
    expect(overdue.commitmentPenalty).to.be.greaterThan(initial.commitmentPenalty)
    expect(overdue.discountBps).to.be.greaterThan(450)
  })

  it('maps the objective Aave liquidity-rate proxy into 0 through 75 basis points', async function () {
    const aToken = await ethers.deployContract('MockAToken', [await token.getAddress()])
    const pool = await ethers.deployContract('MockAavePool', [await token.getAddress(), await aToken.getAddress()])
    await aToken.bindPool(await pool.getAddress())
    const earnFactory = await ethers.deployContract('VaultFactory', [
      await token.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
      await pool.getAddress(),
      await aToken.getAddress(),
      31_337,
      ethers.ZeroAddress,
    ])
    await earnFactory.createPersonalVault(100n * UNIT, maturity, 1_000, 1)
    const earnVault = await ethers.getContractAt('SavingsVault', await earnFactory.vaultAt(0))
    const earnMarket = await ethers.getContractAt('EarlyExitMarket', await earnFactory.earlyExitMarket())
    await token.mint(await saver.getAddress(), 100n * UNIT)
    await token.approve(await earnVault.getAddress(), 100n * UNIT)
    await earnVault.deposit(0, 100n * UNIT)

    expect((await earnMarket.referenceDiscount(await earnVault.getAddress(), 0)).liquidityRiskPenalty).to.equal(0)
    await pool.setLiquidityRate(15n * RAY / 100n)
    expect((await earnMarket.referenceDiscount(await earnVault.getAddress(), 0)).liquidityRiskPenalty).to.equal(75)
  })

  it('calculates and distributes the 0.9% provider fee as 60/20/20', async function () {
    const quote = await createListing()
    await fundProvider(providerOne, quote.saverPayout, quote.providerFee)
    const riskBefore = await token.balanceOf(await riskReserve.getAddress())
    const maintenanceBefore = await token.balanceOf(await maintenanceTreasury.getAddress())

    await market.connect(providerOne).fundListing(0)

    const rewardShare = quote.providerFee * 60n / 100n
    const riskShare = quote.providerFee * 20n / 100n
    expect(await rewardPool.protocolRevenue()).to.equal(rewardShare)
    expect((await token.balanceOf(await riskReserve.getAddress())) - riskBefore).to.equal(riskShare)
    expect((await token.balanceOf(await maintenanceTreasury.getAddress())) - maintenanceBefore)
      .to.equal(quote.providerFee - rewardShare - riskShare)
  })

  it('lets the first successful provider atomically fund and own the full claim', async function () {
    const quote = await createListing()
    await fundProvider(providerOne, quote.saverPayout, quote.providerFee)
    await fundProvider(providerTwo, quote.saverPayout, quote.providerFee)

    await market.connect(providerOne).fundListing(0)
    expect(await vault.positionOwner(0)).to.equal(await providerOne.getAddress())
    expect(await token.balanceOf(await saver.getAddress())).to.equal(quote.saverPayout)
    await expect(market.connect(providerTwo).fundListing(0)).to.be.revertedWithCustomError(market, 'ListingUnavailable')
  })

  it('safely reverts when a provider revokes allowance before funding', async function () {
    const quote = await createListing()
    await fundProvider(providerOne, quote.saverPayout, quote.providerFee)
    await token.connect(providerOne).approve(await market.getAddress(), 0)

    await expect(market.connect(providerOne).fundListing(0)).to.revert(ethers)
    expect((await market.listings(0)).active).to.equal(true)
    expect(await vault.positionOwner(0)).to.equal(await saver.getAddress())
  })

  it('recalculates settlement and protects the saver minimum payout', async function () {
    const aToken = await ethers.deployContract('MockAToken', [await token.getAddress()])
    const pool = await ethers.deployContract('MockAavePool', [await token.getAddress(), await aToken.getAddress()])
    await aToken.bindPool(await pool.getAddress())
    const earnFactory = await ethers.deployContract('VaultFactory', [
      await token.getAddress(), await riskReserve.getAddress(), await maintenanceTreasury.getAddress(),
      await pool.getAddress(), await aToken.getAddress(), 31_337, ethers.ZeroAddress,
    ])
    await earnFactory.createPersonalVault(100n * UNIT, maturity, 1_000, 1)
    const earnVault = await ethers.getContractAt('SavingsVault', await earnFactory.vaultAt(0))
    const earnMarket = await ethers.getContractAt('EarlyExitMarket', await earnFactory.earlyExitMarket())
    await token.mint(await saver.getAddress(), 100n * UNIT)
    await token.approve(await earnVault.getAddress(), 100n * UNIT)
    await earnVault.deposit(0, 100n * UNIT)
    const initial = await currentQuote(earnMarket, earnVault)
    await earnMarket.createListing(await earnVault.getAddress(), 0, maturity, initial.saverPayout)

    // Raising the live Aave rate increases the deterministic risk penalty at settlement.
    await pool.setLiquidityRate(15n * RAY / 100n)
    await token.mint(await providerOne.getAddress(), initial.claimValue)
    await token.connect(providerOne).approve(await earnMarket.getAddress(), initial.claimValue)
    await expect(earnMarket.connect(providerOne).fundListing(0))
      .to.be.revertedWithCustomError(earnMarket, 'MinimumPayoutNotMet')
    expect((await earnMarket.listings(0)).active).to.equal(true)
  })

  it('keeps emergency funds with the saver and the locked claim with the buyer', async function () {
    const quote = await createListing()
    await fundProvider(providerOne, quote.saverPayout, quote.providerFee)
    await market.connect(providerOne).fundListing(0)
    await expect(vault.connect(providerOne).withdrawEmergency(0, UNIT)).to.be.revertedWithCustomError(vault, 'MemberOnly')
    await vault.withdrawEmergency(0, 10n * UNIT)

    await networkHelpers.time.increaseTo(maturity)
    await expect(vault.withdrawLocked(0)).to.be.revertedWithCustomError(vault, 'PositionOwnerOnly')
    await vault.connect(providerOne).withdrawLocked(0)
  })

  it('supports cancellation, expiry and relisting with a newly calculated quote', async function () {
    const now = BigInt(await networkHelpers.time.latest())
    const quote = await createListing(undefined, now + 100n)
    await market.cancelListing(0)
    await market.createListing(await vault.getAddress(), 0, now + 200n, quote.saverPayout)
    await networkHelpers.time.increaseTo(now + 201n)
    const nextQuote = await currentQuote()
    await expect(market.createListing(await vault.getAddress(), 0, now + 300n, nextQuote.saverPayout))
      .to.emit(market, 'ListingExpired')
      .withArgs(1n)
    expect((await market.listings(2)).active).to.equal(true)
  })

  it('rejects unauthorized transfers, sales after maturity and double sales', async function () {
    const quote = await createListing()
    await expect(
      vault.connect(outsider).transferPosition(0, await saver.getAddress(), await outsider.getAddress()),
    ).to.be.revertedWithCustomError(vault, 'MarketOnly')
    await fundProvider(providerOne, quote.saverPayout, quote.providerFee)
    await market.connect(providerOne).fundListing(0)
    await expect(market.connect(providerTwo).fundListing(0)).to.be.revertedWithCustomError(market, 'ListingUnavailable')
    await networkHelpers.time.increaseTo(maturity)
    await expect(
      market.connect(providerOne).createListing(await vault.getAddress(), 0, maturity + 1n, UNIT),
    ).to.revert(ethers)
  })

  it('rolls back atomically when a malicious ERC-20 returns false', async function () {
    const badToken = await ethers.deployContract('FalseReturnUSDT')
    const badFactory = await ethers.deployContract('VaultFactory', [
      await badToken.getAddress(), await riskReserve.getAddress(), await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress, ethers.ZeroAddress, 31_337, ethers.ZeroAddress,
    ])
    await badFactory.createPersonalVault(100n * UNIT, maturity, 1_000, 0)
    const badVault = await ethers.getContractAt('SavingsVault', await badFactory.vaultAt(0))
    const badMarket = await ethers.getContractAt('EarlyExitMarket', await badFactory.earlyExitMarket())
    await badToken.mint(await saver.getAddress(), 100n * UNIT)
    await badToken.approve(await badVault.getAddress(), 100n * UNIT)
    await badVault.deposit(0, 100n * UNIT)
    const quote = await currentQuote(badMarket, badVault)
    await badMarket.createListing(await badVault.getAddress(), 0, maturity, quote.saverPayout)
    await badToken.mint(await providerOne.getAddress(), quote.saverPayout + quote.providerFee)
    await badToken.connect(providerOne).approve(await badMarket.getAddress(), quote.saverPayout + quote.providerFee)
    await badToken.setFailTransfersFrom(true)

    await expect(badMarket.connect(providerOne).fundListing(0)).to.revert(ethers)
    expect(await badVault.positionOwner(0)).to.equal(await saver.getAddress())
    expect((await badMarket.listings(0)).active).to.equal(true)
  })

  it('blocks callback reentrancy while completing the original sale', async function () {
    const callbackToken = await ethers.deployContract('CallbackUSDT')
    const sellerContract = await ethers.deployContract('ReentrantMarketSeller')
    const callbackFactory = await ethers.deployContract('VaultFactory', [
      await callbackToken.getAddress(), await riskReserve.getAddress(), await maintenanceTreasury.getAddress(),
      ethers.ZeroAddress, ethers.ZeroAddress, 31_337, ethers.ZeroAddress,
    ])
    const callbackMarket = await ethers.getContractAt('EarlyExitMarket', await callbackFactory.earlyExitMarket())
    await callbackFactory.createGroupVault(
      [await saver.getAddress(), await sellerContract.getAddress()],
      [UNIT, 100n * UNIT], [1_000, 1_000], maturity, 0,
    )
    const callbackVault = await ethers.getContractAt('SavingsVault', await callbackFactory.vaultAt(0))
    await sellerContract.configure(await callbackVault.getAddress(), await callbackToken.getAddress(), await callbackMarket.getAddress())
    await callbackToken.mint(await sellerContract.getAddress(), 100n * UNIT)
    await sellerContract.deposit(1, 100n * UNIT)
    const claim = await callbackVault.positionValue(1)
    const reference = await callbackMarket.referenceDiscount(await callbackVault.getAddress(), 1)
    const payout = await callbackMarket.payoutFor(claim, reference.discountBps)
    const fee = await callbackMarket.feeFor(payout)
    await sellerContract.list(1, maturity, payout)
    await callbackToken.mint(await providerOne.getAddress(), payout + fee)
    await callbackToken.connect(providerOne).approve(await callbackMarket.getAddress(), payout + fee)
    await callbackToken.setCallbacksEnabled(true)

    await callbackMarket.connect(providerOne).fundListing(0)
    expect(await sellerContract.reentrySucceeded()).to.equal(false)
    expect(await callbackVault.positionOwner(1)).to.equal(await providerOne.getAddress())
  })
})
