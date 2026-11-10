import process from 'node:process'
import { readFile } from 'node:fs/promises'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { Contract, JsonRpcProvider, formatEther } from 'ethers'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const manifestPath = path.resolve(scriptDirectory, '../deployments/polygon/latest.json')
const manifest = JSON.parse(await readFile(manifestPath, 'utf8'))
const provider = new JsonRpcProvider(process.env.POLYGON_RPC_URL, 137, { staticNetwork: true })
const network = await provider.getNetwork()
if (Number(network.chainId) !== 137 || manifest.chainId !== 137) throw new Error('Expected Polygon mainnet chain 137.')

const artifact = async (name) => JSON.parse(await readFile(
  path.resolve(scriptDirectory, `../artifacts/contracts/${name}.sol/${name}.json`),
  'utf8',
))
const [factoryArtifact, safetyArtifact, marketArtifact] = await Promise.all([
  artifact('VaultFactory'), artifact('SafetyController'), artifact('EarlyExitMarket'),
])
const factory = new Contract(manifest.contracts.vaultFactory.address, factoryArtifact.abi, provider)
const safety = new Contract(manifest.contracts.safetyController.address, safetyArtifact.abi, provider)
const market = new Contract(manifest.contracts.earlyExitMarket.address, marketArtifact.abi, provider)
const token = new Contract(manifest.contracts.usdt.address, ['function decimals() view returns (uint8)'], provider)

const same = (actual, expected, label) => {
  if (String(actual).toLowerCase() !== String(expected).toLowerCase()) {
    throw new Error(`${label} mismatch: chain returned ${actual}; manifest records ${expected}.`)
  }
}

const expectedCode = ['safetyController', 'savingsVaultDeployer', 'rewardPool', 'vaultFactory', 'earlyExitMarket']
const receipts = []
for (const name of expectedCode) {
  const record = manifest.contracts[name]
  if (await provider.getCode(record.address) === '0x') throw new Error(`${name} has no deployed bytecode.`)
  if (!receipts.some((receipt) => receipt.hash === record.transactionHash)) {
    const receipt = await provider.getTransactionReceipt(record.transactionHash)
    if (!receipt || receipt.status !== 1) throw new Error(`${name} deployment receipt is missing or failed.`)
    receipts.push(receipt)
  }
}

same(await factory.PROTOCOL_VERSION(), manifest.protocolVersion, 'protocolVersion')
same(await factory.deploymentId(), manifest.deploymentId, 'deploymentId')
same(await factory.asset(), manifest.contracts.usdt.address, 'factory asset')
same(await factory.earlyExitMarket(), manifest.contracts.earlyExitMarket.address, 'factory market')
same(await factory.rewardPool(), manifest.contracts.rewardPool.address, 'factory rewardPool')
same(await factory.riskReserve(), manifest.factoryConfiguration.riskReserve, 'factory riskReserve')
same(await factory.maintenanceTreasury(), manifest.factoryConfiguration.maintenanceTreasury, 'factory maintenanceTreasury')
same(await factory.vaultDeployer(), manifest.contracts.savingsVaultDeployer.address, 'factory vaultDeployer')
same(await factory.safetyController(), manifest.contracts.safetyController.address, 'factory safetyController')
same(await factory.deploymentChainId(), 137, 'factory deploymentChainId')
same(await factory.minimumMaturityDuration(), 25_200, 'minimum maturity')

same(await safety.factory(), manifest.contracts.vaultFactory.address, 'safety factory')
same(await safety.safetyCouncil(), manifest.factoryConfiguration.safety.authority, 'safety council')
same(await safety.timelockDelay(), 86_400, 'safety timelock')
same(await safety.maxPositionPrincipal(), manifest.factoryConfiguration.safety.maxPositionPrincipal, 'position cap')
same(await safety.maxVaultPrincipal(), manifest.factoryConfiguration.safety.maxVaultPrincipal, 'vault cap')
same(await safety.maxProtocolPrincipal(), manifest.factoryConfiguration.safety.maxProtocolPrincipal, 'protocol cap')

same(await market.factory(), manifest.contracts.vaultFactory.address, 'market factory')
same(await market.asset(), manifest.contracts.usdt.address, 'market asset')
same(await market.rewardPool(), manifest.contracts.rewardPool.address, 'market rewardPool')
same(await market.riskReserve(), manifest.factoryConfiguration.riskReserve, 'market riskReserve')
same(await market.maintenanceTreasury(), manifest.factoryConfiguration.maintenanceTreasury, 'market maintenanceTreasury')
same(await market.safetyController(), manifest.contracts.safetyController.address, 'market safetyController')
same(await market.PROVIDER_FEE_BPS(), 90, 'provider fee')
same(await market.REWARD_POOL_SHARE_BPS(), 0, 'reward allocation')
same(await market.RISK_RESERVE_SHARE_BPS(), 0, 'risk allocation')
same(await token.decimals(), 6, 'USDT decimals')

const totalDeploymentFee = receipts.reduce(
  (total, receipt) => total + receipt.gasUsed * receipt.gasPrice,
  0n,
)
const deployer = process.env.POLYGON_DEPLOYER_ADDRESS
const [confirmedNonce, pendingNonce, deployerBalance] = await Promise.all([
  provider.getTransactionCount(deployer, 'latest'),
  provider.getTransactionCount(deployer, 'pending'),
  provider.getBalance(deployer),
])

console.log(JSON.stringify({
  verified: true,
  chainId: 137,
  gitCommit: manifest.gitCommit,
  deploymentId: manifest.deploymentId,
  contracts: Object.fromEntries(expectedCode.map((name) => [name, manifest.contracts[name].address])),
  transactionHashes: receipts.map((receipt) => receipt.hash),
  totalDeploymentFeeWei: totalDeploymentFee.toString(),
  totalDeploymentFeePol: formatEther(totalDeploymentFee),
  deployerNonce: { confirmed: confirmedNonce, pending: pendingNonce },
  deployerBalanceWei: deployerBalance.toString(),
  deployerBalancePol: formatEther(deployerBalance),
  safetyPaused: await safety.paused(),
  minimumMaturitySeconds: Number(await factory.minimumMaturityDuration()),
  providerFeeBps: Number(await market.PROVIDER_FEE_BPS()),
  feeDistribution: {
    rewardPoolBps: Number(await market.REWARD_POOL_SHARE_BPS()),
    riskReserveBps: Number(await market.RISK_RESERVE_SHARE_BPS()),
    maintenanceTreasuryBps: 10_000,
  },
}, null, 2))
