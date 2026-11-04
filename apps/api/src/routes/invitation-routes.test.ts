import { describe, expect, it } from 'vitest'

import { generateInvitationCode } from './invitation-routes.js'

describe('short invitation resolver identifiers', () => {
  it('uses exactly six unambiguous uppercase characters', () => {
    for (let index = 0; index < 500; index += 1) {
      expect(generateInvitationCode()).toMatch(/^[A-HJ-NP-Z2-9]{6}$/)
      expect(generateInvitationCode()).not.toMatch(/[0OI1]/)
    }
  })

  it('provides a broad lookup space instead of a reusable authorization secret', () => {
    const sample = new Set(Array.from({ length: 2_000 }, generateInvitationCode))
    expect(sample.size).toBeGreaterThan(1_990)
  })
})
