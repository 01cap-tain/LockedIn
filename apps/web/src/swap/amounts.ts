function unit(decimals: number): bigint {
  return 10n ** BigInt(decimals);
}

/** Converts a human decimal into smallest units without floating-point arithmetic. */
export function parseAssetAmount(value: string, decimals: number): bigint {
  if (!Number.isInteger(decimals) || decimals < 0 || decimals > 18)
    throw new Error("Unsupported asset decimals.");
  const normalized = value.trim();
  if (!/^\d+(\.\d+)?$/.test(normalized)) throw new Error("Enter a positive numeric amount.");
  const parts = normalized.split(".");
  const whole = parts[0]!;
  const fraction = parts[1] ?? "";
  if (fraction.length > decimals) throw new Error(`Use no more than ${decimals} decimal places.`);
  const result = BigInt(whole) * unit(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (result <= 0n) throw new Error("Amount must be greater than zero.");
  return result;
}

export function formatAssetAmount(value: bigint, decimals: number, maxDecimals = decimals): string {
  const base = unit(decimals);
  const whole = value / base;
  const fraction = (value % base).toString().padStart(decimals, "0").slice(0, maxDecimals).replace(/0+$/, "");
  return fraction ? `${whole}.${fraction}` : whole.toString();
}

export function applyBasisPoints(value: bigint, bps: number): bigint {
  if (!Number.isInteger(bps) || bps < 0 || bps > 10_000) throw new Error("Basis points are outside the valid range.");
  return (value * BigInt(bps)) / 10_000n;
}

/** Grosses up an exact destination requirement for fee and slippage protection. */
export function grossSourceForDestination(destination: bigint, feeBps: number, slippageBps: number): bigint {
  const retainedBps = 10_000 - feeBps - slippageBps;
  if (retainedBps <= 0) throw new Error("Fees and slippage consume the requested amount.");
  return (destination * 10_000n + BigInt(retainedBps - 1)) / BigInt(retainedBps);
}

/** Mirrors EarlyExitMarket's 0.9% provider fee, including integer rounding. */
export function requiredUsdtForEarlyExit(saverPayout: bigint): bigint {
  return saverPayout + applyBasisPoints(saverPayout, 90);
}
