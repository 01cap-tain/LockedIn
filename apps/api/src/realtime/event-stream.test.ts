import { describe, expect, it, vi } from 'vitest'

import { IndexerEventStream } from './event-stream.js'

describe('IndexerEventStream', () => {
  it('fans out finalized batches and releases disconnected subscribers', () => {
    const stream = new IndexerEventStream()
    const listener = vi.fn()
    const unsubscribe = stream.subscribe(listener)
    const batch = {
      chainId: 80_002,
      deploymentId: 'safe-v1',
      fromBlock: 10,
      toBlock: 11,
      events: [],
    }
    stream.publish(batch)
    expect(listener).toHaveBeenCalledWith(batch)
    expect(stream.subscriberCount).toBe(1)
    unsubscribe()
    stream.publish(batch)
    expect(listener).toHaveBeenCalledTimes(1)
    expect(stream.subscriberCount).toBe(0)
  })
})
