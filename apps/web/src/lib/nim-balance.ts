import { getNimiqProvider } from "./nimiq";

/** Reads public luna balance without changing the preserved wallet integration. */
export async function loadNimBalance(address: string): Promise<bigint> {
  const provider = await getNimiqProvider();
  const value = await provider.getBalance(address);
  if (!Number.isSafeInteger(value) || value < 0) throw new Error("Nimiq Pay returned an unsafe luna balance.");
  return BigInt(value);
}
