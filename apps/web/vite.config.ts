import react from "@vitejs/plugin-react";
import { existsSync, readFileSync } from "node:fs";
import path from "node:path";
import { defineConfig } from "vite";

interface AmoyManifest {
  schemaVersion: number;
  chainId: number;
  contracts: { vaultFactory: { address: string; blockNumber: number } };
  factoryConfiguration: { yieldAdapter: string };
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
    manifest.schemaVersion < 2 ||
    manifest.chainId !== 80_002 ||
    !manifest.contracts?.vaultFactory?.address ||
    !manifest.factoryConfiguration?.yieldAdapter
  ) {
    throw new Error(
      "The latest Amoy deployment is incompatible. Redeploy the cooperative-exit contracts."
    );
  }

  return {
    "import.meta.env.VITE_DEPLOYMENT_READY": JSON.stringify("true"),
    "import.meta.env.VITE_FACTORY_ADDRESS": JSON.stringify(
      manifest.contracts.vaultFactory.address
    ),
    "import.meta.env.VITE_CONTRACT_START_BLOCK": JSON.stringify(
      String(manifest.contracts.vaultFactory.blockNumber)
    ),
    "import.meta.env.VITE_YIELD_ADAPTER_KIND": JSON.stringify(
      manifest.factoryConfiguration.yieldAdapter
    ),
  };
}

export default defineConfig(({ mode }) => ({
  plugins: [react()],
  envDir: "../../",
  define: amoyFactoryDefinition(mode),
  server: {
    host: true,
    port: 5173,
  },
}));
