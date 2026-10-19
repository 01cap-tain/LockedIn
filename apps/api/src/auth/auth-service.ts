import { createHash, randomBytes } from 'node:crypto'

import { getAddress, verifyMessage } from 'ethers'

export interface NonceRecord {
  walletAddress: string
  message: string
  expiresAt: Date
  consumedAt: Date | null
}

export interface SessionRecord {
  walletAddress: string
  expiresAt: Date
}

export interface AuthRepository {
  createNonce(
    nonceHash: string,
    walletAddress: string,
    message: string,
    expiresAt: Date,
  ): Promise<void>
  findNonce(nonceHash: string, walletAddress: string): Promise<NonceRecord | null>
  consumeNonce(nonceHash: string, consumedAt: Date): Promise<boolean>
  createSession(tokenHash: string, walletAddress: string, expiresAt: Date): Promise<void>
  findSession(tokenHash: string, now: Date): Promise<SessionRecord | null>
  revokeSession(tokenHash: string, now: Date): Promise<void>
}

export interface AuthChallenge {
  address: string
  nonce: string
  message: string
  expiresAt: string
}

function hash(value: string): string {
  return createHash('sha256').update(value).digest('hex')
}

function authenticationError(message: string): Error & { statusCode: number } {
  return Object.assign(new Error(message), { statusCode: 401 })
}

export class WalletAuthService {
  constructor(
    private readonly repository: AuthRepository,
    private readonly nonceMinutes: number,
    private readonly sessionMinutes: number,
  ) {}

  async createChallenge(address: string, now = new Date()): Promise<AuthChallenge> {
    const normalized = getAddress(address).toLowerCase()
    const nonce = randomBytes(32).toString('hex')
    const expiresAt = new Date(now.getTime() + this.nonceMinutes * 60_000)
    const message = [
      'LockedIn Circle notification access',
      '',
      `Address: ${normalized}`,
      `Nonce: ${nonce}`,
      `Issued At: ${now.toISOString()}`,
      `Expiration Time: ${expiresAt.toISOString()}`,
      '',
      'This signature cannot move funds or approve contract transactions.',
    ].join('\n')
    await this.repository.createNonce(hash(nonce), normalized, message, expiresAt)
    return { address: normalized, nonce, message, expiresAt: expiresAt.toISOString() }
  }

  async verifyChallenge(
    address: string,
    nonce: string,
    signature: string,
    now = new Date(),
  ): Promise<{ token: string; address: string; expiresAt: string }> {
    const normalized = getAddress(address).toLowerCase()
    const nonceHash = hash(nonce)
    const record = await this.repository.findNonce(nonceHash, normalized)
    if (!record || record.consumedAt || record.expiresAt <= now) {
      throw authenticationError('The authentication nonce is invalid, expired, or already used.')
    }
    let recovered: string
    try {
      recovered = verifyMessage(record.message, signature).toLowerCase()
    } catch {
      throw authenticationError('The wallet signature is invalid.')
    }
    if (recovered !== normalized) {
      throw authenticationError('The wallet signature does not match the address.')
    }
    if (!await this.repository.consumeNonce(nonceHash, now)) {
      throw authenticationError('The authentication nonce was already used.')
    }

    const token = randomBytes(32).toString('base64url')
    const expiresAt = new Date(now.getTime() + this.sessionMinutes * 60_000)
    await this.repository.createSession(hash(token), normalized, expiresAt)
    return { token, address: normalized, expiresAt: expiresAt.toISOString() }
  }

  async authenticate(token: string, now = new Date()): Promise<SessionRecord | null> {
    if (!token) return null
    return this.repository.findSession(hash(token), now)
  }

  async logout(token: string, now = new Date()): Promise<void> {
    if (token) await this.repository.revokeSession(hash(token), now)
  }
}
