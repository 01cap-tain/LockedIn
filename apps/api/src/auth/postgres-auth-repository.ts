import type { DatabasePool } from '../db.js'
import type {
  AuthRepository,
  NonceRecord,
  SessionRecord,
} from './auth-service.js'

export class PostgresAuthRepository implements AuthRepository {
  constructor(private readonly pool: DatabasePool) {}

  async createNonce(
    nonceHash: string,
    walletAddress: string,
    message: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_nonces (nonce_hash, wallet_address, message, expires_at)
       VALUES ($1, $2, $3, $4)`,
      [nonceHash, walletAddress, message, expiresAt],
    )
  }

  async findNonce(nonceHash: string, walletAddress: string): Promise<NonceRecord | null> {
    const result = await this.pool.query<{
      wallet_address: string
      message: string
      expires_at: Date
      consumed_at: Date | null
    }>(
      `SELECT wallet_address, message, expires_at, consumed_at
       FROM auth_nonces WHERE nonce_hash = $1 AND wallet_address = $2`,
      [nonceHash, walletAddress],
    )
    const row = result.rows[0]
    return row ? {
      walletAddress: row.wallet_address,
      message: row.message,
      expiresAt: row.expires_at,
      consumedAt: row.consumed_at,
    } : null
  }

  async consumeNonce(nonceHash: string, consumedAt: Date): Promise<boolean> {
    const result = await this.pool.query(
      `UPDATE auth_nonces SET consumed_at = $2
       WHERE nonce_hash = $1 AND consumed_at IS NULL AND expires_at > $2`,
      [nonceHash, consumedAt],
    )
    return result.rowCount === 1
  }

  async createSession(
    tokenHash: string,
    walletAddress: string,
    expiresAt: Date,
  ): Promise<void> {
    await this.pool.query(
      `INSERT INTO auth_sessions (token_hash, wallet_address, expires_at)
       VALUES ($1, $2, $3)`,
      [tokenHash, walletAddress, expiresAt],
    )
  }

  async findSession(tokenHash: string, now: Date): Promise<SessionRecord | null> {
    const result = await this.pool.query<{ wallet_address: string; expires_at: Date }>(
      `SELECT wallet_address, expires_at FROM auth_sessions
       WHERE token_hash = $1 AND revoked_at IS NULL AND expires_at > $2`,
      [tokenHash, now],
    )
    const row = result.rows[0]
    return row ? { walletAddress: row.wallet_address, expiresAt: row.expires_at } : null
  }

  async revokeSession(tokenHash: string, now: Date): Promise<void> {
    await this.pool.query(
      'UPDATE auth_sessions SET revoked_at = $2 WHERE token_hash = $1 AND revoked_at IS NULL',
      [tokenHash, now],
    )
  }
}
