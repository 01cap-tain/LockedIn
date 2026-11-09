export interface ActiveSavingsPosition {
  access: "owner" | "emergency-only";
  isOriginalMember: boolean;
  currentValue: string;
  emergencyBalance: string;
}

/**
 * Current savings are reconstructed from authoritative position snapshots:
 * the claim value belongs to the current claim owner, while the remaining
 * emergency balance belongs only to the original member. Historical deposits
 * and indexed events never enter this calculation, so withdrawals, sales and
 * duplicate projections cannot inflate it.
 */
export function activeSavingsBalance(positions: readonly ActiveSavingsPosition[]): number {
  return positions.reduce((total, position) => {
    const ownedClaim = position.access === "owner" ? safeAmount(position.currentValue) : 0;
    const ownedEmergency = position.isOriginalMember ? safeAmount(position.emergencyBalance) : 0;
    return total + ownedClaim + ownedEmergency;
  }, 0);
}

function safeAmount(value: string): number {
  const amount = Number(value);
  return Number.isFinite(amount) && amount > 0 ? amount : 0;
}
