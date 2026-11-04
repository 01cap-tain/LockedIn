import process from 'node:process'

import { Contract, JsonRpcProvider, getAddress, getCreateAddress } from 'ethers'
import { polygonAaveConfig } from './polygon-aave-config.js'
import { assertProductionMaturityConfiguration } from './production-profile.js'

const required = (name) => {
  const value = process.env[name]
  if (!value) throw new Error(`${name} is intentionally unset; provide a reviewed production value.`)
  return value
}
const positive = (name) => {
  const value = BigInt(required(name))
  if (value <= 0n) throw new Error(`${name} must be positive.`)
  return value
}

const minimumMaturityDuration = Number(process.env.POLYGON_MIN_MATURITY_SECONDS ?? 86_400)
assertProductionMaturityConfiguration({ chainId: 137, profile: 'safe-only-v1-production', minimumMaturityDuration })
const provider = new JsonRpcProvider(required('POLYGON_RPC_URL'), 137, { staticNetwork: true })
if (Number((await provider.getNetwork()).chainId) !== 137) throw new Error('Expected Polygon chain 137.')
const safetyCouncil = getAddress(required('POLYGON_SAFETY_COUNCIL_ADDRESS'))
const maintenanceTreasury = getAddress(required('POLYGON_MAINTENANCE_TREASURY_ADDRESS'))
const deployer = getAddress(required('POLYGON_DEPLOYER_ADDRESS'))
if (safetyCouncil === maintenanceTreasury) throw new Error('Safety and maintenance multisigs must be distinct.')
const nonce = Number(required('POLYGON_DEPLOYER_NONCE'))
if (!Number.isSafeInteger(nonce) || nonce < 0) throw new Error('POLYGON_DEPLOYER_NONCE is invalid.')
const caps = {
  position: positive('POLYGON_MAX_POSITION_PRINCIPAL'),
  vault: positive('POLYGON_MAX_VAULT_PRINCIPAL'),
  protocol: positive('POLYGON_MAX_PROTOCOL_PRINCIPAL'),
}
if (!(caps.position <= caps.vault && caps.vault <= caps.protocol)) throw new Error('Production caps are inconsistent.')
if (caps.position > 1_000n * 10n ** 6n || caps.vault > 10_000n * 10n ** 6n || caps.protocol > 50_000n * 10n ** 6n) {
  throw new Error('Safe-only V1 caps exceed the reviewed launch ceilings.')
}
const token = new Contract(polygonAaveConfig.usdt, ['function decimals() view returns (uint8)'], provider)
const [tokenCode, decimals] = await Promise.all([provider.getCode(polygonAaveConfig.usdt), token.decimals()])
if (tokenCode === '0x' || Number(decimals) !== 6) throw new Error('The maintained production token failed live validation.')

const predicted = {
  safetyController: getCreateAddress({ from: deployer, nonce }),
  savingsVaultDeployer: getCreateAddress({ from: deployer, nonce: nonce + 1 }),
  vaultFactory: getCreateAddress({ from: deployer, nonce: nonce + 2 }),
}
const constructorArguments = {
  safetyController: [predicted.vaultFactory, safetyCouncil, 86_400, caps.position.toString(), caps.vault.toString(), caps.protocol.toString()],
  savingsVaultDeployer: [predicted.vaultFactory],
  vaultFactory: [polygonAaveConfig.usdt, maintenanceTreasury, 137, predicted.savingsVaultDeployer, predicted.safetyController, minimumMaturityDuration],
}
console.log(JSON.stringify({
  status: 'READ_ONLY_SAFE_V1_DEPLOYMENT_PLAN',
  chainId: 137,
  profile: 'safe-only-v1',
  asset: { address: polygonAaveConfig.usdt, decimals: Number(decimals) },
  features: { earn: false, rewards: false, upgradeability: false },
  minimumMaturityDuration,
  feeDistribution: { maintenanceTreasuryBps: 10_000, rewardPoolBps: 0, riskReserveBps: 0 },
  governance: { safetyCouncil, maintenanceTreasury },
  caps: Object.fromEntries(Object.entries(caps).map(([key, value]) => [key, value.toString()])),
  predicted,
  constructorArguments,
  note: 'This script has no signer and cannot deploy or broadcast a transaction.',
}, null, 2))
