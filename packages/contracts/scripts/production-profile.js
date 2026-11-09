export function assertProductionMaturityConfiguration({ chainId, profile, minimumMaturityDuration }) {
  if (chainId !== 137) throw new Error('Production deployment must target Polygon chain 137.')
  if (/dev|test|amoy|local/i.test(profile)) throw new Error('Production deployment rejects development profiles.')
  if (!Number.isSafeInteger(minimumMaturityDuration) || minimumMaturityDuration < 25_200) {
    throw new Error('Production minimum maturity must be at least seven hours.')
  }
}
