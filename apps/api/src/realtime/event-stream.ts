import type { IndexedBatch } from '../indexer/types.js'

type Listener = (batch: IndexedBatch) => void

/** In-process fan-out for finalized indexer batches. PostgreSQL remains durable. */
export class IndexerEventStream {
  private readonly listeners = new Set<Listener>()

  publish(batch: IndexedBatch): void {
    for (const listener of this.listeners) listener(batch)
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  get subscriberCount(): number {
    return this.listeners.size
  }
}
