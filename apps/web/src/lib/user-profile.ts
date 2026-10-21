export interface LocalUserProfile {
  version: 1;
  address: string;
  username: string;
  updatedAt: string;
}

const STORAGE_KEY = "lockedin-user-profiles-v1";

export function walletFallbackName(address?: string | null): string {
  if (!address) return "Connect wallets";
  return address.slice(0, 5);
}

export function walletDisplayName(
  address?: string | null,
  username = loadLocalUsername(address)
): string {
  return username || walletFallbackName(address);
}

export function walletAvatarLabel(
  address?: string | null,
  username = loadLocalUsername(address)
): string {
  if (!address) return "?";
  if (!username) return address.replace(/^0x/i, "").slice(0, 2).toUpperCase();
  const words = username.trim().split(/\s+/).filter(Boolean);
  if (words.length > 1) {
    return `${words.at(0)?.at(0) ?? ""}${words.at(-1)?.at(0) ?? ""}`.toUpperCase();
  }
  return username.slice(0, 2).toUpperCase();
}

export function loadLocalUsername(address?: string | null): string {
  if (!address || typeof window === "undefined") return "";
  try {
    const profiles = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    const profile = profiles?.[address.toLowerCase()] as LocalUserProfile | undefined;
    return profile?.username?.trim() ?? "";
  } catch {
    return "";
  }
}

export function saveLocalUsername(address: string, username: string): string {
  const normalized = username.trim().replace(/\s+/g, " ").slice(0, 24);
  if (typeof window === "undefined") return normalized;
  try {
    const profiles = JSON.parse(window.localStorage.getItem(STORAGE_KEY) ?? "{}");
    profiles[address.toLowerCase()] = {
      version: 1,
      address,
      username: normalized,
      updatedAt: new Date().toISOString(),
    } satisfies LocalUserProfile;
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(profiles));
  } catch {
    // A blocked storage API must not affect wallet or contract operations.
  }
  return normalized;
}
