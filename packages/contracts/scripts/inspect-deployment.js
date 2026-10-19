import { readFile } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import process from "node:process";

import { network } from "hardhat";

const networkName = process.argv.includes("--local") ? "localhost" : "amoy";
const manifestNetwork = networkName === "localhost" ? "local" : "amoy";
const manifestPath = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  `../deployments/${manifestNetwork}/latest.json`
);
const manifest = JSON.parse(await readFile(manifestPath, "utf8"));
if (manifest.schemaVersion < 5) throw new Error("Deployment manifest does not contain an immutable deployment identity.");

const { ethers } = await network.create(networkName);
const factory = await ethers.getContractAt("VaultFactory", manifest.contracts.vaultFactory.address);
const safety = await ethers.getContractAt("SafetyController", manifest.contracts.safetyController.address);
const actual = {
  chainId: Number((await ethers.provider.getNetwork()).chainId),
  protocolVersion: await factory.PROTOCOL_VERSION(),
  deploymentId: await factory.deploymentId(),
  asset: await factory.asset(),
  market: await factory.earlyExitMarket(),
  rewardPool: await factory.rewardPool(),
  safetyController: await factory.safetyController(),
  safetyFactory: await safety.factory(),
};
const expected = {
  chainId: manifest.chainId,
  protocolVersion: manifest.protocolVersion,
  deploymentId: manifest.deploymentId,
  asset: manifest.contracts.mockUsdt.address,
  market: manifest.contracts.earlyExitMarket.address,
  rewardPool: manifest.contracts.rewardPool.address,
  safetyController: manifest.contracts.safetyController.address,
  safetyFactory: manifest.contracts.vaultFactory.address,
};
for (const [key, value] of Object.entries(expected)) {
  if (String(actual[key]).toLowerCase() !== String(value).toLowerCase()) {
    throw new Error(`${key} mismatch: chain returned ${actual[key]}, manifest records ${value}.`);
  }
}
console.log(`Deployment ${manifest.deploymentId} matches its manifest and immutable bindings.`);
console.log(`Protocol ${manifest.protocolVersion} on chain ${manifest.chainId}; safety paused: ${await safety.paused()}.`);
