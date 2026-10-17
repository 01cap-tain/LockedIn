import {
  getHostNetwork,
  init,
  NimiqProviderError,
  type NimiqProvider,
} from '@nimiq/mini-app-sdk'

let providerPromise: Promise<NimiqProvider> | null = null

export interface WalletConnection {
  address: string
  accounts: string[]
  network: string | null
}

export interface NimiqEnvironment {
  isNimiqPay: boolean
  network: string | null
}

export class WalletConnectionError extends Error {
  constructor(
    readonly code: 'UNSUPPORTED_ENVIRONMENT' | 'NO_ACCOUNTS' | 'CONNECTION_FAILED',
    message: string,
    options?: ErrorOptions,
  ) {
    super(message, options)
  }
}

export function getNimiqEnvironment(): NimiqEnvironment {
  const network = getHostNetwork() ?? null
  return { isNimiqPay: network !== null, network }
}

export function describeWalletError(error: unknown): WalletConnectionError {
  if (error instanceof WalletConnectionError) return error
  if (NimiqProviderError.is(error)) {
    return new WalletConnectionError('CONNECTION_FAILED', error.message, { cause: error })
  }
  if (error instanceof Error && /inject|provider|timeout/i.test(error.message)) {
    return new WalletConnectionError(
      'UNSUPPORTED_ENVIRONMENT',
      'Open LockedIn Circle inside Nimiq Pay to connect your wallet.',
      { cause: error },
    )
  }
  return new WalletConnectionError(
    'CONNECTION_FAILED',
    error instanceof Error ? error.message : 'Nimiq Pay could not complete the connection.',
    { cause: error },
  )
}

export async function getNimiqProvider(): Promise<NimiqProvider> {
  providerPromise ??= init({ timeout: 10_000 }).catch((error: unknown) => {
    providerPromise = null
    throw describeWalletError(error)
  })
  return providerPromise
}

export async function connectNimiqWallet(): Promise<WalletConnection> {
  try {
    const provider = await getNimiqProvider()
    const accounts = await provider.listAccounts()
    const address = accounts[0]
    if (!address) {
      throw new WalletConnectionError(
        'NO_ACCOUNTS',
        'Nimiq Pay did not disclose an account. Approve account access and try again.',
      )
    }
    return { address, accounts, network: getHostNetwork() ?? null }
  } catch (error) {
    throw describeWalletError(error)
  }
}
