import { readdirSync, readFileSync, statSync } from 'node:fs'
import path from 'node:path'

const EVM_RUNTIME_LIMIT = 24_576
const artifactRoot = path.resolve('artifacts/contracts')
const productionContracts = new Set([
  'VaultFactory',
  'SavingsVault',
  'SavingsVaultDeployer',
  'EarlyExitMarket',
  'SafetyController',
])
const results = []

function visit(directory) {
  for (const entry of readdirSync(directory)) {
    const target = path.join(directory, entry)
    if (statSync(target).isDirectory()) {
      visit(target)
      continue
    }
    if (!entry.endsWith('.json') || entry.endsWith('.dbg.json')) continue
    const artifact = JSON.parse(readFileSync(target, 'utf8'))
    if (!productionContracts.has(artifact.contractName)) continue
    const bytes = Math.max(0, (artifact.deployedBytecode.length - 2) / 2)
    results.push({ contract: artifact.contractName, bytes, remaining: EVM_RUNTIME_LIMIT - bytes })
  }
}

visit(artifactRoot)
results.sort((left, right) => right.bytes - left.bytes)
for (const result of results) {
  console.log(`${result.contract}: ${result.bytes} bytes (${result.remaining} bytes remaining)`)
}
const oversized = results.filter(({ bytes }) => bytes > EVM_RUNTIME_LIMIT)
if (oversized.length > 0) {
  throw new Error(`EVM runtime-size limit exceeded: ${oversized.map(({ contract }) => contract).join(', ')}`)
}
if (results.length !== productionContracts.size) {
  throw new Error('One or more production contract artifacts were not found.')
}
