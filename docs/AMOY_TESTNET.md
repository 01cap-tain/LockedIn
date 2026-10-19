# Polygon Amoy persistent testnet

## Security boundary

Amoy chain state is authoritative for vault balances, position ownership, deterministic discounts and settlement. Deployment manifests contain public metadata only. RPC credentials, API keys, private keys and mnemonics belong only in the ignored `.env.amoy` file or a CI secret store.

Never use a funded production wallet for this testnet. Create disposable Amoy-only wallets and fund them with test POL. The deployment creates a standalone SafetyController followed by the factory, whose constructor creates its RewardPool and EarlyExitMarket, so it is substantially more expensive than the two mock contracts. The deployment script checks a live gas-price-based balance budget before sending its first transaction; approximately 0.5 test POL is a sensible starting balance, but the script's current calculation is authoritative.

## Network

- Chain ID: `80002` (`0x13882`)
- Native test token: POL
- Explorer: `https://amoy.polygonscan.com`
- RPC: supplied as `AMOY_RPC_URL`; no real credential-bearing URL is committed

Polygon documents Amoy chain ID 80002 and the Amoy PolygonScan explorer. Aave does not publish an official Polygon Amoy V3 deployment used by this project, so the testnet deployment uses `MockUSDT` and an isolated `MockYieldAdapter` for every Earn vault. The production `AaveYieldAdapter` remains covered locally and through an explicitly configured Polygon-mainnet fork.

## Configure

Copy `.env.amoy.example` to `.env.amoy` and fill its blank values. The file is ignored by Git. The deployer is the only required private key. Risk-reserve and maintenance addresses are public recipient addresses; they must be non-zero and distinct.

Use a dedicated Amoy endpoint such as `https://polygon-amoy.g.alchemy.com/v2/YOUR_ALCHEMY_API_KEY`. The formerly documented `rpc-amoy.polygon.technology` host may fail DNS resolution, while shared demo endpoints can return rate-limit errors during deployment.

For interactive testing, leave `AMOY_WALLET_A_PRIVATE_KEY` and `AMOY_WALLET_B_PRIVATE_KEY` blank. Connect Wallet A through MetaMask, use the Wallet page to mint valueless test mUSDT, and perform the saver flow. Then switch MetaMask to Wallet B; the app listens for the account change, clears address-scoped state and reloads the market for the new signer. Wallet B can mint its own test mUSDT before funding the listing.

The two optional wallet private keys are needed only by `contracts:test:amoy`, which provides a repeatable automated CLI version of the same flow. Never export real or funded-wallet keys for this test.

The Amoy safety council is deliberately the disposable deployer and is labelled `test-only-deployer` in the manifest. Its unpause/cap timelock is 24 hours. Testnet exposure caps are 1,000,000 mUSDT per position, 10,000,000 mUSDT per vault and 100,000,000 mUSDT protocol-wide. These high values are test configuration, not proposed production economics. Production safety authority must be a reviewed multisig, and production caps remain unset until audit and economic review.

The Hardhat configuration reads `.env.amoy` using Node's built-in environment-file loader. Vite exposes only variables prefixed with `VITE_`; private key variables are never included in the browser bundle.

## Deploy and test

```powershell
npm run build -w @lockedin-circle/contracts
npm run contracts:deploy:amoy
```

The deployer writes a timestamped manifest and `packages/contracts/deployments/amoy/latest.json`. Amoy-mode Vite reads the public factory address directly from that manifest; no address is copied into source code or `.env.amoy`. Before deployment, `dev:amoy` may still be used to test MetaMask connection, but it disables all contract actions and displays a deployment-pending notice. Restart Vite after deployment, then run:

```powershell
npm run contracts:test:amoy
npm run contracts:test:amoy:persistence
npm run dev:amoy
```

When the optional Wallet A/B keys are configured, the automated flow creates Safe and Earn vaults with two wallets, deposits MockUSDT, settles an early exit, checks the 0.9% fee split and funds mock yield. The persistence command starts a fresh process and re-queries ownership and listing state. When testing with MetaMask instead, perform those actions in the UI; restarting Vite cannot erase Amoy state because the contracts retain it on Amoy.

For PolygonScan verification, configure `POLYGONSCAN_API_KEY` and run:

```powershell
npm run contracts:verify:amoy
```

## Nimiq Pay limitation

Nimiq Pay officially documents an injected standard Ethereum provider and production Polygon support, but its official published network list does not establish Polygon Amoy support. Until a real-device probe succeeds, use a development EVM wallet that supports custom Amoy connections. The Nimiq identity connection remains usable but is not the signer for Amoy contract transactions.
