/**
 * Client side of the real-token earning rails. INTENTIONALLY THIN.
 *
 * TRUST MODEL (do not "optimize" this away):
 *  - This is a static, fully inspectable client. It can NEVER be the authority
 *    on how many tokens a player earned — anyone can edit localStorage / the JS.
 *  - So the client only does two things: (1) ASK the backend what's claimable
 *    for a wallet, and (2) forward a wallet-signed claim REQUEST. The backend
 *    (token-backend/) verifies the signature, consults its own ledger, and is
 *    the only thing that ever signs a treasury transfer.
 *  - Until a backend URL is configured + deployed, claiming is simply disabled
 *    and we say so honestly rather than fake a payout.
 */

const LS_KEY = "tinydead.tokenapi";

function readInit(): string {
  try {
    return localStorage.getItem(LS_KEY) ?? "";
  } catch {
    return "";
  }
}

let apiUrl = readInit();

/** Configured reward-backend base URL (empty string = not set up yet). */
export function getTokenApiUrl(): string {
  return apiUrl;
}

/** Point the client at a deployed token-backend. Returns the normalized URL. */
export function setTokenApiUrl(input: string): string {
  apiUrl = (input || "").trim().replace(/\/+$/, "");
  try {
    localStorage.setItem(LS_KEY, apiUrl);
  } catch {
    /* storage unavailable — session only */
  }
  return apiUrl;
}

/**
 * Server-authoritative claimable balance for a wallet. Returns null when no
 * backend is configured or it's unreachable (so the UI can stay honest).
 */
export async function fetchClaimable(address: string): Promise<number | null> {
  if (!apiUrl) return null;
  try {
    const r = await fetch(`${apiUrl}/claimable?address=${encodeURIComponent(address)}`, {
      headers: { accept: "application/json" },
    });
    if (!r.ok) return null;
    const j = (await r.json()) as { claimable?: unknown };
    return typeof j.claimable === "number" && Number.isFinite(j.claimable) ? j.claimable : null;
  } catch {
    return null;
  }
}

/** base64-encode raw signature bytes for JSON transport (no deps). */
export function bytesToB64(bytes: Uint8Array): string {
  let s = "";
  for (let i = 0; i < bytes.length; i++) s += String.fromCharCode(bytes[i]);
  return btoa(s);
}
