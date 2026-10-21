const UNIT = 10n ** 6n

/**
 * Deploys the standalone safety and reward contracts first. Both bind their
 * immutable factory authority to the fourth CREATE address from the signer.
 */
export async function deployFactory(
  ethers,
  factoryArguments,
  safetyCouncil,
  {
    timelockDelay = 24 * 60 * 60,
    maxPositionPrincipal = 1_000_000n * UNIT,
    maxVaultPrincipal = 10_000_000n * UNIT,
    maxProtocolPrincipal = 100_000_000n * UNIT,
    epochDuration = 7 * 24 * 60 * 60,
    registrationGrace = 24 * 60 * 60,
    minimumRewardTarget = UNIT,
    minimumSavingDuration = 24 * 60 * 60,
  } = {},
) {
  const [deployer] = await ethers.getSigners()
  const deployerAddress = await deployer.getAddress()
  const nonce = await ethers.provider.getTransactionCount(deployerAddress)
  const predictedFactory = ethers.getCreateAddress({
    from: deployerAddress,
    nonce: nonce + 3,
  })
  const safetyController = await ethers.deployContract('SafetyController', [
    predictedFactory,
    safetyCouncil,
    timelockDelay,
    maxPositionPrincipal,
    maxVaultPrincipal,
    maxProtocolPrincipal,
  ])
  const rewardPool = await ethers.deployContract('RewardPool', [
    factoryArguments[0],
    predictedFactory,
    epochDuration,
    registrationGrace,
    minimumRewardTarget,
    minimumSavingDuration,
  ])
  const vaultDeployer = await ethers.deployContract('SavingsVaultDeployer', [
    predictedFactory,
  ])
  const factory = await ethers.deployContract('VaultFactory', [
    ...factoryArguments,
    await vaultDeployer.getAddress(),
    await safetyController.getAddress(),
    await rewardPool.getAddress(),
  ])
  return { factory, safetyController, rewardPool, vaultDeployer }
}
