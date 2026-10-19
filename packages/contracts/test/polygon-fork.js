import { expect } from 'chai'
import { network } from 'hardhat'
import process from 'node:process'

import { polygonAaveConfig } from '../scripts/polygon-aave-config.js'

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
