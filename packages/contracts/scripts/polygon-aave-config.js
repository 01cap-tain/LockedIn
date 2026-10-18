import { AaveV3Polygon } from '@aave-dao/aave-address-book'

// Production deployments must source these values from the maintained Aave
// address-book package. They are intentionally not copied into environment files.
export const polygonAaveConfig = Object.freeze({
  chainId: AaveV3Polygon.CHAIN_ID,
  pool: AaveV3Polygon.POOL,
  usdt: AaveV3Polygon.ASSETS.USDT0.UNDERLYING,
  aUsdt: AaveV3Polygon.ASSETS.USDT0.A_TOKEN,
  decimals: AaveV3Polygon.ASSETS.USDT0.decimals,
})

if (polygonAaveConfig.chainId !== 137 || polygonAaveConfig.decimals !== 6) {
  throw new Error('The installed Aave address book does not describe six-decimal Polygon USDT.')
}
