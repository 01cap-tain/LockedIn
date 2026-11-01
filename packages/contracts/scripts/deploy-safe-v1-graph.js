export async function deploySafeV1Graph({
  ethers,
  deployer,
  asset,
  maintenanceTreasury,
  safetyCouncil,
  chainId,
  timelockDelay,
  maxPositionPrincipal,
  maxVaultPrincipal,
  maxProtocolPrincipal,
}) {
  const deployerAddress = await deployer.getAddress()
  const nonce = await ethers.provider.getTransactionCount(deployerAddress, 'pending')
  const predictedFactory = ethers.getCreateAddress({ from: deployerAddress, nonce: nonce + 2 })
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
  const factoryFactory = await ethers.getContractFactory('VaultFactory', deployer)

  const safety = await safetyFactory.deploy(...safetyArguments)
  await safety.waitForDeployment()
  const vaultDeployer = await vaultDeployerFactory.deploy(predictedFactory)
  await vaultDeployer.waitForDeployment()
  const factoryArguments = [
    asset,
    maintenanceTreasury,
    chainId,
    await vaultDeployer.getAddress(),
    await safety.getAddress(),
  ]
  const factory = await factoryFactory.deploy(...factoryArguments)
  await factory.waitForDeployment()
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
    constructorArguments: { safety: safetyArguments, vaultDeployer: [predictedFactory], factory: factoryArguments },
    records: {
      safetyController: safetyRecord,
      savingsVaultDeployer: vaultDeployerRecord,
      vaultFactory: factoryRecord,
      earlyExitMarket: {
        address: await factory.earlyExitMarket(),
        transactionHash: factoryRecord.transactionHash,
        blockNumber: factoryReceipt.blockNumber,
      },
    },
  }
}
