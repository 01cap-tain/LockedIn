import { expect } from 'chai'
import { network } from 'hardhat'

const UNIT = 10n ** 6n

describe('EarlyExitMarket', function () {
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
    ])
    maturity = BigInt(await networkHelpers.time.latest()) + 30n * 24n * 60n * 60n
    await factory.createPersonalVault(100n * UNIT, maturity, 1_000)
    vault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(0))
    market = await ethers.getContractAt('EarlyExitMarket', await factory.earlyExitMarket())
    rewardPool = await ethers.getContractAt('RewardPool', await factory.rewardPool())
    await token.mint(await saver.getAddress(), 100n * UNIT)
    await token.approve(await vault.getAddress(), 100n * UNIT)
    await vault.deposit(0, 100n * UNIT)
  })

  async function createListing(discount = 800, expiresAt = maturity) {
    await market.createListing(await vault.getAddress(), 0, discount, expiresAt)
    return 0n
  }

  async function submitOffer(listingId = 0n, signer = providerOne, discount = 500, expiresAt = maturity) {
    await market.connect(signer).submitOffer(listingId, discount, expiresAt)
    return (await market.offerCount(listingId)) - 1n
  }

  async function fundOffer(signer, discount = 500) {
    const positionValue = (await vault.position(0)).lockedBalance
    const sellerReceives = await market.claimValue(positionValue, discount)
    const fee = await market.feeFor(sellerReceives)
    await token.mint(await signer.getAddress(), sellerReceives + fee)
    await token.connect(signer).approve(await market.getAddress(), sellerReceives + fee)
    return { positionValue, sellerReceives, fee }
  }

  it('enforces the 4.5% to 8% discount boundaries', async function () {
    await expect(market.createListing(await vault.getAddress(), 0, 449, maturity)).to.be.revertedWithCustomError(market, 'InvalidDiscount')
    await expect(market.createListing(await vault.getAddress(), 0, 801, maturity)).to.be.revertedWithCustomError(market, 'InvalidDiscount')
    await (await market.createListing(await vault.getAddress(), 0, 450, maturity)).wait()

    await expect(market.connect(providerOne).submitOffer(0, 449, maturity)).to.be.revertedWithCustomError(market, 'InvalidDiscount')
    await expect(market.connect(providerOne).submitOffer(0, 801, maturity)).to.be.revertedWithCustomError(market, 'InvalidDiscount')
  })

  it('calculates and distributes the 0.9% provider fee as 60/20/20', async function () {
    await createListing()
    await submitOffer()
    const { sellerReceives, fee } = await fundOffer(providerOne)
    const riskBefore = await token.balanceOf(await riskReserve.getAddress())
    const maintenanceBefore = await token.balanceOf(await maintenanceTreasury.getAddress())

    await market.acceptOffer(0, 0)

    const rewardShare = fee * 60n / 100n
    const riskShare = fee * 20n / 100n
    expect(await rewardPool.protocolRevenue()).to.equal(rewardShare)
    expect((await token.balanceOf(await riskReserve.getAddress())) - riskBefore).to.equal(riskShare)
    expect((await token.balanceOf(await maintenanceTreasury.getAddress())) - maintenanceBefore).to.equal(fee - rewardShare - riskShare)
    expect(await token.balanceOf(await saver.getAddress())).to.equal(sellerReceives)
  })

  it('atomically exchanges payment for full position ownership', async function () {
    await createListing()
    await submitOffer()
    const { sellerReceives } = await fundOffer(providerOne)

    await market.acceptOffer(0, 0)

    expect(await vault.positionOwner(0)).to.equal(await providerOne.getAddress())
    expect(await token.balanceOf(await saver.getAddress())).to.equal(sellerReceives)
    expect(await market.positionSold(await vault.getAddress(), 0)).to.equal(true)
    expect((await market.listings(0)).active).to.equal(false)
  })

  it('lets only the purchased position owner withdraw the locked claim at maturity', async function () {
    await createListing()
    await submitOffer()
    const { positionValue } = await fundOffer(providerOne)
    await market.acceptOffer(0, 0)
    await networkHelpers.time.increaseTo(maturity)

    await expect(vault.withdrawLocked(0)).to.be.revertedWithCustomError(vault, 'PositionOwnerOnly')
    const before = await token.balanceOf(await providerOne.getAddress())
    await vault.connect(providerOne).withdrawLocked(0)
    expect((await token.balanceOf(await providerOne.getAddress())) - before).to.equal(positionValue)
    await expect(vault.connect(providerOne).withdrawLocked(0)).to.be.revertedWithCustomError(vault, 'NothingToWithdraw')
  })

  it('leaves emergency funds withdrawable only by the original saver', async function () {
    await createListing()
    await submitOffer()
    await fundOffer(providerOne)
    await market.acceptOffer(0, 0)

    await expect(vault.connect(providerOne).withdrawEmergency(0, UNIT)).to.be.revertedWithCustomError(vault, 'MemberOnly')
    await vault.withdrawEmergency(0, 10n * UNIT)
    expect((await vault.position(0)).emergencyBalance).to.equal(0n)
  })

  it('rejects expired and cancelled listings and offers', async function () {
    const soon = BigInt(await networkHelpers.time.latest()) + 100n
    await createListing(800, soon)
    await submitOffer(0, providerOne, 500, soon)
    await networkHelpers.time.increaseTo(soon + 1n)
    await expect(market.acceptOffer(0, 0)).to.be.revertedWithCustomError(market, 'ListingUnavailable')

    await market.cancelListing(0)
    const nextExpiry = BigInt(await networkHelpers.time.latest()) + 100n
    // The expired listing is cleared by the saver through a new cancellation path only before expiry,
    // so use a fresh vault for the explicit cancellation assertion.
    await factory.createPersonalVault(UNIT, maturity, 1_000)
    const secondVault = await ethers.getContractAt('SavingsVault', await factory.vaultAt(1))
    await token.mint(await saver.getAddress(), 10n * UNIT)
    await token.approve(await secondVault.getAddress(), 10n * UNIT)
    await secondVault.deposit(0, 10n * UNIT)
    await market.createListing(await secondVault.getAddress(), 0, 800, nextExpiry)
    await market.cancelListing(1)
    await expect(market.connect(providerOne).submitOffer(1, 500, nextExpiry)).to.be.revertedWithCustomError(market, 'ListingUnavailable')
  })

  it('rejects an expired offer while its listing remains active', async function () {
    const now = BigInt(await networkHelpers.time.latest())
    await createListing(800, now + 1_000n)
    await submitOffer(0, providerOne, 500, now + 100n)
    await fundOffer(providerOne)
    await networkHelpers.time.increaseTo(now + 101n)
    await expect(market.acceptOffer(0, 0)).to.be.revertedWithCustomError(market, 'OfferUnavailable')
    expect((await market.listings(0)).active).to.equal(true)
  })

  it('prevents unauthorized acceptance and direct position transfer', async function () {
    await createListing()
    await submitOffer()
    await fundOffer(providerOne)

    await expect(market.connect(outsider).acceptOffer(0, 0)).to.be.revertedWithCustomError(market, 'SaverOnly')
    await expect(
      vault.connect(outsider).transferPosition(0, await saver.getAddress(), await outsider.getAddress()),
    ).to.be.revertedWithCustomError(vault, 'MarketOnly')
  })

  it('prevents a position from being sold twice', async function () {
    await createListing()
    await submitOffer()
    await fundOffer(providerOne)
    await market.acceptOffer(0, 0)

    await expect(
      market.connect(providerOne).createListing(await vault.getAddress(), 0, 800, maturity),
    ).to.be.revertedWithCustomError(market, 'PositionAlreadySold')
    await expect(market.acceptOffer(0, 0)).to.be.revertedWithCustomError(market, 'ListingUnavailable')
  })

  it('prevents accepting a sale at or after maturity', async function () {
    await createListing(800, maturity)
    await submitOffer(0, providerOne, 500, maturity)
    await fundOffer(providerOne)
    await networkHelpers.time.setNextBlockTimestamp(maturity)
    await expect(market.acceptOffer(0, 0)).to.revert(ethers)
  })

  it('supports competing offers and only transfers to the saver-selected provider', async function () {
    await createListing()
    await submitOffer(0, providerOne, 650)
    await submitOffer(0, providerTwo, 475)
    await fundOffer(providerTwo, 475)

    await market.acceptOffer(0, 1)

    expect(await vault.positionOwner(0)).to.equal(await providerTwo.getAddress())
    expect((await market.offers(0, 0)).active).to.equal(true)
    expect((await market.offers(0, 1)).active).to.equal(false)
  })

  it('allows saver rejection and provider cancellation of individual offers', async function () {
    await createListing()
    await submitOffer(0, providerOne, 650)
    await submitOffer(0, providerTwo, 500)
    await market.rejectOffer(0, 0)
    await market.connect(providerTwo).cancelOffer(0, 1)
    expect((await market.offers(0, 0)).active).to.equal(false)
    expect((await market.offers(0, 1)).active).to.equal(false)
  })

  it('returns a bounded reference discount with all four risk components', async function () {
    const result = await market.referenceDiscount(await vault.getAddress(), 0)
    expect(result.discountBps).to.be.gte(450)
    expect(result.discountBps).to.be.lte(800)
    expect(result.remainingDaysScore).to.be.gte(0)
    expect(result.timeWeightedProgressScore).to.be.gte(0)
    expect(result.consistencyScore).to.be.gte(0)
    expect(result.positionValueScore).to.be.gte(0)
  })

  it('rolls back atomically when a malicious ERC-20 returns false', async function () {
    const badToken = await ethers.deployContract('FalseReturnUSDT')
    const badFactory = await ethers.deployContract('VaultFactory', [
      await badToken.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
    ])
    await badFactory.createPersonalVault(100n * UNIT, maturity, 1_000)
    const badVault = await ethers.getContractAt('SavingsVault', await badFactory.vaultAt(0))
    const badMarket = await ethers.getContractAt('EarlyExitMarket', await badFactory.earlyExitMarket())
    await badToken.mint(await saver.getAddress(), 100n * UNIT)
    await badToken.approve(await badVault.getAddress(), 100n * UNIT)
    await badVault.deposit(0, 100n * UNIT)
    await badMarket.createListing(await badVault.getAddress(), 0, 800, maturity)
    await badMarket.connect(providerOne).submitOffer(0, 500, maturity)
    const sellerReceives = await badMarket.claimValue(90n * UNIT, 500)
    const fee = await badMarket.feeFor(sellerReceives)
    await badToken.mint(await providerOne.getAddress(), sellerReceives + fee)
    await badToken.connect(providerOne).approve(await badMarket.getAddress(), sellerReceives + fee)
    await badToken.setFailTransfersFrom(true)

    await expect(badMarket.acceptOffer(0, 0)).to.revert(ethers)
    expect(await badVault.positionOwner(0)).to.equal(await saver.getAddress())
    expect((await badMarket.listings(0)).active).to.equal(true)
    expect(await badMarket.positionSold(await badVault.getAddress(), 0)).to.equal(false)
  })

  it('blocks callback reentrancy while completing the original sale', async function () {
    const callbackToken = await ethers.deployContract('CallbackUSDT')
    const sellerContract = await ethers.deployContract('ReentrantMarketSeller')
    const callbackFactory = await ethers.deployContract('VaultFactory', [
      await callbackToken.getAddress(),
      await riskReserve.getAddress(),
      await maintenanceTreasury.getAddress(),
    ])
    const callbackMarket = await ethers.getContractAt('EarlyExitMarket', await callbackFactory.earlyExitMarket())
    await callbackFactory.createGroupVault(
      [await saver.getAddress(), await sellerContract.getAddress()],
      [UNIT, 100n * UNIT],
      [1_000, 1_000],
      maturity,
    )
    const callbackVault = await ethers.getContractAt('SavingsVault', await callbackFactory.vaultAt(0))
    await sellerContract.configure(await callbackVault.getAddress(), await callbackToken.getAddress(), await callbackMarket.getAddress())
    await callbackToken.mint(await sellerContract.getAddress(), 100n * UNIT)
    await sellerContract.deposit(1, 100n * UNIT)
    await sellerContract.list(1, 800, maturity)
    await callbackMarket.connect(providerOne).submitOffer(0, 500, maturity)
    const sellerReceives = await callbackMarket.claimValue(90n * UNIT, 500)
    const fee = await callbackMarket.feeFor(sellerReceives)
    await callbackToken.mint(await providerOne.getAddress(), sellerReceives + fee)
    await callbackToken.connect(providerOne).approve(await callbackMarket.getAddress(), sellerReceives + fee)
    await callbackToken.setCallbacksEnabled(true)

    await sellerContract.accept(0)

    expect(await sellerContract.reentrySucceeded()).to.equal(false)
    expect(await callbackVault.positionOwner(1)).to.equal(await providerOne.getAddress())
  })
})
