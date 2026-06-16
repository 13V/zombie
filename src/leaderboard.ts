/**
 * Client for the GLOBAL leaderboard hosted on the relay server (see
 * server/src/leaderboard.ts). The relay already knows every player, so it also
 * stores the worldwide top survivors. This replaces the old "lobby-only" board
 * that could only ever show players in your own island instance.
 *
 * Both calls are best-effort: a failure (server asleep / offline) just resolves
 * to a no-op so the game never blocks on the leaderboard.
 */
import { getServerUrl } from "./net";

export interface LbRow {
  addr: string; // wallet address (the unique per-player key)
  name: string; // display name (cosmetic)
  round: number;
  score: number;
}

/** Derive the relay's HTTP origin from its ws(s):// URL (mirrors warmServer). */
function httpBase(): string {
  return getServerUrl()
    .replace(/^wss:\/\//, "https://")
    .replace(/^ws:\/\//, "http://")
    .replace(/\/$/, "");
}

/** Fetch the current global top survivors. Returns [] on any failure. */
export async function fetchLeaderboard(timeoutMs = 6000): Promise<LbRow[]> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(`${httpBase()}/leaderboard`, { signal: ctrl.signal });
    if (!res.ok) return [];
    const j = (await res.json()) as { ok?: boolean; rows?: LbRow[] };
    return Array.isArray(j.rows) ? j.rows : [];
  } catch {
    return [];
  } finally {
    clearTimeout(t);
  }
}

/**
 * Submit a finished run to the global board, keyed by WALLET address. Requires a
 * connected wallet — the global board is wallet-gated (true per-player identity).
 * Fire-and-forget; never throws.
 */
export async function submitScore(addr: string | null, name: string, round: number, score: number): Promise<void> {
  if (!addr || !(round > 0)) return; // no wallet or nothing to record
  try {
    await fetch(`${httpBase()}/score`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addr, name, round, score }),
    });
  } catch {
    /* best-effort */
  }
}
