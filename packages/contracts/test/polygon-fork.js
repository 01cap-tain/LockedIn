import { expect } from 'chai'
import { network } from 'hardhat'
import process from 'node:process'

import { polygonAaveConfig } from '../scripts/polygon-aave-config.js'
import { deploySafeV1Graph } from '../scripts/deploy-safe-v1-graph.js'

const forkDescribe = process.env.POLYGON_RPC_URL ? describe : describe.skip

forkDescribe('Polygon Aave configuration (optional fork)', function () {
  it('validates the maintained Pool, USDT and aUSDT against live fork state', async function () {
    const { ethers } = await network.create('polygonFork')
    const [deployer] = await ethers.getSigners()
    const adapter = await ethers.deployContract('AaveYieldAdapter', [
      polygonAaveConfig.usdt,
      polygonAaveConfig.pool,
      polygonAaveConfig.aUsdt,
      await deployer.getAddress(),
      polygonAaveConfig.chainId,
    ])

    expect(await adapter.asset()).to.equal(polygonAaveConfig.usdt)
    expect(await adapter.aavePool()).to.equal(polygonAaveConfig.pool)
    expect(await adapter.aToken()).to.equal(polygonAaveConfig.aUsdt)
    const reserve = await adapter.reserveStatus()
    expect(reserve.active).to.equal(true)
    expect(reserve.currentSupply).to.be.greaterThan(0n)
    // This is a live observation, not a promise that future redemptions succeed.
    expect(reserve.availableLiquidity).to.be.greaterThanOrEqual(0n)
  })
})

forkDescribe('Safe-only V1 against Polygon production USDT (optional fork)', function () {
  it('accepts the official six-decimal token and immutably disables Earn', async function () {
    const { ethers } = await network.create('polygonFork')
    const [deployer, maintenance] = await ethers.getSigners()
    const unit = 10n ** 6n
    const deployment = await deploySafeV1Graph({
      ethers,
      deployer,
      asset: polygonAaveConfig.usdt,
      maintenanceTreasury: await maintenance.getAddress(),
      safetyCouncil: await deployer.getAddress(),
      chainId: 137,
      timelockDelay: 2 * 24 * 60 * 60,
      maxPositionPrincipal: 1_000n * unit,
      maxVaultPrincipal: 10_000n * unit,
      maxProtocolPrincipal: 50_000n * unit,
      minimumMaturityDuration: 24 * 60 * 60,
    })
    expect(await deployment.factory.asset()).to.equal(polygonAaveConfig.usdt)
    expect(await deployment.factory.PROTOCOL_VERSION()).to.equal('lockedin-circle/1.3.0-safe')
    const latest = await ethers.provider.getBlock('latest')
    await expect(deployment.factory.createPersonalVault(
      100n * unit,
      BigInt(latest.timestamp + 30 * 24 * 60 * 60),
      1_000,
      1,
    )).to.be.revertedWithCustomError(deployment.factory, 'EarnDisabled')
  })
})
