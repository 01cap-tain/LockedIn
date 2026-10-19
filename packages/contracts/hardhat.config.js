import hardhatToolboxMochaEthers from '@nomicfoundation/hardhat-toolbox-mocha-ethers'
import { defineConfig } from 'hardhat/config'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

// Node loads the ignored testnet environment without an additional dotenv dependency.
// Existing shell variables win, allowing CI secret stores to remain authoritative.
try {
  process.loadEnvFile(
    path.resolve(
      path.dirname(fileURLToPath(import.meta.url)),
      '../../.env.amoy'
    )
  )
} catch (error) {
  if (error?.code !== 'ENOENT') throw error
}

const networks = {
  localhost: {
    type: 'http',
    chainType: 'l1',
    url: 'http://127.0.0.1:8545',
  },
}

if (process.env.AMOY_RPC_URL) {
  const accounts = [
    process.env.AMOY_DEPLOYER_PRIVATE_KEY,
    process.env.AMOY_WALLET_A_PRIVATE_KEY,
    process.env.AMOY_WALLET_B_PRIVATE_KEY,
  ].filter(Boolean)
  networks.amoy = {
    type: 'http',
    chainType: 'l1',
    chainId: 80_002,
    url: process.env.AMOY_RPC_URL,
    accounts,
  }
}

if (process.env.POLYGON_RPC_URL) {
  networks.polygonFork = {
    type: 'edr-simulated',
    chainType: 'l1',
    chainId: 137,
    forking: { url: process.env.POLYGON_RPC_URL },
  }
}

export default defineConfig({
  plugins: [hardhatToolboxMochaEthers],
  solidity: {
    version: '0.8.30',
    settings: {
      // The factory embeds SavingsVault creation code. Optimize for deployment
      // size so the real EVM limit remains enforced as vault features grow.
      optimizer: { enabled: true, runs: 1 },
      viaIR: true,
    },
  },
  paths: {
    sources: './contracts',
    tests: { mocha: './test' },
    cache: './cache',
    artifacts: './artifacts',
  },
  networks,
  verify: process.env.POLYGONSCAN_API_KEY
    ? { etherscan: { apiKey: process.env.POLYGONSCAN_API_KEY } }
    : undefined,
})
