import { describe, expect, it, vi } from 'vitest'

import { connectEvmWallet, watchEvmWallet, type Eip1193EventsProvider } from './evm-wallet'

function providerWith(request: (method: string) => unknown): Eip1193EventsProvider {
  return {
    request: vi.fn(({ method }: { method: string }) => Promise.resolve(request(method))),
  }
}

describe('EVM wallet connection', () => {
  it('rejects a missing provider when the development fallback is disabled', async () => {
    await expect(connectEvmWallet({ expectedChainId: '0x89', allowDevelopmentFallback: false }))
      .rejects.toMatchObject({ code: 'MISSING_PROVIDER' })
  })

  it('maps user rejection to a typed connection error', async () => {
    const provider: Eip1193EventsProvider = {
      request: vi.fn().mockRejectedValue(Object.assign(new Error('Rejected'), { code: 4001 })),
    }
    await expect(connectEvmWallet({ provider, expectedChainId: '0x89' }))
      .rejects.toEqual(expect.objectContaining({ code: 'CONNECTION_REJECTED' }))
  })

  it('rejects a provider connected to the wrong chain', async () => {
    const provider = providerWith((method) => method === 'eth_requestAccounts'
      ? ['0x0000000000000000000000000000000000000001']
      : '0x1')
    await expect(connectEvmWallet({ provider, expectedChainId: '0x89' }))
      .rejects.toMatchObject({ code: 'WRONG_NETWORK' })
  })

  it('connects the EVM account exposed by an EIP-1193 provider', async () => {
    const address = '0x0000000000000000000000000000000000000001'
    const provider = providerWith((method) => {
      if (method === 'eth_requestAccounts' || method === 'eth_accounts') return [address]
      if (method === 'eth_chainId') return '0x89'
      throw new Error(`Unexpected method: ${method}`)
    })

    const session = await connectEvmWallet({ provider, expectedChainId: '0x89' })
    expect(session.address).toBe(address)
    expect(session.chainId).toBe('0x89')
    expect(session.source).toBe('nimiq-pay')
  })

  it('forwards account and chain changes and removes both listeners', () => {
    const listeners = new Map<string, (...args: unknown[]) => void>()
    const provider: Eip1193EventsProvider = {
      request: vi.fn(),
      on: vi.fn((event, listener) => listeners.set(event, listener)),
      removeListener: vi.fn((event) => listeners.delete(event)),
    }
    const onAccountsChanged = vi.fn()
    const onChainChanged = vi.fn()
    const stop = watchEvmWallet(provider, { onAccountsChanged, onChainChanged })

    listeners.get('accountsChanged')?.(['0xabc'])
    listeners.get('chainChanged')?.('0x89')
    expect(onAccountsChanged).toHaveBeenCalledWith(['0xabc'])
    expect(onChainChanged).toHaveBeenCalledWith('0x89')
    stop()
    expect(provider.removeListener).toHaveBeenCalledTimes(2)
  })
})
