import { beforeEach, describe, expect, it, vi } from 'vitest'

const sdk = vi.hoisted(() => ({
  getHostNetwork: vi.fn<() => string | undefined>(),
  init: vi.fn(),
  listAccounts: vi.fn(),
}))

vi.mock('@nimiq/mini-app-sdk', () => ({
  getHostNetwork: sdk.getHostNetwork,
  init: sdk.init,
  NimiqProviderError: { is: () => false },
}))

import {
  connectNimiqWallet,
  describeWalletError,
  getNimiqEnvironment,
  WalletConnectionError,
} from './nimiq'

beforeEach(() => {
  sdk.getHostNetwork.mockReset()
  sdk.init.mockReset()
  sdk.listAccounts.mockReset()
})

describe('Nimiq Pay connection', () => {
  it('detects the host network exposed by Nimiq Pay', () => {
    sdk.getHostNetwork.mockReturnValue('test')

    expect(getNimiqEnvironment()).toEqual({ isNimiqPay: true, network: 'test' })
  })

  it('initializes the official provider and reads the disclosed wallet address', async () => {
    sdk.getHostNetwork.mockReturnValue('main')
    sdk.listAccounts.mockResolvedValue(['NQ12 TEST ADDRESS'])
    sdk.init.mockResolvedValue({ listAccounts: sdk.listAccounts })

    await expect(connectNimiqWallet()).resolves.toEqual({
      address: 'NQ12 TEST ADDRESS',
      accounts: ['NQ12 TEST ADDRESS'],
      network: 'main',
    })
    expect(sdk.init).toHaveBeenCalledWith({ timeout: 10_000 })
    expect(sdk.listAccounts).toHaveBeenCalledOnce()
  })
})

describe('wallet error handling', () => {
  it('preserves typed wallet errors', () => {
    const error = new WalletConnectionError('NO_ACCOUNTS', 'No account was disclosed')
    expect(describeWalletError(error)).toBe(error)
  })

  it('turns provider-injection failures into an unsupported-environment message', () => {
    const error = describeWalletError(new Error('Provider injection timeout'))
    expect(error.code).toBe('UNSUPPORTED_ENVIRONMENT')
    expect(error.message).toContain('inside Nimiq Pay')
  })
})
