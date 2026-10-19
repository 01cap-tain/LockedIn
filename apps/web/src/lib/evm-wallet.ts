import {
  BrowserProvider,
  JsonRpcProvider,
  type Eip1193Provider,
  type Signer,
} from "ethers";

export type EvmWalletSource = "injected-wallet" | "hardhat-development";

export interface EvmWalletSession {
  address: string;
  chainId: string;
  signer: Signer;
  source: EvmWalletSource;
}

export interface Eip1193EventsProvider extends Eip1193Provider {
  on?: (event: string, listener: (...args: unknown[]) => void) => void;
  removeListener?: (
    event: string,
    listener: (...args: unknown[]) => void
  ) => void;
}

export class EvmWalletError extends Error {
  constructor(
    readonly code:
      | "MISSING_PROVIDER"
      | "CONNECTION_REJECTED"
      | "WRONG_NETWORK"
      | "CONNECTION_FAILED",
    message: string,
    options?: ErrorOptions
  ) {
    super(message, options);
  }
}

interface ConnectOptions {
  provider?: Eip1193EventsProvider;
  expectedChainId?: string;
  allowDevelopmentFallback?: boolean;
  developmentRpcUrl?: string;
  developmentAccountIndex?: number;
  forceDevelopmentFallback?: boolean;
}

interface AddEthereumChainParameter {
  chainId: string;
  chainName: string;
  nativeCurrency: {
    name: string;
    symbol: string;
    decimals: number;
  };
  rpcUrls: string[];
  blockExplorerUrls: string[];
}

const POLYGON_AMOY_CHAIN_ID = "0x13882";

/**
 * Returns public metadata that an injected wallet can use to add a missing
 * test network. Application RPC credentials are deliberately not used here:
 * values passed to `wallet_addEthereumChain` are visible to the wallet/user.
 */
function addChainParameter(
  chainId: string
): AddEthereumChainParameter | undefined {
  if (chainId !== POLYGON_AMOY_CHAIN_ID) return undefined;

  return {
    chainId: POLYGON_AMOY_CHAIN_ID,
    chainName: "Polygon Amoy",
    nativeCurrency: { name: "POL", symbol: "POL", decimals: 18 },
    rpcUrls: ["https://rpc-amoy.polygon.technology/"],
    blockExplorerUrls: ["https://amoy.polygonscan.com/"],
  };
}

function configuredChainId(): string {
  return (import.meta.env.VITE_EVM_CHAIN_ID ?? "0x7a69").toLowerCase();
}

function injectedProvider(): Eip1193EventsProvider | undefined {
  return typeof window === "undefined" ? undefined : window.ethereum;
}

function providerErrorCode(error: unknown): number | undefined {
  if (typeof error !== "object" || error === null) return undefined;

  if ("code" in error) {
    if (typeof error.code === "number") return error.code;
    if (typeof error.code === "string") {
      const parsedCode = Number(error.code);
      if (Number.isFinite(parsedCode)) return parsedCode;
    }
  }

  // Some wallet bridges wrap the original EIP-1193 error.
  if ("error" in error) return providerErrorCode(error.error);
  if ("cause" in error) return providerErrorCode(error.cause);
  return undefined;
}

/**
 * Wallet extensions frequently reject with a plain JSON object rather than an
 * `Error`. Preserve the provider's useful explanation without exposing the
 * whole object (which may contain verbose request payloads).
 */
function providerErrorMessage(error: unknown, depth = 0): string | undefined {
  if (depth > 3) return undefined;
  if (error instanceof Error && error.message.trim()) return error.message;
  if (typeof error !== "object" || error === null) return undefined;
  const record = error as Record<string, unknown>;

  for (const key of ["shortMessage", "message", "reason"] as const) {
    if (key in record) {
      const value = record[key];
      if (typeof value === "string" && value.trim()) return value;
    }
  }

  for (const key of ["error", "cause", "data"] as const) {
    if (key in record) {
      const nestedMessage = providerErrorMessage(record[key], depth + 1);
      if (nestedMessage) return nestedMessage;
    }
  }
  return undefined;
}

function normalizeChainId(chainId: unknown): string {
  if (typeof chainId !== "string")
    throw new EvmWalletError(
      "CONNECTION_FAILED",
      "The EVM provider returned an invalid network."
    );
  return chainId.toLowerCase();
}

/**
 * Requests a wallet-controlled network change. MetaMask uses error 4902 when
 * the requested chain is unknown; for Amoy we can then present its standard
 * network metadata and let the user approve adding it.
 */
async function selectExpectedChain(
  provider: Eip1193EventsProvider,
  expectedChainId: string
): Promise<string> {
  let chainId = normalizeChainId(
    await provider.request({ method: "eth_chainId" })
  );
  if (chainId === expectedChainId) return chainId;

  try {
    await provider.request({
      method: "wallet_switchEthereumChain",
      params: [{ chainId: expectedChainId }],
    });
  } catch (error) {
    if (providerErrorCode(error) !== 4902) throw error;

    const chainParameter = addChainParameter(expectedChainId);
    if (!chainParameter) throw error;
    await provider.request({
      method: "wallet_addEthereumChain",
      params: [chainParameter],
    });
  }

  chainId = normalizeChainId(await provider.request({ method: "eth_chainId" }));
  if (chainId !== expectedChainId) {
    throw new EvmWalletError(
      "WRONG_NETWORK",
      `Switch the EVM wallet to chain ${expectedChainId}; the connected chain is ${chainId}.`
    );
  }
  return chainId;
}

export async function connectEvmWallet(
  options: ConnectOptions = {}
): Promise<EvmWalletSession> {
  const expectedChainId = (
    options.expectedChainId ?? configuredChainId()
  ).toLowerCase();
  const provider = options.forceDevelopmentFallback
    ? undefined
    : options.provider ?? injectedProvider();

  if (provider) {
    try {
      const accounts = await provider.request({
        method: "eth_requestAccounts",
      });
      // Account access and network selection are separate wallet approvals.
      // An already-authorized site may skip the first prompt but still show
      // MetaMask's confirmation dialog when a network change is necessary.
      const chainId = await selectExpectedChain(provider, expectedChainId);
      if (!Array.isArray(accounts) || typeof accounts[0] !== "string") {
        throw new EvmWalletError(
          "CONNECTION_FAILED",
          "The EVM wallet did not disclose an account."
        );
      }

      const browserProvider = new BrowserProvider(provider);
      const signer = await browserProvider.getSigner(accounts[0]);
      return {
        address: await signer.getAddress(),
        chainId,
        signer,
        source: "injected-wallet",
      };
    } catch (error) {
      if (error instanceof EvmWalletError) throw error;
      if (providerErrorCode(error) === 4001) {
        throw new EvmWalletError(
          "CONNECTION_REJECTED",
          "EVM wallet access was rejected.",
          { cause: error }
        );
      }
      throw new EvmWalletError(
        "CONNECTION_FAILED",
        providerErrorMessage(error) ?? "The EVM wallet connection failed.",
        { cause: error }
      );
    }
  }

  const allowFallback =
    options.allowDevelopmentFallback ??
    import.meta.env.VITE_ENABLE_HARDHAT_FALLBACK === "true";
  if (!allowFallback) {
    throw new EvmWalletError(
      "MISSING_PROVIDER",
      "No injected EVM wallet is available. Enable MetaMask in this browser or open the app inside Nimiq Pay."
    );
  }

  const rpcUrl =
    options.developmentRpcUrl ??
    import.meta.env.VITE_HARDHAT_RPC_URL ??
    "http://127.0.0.1:8545";
  const jsonRpcProvider = new JsonRpcProvider(rpcUrl);
  const network = await jsonRpcProvider.getNetwork();
  const chainId = `0x${network.chainId.toString(16)}`;
  if (chainId !== expectedChainId) {
    throw new EvmWalletError(
      "WRONG_NETWORK",
      `The Hardhat fallback is on ${chainId}, expected ${expectedChainId}.`
    );
  }
  const signer = await jsonRpcProvider.getSigner(
    options.developmentAccountIndex ?? 0
  );
  return {
    address: await signer.getAddress(),
    chainId,
    signer,
    source: "hardhat-development",
  };
}

export async function listDevelopmentAccounts(
  rpcUrl = import.meta.env.VITE_HARDHAT_RPC_URL ?? "http://127.0.0.1:8545"
): Promise<string[]> {
  const provider = new JsonRpcProvider(rpcUrl);
  return (await provider.listAccounts()).map((signer) => signer.address);
}

export function watchEvmWallet(
  provider: Eip1193EventsProvider,
  handlers: {
    onAccountsChanged: (accounts: string[]) => void;
    onChainChanged: (chainId: string) => void;
  }
): () => void {
  const accountsListener = (...args: unknown[]) => {
    const accounts = args[0];
    handlers.onAccountsChanged(
      Array.isArray(accounts)
        ? accounts.filter((item): item is string => typeof item === "string")
        : []
    );
  };
  const chainListener = (...args: unknown[]) =>
    handlers.onChainChanged(normalizeChainId(args[0]));
  provider.on?.("accountsChanged", accountsListener);
  provider.on?.("chainChanged", chainListener);
  return () => {
    provider.removeListener?.("accountsChanged", accountsListener);
    provider.removeListener?.("chainChanged", chainListener);
  };
}

export function getInjectedEvmProvider(): Eip1193EventsProvider | undefined {
  return injectedProvider();
}

declare global {
  interface Window {
    ethereum?: Eip1193EventsProvider;
  }
}
