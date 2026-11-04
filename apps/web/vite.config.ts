import react from "@vitejs/plugin-react";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

interface AmoyManifest {
  schemaVersion: number;
  chainId: number;
  protocolVersion: string;
  deploymentId: string;
  deploymentBlock: number;
  contracts: {
    mockUsdt: { address: string };
    vaultFactory: { address: string; blockNumber: number };
    earlyExitMarket: { address: string };
    safetyController: { address: string };
  };
  profile?: string;
  factoryConfiguration?: { yieldAdapter?: string; vaultMode?: string; minimumMaturitySeconds?: number; testConfiguration?: boolean };
}

function amoyFactoryDefinition(mode: string): Record<string, string> {
  if (mode !== "amoy") return {};

  // Amoy's public contract address comes from the versioned deployment record.
  // Secret RPC and signer values remain in the root's ignored .env.amoy file.
  const manifestPath = path.resolve(
    import.meta.dirname,
    "../../packages/contracts/deployments/amoy/latest.json"
  );
  if (!existsSync(manifestPath)) {
    return {
      "import.meta.env.VITE_DEPLOYMENT_READY": JSON.stringify("false"),
    };
  }
  let manifest: AmoyManifest;
  try {
    manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as AmoyManifest;
  } catch {
    throw new Error("The latest Amoy deployment manifest is not valid JSON.");
  }
  if (
    manifest.schemaVersion < 5 ||
    manifest.chainId !== 80_002 ||
    !manifest.protocolVersion ||
    !manifest.deploymentId ||
    !manifest.deploymentBlock ||
    !manifest.contracts?.mockUsdt?.address ||
    !manifest.contracts?.vaultFactory?.address ||
    !manifest.contracts?.earlyExitMarket?.address ||
    !manifest.contracts?.safetyController?.address
  ) {
    return {
      "import.meta.env.VITE_DEPLOYMENT_READY": JSON.stringify("false"),
      "import.meta.env.VITE_DEPLOYMENT_BLOCK_REASON": JSON.stringify(
        "The Amoy manifest predates deployment-identity verification. Deploy the current contracts before enabling transactions."
      ),
    };
  }

  const deploymentDirectory = path.dirname(manifestPath);
  const deployments = readdirSync(deploymentDirectory)
    .filter((name) => name.endsWith(".json") && name !== "latest.json" && name !== "latest-flow.json")
    .flatMap((name) => {
      try {
        const candidate = JSON.parse(readFileSync(path.join(deploymentDirectory, name), "utf8")) as AmoyManifest;
        if (candidate.schemaVersion < 5 || candidate.chainId !== manifest.chainId || !candidate.contracts?.vaultFactory?.address) return [];
        return [{
          deploymentId: candidate.deploymentId,
          protocolVersion: candidate.protocolVersion,
          factoryAddress: candidate.contracts.vaultFactory.address,
          marketAddress: candidate.contracts.earlyExitMarket.address,
          deploymentBlock: candidate.contracts.vaultFactory.blockNumber,
          legacy: candidate.deploymentId !== manifest.deploymentId,
        }];
      } catch {
        return [];
      }
    })
    .filter((entry, index, entries) => entries.findIndex((other) => other.factoryAddress.toLowerCase() === entry.factoryAddress.toLowerCase()) === index);

  return {
    "import.meta.env.VITE_DEPLOYMENT_READY": JSON.stringify("true"),
    "import.meta.env.VITE_FACTORY_ADDRESS": JSON.stringify(
      manifest.contracts.vaultFactory.address
    ),
    "import.meta.env.VITE_CONTRACT_START_BLOCK": JSON.stringify(
      String(manifest.contracts.vaultFactory.blockNumber)
    ),
    "import.meta.env.VITE_YIELD_ADAPTER_KIND": JSON.stringify(
      manifest.factoryConfiguration?.yieldAdapter ?? "Disabled"
    ),
    "import.meta.env.VITE_EXPECTED_CHAIN_ID": JSON.stringify(String(manifest.chainId)),
    "import.meta.env.VITE_EXPECTED_PROTOCOL_VERSION": JSON.stringify(manifest.protocolVersion),
    "import.meta.env.VITE_EXPECTED_DEPLOYMENT_ID": JSON.stringify(manifest.deploymentId),
    "import.meta.env.VITE_EXPECTED_ASSET_ADDRESS": JSON.stringify(manifest.contracts.mockUsdt.address),
    "import.meta.env.VITE_EXPECTED_MARKET_ADDRESS": JSON.stringify(manifest.contracts.earlyExitMarket.address),
    "import.meta.env.VITE_EXPECTED_SAFETY_CONTROLLER_ADDRESS": JSON.stringify(manifest.contracts.safetyController.address),
    "import.meta.env.VITE_DEPLOYMENTS_JSON": JSON.stringify(JSON.stringify(deployments)),
    "import.meta.env.VITE_MIN_MATURITY_SECONDS": JSON.stringify(String(manifest.factoryConfiguration?.minimumMaturitySeconds ?? 3_600)),
    "import.meta.env.VITE_TEST_CONFIGURATION": JSON.stringify(String(Boolean(manifest.factoryConfiguration?.testConfiguration))),
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  envDir: "../../",
  define: amoyFactoryDefinition(mode),
  server: {
    host: true,
    port: 5173,
    // Never hide a stale build by silently opening 5174/5175. The developer
    // must stop the process already holding 5173, making manifest mismatches
    // visible instead of serving multiple deployment versions at once.
    strictPort: true,
    // Keep the API bound to localhost during LAN/mobile development. Browsers
    // use this same-origin proxy, including the long-lived SSE connection.
    proxy: {
      "/api": {
        target: "http://127.0.0.1:3001",
        changeOrigin: false,
      },
    },
  },
  build: {
    rollupOptions: {
      output: {
        // Wallet and chain libraries change independently from application UI.
        // Stable vendor chunks keep route changes small and cacheable.
        manualChunks(id) {
          if (id.includes("node_modules/ethers")) return "evm-vendor";
          if (id.includes("node_modules/@nimiq")) return "nimiq-vendor";
          if (id.includes("node_modules/react")) return "react-vendor";
          return undefined;
        },
      },
    },
  },
}));
