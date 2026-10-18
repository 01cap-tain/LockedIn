# Deployment manifests

`deploy-amoy.js` writes immutable, versioned JSON manifests under `amoy/` and refreshes `amoy/latest.json`.

Manifests contain only public chain metadata, addresses and transaction references. Never place RPC URLs, API keys, mnemonics or private keys here.

The frontend factory address must be copied from the selected manifest into the deployment environment as `VITE_FACTORY_ADDRESS`; contract addresses are never embedded in source code.
