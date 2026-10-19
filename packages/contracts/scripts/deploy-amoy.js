import { execFileSync } from "node:child_process";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import path from "node:path";
import process from "node:process";
import { fileURLToPath } from "node:url";

import { network } from "hardhat";

const CHAIN_ID = 80_002;
const TOKEN_DECIMALS = 6;
const UNIT = 10n ** BigInt(TOKEN_DECIMALS);
// These deliberately high limits are testnet parameters, not production recommendations.
const AMOY_SAFETY_TIMELOCK_SECONDS = 24 * 60 * 60;
const AMOY_MAX_POSITION_PRINCIPAL = 1_000_000n * UNIT;
const AMOY_MAX_VAULT_PRINCIPAL = 10_000_000n * UNIT;
const AMOY_MAX_PROTOCOL_PRINCIPAL = 100_000_000n * UNIT;
const AMOY_REWARD_EPOCH_SECONDS = 24 * 60 * 60;
const AMOY_REWARD_GRACE_SECONDS = 6 * 60 * 60;
const AMOY_MINIMUM_REWARD_TARGET = 10n * UNIT;
const AMOY_MINIMUM_SAVING_DURATION = 7 * 24 * 60 * 60;
const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const prerequisitePath = path.resolve(
  scriptDirectory,
  "../deployments/amoy-prerequisites.json"
);

function requiredAddress(ethers, name) {
  const value = process.env[name];
  if (!value || !ethers.isAddress(value) || value === ethers.ZeroAddress) {
    throw new Error(`${name} must be a non-zero public EVM address.`);
  }
  return ethers.getAddress(value);
}

function gitCommit() {
  const gitExecutable =
    process.env.GIT_EXECUTABLE ??
    (process.platform === "win32"
      ? "C:\\Program Files\\Git\\cmd\\git.exe"
      : "git");
  try {
    const status = execFileSync(gitExecutable, ["status", "--porcelain=v1"], {
      encoding: "utf8",
    }).trim();
    if (status) {
      throw new Error("The worktree is not clean.");
    }
    return execFileSync(gitExecutable, ["rev-parse", "HEAD"], {
      encoding: "utf8",
    }).trim();
  } catch {
    throw new Error(
      "Deployment requires a clean Git worktree and a working Git executable. Set GIT_EXECUTABLE only for a non-standard Git installation."
    );
  }
}

async function deploymentRecord(contract) {
  const transaction = contract.deploymentTransaction();
  if (!transaction) throw new Error("Missing deployment transaction.");
  const receipt = await transaction.wait();
  return {
    address: await contract.getAddress(),
    transactionHash: transaction.hash,
    blockNumber: receipt.blockNumber,
  };
}

if (!process.env.AMOY_RPC_URL || !process.env.AMOY_DEPLOYER_PRIVATE_KEY) {
  throw new Error(
    "AMOY_RPC_URL and AMOY_DEPLOYER_PRIVATE_KEY are required in the process environment."
  );
}

// Refuse before sending any transaction if the manifest cannot identify exact source.
const commit = gitCommit();

const { ethers } = await network.create("amoy");
const [deployer] = await ethers.getSigners();
if (!deployer) throw new Error("No Amoy deployer signer is configured.");
const chain = await ethers.provider.getNetwork();
if (Number(chain.chainId) !== CHAIN_ID)
  throw new Error(`Expected Amoy ${CHAIN_ID}, received ${chain.chainId}.`);

const riskReserve = requiredAddress(ethers, "AMOY_RISK_RESERVE_ADDRESS");
const maintenanceTreasury = requiredAddress(
  ethers,
  "AMOY_MAINTENANCE_TREASURY_ADDRESS"
);
if (riskReserve === maintenanceTreasury)
  throw new Error("Test treasury addresses must be distinct.");

const prerequisite = JSON.parse(await readFile(prerequisitePath, "utf8"));
if (prerequisite.chainId !== CHAIN_ID) {
  throw new Error(
    "Recovered Amoy prerequisite metadata has the wrong chain ID."
  );
}
const tokenRecord = prerequisite.contracts.mockUsdt;
const adapterFactoryRecord = prerequisite.contracts.mockYieldAdapterFactory;
const token = await ethers.getContractAt("MockUSDT", tokenRecord.address);
const mockYieldAdapterFactory = await ethers.getContractAt(
  "MockYieldAdapterFactory",
  adapterFactoryRecord.address
);
const [tokenCode, adapterCode, tokenDecimals, adapterAsset, adapterChainId] =
  await Promise.all([
    ethers.provider.getCode(tokenRecord.address),
    ethers.provider.getCode(adapterFactoryRecord.address),
    token.decimals(),
    mockYieldAdapterFactory.asset(),
    mockYieldAdapterFactory.expectedChainId(),
  ]);
if (
  tokenCode === "0x" ||
  adapterCode === "0x" ||
  Number(tokenDecimals) !== TOKEN_DECIMALS ||
  adapterAsset.toLowerCase() !== tokenRecord.address.toLowerCase() ||
  Number(adapterChainId) !== CHAIN_ID
) {
  throw new Error("Recovered Amoy mock contracts failed on-chain validation.");
}
console.log(`Reusing confirmed MockUSDT at ${tokenRecord.address}.`);
console.log(
  `Reusing confirmed MockYieldAdapterFactory at ${adapterFactoryRecord.address}.`
);

const deployerAddress = await deployer.getAddress();
const safetyNonce = await ethers.provider.getTransactionCount(
  deployerAddress,
  "pending"
);
// SafetyController and RewardPool need an immutable factory address, so both bind
// to the third CREATE address (after their own deployments). The factory constructor
// checks both reciprocal bindings and rejects any mismatch.
const predictedFactoryAddress = ethers.getCreateAddress({
  from: deployerAddress,
  nonce: safetyNonce + 2,
});
const safetyArguments = [
  predictedFactoryAddress,
  deployerAddress, // TEST ONLY: replace with a reviewed multisig for production.
  AMOY_SAFETY_TIMELOCK_SECONDS,
  AMOY_MAX_POSITION_PRINCIPAL,
  AMOY_MAX_VAULT_PRINCIPAL,
  AMOY_MAX_PROTOCOL_PRINCIPAL,
];
const safetyContractFactory = await ethers.getContractFactory(
  "SafetyController",
  deployer
);
const unsignedSafetyDeployment =
  await safetyContractFactory.getDeployTransaction(...safetyArguments);
const rewardArguments = [
  await token.getAddress(),
  predictedFactoryAddress,
  AMOY_REWARD_EPOCH_SECONDS,
  AMOY_REWARD_GRACE_SECONDS,
  AMOY_MINIMUM_REWARD_TARGET,
  AMOY_MINIMUM_SAVING_DURATION,
];
const rewardPoolFactory = await ethers.getContractFactory("RewardPool", deployer);
const unsignedRewardDeployment =
  await rewardPoolFactory.getDeployTransaction(...rewardArguments);

const factoryArguments = [
  await token.getAddress(),
  riskReserve,
  maintenanceTreasury,
  ethers.ZeroAddress,
  ethers.ZeroAddress,
  CHAIN_ID,
  await mockYieldAdapterFactory.getAddress(),
];
const factoryContract = await ethers.getContractFactory(
  "VaultFactory",
  deployer
);
const [deployerBalance, feeData] = await Promise.all([
  ethers.provider.getBalance(deployerAddress),
  ethers.provider.getFeeData(),
]);
const deploymentGasPrice = feeData.gasPrice;
if (!deploymentGasPrice) {
  throw new Error("The Amoy RPC did not return a usable legacy gas price.");
}
const [estimatedSafetyGas, estimatedRewardGas] = await Promise.all([
  ethers.provider.estimateGas({
    ...unsignedSafetyDeployment,
    from: deployerAddress,
  }),
  ethers.provider.estimateGas({
    ...unsignedRewardDeployment,
    from: deployerAddress,
  }),
]);
const safetyGasLimit = (estimatedSafetyGas * 120n) / 100n;
const rewardGasLimit = (estimatedRewardGas * 120n) / 100n;
// The factory validates the controller's deployed bytecode, so its live gas
// estimate is only possible after the controller exists. Reserve a conservative
// testnet budget before sending the first transaction to avoid an orphaned setup.
const factoryPreflightGasBudget = 12_000_000n;
const minimumDeploymentBalance =
  (safetyGasLimit + rewardGasLimit + factoryPreflightGasBudget) * deploymentGasPrice;
if (deployerBalance < minimumDeploymentBalance) {
  throw new Error(
    `The Amoy deployer is underfunded for SafetyController, RewardPool and VaultFactory. ` +
      `Current balance: ${ethers.formatEther(deployerBalance)} POL; ` +
      `required at the current gas price: ${ethers.formatEther(
        minimumDeploymentBalance
      )} POL. ` +
      "Request more test POL or retry when Amoy gas is lower."
  );
}

console.log(
  "Deploying SafetyController with a deployer-controlled TEST-ONLY safety role..."
);
const safetyController = await safetyContractFactory.deploy(...safetyArguments, {
  gasLimit: safetyGasLimit,
  gasPrice: deploymentGasPrice,
});
await safetyController.waitForDeployment();
const safetyRecord = await deploymentRecord(safetyController);
console.log(`SafetyController confirmed at ${safetyRecord.address}.`);

console.log("Deploying the deterministic protocol RewardPool...");
const rewardPoolContract = await rewardPoolFactory.deploy(...rewardArguments, {
  gasLimit: rewardGasLimit,
  gasPrice: deploymentGasPrice,
});
await rewardPoolContract.waitForDeployment();
const rewardPoolRecord = await deploymentRecord(rewardPoolContract);
console.log(`RewardPool confirmed at ${rewardPoolRecord.address}.`);

factoryArguments.push(safetyRecord.address, rewardPoolRecord.address);
const unsignedFactoryDeployment = await factoryContract.getDeployTransaction(
  ...factoryArguments
);
const estimatedFactoryGas = await ethers.provider.estimateGas({
  ...unsignedFactoryDeployment,
  from: deployerAddress,
});
const factoryGasLimit = (estimatedFactoryGas * 120n) / 100n;
if ((await ethers.provider.getBalance(deployerAddress)) < factoryGasLimit * deploymentGasPrice) {
  throw new Error(
    "SafetyController and RewardPool were confirmed, but the deployer no longer has enough POL for VaultFactory. " +
      `The controller is bound to ${predictedFactoryAddress}; fund the same deployer before retrying with recovery tooling.`
  );
}

console.log(
  "Deploying VaultFactory and its RewardPool/EarlyExitMarket/SavingsVaultDeployer..."
);
const factory = await factoryContract.deploy(...factoryArguments, {
  gasLimit: factoryGasLimit,
  gasPrice: deploymentGasPrice,
});
await factory.waitForDeployment();
console.log(`VaultFactory confirmed at ${await factory.getAddress()}.`);

const factoryRecord = await deploymentRecord(factory);
if (factoryRecord.address.toLowerCase() !== predictedFactoryAddress.toLowerCase()) {
  throw new Error("Confirmed factory address differs from the safety binding.");
}
const factoryReceipt = await factory.deploymentTransaction().wait();
const rewardPool = await factory.rewardPool();
if (rewardPool.toLowerCase() !== rewardPoolRecord.address.toLowerCase()) {
  throw new Error("Factory reported an unexpected RewardPool address.");
}
const earlyExitMarket = await factory.earlyExitMarket();
const vaultDeployer = await factory.vaultDeployer();
const timestamp = new Date().toISOString();
const manifest = {
  schemaVersion: 4,
  network: "polygon-amoy",
  chainId: CHAIN_ID,
  explorer: "https://amoy.polygonscan.com",
  gitCommit: commit,
  deploymentTimestamp: timestamp,
  tokenDecimals: TOKEN_DECIMALS,
  contracts: {
    mockUsdt: tokenRecord,
    mockYieldAdapterFactory: adapterFactoryRecord,
    safetyController: safetyRecord,
    vaultFactory: factoryRecord,
    rewardPool: rewardPoolRecord,
    earlyExitMarket: {
      address: earlyExitMarket,
      transactionHash: factoryRecord.transactionHash,
      blockNumber: factoryReceipt.blockNumber,
    },
    savingsVaultDeployer: {
      address: vaultDeployer,
      transactionHash: factoryRecord.transactionHash,
      blockNumber: factoryReceipt.blockNumber,
    },
  },
  factoryConfiguration: {
    savingsVaultDeployment: "non-upgradeable-per-vault",
    yieldAdapter: "MockYieldAdapter",
    riskReserve,
    maintenanceTreasury,
    safety: {
      authority: deployerAddress,
      authorityType: "test-only-deployer",
      timelockSeconds: AMOY_SAFETY_TIMELOCK_SECONDS,
      maxPositionPrincipal: AMOY_MAX_POSITION_PRINCIPAL.toString(),
      maxVaultPrincipal: AMOY_MAX_VAULT_PRINCIPAL.toString(),
      maxProtocolPrincipal: AMOY_MAX_PROTOCOL_PRINCIPAL.toString(),
    },
    rewards: {
      epochSeconds: AMOY_REWARD_EPOCH_SECONDS,
      registrationGraceSeconds: AMOY_REWARD_GRACE_SECONDS,
      minimumRewardTarget: AMOY_MINIMUM_REWARD_TARGET.toString(),
      minimumSavingDurationSeconds: AMOY_MINIMUM_SAVING_DURATION,
      environment: "test-only-amoy",
    },
  },
};

const outputDirectory = path.resolve(scriptDirectory, "../deployments/amoy");
await mkdir(outputDirectory, { recursive: true });
const version = `${timestamp.replace(/[:.]/g, "-")}-${commit.slice(0, 12)}`;
const contents = `${JSON.stringify(manifest, null, 2)}\n`;
await writeFile(path.join(outputDirectory, `${version}.json`), contents, {
  flag: "wx",
});
await writeFile(path.join(outputDirectory, "latest.json"), contents);

console.log(`Amoy deployment recorded as ${version}.`);
console.log(`VaultFactory: ${factoryRecord.address}`);
console.log(`SafetyController: ${safetyRecord.address} (TEST-ONLY authority)`);
console.log(
  `Explorer: https://amoy.polygonscan.com/address/${factoryRecord.address}`
);
