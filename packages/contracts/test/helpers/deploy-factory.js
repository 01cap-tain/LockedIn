const UNIT = 10n ** 6n

export async function createSecureGroupInvitation(
  ethers,
  vault,
  creator,
  invitee,
  expiry,
  nonce,
  secret = ethers.hexlify(ethers.randomBytes(32)),
) {
  const inviteeAddress = typeof invitee === 'string' ? invitee : await invitee.getAddress()
  const { chainId } = await ethers.provider.getNetwork()
  const commitment = ethers.keccak256(ethers.AbiCoder.defaultAbiCoder().encode(
    ['address', 'address', 'bytes32', 'uint64', 'uint256', 'uint256'],
    [await vault.getAddress(), inviteeAddress, secret, expiry, nonce, chainId],
  ))
  await vault.connect(creator).createGroupInvitation(inviteeAddress, commitment, expiry, nonce)
  return { commitment, invitee: inviteeAddress, secret, expiry, nonce }
}

/**
 * Deploys the Safe-only V1 safety controller and vault deployer first. Both
 * bind their immutable factory authority to the third CREATE address.
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
    minimumMaturityDuration = 10 * 60,
  } = {},
) {
  const [deployer] = await ethers.getSigners()
  const deployerAddress = await deployer.getAddress()
  const nonce = await ethers.provider.getTransactionCount(deployerAddress)
  const predictedFactory = ethers.getCreateAddress({
    from: deployerAddress,
    nonce: nonce + 2,
  })
  const safetyController = await ethers.deployContract('SafetyController', [
    predictedFactory,
    safetyCouncil,
    timelockDelay,
    maxPositionPrincipal,
    maxVaultPrincipal,
    maxProtocolPrincipal,
  ])
  const vaultDeployer = await ethers.deployContract('SavingsVaultDeployer', [
    predictedFactory,
  ])
  // Existing tests pass the former graph arguments. V1 deliberately selects
  // only asset, maintenance treasury and chain ID from that tuple.
  const factory = await ethers.deployContract('VaultFactory', [
    factoryArguments[0],
    factoryArguments[2],
    factoryArguments[5],
    await vaultDeployer.getAddress(),
    await safetyController.getAddress(),
    minimumMaturityDuration,
  ])
  return { factory, safetyController, vaultDeployer }
}

/**
 * Creates a circle through the production creator-first flow. The creator only
 * supplies their own terms; every other signer joins from their own wallet and
 * selects their own target/allocation before a member activates the circle.
 */
export async function createActivatedGroup(
  ethers,
  factory,
  signers,
  targets,
  emergencyBps,
  maturity,
  mode = 0,
  { publicJoining = false, name = 'Test circle' } = {},
) {
  const creator = signers[0]
  const latest = await ethers.provider.getBlock('latest')
  const enrollmentDeadline = BigInt(latest.timestamp) +
    (BigInt(maturity) - BigInt(latest.timestamp)) / 2n
  await factory.connect(creator).createPublicGroupVault(
    name,
    targets[0],
    emergencyBps[0],
    signers.length,
    enrollmentDeadline,
    maturity,
    mode,
    publicJoining,
  )
  const vault = await ethers.getContractAt(
    'SavingsVault',
    await factory.vaultAt((await factory.vaultCount()) - 1n),
  )
  for (let index = 1; index < signers.length; index += 1) {
    let invitation
    if (!publicJoining) {
      invitation = await createSecureGroupInvitation(
        ethers,
        vault,
        creator,
        signers[index],
        enrollmentDeadline,
        BigInt(index),
      )
    }
    if (!publicJoining && typeof signers[index].joinInviteOnlyGroup === 'function') {
      await signers[index].joinInviteOnlyGroup(
        vault,
        invitation.invitee,
        invitation.secret,
        invitation.expiry,
        invitation.nonce,
        targets[index],
        emergencyBps[index],
      )
    } else if (publicJoining && typeof signers[index].joinGroup === 'function') {
      await signers[index].joinGroup(vault, targets[index], emergencyBps[index])
    } else if (!publicJoining) {
      await vault.connect(signers[index]).joinInviteOnlyGroup(
        invitation.invitee,
        invitation.secret,
        invitation.expiry,
        invitation.nonce,
        targets[index],
        emergencyBps[index],
      )
    } else {
      await vault.connect(signers[index]).joinPublicGroup(targets[index], emergencyBps[index])
    }
  }
  await vault.connect(creator).activateGroup()
  return vault
}
