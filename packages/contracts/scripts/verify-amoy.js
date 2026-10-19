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
const adapterRate = 5n * 10n ** 25n

const targets = [
  {
    name: 'MockUSDT',
    address: contracts.mockUsdt.address,
    constructorArgs: [],
  },
  {
    name: 'MockYieldAdapterFactory',
    address: contracts.mockYieldAdapterFactory.address,
    constructorArgs: [
      contracts.mockUsdt.address,
      manifest.chainId,
      adapterRate,
    ],
  },
  {
    name: 'SafetyController',
    address: contracts.safetyController.address,
    constructorArgs: [
      contracts.vaultFactory.address,
      config.safety.authority,
      config.safety.timelockSeconds,
      config.safety.maxPositionPrincipal,
      config.safety.maxVaultPrincipal,
      config.safety.maxProtocolPrincipal,
    ],
  },
  {
    name: 'VaultFactory',
    address: contracts.vaultFactory.address,
    constructorArgs: [
      contracts.mockUsdt.address,
      config.riskReserve,
      config.maintenanceTreasury,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
      manifest.chainId,
      contracts.mockYieldAdapterFactory.address,
      contracts.safetyController.address,
    ],
  },
  {
    name: 'RewardPool',
    address: contracts.rewardPool.address,
    constructorArgs: [
      contracts.mockUsdt.address,
      contracts.vaultFactory.address,
    ],
  },
  {
    name: 'EarlyExitMarket',
    address: contracts.earlyExitMarket.address,
    constructorArgs: [
      contracts.mockUsdt.address,
      contracts.rewardPool.address,
      contracts.vaultFactory.address,
      config.riskReserve,
      config.maintenanceTreasury,
      contracts.safetyController.address,
    ],
  },
  {
    name: 'SavingsVaultDeployer',
    address: contracts.savingsVaultDeployer.address,
    constructorArgs: [],
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
