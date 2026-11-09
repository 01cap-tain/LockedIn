import type { Signer } from "ethers";
import { getAddress } from "ethers";

import { decodeGroupInvitation, encodeGroupInvitation, type SecureGroupInvitation } from "./contracts";

interface AuthSession { token: string; address: string; expiresAt: string }
export interface ResolvedRecipient { username?: string; walletAddress: string }
export interface ShortInvitation { code: string }
export interface CreatorInvitation { code: string; invitation: SecureGroupInvitation; recipientUsername?: string }

function base(): string { return (import.meta.env.VITE_INDEXER_API_URL?.trim() || "").replace(/\/$/, ""); }
function endpoint(path: string): string { return `${base()}${path}`; }

async function session(signer: Signer): Promise<AuthSession> {
  const address = getAddress(await signer.getAddress());
  const key = `lockedin-api-session:${address.toLowerCase()}`;
  const stored = sessionStorage.getItem(key);
  if (stored) {
    const parsed = JSON.parse(stored) as AuthSession;
    if (new Date(parsed.expiresAt).getTime() > Date.now() + 30_000) return parsed;
  }
  const challengeResponse = await fetch(endpoint("/api/auth/nonce"), {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ address }),
  });
  if (!challengeResponse.ok) throw new Error("The invitation service is unavailable.");
  const challenge = await challengeResponse.json() as { nonce: string; message: string };
  const signature = await signer.signMessage(challenge.message);
  const verifyResponse = await fetch(endpoint("/api/auth/verify"), {
    method: "POST", headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ address, nonce: challenge.nonce, signature }),
  });
  if (!verifyResponse.ok) throw new Error("Wallet verification failed.");
  const authenticated = await verifyResponse.json() as AuthSession;
  sessionStorage.setItem(key, JSON.stringify(authenticated));
  return authenticated;
}

async function authenticatedFetch(signer: Signer, path: string, init?: RequestInit): Promise<Response> {
  const authenticated = await session(signer);
  return fetch(endpoint(path), {
    ...init,
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${authenticated.token}`, ...init?.headers },
  });
}

async function responseError(response: Response, fallback: string): Promise<Error> {
  const result = await response.json().catch(() => null) as { message?: string } | null;
  return new Error(result?.message?.trim() || fallback);
}

export async function loadVerifiedUsername(signer: Signer): Promise<string> {
  const response = await authenticatedFetch(signer, "/api/profile");
  if (!response.ok) throw await responseError(response, "Your profile could not be loaded.");
  const result = await response.json() as { username: string | null };
  return result.username?.trim() ?? "";
}

export async function resolveInvitationRecipient(signer: Signer, value: string): Promise<ResolvedRecipient> {
  const input = value.trim();
  try { return { walletAddress: getAddress(input) }; } catch { /* Treat as username. */ }
  const response = await authenticatedFetch(signer, `/api/profiles/resolve/${encodeURIComponent(input.replace(/^@/, ""))}`);
  if (!response.ok) throw await responseError(response, "Username not found. Enter the recipient's Polygon wallet address instead.");
  const result = await response.json() as { username: string; wallet_address: string };
  return { username: result.username, walletAddress: getAddress(result.wallet_address) };
}

export async function registerVerifiedUsername(signer: Signer, username: string): Promise<string> {
  const response = await authenticatedFetch(signer, "/api/profile/username", {
    method: "PUT", body: JSON.stringify({ username: username.trim() }),
  });
  if (!response.ok) {
    throw await responseError(response, "This username could not be registered.");
  }
  const result = await response.json() as { username: string };
  return result.username;
}

export async function registerShortInvitation(
  signer: Signer,
  invitation: SecureGroupInvitation,
  recipientUsername?: string,
): Promise<ShortInvitation> {
  const response = await authenticatedFetch(signer, "/api/invitations", {
    method: "POST",
    body: JSON.stringify({
      vault: invitation.vault, invitee: invitation.invitee, commitment: invitation.commitment,
      expiry: Number(invitation.expiry), recipientUsername,
      payload: { encodedInvitation: encodeGroupInvitation(invitation) },
    }),
  });
  if (!response.ok) throw await responseError(response, "The secure invite was created on-chain, but its short code could not be saved. Please retry from the invitation card.");
  return response.json() as Promise<ShortInvitation>;
}

export async function loadCreatorInvitations(signer: Signer): Promise<CreatorInvitation[]> {
  const response = await authenticatedFetch(signer, "/api/invitations");
  if (!response.ok) throw await responseError(response, "Saved invitations could not be loaded.");
  const result = await response.json() as { items: Array<{ code: string; recipient_username?: string; invitation_payload: { encodedInvitation: string } }> };
  return result.items.flatMap((item) => {
    try {
      return [{ code: item.code, recipientUsername: item.recipient_username, invitation: decodeGroupInvitation(item.invitation_payload.encodedInvitation) }];
    } catch {
      return [];
    }
  });
}

export async function resolveShortInvitation(signer: Signer, code: string): Promise<SecureGroupInvitation> {
  const response = await authenticatedFetch(signer, `/api/invitations/${encodeURIComponent(code.trim().toUpperCase())}`);
  if (!response.ok) throw await responseError(response, "This invitation is invalid or no longer available.");
  const result = await response.json() as { payload: { encodedInvitation: string } };
  return decodeGroupInvitation(result.payload.encodedInvitation);
}
