import { readFile } from 'node:fs/promises'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import hre from 'hardhat'
import { verifyContract } from '@nomicfoundation/hardhat-verify/verify'

if (!process.env.POLYGONSCAN_API_KEY)
  throw new Error('POLYGONSCAN_API_KEY is required for verification.')

const directory = path.resolve(
  path.dirname(fileURLToPath(import.meta.url)),
  '../deployments/amoy'
)
const manifest = JSON.parse(
  await readFile(path.join(directory, 'latest.json'), 'utf8')
)
const contracts = manifest.contracts
const config = manifest.factoryConfiguration
if (manifest.profile !== 'safe-only-v1' || manifest.schemaVersion < 6) {
  throw new Error('The latest manifest is not the corrected Safe-only V1 deployment.')
}

const targets = [
  {
    name: 'RewardPool',
    address: contracts.rewardPool.address,
    constructorArgs: manifest.constructorArguments.rewardPool,
  },
  {
    name: 'MockUSDT',
    address: contracts.mockUsdt.address,
    constructorArgs: [],
  },
  {
    name: 'SafetyController',
    address: contracts.safetyController.address,
    constructorArgs: manifest.constructorArguments.safety,
  },
  {
    name: 'VaultFactory',
    address: contracts.vaultFactory.address,
    constructorArgs: [
      ...manifest.constructorArguments.factory,
    ],
  },
  {
    name: 'EarlyExitMarket',
    address: contracts.earlyExitMarket.address,
    constructorArgs: [
      contracts.mockUsdt.address,
      contracts.vaultFactory.address,
      contracts.rewardPool.address,
      config.riskReserve,
      config.maintenanceTreasury,
      contracts.safetyController.address,
    ],
  },
  {
    name: 'SavingsVaultDeployer',
    address: contracts.savingsVaultDeployer.address,
    constructorArgs: manifest.constructorArguments.vaultDeployer,
  },
]

for (const target of targets) {
  try {
    await verifyContract(
      {
        address: target.address,
        constructorArgs: target.constructorArgs,
        provider: 'etherscan',
      },
      hre
    )
    console.log(
      `${target.name} verified: ${manifest.explorer}/address/${target.address}#code`
    )
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error)
    if (/already verified/i.test(message))
      console.log(`${target.name} was already verified.`)
    else throw error
  }
}
