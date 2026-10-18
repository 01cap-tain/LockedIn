import react from '@vitejs/plugin-react'
import { readFileSync } from 'node:fs'
import path from 'node:path'
import { defineConfig } from 'vite'

interface AmoyManifest {
  chainId: number
  contracts: { vaultFactory: { address: string; blockNumber: number } }
}

function amoyFactoryDefinition(mode: string): Record<string, string> {
  if (mode !== 'amoy') return {}

  // Amoy's public contract address comes from the versioned deployment record.
  // Secret RPC and signer values remain in the root's ignored .env.amoy file.
  const manifestPath = path.resolve(
    import.meta.dirname,
    '../../packages/contracts/deployments/amoy/latest.json'
  )
  let manifest: AmoyManifest
  try {
    manifest = JSON.parse(readFileSync(manifestPath, 'utf8')) as AmoyManifest
  } catch {
    throw new Error(
      'Amoy deployment manifest not found. Run npm run contracts:deploy:amoy first.'
    )
  }
  if (manifest.chainId !== 80_002 || !manifest.contracts?.vaultFactory?.address) {
    throw new Error('The latest Amoy deployment manifest is invalid.')
  }

  return {
    'import.meta.env.VITE_FACTORY_ADDRESS': JSON.stringify(
      manifest.contracts.vaultFactory.address
    ),
    'import.meta.env.VITE_CONTRACT_START_BLOCK': JSON.stringify(
      String(manifest.contracts.vaultFactory.blockNumber)
    ),
  }
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  envDir: '../../',
  define: amoyFactoryDefinition(mode),
  server: {
    host: true,
    port: 5173,
  },
}))
