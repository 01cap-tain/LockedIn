import type { DatabaseClient } from '../db.js'
import type { CanonicalEvent, StoredEvent } from './types.js'

function text(event: StoredEvent, key: string): string {
  const value = event.payload[key]
  if (value === undefined) throw new Error(`${event.eventName} is missing ${key}.`)
  return String(value)
}

function integer(event: StoredEvent, key: string): number {
  const value = Number(text(event, key))
  if (!Number.isSafeInteger(value)) throw new Error(`${key} is not a safe integer.`)
  return value
}

async function notify(
  client: DatabaseClient,
  event: StoredEvent,
  wallet: string,
  kind: string,
  title: string,
  body: string,
): Promise<void> {
  await client.query(
    `INSERT INTO notifications
       (wallet_address, kind, title, body, data, source_event_id)
     VALUES ($1, $2, $3, $4, $5, $6)
     ON CONFLICT (wallet_address, kind, source_event_id) DO NOTHING`,
    [wallet.toLowerCase(), kind, title, body, event.payload, event.id],
  )
}

async function notifyCreator(
  client: DatabaseClient,
  event: StoredEvent,
  kind: string,
  title: string,
  body: string,
): Promise<void> {
  const result = await client.query<{ creator: string }>(
    'SELECT creator FROM vaults WHERE address = $1',
    [event.contractAddress],
  )
  const creator = result.rows[0]?.creator
  if (creator) await notify(client, event, creator, kind, title, body)
}

export async function insertCanonicalEvent(
  client: DatabaseClient,
  event: CanonicalEvent,
): Promise<StoredEvent | null> {
  const result = await client.query<{ id: string }>(
    `INSERT INTO chain_events
       (chain_id, deployment_id, block_number, block_hash, transaction_hash, transaction_index,
        log_index, contract_address, event_name, payload)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
     ON CONFLICT (deployment_id, transaction_hash, log_index) DO NOTHING
     RETURNING id`,
    [
      event.chainId,
      event.deploymentId,
      event.blockNumber,
      event.blockHash,
      event.transactionHash,
      event.transactionIndex,
      event.logIndex,
      event.contractAddress,
      event.eventName,
      event.payload,
    ],
  )
  const id = result.rows[0]?.id
  return id ? { ...event, id } : null
}

export async function projectEvent(
  client: DatabaseClient,
  event: StoredEvent,
): Promise<void> {
  switch (event.eventName) {
    case 'VaultCreated': {
      await client.query(
        `INSERT INTO vaults
           (address, deployment_id, creator, is_group, mode, yield_adapter, maturity,
            lifecycle, creation_transaction_hash, creation_block_number, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
         ON CONFLICT (address) DO UPDATE SET
           deployment_id = EXCLUDED.deployment_id,
           creator = EXCLUDED.creator,
           is_group = EXCLUDED.is_group,
           mode = EXCLUDED.mode,
           yield_adapter = EXCLUDED.yield_adapter,
           maturity = EXCLUDED.maturity,
           creation_transaction_hash = EXCLUDED.creation_transaction_hash,
           creation_block_number = EXCLUDED.creation_block_number,
           source_event_id = EXCLUDED.source_event_id`,
        [
          text(event, 'vault').toLowerCase(),
          event.deploymentId,
          text(event, 'creator').toLowerCase(),
          event.payload.isGroup,
          integer(event, 'mode'),
          text(event, 'yieldAdapter').toLowerCase(),
          text(event, 'maturity'),
          event.payload.isGroup ? 'PENDING_INVITATIONS' : 'ACTIVE',
          event.transactionHash,
          event.blockNumber,
          event.id,
        ],
      )
      break
    }
    case 'GroupInvitationCreated': {
      const member = text(event, 'member').toLowerCase()
      await client.query(
        `INSERT INTO group_invitations
           (vault_address, member_address, status, expires_at, updated_block_number, source_event_id)
         VALUES ($1, $2, 'PENDING', $3, $4, $5)
         ON CONFLICT (vault_address, member_address) DO UPDATE SET
           status = EXCLUDED.status,
           expires_at = EXCLUDED.expires_at,
           updated_block_number = EXCLUDED.updated_block_number,
           source_event_id = EXCLUDED.source_event_id`,
        [event.contractAddress, member, text(event, 'expiresAt'), event.blockNumber, event.id],
      )
      await notify(
        client,
        event,
        member,
        'GROUP_INVITATION_RECEIVED',
        'Group invitation received',
        'Review the complete vault terms before accepting or declining.',
      )
      break
    }
    case 'GroupInvitationAccepted':
    case 'GroupInvitationDeclined': {
      const member = text(event, 'member').toLowerCase()
      const status = event.eventName === 'GroupInvitationAccepted' ? 'ACCEPTED' : 'DECLINED'
      await client.query(
        `INSERT INTO group_invitations
           (vault_address, member_address, status, updated_block_number, source_event_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (vault_address, member_address) DO UPDATE SET
           status = EXCLUDED.status,
           updated_block_number = EXCLUDED.updated_block_number,
           source_event_id = EXCLUDED.source_event_id`,
        [event.contractAddress, member, status, event.blockNumber, event.id],
      )
      await notifyCreator(
        client,
        event,
        `GROUP_INVITATION_${status}`,
        `Invitation ${status.toLowerCase()}`,
        `${member} ${status.toLowerCase()} the group invitation.`,
      )
      break
    }
    case 'GroupActivated': {
      await client.query(
        `UPDATE vaults SET lifecycle = 'ACTIVE' WHERE address = $1`,
        [event.contractAddress],
      )
      const members = await client.query<{ member_address: string }>(
        'SELECT member_address FROM group_invitations WHERE vault_address = $1',
        [event.contractAddress],
      )
      for (const { member_address: member } of members.rows) {
        await notify(
          client,
          event,
          member,
          'GROUP_ACTIVATED',
          'Group activated',
          'Every invited member accepted. Deposits are now enabled.',
        )
      }
      break
    }
    case 'GroupInvitationExpired':
    case 'UnactivatedGroupCancelled': {
      await client.query(
        `UPDATE vaults SET lifecycle = $2 WHERE address = $1`,
        [
          event.contractAddress,
          event.eventName === 'GroupInvitationExpired' ? 'INVITATION_EXPIRED' : 'CANCELLED',
        ],
      )
      break
    }
    case 'GroupMemberStatusChanged': {
      await client.query(
        `INSERT INTO group_member_statuses
           (vault_address, position_id, member_address, status,
            updated_block_number, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vault_address, position_id) DO UPDATE SET
           member_address = EXCLUDED.member_address,
           status = EXCLUDED.status,
           updated_block_number = EXCLUDED.updated_block_number,
           source_event_id = EXCLUDED.source_event_id`,
        [
          event.contractAddress,
          text(event, 'positionId'),
          text(event, 'member').toLowerCase(),
          integer(event, 'newStatus'),
          event.blockNumber,
          event.id,
        ],
      )
      break
    }
    case 'GroupExitRequested': {
      await client.query(
        `INSERT INTO cooperative_exit_requests
           (vault_address, request_id, requester, position_id, status,
            pending_expires_at, updated_block_number, source_event_id)
         VALUES ($1, $2, $3, $4, 'PENDING', $5, $6, $7)
         ON CONFLICT (vault_address, request_id) DO UPDATE SET
           status = EXCLUDED.status,
           pending_expires_at = EXCLUDED.pending_expires_at,
           updated_block_number = EXCLUDED.updated_block_number,
           source_event_id = EXCLUDED.source_event_id`,
        [
          event.contractAddress,
          text(event, 'requestId'),
          text(event, 'requester').toLowerCase(),
          text(event, 'positionId'),
          text(event, 'expiresAt'),
          event.blockNumber,
          event.id,
        ],
      )
      const recipients = await client.query<{ member_address: string }>(
        `SELECT member_address FROM group_invitations
         WHERE vault_address = $1 AND member_address <> $2 AND status = 'ACCEPTED'`,
        [event.contractAddress, text(event, 'requester').toLowerCase()],
      )
      for (const { member_address: member } of recipients.rows) {
        await notify(
          client,
          event,
          member,
          'GROUP_EXIT_REQUESTED',
          'Cooperative exit requested',
          'A member requested an early group exit. Approval remains an on-chain wallet action.',
        )
      }
      break
    }
    case 'GroupExitApproved':
    case 'GroupExitApprovalRevoked': {
      const approved = event.eventName === 'GroupExitApproved'
      await client.query(
        `INSERT INTO cooperative_exit_approvals
           (vault_address, request_id, approver, approved, updated_block_number, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (vault_address, request_id, approver) DO UPDATE SET
           approved = EXCLUDED.approved,
           updated_block_number = EXCLUDED.updated_block_number,
           source_event_id = EXCLUDED.source_event_id`,
        [
          event.contractAddress,
          text(event, 'requestId'),
          text(event, 'approver').toLowerCase(),
          approved,
          event.blockNumber,
          event.id,
        ],
      )
      const request = await client.query<{ requester: string }>(
        `SELECT requester FROM cooperative_exit_requests
         WHERE vault_address = $1 AND request_id = $2`,
        [event.contractAddress, text(event, 'requestId')],
      )
      const requester = request.rows[0]?.requester
      if (requester && approved) {
        await notify(
          client,
          event,
          requester,
          'GROUP_EXIT_APPROVAL_RECEIVED',
          'Exit approval received',
          `${text(event, 'approver')} approved the cooperative exit.`,
        )
      }
      break
    }
    case 'GroupExitAuthorized': {
      await client.query(
        `UPDATE cooperative_exit_requests
         SET status = 'AUTHORIZED', authorization_expires_at = $3,
             updated_block_number = $4, source_event_id = $5
         WHERE vault_address = $1 AND request_id = $2`,
        [
          event.contractAddress,
          text(event, 'requestId'),
          text(event, 'authorizationExpiresAt'),
          event.blockNumber,
          event.id,
        ],
      )
      const request = await client.query<{ requester: string }>(
        `SELECT requester FROM cooperative_exit_requests
         WHERE vault_address = $1 AND request_id = $2`,
        [event.contractAddress, text(event, 'requestId')],
      )
      const requester = request.rows[0]?.requester
      if (requester) {
        await notify(
          client,
          event,
          requester,
          'GROUP_EXIT_AUTHORIZED',
          'Cooperative exit authorized',
          'Execute the live claim before the separate 24-hour authorization expires.',
        )
      }
      break
    }
    case 'GroupExitCancelled':
    case 'GroupExitExpired':
    case 'GroupExitAuthorizationExpired':
    case 'GroupExitCompleted': {
      const statusByEvent: Record<string, string> = {
        GroupExitCancelled: 'CANCELLED',
        GroupExitExpired: 'EXPIRED',
        GroupExitAuthorizationExpired: 'AUTHORIZATION_EXPIRED',
        GroupExitCompleted: 'COMPLETED',
      }
      await client.query(
        `UPDATE cooperative_exit_requests
         SET status = $3, updated_block_number = $4, source_event_id = $5
         WHERE vault_address = $1 AND request_id = $2`,
        [
          event.contractAddress,
          text(event, 'requestId'),
          statusByEvent[event.eventName],
          event.blockNumber,
          event.id,
        ],
      )
      const request = await client.query<{ requester: string }>(
        `SELECT requester FROM cooperative_exit_requests
         WHERE vault_address = $1 AND request_id = $2`,
        [event.contractAddress, text(event, 'requestId')],
      )
      const requester = request.rows[0]?.requester
      if (requester) {
        await notify(
          client,
          event,
          requester,
          `GROUP_EXIT_${statusByEvent[event.eventName]}`,
          `Exit ${statusByEvent[event.eventName]?.toLowerCase().replace('_', ' ')}`,
          'This notification mirrors finalized chain state and cannot change the outcome.',
        )
      }
      break
    }
    case 'ListingCreated': {
      await client.query(
        `INSERT INTO market_listings
           (market_address, listing_id, vault_address, position_id, seller,
            claim_value, discount_bps, saver_payout, provider_return, provider_fee,
            minimum_payout, expires_at, status, updated_block_number, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, 'ACTIVE', $13, $14)
         ON CONFLICT (market_address, listing_id) DO UPDATE SET
           status = EXCLUDED.status,
           updated_block_number = EXCLUDED.updated_block_number,
           source_event_id = EXCLUDED.source_event_id`,
        [
          event.contractAddress,
          text(event, 'listingId'),
          text(event, 'vault').toLowerCase(),
          text(event, 'positionId'),
          text(event, 'seller').toLowerCase(),
          text(event, 'claimValue'),
          integer(event, 'systemDiscountBps'),
          text(event, 'saverPayout'),
          text(event, 'providerPotentialReturn'),
          text(event, 'providerFee'),
          text(event, 'minimumPayout'),
          text(event, 'expiresAt'),
          event.blockNumber,
          event.id,
        ],
      )
      break
    }
    case 'ListingCancelled':
    case 'ListingExpired': {
      await client.query(
        `UPDATE market_listings
         SET status = $3, updated_block_number = $4, source_event_id = $5
         WHERE market_address = $1 AND listing_id = $2`,
        [
          event.contractAddress,
          text(event, 'listingId'),
          event.eventName === 'ListingCancelled' ? 'CANCELLED' : 'EXPIRED',
          event.blockNumber,
          event.id,
        ],
      )
      break
    }
    case 'ListingFunded': {
      const listingId = text(event, 'listingId')
      const listing = await client.query<{
        vault_address: string
        position_id: string
        seller: string
      }>(
        `UPDATE market_listings
         SET status = 'FUNDED', claim_value = $3, discount_bps = $4,
             saver_payout = $5, provider_return = $6, provider_fee = $7,
             updated_block_number = $8, source_event_id = $9
         WHERE market_address = $1 AND listing_id = $2
         RETURNING vault_address, position_id, seller`,
        [
          event.contractAddress,
          listingId,
          text(event, 'claimValue'),
          integer(event, 'systemDiscountBps'),
          text(event, 'saverPayout'),
          text(event, 'providerPotentialReturn'),
          text(event, 'providerFee'),
          event.blockNumber,
          event.id,
        ],
      )
      const row = listing.rows[0]
      if (!row) throw new Error(`Listing ${listingId} was funded before its creation event.`)
      const provider = text(event, 'provider').toLowerCase()
      await client.query(
        `INSERT INTO completed_trades
           (market_address, listing_id, vault_address, position_id, seller, provider,
            claim_value, discount_bps, saver_payout, provider_return, provider_fee,
            transaction_hash, block_number, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14)
         ON CONFLICT (market_address, listing_id) DO NOTHING`,
        [
          event.contractAddress,
          listingId,
          row.vault_address,
          row.position_id,
          row.seller,
          provider,
          text(event, 'claimValue'),
          integer(event, 'systemDiscountBps'),
          text(event, 'saverPayout'),
          text(event, 'providerPotentialReturn'),
          text(event, 'providerFee'),
          event.transactionHash,
          event.blockNumber,
          event.id,
        ],
      )
      await notify(
        client,
        event,
        row.seller,
        'MARKET_SALE_COMPLETED',
        'Savings claim sold',
        `+${text(event, 'saverPayout')} token base units were paid by the liquidity provider.`,
      )
      await notify(
        client,
        event,
        provider,
        'MARKET_PURCHASE_COMPLETED',
        'Savings claim purchased',
        'The locked claim transferred atomically; the saver retained emergency ownership.',
      )
      break
    }
    case 'RewardClaimed': {
      await client.query(
        `INSERT INTO reward_claims
           (recipient, amount, transaction_hash, block_number, source_event_id)
         VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (source_event_id) DO NOTHING`,
        [
          text(event, 'recipient').toLowerCase(),
          text(event, 'amount'),
          event.transactionHash,
          event.blockNumber,
          event.id,
        ],
      )
      break
    }
    case 'ProtocolRevenueReceived':
    case 'ProtocolGroupRegistered':
    case 'ProtocolEpochFinalized':
    case 'ProtocolGroupAllocated':
    case 'ProtocolRevenueRolledForward': {
      await client.query(
        `INSERT INTO reward_epoch_events
           (chain_id, epoch_id, event_name, vault_address, payload,
            block_number, source_event_id)
         VALUES ($1, $2, $3, $4, $5, $6, $7)
         ON CONFLICT (source_event_id) DO NOTHING`,
        [
          event.chainId,
          text(event, event.eventName === 'ProtocolRevenueRolledForward' ? 'fromEpochId' : 'epochId'),
          event.eventName,
          event.payload.vault ? text(event, 'vault').toLowerCase() : null,
          event.payload,
          event.blockNumber,
          event.id,
        ],
      )
      break
    }
    default:
      // Canonical events remain queryable even when they require no materialized view.
      break
  }
}

export async function clearProjections(client: DatabaseClient): Promise<void> {
  await client.query(`
    DELETE FROM notifications WHERE source_event_id IS NOT NULL;
    DELETE FROM reward_claims;
    DELETE FROM reward_epoch_events;
    DELETE FROM completed_trades;
    DELETE FROM market_listings;
    DELETE FROM cooperative_exit_approvals;
    DELETE FROM cooperative_exit_requests;
    DELETE FROM group_member_statuses;
    DELETE FROM group_invitations;
    DELETE FROM vaults;
  `)
}

export async function rebuildProjections(client: DatabaseClient): Promise<void> {
  await clearProjections(client)
  const result = await client.query<{
    id: string
    chain_id: string
    deployment_id: string
    block_number: string
    block_hash: string
    transaction_hash: string
    transaction_index: number
    log_index: number
    contract_address: string
    event_name: string
    payload: Record<string, string | number | boolean>
  }>(`
    SELECT id, chain_id, deployment_id, block_number, block_hash, transaction_hash,
           transaction_index, log_index, contract_address, event_name, payload
    FROM chain_events
    ORDER BY block_number, transaction_index, log_index
  `)
  for (const row of result.rows) {
    await projectEvent(client, {
      id: row.id,
      chainId: Number(row.chain_id),
      deploymentId: row.deployment_id,
      blockNumber: Number(row.block_number),
      blockHash: row.block_hash,
      transactionHash: row.transaction_hash,
      transactionIndex: row.transaction_index,
      logIndex: row.log_index,
      contractAddress: row.contract_address,
      contractKind: 'vault',
      eventName: row.event_name,
      payload: row.payload,
    })
  }
}
