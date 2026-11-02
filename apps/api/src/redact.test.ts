import { describe, expect, it } from 'vitest'

import { redactSensitiveText } from './redact.js'

describe('redactSensitiveText', () => {
  it('removes HTTP and websocket RPC credentials from provider errors', () => {
    const message = 'requestUrl https://rpc.example/v2/secret-key and wss://rpc.example/ws/secret'
    const redacted = redactSensitiveText(message)
    expect(redacted).not.toContain('secret')
    expect(redacted).toBe('requestUrl [redacted RPC URL] and [redacted RPC URL]')
  })
})
