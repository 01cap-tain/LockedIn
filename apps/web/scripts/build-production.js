import { spawnSync } from "node:child_process";
import path from "node:path";
import process from "node:process";

const viteCli = path.resolve(import.meta.dirname, "../../../node_modules/vite/bin/vite.js");
const result = spawnSync(process.execPath, [viteCli, "build", "--mode", "production"], {
  stdio: "inherit",
  env: {
    ...process.env,
    NODE_ENV: "production",
    // Prevent an ignored root .env with NODE_ENV=development from making
    // Vite reactivate development transforms after configuration loads.
    VITE_USER_NODE_ENV: "production",
  },
});

if (result.error) throw result.error;
process.exit(result.status ?? 1);
