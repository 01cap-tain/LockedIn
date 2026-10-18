import hardhatToolboxMochaEthers from '@nomicfoundation/hardhat-toolbox-mocha-ethers'
import { defineConfig } from 'hardhat/config'
import process from 'node:process'

const networks = {
  localhost: {
    type: 'http',
    chainType: 'l1',
    url: 'http://127.0.0.1:8545',
  },
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
      optimizer: { enabled: true, runs: 200 },
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
})
