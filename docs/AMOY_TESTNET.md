# Polygon Amoy persistent testnet

## Security boundary

Amoy chain state is authoritative for vault balances, position ownership, deterministic discounts and settlement. Deployment manifests contain public metadata only. RPC credentials, API keys, private keys and mnemonics belong only in the ignored `.env.amoy` file or a CI secret store.

Never use a funded production wallet for this testnet. Create disposable Amoy-only wallets and fund them with test POL.

## Network

- Chain ID: `80002` (`0x13882`)
- Native test token: POL
- Explorer: `https://amoy.polygonscan.com`
- RPC: supplied as `AMOY_RPC_URL`; no credential-bearing URL is committed

Polygon documents Amoy chain ID 80002 and the Amoy PolygonScan explorer. Aave does not publish an official Polygon Amoy V3 deployment used by this project, so the testnet deployment uses `MockUSDT` and an isolated `MockYieldAdapter` for every Earn vault. The production `AaveYieldAdapter` remains covered locally and through an explicitly configured Polygon-mainnet fork.

## Configure

Copy `.env.amoy.example` to `.env.amoy` and fill its blank values. The file is ignored by Git. Use three distinct disposable private keys: deployer, wallet A and wallet B. Risk-reserve and maintenance addresses must also be non-zero and distinct.

The Hardhat configuration reads `.env.amoy` using Node's built-in environment-file loader. Vite exposes only variables prefixed with `VITE_`; private key variables are never included in the browser bundle.

## Deploy and test

```powershell
npm run build -w @lockedin-circle/contracts
npm run contracts:deploy:amoy
```

The deployer writes a timestamped manifest and `packages/contracts/deployments/amoy/latest.json`. Amoy-mode Vite reads the public factory address directly from that manifest; no address is copied into source code or `.env.amoy`. Then run:

```powershell
npm run contracts:test:amoy
npm run contracts:test:amoy:persistence
npm run dev:amoy
```

The first flow creates Safe and Earn vaults with two wallets, deposits MockUSDT, settles an early exit, checks the 0.9% fee split and funds mock yield. The persistence command starts a fresh process and re-queries ownership and listing state. Restarting Vite cannot erase Amoy state.

For PolygonScan verification, configure `POLYGONSCAN_API_KEY` and run:

```powershell
npm run contracts:verify:amoy
```

## Nimiq Pay limitation

Nimiq Pay officially documents an injected standard Ethereum provider and production Polygon support, but its official published network list does not establish Polygon Amoy support. Until a real-device probe succeeds, use a development EVM wallet that supports custom Amoy connections. The Nimiq identity connection remains usable but is not the signer for Amoy contract transactions.
