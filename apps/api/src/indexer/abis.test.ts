import { describe, expect, it } from 'vitest'

import { contractInterfaces } from './abis.js'

describe('vault invitation event compatibility', () => {
  it('parses commitment-based invitation lifecycle events', () => {
    const commitment = `0x${'ab'.repeat(32)}`
    const invitee = '0x2222222222222222222222222222222222222222'
    const encoded = contractInterfaces.vault.encodeEventLog(
      'GroupInvitationCreated(bytes32,address,uint64,uint256,uint64)',
      [commitment, invitee, 1_800_000_000, 42, 1],
    )
    const parsed = contractInterfaces.vault.parseLog(encoded)

    expect(parsed?.name).toBe('GroupInvitationCreated')
    expect(parsed?.args.commitment).toBe(commitment)
    expect(parsed?.args.invitee).toBe(invitee)
  })

  it('continues to parse legacy invitation events', () => {
    const member = '0x3333333333333333333333333333333333333333'
    const encoded = contractInterfaces.vault.encodeEventLog(
      'GroupInvitationCreated(address,uint64)',
      [member, 1_800_000_000],
    )
    const parsed = contractInterfaces.vault.parseLog(encoded)

    expect(parsed?.name).toBe('GroupInvitationCreated')
    expect(parsed?.args.member).toBe(member)
  })
})
