/**
 * Client side of WALLET CLOUD-SAVE. INTENTIONALLY THIN + dependency-free.
 *
 * Players who connect a Solana wallet get their progress synced to a durable
 * PartyKit backend keyed by their wallet address, so it follows them across
 * devices. This module only talks to that backend over HTTP; ALL network calls
 * are wrapped in try/catch and return null on any failure, so the game degrades
 * gracefully to localStorage-only play when offline or when no URL is set.
 *
 * TRUST MODEL: identical spirit to token.ts — the client proves wallet ownership
 * with a signed, timestamped message and the backend is authoritative. The save
 * blob itself is just opaque progress; it's re-sanitized client-side (see
 * sanitizeSave) before it's ever trusted, so a forged cloud blob can't poison
 * the economy.
 *
 * WIRE CONTRACT (fixed — matches the PartyKit backend exactly):
 *   Base URL = a PartyKit host, e.g. https://tiny-dead.<user>.partykit.dev
 *   Save endpoints live under <base>/parties/save/<walletAddress>.
 *   - POST <base>/parties/save/<addr>/login
 *       body  { message, signature (base64) }
 *       → 200 { ok:true, token, save:object|null, updated:number } | 401 { ok:false, error }
 *     message MUST be exactly: `Tiny Dead save sync\naddress: <addr>\nts: <ms>`
 *     (ts = Date.now(); server allows ±5 min).
 *   - POST <base>/parties/save/<addr>  header Authorization: Bearer <token>
 *       body  { save:object, updated:number }   (must be < 256 KB)
 *       → { ok:true, updated:number } | 401
 *   - GET  <base>/parties/save/<addr> → { ok:true, save:object|null, updated:number }
 */

const LS_KEY = "tinydead.saveapi";

/** Build-time default save host from Vite's env (VITE_SAVE_URL). Read defensively
 *  — `import.meta.env` only exists under the Vite bundler, never in plain Node
 *  (tests), so we narrow it ourselves rather than depend on vite/client types. */
function envSaveUrl(): string {
  const env = (import.meta as unknown as { env?: Record<string, string | undefined> }).env;
  return env?.VITE_SAVE_URL ?? "";
}

function readInit(): string {
  try {
    return localStorage.getItem(LS_KEY) ?? envSaveUrl();
  } catch {
    return envSaveUrl();
  }
}

let apiUrl = readInit();

/** Configured cloud-save base URL (empty string = cloud save DISABLED). */
export function getSaveApiUrl(): string {
  return apiUrl;
}

/** Point the client at a deployed PartyKit save host. Returns the normalized URL. */
export function setSaveApiUrl(input: string): string {
  apiUrl = (input || "").trim().replace(/\/+$/, "");
  try {
    localStorage.setItem(LS_KEY, apiUrl);
  } catch {
    /* storage unavailable — session only */
  }
  return apiUrl;
}

/** True only when a save backend URL is configured (else everything no-ops). */
export function cloudEnabled(): boolean {
  return !!getSaveApiUrl();
}

/** The canonical login message the backend verifies (±5 min on ts). */
export function saveSignText(address: string, ts = Date.now()): string {
  return `Tiny Dead save sync\naddress: ${address}\nts: ${ts}`;
}

/** Per-wallet save endpoint base: <base>/parties/save/<addr>. */
function partyUrl(address: string): string {
  return `${apiUrl}/parties/save/${encodeURIComponent(address)}`;
}

/**
 * Prove wallet ownership and fetch the stored save in one round-trip. Builds the
 * canonical message, asks the caller to sign it (so this module stays wallet-
 * agnostic), then POSTs /login. Returns the session token + stored save, or null
 * on any failure (no URL, declined signature, network/HTTP error, 401).
 */
export async function cloudLogin(
  address: string,
  sign: (text: string) => Promise<string | null>,
): Promise<{ token: string; save: unknown; updated: number } | null> {
  if (!apiUrl || !address) return null;
  try {
    const message = saveSignText(address);
    const signature = await sign(message);
    if (!signature) return null; // declined / can't sign
    const res = await fetch(`${partyUrl(address)}/login`, {
      method: "POST",
      headers: { "content-type": "application/json", accept: "application/json" },
      body: JSON.stringify({ message, signature }),
    });
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as
      | { ok?: boolean; token?: string; save?: unknown; updated?: number }
      | null;
    if (!j || !j.ok || typeof j.token !== "string") return null;
    return {
      token: j.token,
      save: j.save ?? null,
      updated: typeof j.updated === "number" ? j.updated : 0,
    };
  } catch {
    return null;
  }
}

/**
 * Push a save blob to the cloud with the bearer token from cloudLogin. Returns
 * the server's authoritative `updated` timestamp, or null on any failure (incl.
 * an expired/invalid token → 401, which the caller treats as "drop the token and
 * re-login on the next connect"). Never signs — the session token covers pushes.
 */
export async function cloudPush(
  address: string,
  token: string,
  save: object,
  updated: number,
): Promise<number | null> {
  if (!apiUrl || !address || !token) return null;
  try {
    const res = await fetch(partyUrl(address), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        accept: "application/json",
        authorization: `Bearer ${token}`,
      },
      body: JSON.stringify({ save, updated }),
    });
    if (!res.ok) return null; // 401 etc → caller drops the token
    const j = (await res.json().catch(() => null)) as { ok?: boolean; updated?: number } | null;
    if (!j || !j.ok) return null;
    return typeof j.updated === "number" ? j.updated : updated;
  } catch {
    return null;
  }
}

/**
 * Read the stored save for a wallet without logging in (optional convenience —
 * login already returns the save, so this is unused by the main flow). Returns
 * null on any failure.
 */
export async function cloudPull(
  address: string,
): Promise<{ save: unknown; updated: number } | null> {
  if (!apiUrl || !address) return null;
  try {
    const res = await fetch(partyUrl(address), { headers: { accept: "application/json" } });
    if (!res.ok) return null;
    const j = (await res.json().catch(() => null)) as
      | { ok?: boolean; save?: unknown; updated?: number }
      | null;
    if (!j || !j.ok) return null;
    return { save: j.save ?? null, updated: typeof j.updated === "number" ? j.updated : 0 };
  } catch {
    return null;
  }
}
