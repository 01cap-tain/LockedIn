import type { Log } from 'ethers'

import { contractInterfaces, type ContractKind } from './abis.js'
import type { CanonicalEvent } from './types.js'

function jsonValue(value: unknown): string | number | boolean {
  if (typeof value === 'bigint') return value.toString()
  if (typeof value === 'string' || typeof value === 'number' || typeof value === 'boolean') {
    return value
  }
  throw new Error(`Unsupported event value: ${String(value)}`)
}

export function decodeLog(
  chainId: number,
  deploymentId: string,
  kind: ContractKind,
  log: Log,
): CanonicalEvent | null {
  const parsed = contractInterfaces[kind].parseLog({
    topics: [...log.topics],
    data: log.data,
  })
  if (!parsed) return null
  const payload: Record<string, string | number | boolean> = {}
  for (let index = 0; index < parsed.fragment.inputs.length; index += 1) {
    const input = parsed.fragment.inputs[index]
    if (!input?.name) continue
    payload[input.name] = jsonValue(parsed.args[index])
  }
  if (!log.blockHash || !log.transactionHash || log.transactionIndex === null) {
    throw new Error('RPC returned an unmined log in a confirmed range.')
  }
  return {
    chainId,
    deploymentId,
    blockNumber: log.blockNumber,
    blockHash: log.blockHash.toLowerCase(),
    transactionHash: log.transactionHash.toLowerCase(),
    transactionIndex: log.transactionIndex,
    logIndex: log.index,
    contractAddress: log.address.toLowerCase(),
    contractKind: kind,
    eventName: parsed.name,
    payload,
  }
}
