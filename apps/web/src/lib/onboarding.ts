/**
 * Completion is scoped to one wallet and immutable deployment. A user who
 * changes wallet, chain or protocol deployment therefore receives the guide
 * for the context they are actually using.
 */
export function onboardingStorageKey(
  chainId: string,
  address: string,
  deploymentId: string
): string {
  return `lockedin:onboarding:v3:${chainId.toLowerCase()}:${deploymentId.toLowerCase()}:${address.toLowerCase()}`;
}

export function onboardingIsComplete(
  storage: Pick<Storage, "getItem">,
  chainId: string,
  address: string,
  deploymentId: string
): boolean {
  return storage.getItem(onboardingStorageKey(chainId, address, deploymentId)) === "complete";
}

export function markOnboardingComplete(
  storage: Pick<Storage, "setItem">,
  chainId: string,
  address: string,
  deploymentId: string
): void {
  storage.setItem(
    onboardingStorageKey(chainId, address, deploymentId),
    "complete"
  );
}
