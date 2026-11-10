# Deployment manifests

This directory contains public, versioned deployment records. A manifest is an immutable description of a deployment, not a source of secrets and not an upgrade mechanism.

## Polygon mainnet

The active Safe-only V1 deployment is recorded in [`polygon/latest.json`](polygon/latest.json). The timestamped file in the same directory is the permanent deployment record.

The mainnet manifest includes:

- Polygon chain ID and deployment block;
- protocol version and deployment identity;
- official Polygon USDT address and token decimals;
- deployed contract addresses and transaction hashes;
- constructor arguments;
- Safe-only feature flags;
- fee destination and distribution;
- Safety Council authority, timelock and exposure limits; and
- the exact source commit used for deployment.

Production consumers must verify the complete manifest identity before enabling writes. Do not mix an address from one deployment with the deployment ID, block or factory from another.

## Polygon Amoy

The `amoy/` directory contains development-only and historical testnet deployments. Amoy uses chain ID `80002`, test tokens and test-only configuration. Nothing in an Amoy manifest is a production asset or production contract address.

The Amoy deployment script writes timestamped JSON manifests and refreshes `amoy/latest.json` for the active development deployment.

## Secret boundary

Manifests contain public chain metadata only. Never add any of the following:

- RPC credentials or credential-bearing RPC URLs;
- API keys;
- private keys, mnemonics or keystore passwords;
- database credentials; or
- authentication tokens.

Private deployment configuration belongs in an ignored local environment or a managed secret store. Browser configuration must use only public values, and financial writes must remain disabled when manifest verification fails.
