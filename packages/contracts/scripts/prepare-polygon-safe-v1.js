import process from 'node:process'
import { execFileSync } from 'node:child_process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Contract, JsonRpcProvider, getAddress, getCreateAddress, keccak256 } from 'ethers'
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

const minimumMaturityDuration = Number(process.env.POLYGON_MIN_MATURITY_SECONDS ?? 25_200)
assertProductionMaturityConfiguration({ chainId: 137, profile: 'safe-only-v1-production', minimumMaturityDuration })
const provider = new JsonRpcProvider(required('POLYGON_RPC_URL'), 137, { staticNetwork: true })
if (Number((await provider.getNetwork()).chainId) !== 137) throw new Error('Expected Polygon chain 137.')
const safetyCouncil = getAddress(required('POLYGON_SAFETY_COUNCIL_ADDRESS'))
const riskReserve = getAddress(required('POLYGON_RISK_RESERVE_ADDRESS'))
const maintenanceTreasury = getAddress(required('POLYGON_MAINTENANCE_TREASURY_ADDRESS'))
const deployer = getAddress(required('POLYGON_DEPLOYER_ADDRESS'))
if (new Set([safetyCouncil, riskReserve, maintenanceTreasury].map((value) => value.toLowerCase())).size !== 3) {
  throw new Error('Safety, risk-reserve and maintenance destinations must be distinct.')
}
const [confirmedNonce, pendingNonce] = await Promise.all([
  provider.getTransactionCount(deployer, 'latest'),
  provider.getTransactionCount(deployer, 'pending'),
])
const nonce = pendingNonce
const caps = {
  position: positive('POLYGON_MAX_POSITION_PRINCIPAL'),
  vault: positive('POLYGON_MAX_VAULT_PRINCIPAL'),
  protocol: positive('POLYGON_MAX_PROTOCOL_PRINCIPAL'),
}
if (!(caps.position <= caps.vault && caps.vault <= caps.protocol)) throw new Error('Production caps are inconsistent.')
if (caps.position > 5_000n * 10n ** 6n || caps.vault > 25_000n * 10n ** 6n || caps.protocol > 50_000n * 10n ** 6n) {
  throw new Error('Safe-only V1 caps exceed the reviewed launch ceilings.')
}
const token = new Contract(polygonAaveConfig.usdt, ['function decimals() view returns (uint8)'], provider)
const [tokenCode, decimals] = await Promise.all([provider.getCode(polygonAaveConfig.usdt), token.decimals()])
if (tokenCode === '0x' || Number(decimals) !== 6) throw new Error('The maintained production token failed live validation.')
const feeData = await provider.getFeeData()
const deploymentGasPrice = feeData.maxFeePerGas ?? feeData.gasPrice
if (!deploymentGasPrice) throw new Error('The Polygon RPC did not return a usable gas price.')
const gasCeilings = { safetyController: 1_500_000n, savingsVaultDeployer: 6_500_000n, rewardPool: 2_500_000n, vaultFactory: 4_500_000n }
const maximumDeploymentCostWei = Object.values(gasCeilings).reduce((total, gas) => total + gas, 0n) * deploymentGasPrice
const deployerBalanceWei = await provider.getBalance(deployer)
if (deployerBalanceWei < maximumDeploymentCostWei) throw new Error('The deployer balance is below the current deployment-cost ceiling.')
const authorityKinds = Object.fromEntries(await Promise.all(
  Object.entries({ safetyCouncil, riskReserve, maintenanceTreasury }).map(async ([name, address]) => [
    name,
    await provider.getCode(address) === '0x' ? 'EOA' : 'CONTRACT',
  ])
))

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const artifactsDirectory = path.resolve(scriptDirectory, '../artifacts/contracts')
const artifactNames = ['SafetyController', 'SavingsVaultDeployer', 'RewardPool', 'VaultFactory', 'EarlyExitMarket', 'SavingsVault']
const bytecodeHashes = Object.fromEntries(await Promise.all(artifactNames.map(async (name) => {
  const artifact = JSON.parse(await readFile(path.join(artifactsDirectory, `${name}.sol`, `${name}.json`), 'utf8'))
  return [name, { creation: keccak256(artifact.bytecode), runtime: keccak256(artifact.deployedBytecode) }]
})))
const git = process.env.GIT_EXECUTABLE ?? (process.platform === 'win32' ? 'C:\\Program Files\\Git\\cmd\\git.exe' : 'git')
const gitCommit = execFileSync(git, ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim()
const workingTreeClean = execFileSync(git, ['status', '--porcelain=v1'], { encoding: 'utf8' }).trim() === ''

const predicted = {
  safetyController: getCreateAddress({ from: deployer, nonce }),
  savingsVaultDeployer: getCreateAddress({ from: deployer, nonce: nonce + 1 }),
  rewardPool: getCreateAddress({ from: deployer, nonce: nonce + 2 }),
  vaultFactory: getCreateAddress({ from: deployer, nonce: nonce + 3 }),
}
const constructorArguments = {
  safetyController: [predicted.vaultFactory, safetyCouncil, 86_400, caps.position.toString(), caps.vault.toString(), caps.protocol.toString()],
  savingsVaultDeployer: [predicted.vaultFactory],
  rewardPool: [polygonAaveConfig.usdt, predicted.vaultFactory, 2_592_000, 259_200, '10000000', 25_200],
  vaultFactory: [polygonAaveConfig.usdt, predicted.rewardPool, riskReserve, maintenanceTreasury, 137, predicted.savingsVaultDeployer, predicted.safetyController, minimumMaturityDuration],
}
console.log(JSON.stringify({
  status: 'READ_ONLY_SAFE_V1_DEPLOYMENT_PLAN',
  gitCommit,
  workingTreeClean,
  chainId: 137,
  profile: 'safe-only-v1',
  asset: { address: polygonAaveConfig.usdt, decimals: Number(decimals) },
  features: { earn: false, rewards: false, upgradeability: false },
  minimumMaturityDuration,
  feeDistribution: { maintenanceTreasuryBps: 2_000, rewardPoolBps: 6_000, riskReserveBps: 2_000 },
  governance: { safetyCouncil, riskReserve, maintenanceTreasury, authorityKinds },
  caps: Object.fromEntries(Object.entries(caps).map(([key, value]) => [key, value.toString()])),
  predicted,
  deploymentOrder: ['SafetyController', 'SavingsVaultDeployer', 'RewardPool', 'VaultFactory (creates EarlyExitMarket)'],
  compiler: { version: '0.8.30', optimizer: { enabled: true, runs: 1 }, viaIR: true },
  bytecodeHashes,
  gasCeilings: Object.fromEntries(Object.entries(gasCeilings).map(([name, value]) => [name, value.toString()])),
  deploymentGasPriceWei: deploymentGasPrice.toString(),
  maximumDeploymentCostWei: maximumDeploymentCostWei.toString(),
  deployerBalanceWei: deployerBalanceWei.toString(),
  deployerNonces: { confirmed: confirmedNonce, pending: pendingNonce },
  constructorArguments,
  verificationCommands: [
    'npx hardhat verify --network polygon <SafetyController> <constructor args>',
    'npx hardhat verify --network polygon <SavingsVaultDeployer> <constructor args>',
    'npx hardhat verify --network polygon <RewardPool> <constructor args>',
    'npx hardhat verify --network polygon <VaultFactory> <constructor args>',
  ],
  note: 'This script has no signer and cannot deploy or broadcast a transaction.',
}, null, 2))
