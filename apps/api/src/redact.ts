/** Prevent provider credentials embedded in transport errors reaching logs or health responses. */
export function redactSensitiveText(value: string): string {
  return value
    .replace(/https?:\/\/[^\s"'\\]+/giu, '[redacted RPC URL]')
    .replace(/wss?:\/\/[^\s"'\\]+/giu, '[redacted RPC URL]')
}
