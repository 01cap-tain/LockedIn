export async function deploySafeV1Graph({
  ethers,
  deployer,
  asset,
  riskReserve,
  maintenanceTreasury,
  safetyCouncil,
  chainId,
  timelockDelay,
  maxPositionPrincipal,
  maxVaultPrincipal,
  maxProtocolPrincipal,
  minimumMaturityDuration,
  rewardEpochDuration = 30 * 24 * 60 * 60,
  rewardRegistrationGrace = 3 * 24 * 60 * 60,
  minimumRewardTarget = 10n * 10n ** 6n,
  minimumRewardSavingDuration = 7 * 60 * 60,
}) {
  if (!Number.isSafeInteger(minimumMaturityDuration) || minimumMaturityDuration < 25_200) {
    throw new Error('minimumMaturityDuration must be at least 25,200 seconds.')
  }
  const deployerAddress = await deployer.getAddress()
  const nonce = await ethers.provider.getTransactionCount(deployerAddress, 'pending')
  if (!riskReserve) throw new Error('riskReserve compatibility address is required even though Safe-only fees route to maintenance.')
  const predictedFactory = ethers.getCreateAddress({ from: deployerAddress, nonce: nonce + 3 })
  const safetyArguments = [
    predictedFactory,
    safetyCouncil,
    timelockDelay,
    maxPositionPrincipal,
    maxVaultPrincipal,
    maxProtocolPrincipal,
  ]
  const safetyFactory = await ethers.getContractFactory('SafetyController', deployer)
  const vaultDeployerFactory = await ethers.getContractFactory('SavingsVaultDeployer', deployer)
  const rewardPoolFactory = await ethers.getContractFactory('RewardPool', deployer)
  const factoryFactory = await ethers.getContractFactory('VaultFactory', deployer)

  // Public Amoy providers have repeatedly failed estimation for creation code
  // even though measured execution is comfortably below the block limit.
  // These ceilings are above the local measured costs without being unbounded.
  const safety = await safetyFactory.deploy(...safetyArguments, { gasLimit: 1_500_000n })
  await safety.waitForDeployment()
  console.log(`SafetyController confirmed at ${await safety.getAddress()}.`)
  const vaultDeployer = await vaultDeployerFactory.deploy(predictedFactory, { gasLimit: 6_500_000n })
  await vaultDeployer.waitForDeployment()
  console.log(`SavingsVaultDeployer confirmed at ${await vaultDeployer.getAddress()}.`)
  const rewardPoolArguments = [
    asset,
    predictedFactory,
    rewardEpochDuration,
    rewardRegistrationGrace,
    minimumRewardTarget,
    minimumRewardSavingDuration,
  ]
  const rewardPool = await rewardPoolFactory.deploy(...rewardPoolArguments, { gasLimit: 2_500_000n })
  await rewardPool.waitForDeployment()
  console.log(`RewardPool confirmed at ${await rewardPool.getAddress()}.`)
  const factoryArguments = [
    asset,
    await rewardPool.getAddress(),
    riskReserve,
    maintenanceTreasury,
    chainId,
    await vaultDeployer.getAddress(),
    await safety.getAddress(),
    minimumMaturityDuration,
  ]
  const factory = await factoryFactory.deploy(...factoryArguments, { gasLimit: 4_500_000n })
  await factory.waitForDeployment()
  console.log(`VaultFactory confirmed at ${await factory.getAddress()}.`)
  if ((await factory.getAddress()).toLowerCase() !== predictedFactory.toLowerCase()) {
    throw new Error('Factory CREATE address did not match the immutable safety/deployer binding.')
  }

  const deploymentRecord = async (contract) => {
    const transaction = contract.deploymentTransaction()
    if (!transaction) throw new Error('Deployment transaction is unavailable.')
    const receipt = await transaction.wait()
    return {
      address: await contract.getAddress(),
      transactionHash: transaction.hash,
      blockNumber: receipt.blockNumber,
    }
  }
  const [safetyRecord, vaultDeployerRecord, factoryRecord] = await Promise.all([
    deploymentRecord(safety),
    deploymentRecord(vaultDeployer),
    deploymentRecord(factory),
  ])
  const factoryReceipt = await factory.deploymentTransaction().wait()
  return {
    factory,
    safety,
    vaultDeployer,
    rewardPool,
    constructorArguments: { safety: safetyArguments, vaultDeployer: [predictedFactory], rewardPool: rewardPoolArguments, factory: factoryArguments },
    records: {
      safetyController: safetyRecord,
      savingsVaultDeployer: vaultDeployerRecord,
      rewardPool: await deploymentRecord(rewardPool),
      vaultFactory: factoryRecord,
      earlyExitMarket: {
        address: await factory.earlyExitMarket(),
        transactionHash: factoryRecord.transactionHash,
        blockNumber: factoryReceipt.blockNumber,
      },
    },
  }
}
