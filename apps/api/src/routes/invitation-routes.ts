import { createHash, randomInt } from 'node:crypto'

import { Contract, JsonRpcProvider, getAddress, isAddress } from 'ethers'
import type { FastifyInstance, FastifyRequest } from 'fastify'
import { z } from 'zod'

import type { WalletAuthService } from '../auth/auth-service.js'
import type { ApiConfig } from '../config.js'
import type { DatabasePool } from '../db.js'

const ALPHABET = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'
const vaultAbi = [
  'function groupCreator() view returns (address)',
  'function activeGroupInvitation(address) view returns (bytes32)',
  'function invitationStatus(bytes32) view returns (uint8)',
] as const

export function generateInvitationCode(): string {
  return Array.from({ length: 6 }, () => ALPHABET[randomInt(ALPHABET.length)]).join('')
}

function bearer(request: FastifyRequest): string {
  const header = request.headers.authorization
  return header?.startsWith('Bearer ') ? header.slice(7) : ''
}

async function wallet(request: FastifyRequest, service: WalletAuthService): Promise<string> {
  const session = await service.authenticate(bearer(request))
  if (!session) throw Object.assign(new Error('Authentication required.'), { statusCode: 401 })
  return getAddress(session.walletAddress).toLowerCase()
}

function genericInviteError(statusCode = 404): Error & { statusCode: number } {
  return Object.assign(new Error('This invitation is invalid or no longer available.'), { statusCode })
}

export async function registerInvitationRoutes(
  app: FastifyInstance,
  pool: DatabasePool,
  auth: WalletAuthService,
  config: ApiConfig,
): Promise<void> {
  const provider = new JsonRpcProvider(config.rpcUrl, config.manifest.chainId, { staticNetwork: true })

  app.put('/api/profile/username', async (request) => {
    const address = await wallet(request, auth)
    const body = z.object({ username: z.string().trim().min(3).max(24).regex(/^[A-Za-z0-9_]+$/) }).parse(request.body)
    const normalized = body.username.toLowerCase()
    const result = await pool.query(
      `INSERT INTO verified_wallet_profiles (wallet_address, username, username_normalized)
       VALUES ($1, $2, $3)
       ON CONFLICT (wallet_address) DO UPDATE SET username = EXCLUDED.username,
         username_normalized = EXCLUDED.username_normalized, updated_at = now()
       RETURNING wallet_address, username`,
      [address, body.username, normalized],
    )
    return result.rows[0]
  })

  app.get('/api/profiles/resolve/:username', async (request) => {
    await wallet(request, auth)
    const { username } = z.object({ username: z.string().trim().min(3).max(24) }).parse(request.params)
    const result = await pool.query(
      'SELECT wallet_address, username FROM verified_wallet_profiles WHERE username_normalized = $1',
      [username.replace(/^@/, '').toLowerCase()],
    )
    if (!result.rows[0]) throw Object.assign(new Error('Username not found. Enter the recipient’s Polygon wallet address instead.'), { statusCode: 404 })
    return result.rows[0]
  })

  app.post('/api/invitations', async (request, reply) => {
    const creator = await wallet(request, auth)
    const body = z.object({
      vault: z.string(), invitee: z.string(), commitment: z.string().regex(/^0x[0-9a-fA-F]{64}$/),
      expiry: z.coerce.number().int().positive(), payload: z.record(z.string(), z.unknown()),
      recipientUsername: z.string().max(24).optional(),
    }).parse(request.body)
    if (!isAddress(body.vault) || !isAddress(body.invitee)) throw Object.assign(new Error('Enter a valid Polygon wallet address.'), { statusCode: 400 })
    const vaultAddress = getAddress(body.vault)
    const invitee = getAddress(body.invitee).toLowerCase()
    if (invitee === creator || invitee === getAddress('0x0000000000000000000000000000000000000000').toLowerCase()) {
      throw Object.assign(new Error('Choose a different non-zero recipient wallet.'), { statusCode: 400 })
    }
    const contract = new Contract(vaultAddress, vaultAbi, provider)
    const [onchainCreator, activeCommitment, status] = await Promise.all([
      contract.getFunction('groupCreator')(), contract.getFunction('activeGroupInvitation')(invitee), contract.getFunction('invitationStatus')(body.commitment),
    ])
    if (getAddress(onchainCreator).toLowerCase() !== creator || activeCommitment.toLowerCase() !== body.commitment.toLowerCase() || Number(status) !== 1) {
      throw genericInviteError(400)
    }
    for (let attempt = 0; attempt < 8; attempt += 1) {
      const shortCode = generateInvitationCode()
      const inserted = await pool.query(
        `INSERT INTO invitation_lookup_codes
          (code, chain_id, vault_address, creator_address, invitee_address, recipient_username, commitment, invitation_payload, expires_at)
         VALUES ($1,$2,$3,$4,$5,$6,$7,$8,to_timestamp($9)) ON CONFLICT DO NOTHING RETURNING code`,
        [shortCode, config.manifest.chainId, vaultAddress.toLowerCase(), creator, invitee, body.recipientUsername ?? null, body.commitment.toLowerCase(), body.payload, body.expiry],
      )
      if (inserted.rows[0]) return reply.code(201).send({ code: shortCode })
    }
    throw Object.assign(new Error('Could not allocate an invitation code. Please try again.'), { statusCode: 503 })
  })

  app.get('/api/invitations', async (request) => {
    const creator = await wallet(request, auth)
    const result = await pool.query(
      `SELECT code, vault_address, invitee_address, recipient_username, commitment, invitation_payload, expires_at,
              revoked_at, consumed_at
       FROM invitation_lookup_codes WHERE creator_address = $1
       ORDER BY created_at DESC LIMIT 100`, [creator],
    )
    return { items: result.rows }
  })

  app.get('/api/invitations/:code', async (request) => {
    const invitee = await wallet(request, auth)
    const { code: lookup } = z.object({ code: z.string().length(6).transform((value) => value.toUpperCase()) }).parse(request.params)
    const actorHash = createHash('sha256').update(`${request.ip}:${invitee}`).digest('hex')
    const attempts = await pool.query<{ count: string }>(
      `SELECT count(*)::text AS count FROM invitation_lookup_failures
       WHERE actor_hash = $1 AND attempted_at > now() - interval '15 minutes'`, [actorHash],
    )
    if (Number(attempts.rows[0]?.count ?? 0) >= 8) throw genericInviteError(429)
    const result = await pool.query(
      `SELECT * FROM invitation_lookup_codes WHERE code = $1 AND invitee_address = $2
       AND revoked_at IS NULL AND consumed_at IS NULL AND expires_at > now()`, [lookup, invitee],
    )
    const row = result.rows[0]
    if (!row) {
      await pool.query('INSERT INTO invitation_lookup_failures (actor_hash) VALUES ($1)', [actorHash])
      throw genericInviteError()
    }
    const contract = new Contract(row.vault_address, vaultAbi, provider)
    const [activeCommitment, status] = await Promise.all([
      contract.getFunction('activeGroupInvitation')(invitee), contract.getFunction('invitationStatus')(row.commitment),
    ])
    if (activeCommitment.toLowerCase() !== row.commitment || Number(status) !== 1) throw genericInviteError()
    return { code: row.code, vault: row.vault_address, recipientUsername: row.recipient_username, payload: row.invitation_payload, expiresAt: row.expires_at }
  })
}
