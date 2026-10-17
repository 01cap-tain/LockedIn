import { BrowserProvider, JsonRpcProvider, type Eip1193Provider, type Signer } from 'ethers'

export type EvmWalletSource = 'nimiq-pay' | 'hardhat-development'

export interface EvmWalletSession {
  address: string
  chainId: string
  signer: Signer
  source: EvmWalletSource
}

export interface Eip1193EventsProvider extends Eip1193Provider {
  on?: (event: string, listener: (...args: unknown[]) => void) => void
  removeListener?: (event: string, listener: (...args: unknown[]) => void) => void
}

export class EvmWalletError extends Error {
  constructor(
    readonly code: 'MISSING_PROVIDER' | 'CONNECTION_REJECTED' | 'WRONG_NETWORK' | 'CONNECTION_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

interface ConnectOptions {
  provider?: Eip1193EventsProvider
  expectedChainId?: string
  allowDevelopmentFallback?: boolean
  developmentRpcUrl?: string
}

function configuredChainId(): string {
  return (import.meta.env.VITE_EVM_CHAIN_ID ?? '0x7a69').toLowerCase()
}

function injectedProvider(): Eip1193EventsProvider | undefined {
  return typeof window === 'undefined' ? undefined : window.ethereum
}

function providerErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null || !('code' in error)) return undefined
  return typeof error.code === 'number' ? error.code : undefined
}

function normalizeChainId(chainId: unknown): string {
  if (typeof chainId !== 'string') throw new EvmWalletError('CONNECTION_FAILED', 'The EVM provider returned an invalid network.')
  return chainId.toLowerCase()
}

export async function connectEvmWallet(options: ConnectOptions = {}): Promise<EvmWalletSession> {
  const expectedChainId = (options.expectedChainId ?? configuredChainId()).toLowerCase()
  const provider = options.provider ?? injectedProvider()

  if (provider) {
    try {
      const accounts = await provider.request({ method: 'eth_requestAccounts' })
      const chainId = normalizeChainId(await provider.request({ method: 'eth_chainId' }))
      if (chainId !== expectedChainId) {
        throw new EvmWalletError(
          'WRONG_NETWORK',
          `Switch the EVM wallet to chain ${expectedChainId}; the connected chain is ${chainId}.`,
        )
      }
      if (!Array.isArray(accounts) || typeof accounts[0] !== 'string') {
        throw new EvmWalletError('CONNECTION_FAILED', 'The EVM wallet did not disclose an account.')
      }

      const browserProvider = new BrowserProvider(provider)
      const signer = await browserProvider.getSigner(accounts[0])
      return { address: await signer.getAddress(), chainId, signer, source: 'nimiq-pay' }
    } catch (error) {
      if (error instanceof EvmWalletError) throw error
      if (providerErrorCode(error) === 4001) {
        throw new EvmWalletError('CONNECTION_REJECTED', 'EVM wallet access was rejected.', { cause: error })
      }
      throw new EvmWalletError(
        'CONNECTION_FAILED',
        error instanceof Error ? error.message : 'The EVM wallet connection failed.',
        { cause: error },
      )
    }
  }

  const allowFallback = options.allowDevelopmentFallback
    ?? import.meta.env.VITE_ENABLE_HARDHAT_FALLBACK === 'true'
  if (!allowFallback) {
    throw new EvmWalletError(
      'MISSING_PROVIDER',
      'No supported EVM provider is available. Open the app inside Nimiq Pay.',
    )
  }

  const rpcUrl = options.developmentRpcUrl
    ?? import.meta.env.VITE_HARDHAT_RPC_URL
    ?? 'http://127.0.0.1:8545'
  const jsonRpcProvider = new JsonRpcProvider(rpcUrl)
  const network = await jsonRpcProvider.getNetwork()
  const chainId = `0x${network.chainId.toString(16)}`
  if (chainId !== expectedChainId) {
    throw new EvmWalletError('WRONG_NETWORK', `The Hardhat fallback is on ${chainId}, expected ${expectedChainId}.`)
  }
  const signer = await jsonRpcProvider.getSigner(0)
  return { address: await signer.getAddress(), chainId, signer, source: 'hardhat-development' }
}

export function watchEvmWallet(
  provider: Eip1193EventsProvider,
  handlers: { onAccountsChanged: (accounts: string[]) => void; onChainChanged: (chainId: string) => void },
): () => void {
  const accountsListener = (...args: unknown[]) => {
    const accounts = args[0]
    handlers.onAccountsChanged(Array.isArray(accounts) ? accounts.filter((item): item is string => typeof item === 'string') : [])
  }
  const chainListener = (...args: unknown[]) => handlers.onChainChanged(normalizeChainId(args[0]))
  provider.on?.('accountsChanged', accountsListener)
  provider.on?.('chainChanged', chainListener)
  return () => {
    provider.removeListener?.('accountsChanged', accountsListener)
    provider.removeListener?.('chainChanged', chainListener)
  }
}

export function getInjectedEvmProvider(): Eip1193EventsProvider | undefined {
  return injectedProvider()
}

declare global {
  interface Window {
    ethereum?: Eip1193EventsProvider
  }
}
