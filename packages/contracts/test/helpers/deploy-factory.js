const UNIT = 10n ** 6n

/**
 * Deploys the standalone safety controller first and binds its immutable
 * factory address to the next CREATE address from the same test signer.
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
  } = {},
) {
  const [deployer] = await ethers.getSigners()
  const deployerAddress = await deployer.getAddress()
  const nonce = await ethers.provider.getTransactionCount(deployerAddress)
  const predictedFactory = ethers.getCreateAddress({
    from: deployerAddress,
    nonce: nonce + 1,
  })
  const safetyController = await ethers.deployContract('SafetyController', [
    predictedFactory,
    safetyCouncil,
    timelockDelay,
    maxPositionPrincipal,
    maxVaultPrincipal,
    maxProtocolPrincipal,
  ])
  const factory = await ethers.deployContract('VaultFactory', [
    ...factoryArguments,
    await safetyController.getAddress(),
  ])
  return { factory, safetyController }
}
