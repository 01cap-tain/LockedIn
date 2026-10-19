import { Wallet } from 'ethers'
import { describe, expect, it } from 'vitest'

import {
  WalletAuthService,
  type AuthRepository,
  type NonceRecord,
  type SessionRecord,
} from './auth-service.js'

class MemoryAuthRepository implements AuthRepository {
  readonly nonces = new Map<string, NonceRecord>()
  readonly sessions = new Map<string, SessionRecord & { revokedAt: Date | null }>()

  async createNonce(
    nonceHash: string,
    walletAddress: string,
    message: string,
    expiresAt: Date,
  ): Promise<void> {
    this.nonces.set(nonceHash, { walletAddress, message, expiresAt, consumedAt: null })
  }

  async findNonce(nonceHash: string, walletAddress: string): Promise<NonceRecord | null> {
    const record = this.nonces.get(nonceHash)
    return record?.walletAddress === walletAddress ? record : null
  }

  async consumeNonce(nonceHash: string, consumedAt: Date): Promise<boolean> {
    const record = this.nonces.get(nonceHash)
    if (!record || record.consumedAt || record.expiresAt <= consumedAt) return false
    record.consumedAt = consumedAt
    return true
  }

  async createSession(
    tokenHash: string,
    walletAddress: string,
    expiresAt: Date,
  ): Promise<void> {
    this.sessions.set(tokenHash, { walletAddress, expiresAt, revokedAt: null })
  }

  async findSession(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    const session = this.sessions.get(tokenHash)
    return session && !session.revokedAt && session.expiresAt > now ? session : null
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    const session = this.sessions.get(tokenHash)
    if (session) session.revokedAt = now
  }
}

describe('signed EVM wallet authentication', () => {
  it('issues a short session and rejects nonce replay', async () => {
    const repository = new MemoryAuthRepository()
    const service = new WalletAuthService(repository, 5, 30)
    const wallet = Wallet.createRandom()
    const now = new Date('2026-10-19T10:00:00.000Z')
    const challenge = await service.createChallenge(wallet.address, now)
    const signature = await wallet.signMessage(challenge.message)
    const session = await service.verifyChallenge(
      wallet.address,
      challenge.nonce,
      signature,
      new Date(now.getTime() + 1_000),
    )
    expect(session.address).toBe(wallet.address.toLowerCase())
    expect(await service.authenticate(session.token, new Date(now.getTime() + 2_000)))
      .toMatchObject({ walletAddress: wallet.address.toLowerCase() })
    await expect(service.verifyChallenge(
      wallet.address,
      challenge.nonce,
      signature,
      new Date(now.getTime() + 3_000),
    )).rejects.toThrow(/already used|invalid/i)
  })

  it('rejects expired nonces and signatures from another wallet', async () => {
    const repository = new MemoryAuthRepository()
    const service = new WalletAuthService(repository, 5, 30)
    const wallet = Wallet.createRandom()
    const attacker = Wallet.createRandom()
    const now = new Date('2026-10-19T10:00:00.000Z')
    const challenge = await service.createChallenge(wallet.address, now)
    await expect(service.verifyChallenge(
      wallet.address,
      challenge.nonce,
      await attacker.signMessage(challenge.message),
      new Date(now.getTime() + 1_000),
    )).rejects.toThrow(/does not match/i)
    await expect(service.verifyChallenge(
      wallet.address,
      challenge.nonce,
      await wallet.signMessage(challenge.message),
      new Date(now.getTime() + 6 * 60_000),
    )).rejects.toThrow(/expired/i)
  })

  it('expires and revokes bearer sessions without granting financial authority', async () => {
    const repository = new MemoryAuthRepository()
    const service = new WalletAuthService(repository, 5, 30)
    const wallet = Wallet.createRandom()
    const now = new Date('2026-10-19T10:00:00.000Z')
    const challenge = await service.createChallenge(wallet.address, now)
    const session = await service.verifyChallenge(
      wallet.address,
      challenge.nonce,
      await wallet.signMessage(challenge.message),
      now,
    )
    expect(await service.authenticate(session.token, new Date(now.getTime() + 31 * 60_000)))
      .toBeNull()
    await service.logout(session.token, now)
    expect(await service.authenticate(session.token, now)).toBeNull()
  })
})
