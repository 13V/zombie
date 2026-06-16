/**
 * leaderboard.ts — a tiny persistent GLOBAL leaderboard for the game.
 *
 * The relay server is already deployed and reachable by every client, so it
 * doubles as the leaderboard backend: clients POST a finished run and GET the
 * current top survivors (rendered on the hub billboard).
 *
 * Storage is a single JSON file (best-effort). On a host with a persistent disk
 * (set LEADERBOARD_FILE to a path on the mount) entries survive restarts; on an
 * ephemeral filesystem they persist for the life of the instance. Either way the
 * board is GLOBAL + LIVE across all online players, which is the thing that was
 * missing (the old board only showed players in your own lobby instance).
 *
 * Anti-garbage: names are sanitized + length-capped, round/score are clamped to
 * sane bounds, and we keep only each NAME's best run so one player can't flood
 * the board. This is a casual game leaderboard, not a bank — cheap and forgiving.
 */
import { readFileSync, writeFileSync } from 'node:fs';

export interface ScoreRow {
  addr: string; // wallet address — the UNIQUE per-player key
  name: string; // display name (cosmetic only)
  round: number;
  score: number;
  ts: number; // ms epoch the row was recorded (tiebreak / recency)
}

const FILE = process.env.LEADERBOARD_FILE || './leaderboard.json';
export const CAP = 100; // rows kept/served
const MAX_NAME = 16;
export const MAX_ROUND = 100_000; // generous ceiling; rejects obviously forged values
export const MAX_SCORE = 1_000_000_000;

/** A leaderboard store: the in-memory/file one (default) or the Supabase one.
 *  Methods are async so a Postgres-backed store can be dropped in transparently. */
export interface LbStore {
  top(limit?: number): Promise<ScoreRow[]>;
  submit(input: { addr?: unknown; name?: unknown; round?: unknown; score?: unknown }): Promise<{ ok: boolean; rank: number }>;
}

/** Validate a Solana wallet address (base58, 32–44 chars). Returns "" if bad.
 *  The board is keyed on this so identity is the wallet, not the display name. */
export function cleanAddr(raw: unknown): string {
  if (typeof raw !== 'string') return '';
  const s = raw.trim();
  return /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(s) ? s : '';
}

/** Strip control chars / collapse whitespace / cap a display name → "Anon"
 *  fallback. Filters by code point so there are no control-char regex literals. */
export function cleanName(raw: unknown): string {
  if (typeof raw !== 'string') return 'Anon';
  let out = '';
  let prevSpace = false;
  for (const ch of raw) {
    const code = ch.codePointAt(0)!;
    if (code < 0x20 || code === 0x7f) continue; // drop control chars
    const isSpace = ch === ' ' || ch === '\t';
    if (isSpace) {
      if (prevSpace || out === '') continue; // collapse + no leading space
      out += ' ';
      prevSpace = true;
    } else {
      out += ch;
      prevSpace = false;
    }
    if (out.length >= MAX_NAME) break;
  }
  out = out.trim().slice(0, MAX_NAME);
  return out || 'Anon';
}

export function clampInt(v: unknown, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.floor(n));
}

export class Leaderboard implements LbStore {
  private rows: ScoreRow[] = [];
  private saveTimer: ReturnType<typeof setTimeout> | null = null;

  constructor() {
    this.load();
  }

  private load(): void {
    try {
      const raw = JSON.parse(readFileSync(FILE, 'utf8'));
      if (Array.isArray(raw)) {
        this.rows = raw
          .map((r) => ({ addr: cleanAddr(r?.addr), name: cleanName(r?.name), round: clampInt(r?.round, MAX_ROUND), score: clampInt(r?.score, MAX_SCORE), ts: clampInt(r?.ts, Number.MAX_SAFE_INTEGER) }))
          .filter((r) => r.addr && r.round > 0)
          .slice(0, CAP);
        this.resort();
      }
    } catch {
      /* no file yet / unreadable — start empty */
    }
  }

  /** Debounced best-effort persist (never throws into the request path). */
  private scheduleSave(): void {
    if (this.saveTimer) return;
    this.saveTimer = setTimeout(() => {
      this.saveTimer = null;
      try {
        writeFileSync(FILE, JSON.stringify(this.rows));
      } catch {
        /* ephemeral FS or no perms — keep serving from memory */
      }
    }, 1500);
    this.saveTimer.unref?.();
  }

  private resort(): void {
    // round desc, then score desc, then most-recent first
    this.rows.sort((a, b) => b.round - a.round || b.score - a.score || b.ts - a.ts);
    if (this.rows.length > CAP) this.rows.length = CAP;
  }

  /** Current top rows (already sorted, capped). Returns a fresh array. */
  async top(limit = CAP): Promise<ScoreRow[]> {
    return this.rows.slice(0, Math.min(limit, CAP));
  }

  /**
   * Record a finished run, keyed by WALLET address (the unique per-player id).
   * Keeps only each wallet's BEST run (higher round, then higher score) so one
   * player can't flood the board, and updates that wallet's display name to the
   * latest. Requires a valid address — name-only runs are rejected. Returns the
   * row's 0-based rank, or -1 if it didn't qualify.
   */
  async submit(input: { addr?: unknown; name?: unknown; round?: unknown; score?: unknown }): Promise<{ ok: boolean; rank: number }> {
    const row: ScoreRow = {
      addr: cleanAddr(input.addr),
      name: cleanName(input.name),
      round: clampInt(input.round, MAX_ROUND),
      score: clampInt(input.score, MAX_SCORE),
      ts: Date.now(),
    };
    if (!row.addr || row.round <= 0) return { ok: false, rank: -1 };

    const existing = this.rows.find((r) => r.addr === row.addr);
    if (existing) {
      existing.name = row.name; // keep the wallet's display name fresh
      // only replace the score if this run is strictly better than the current best
      const better = row.round > existing.round || (row.round === existing.round && row.score > existing.score);
      if (better) { existing.round = row.round; existing.score = row.score; existing.ts = row.ts; }
    } else {
      this.rows.push(row);
    }
    this.resort();
    this.scheduleSave();
    const rank = this.rows.findIndex((r) => r.addr === row.addr);
    return { ok: true, rank };
  }
}

/**
 * Pick the leaderboard backend at startup. If Supabase is configured (durable
 * Postgres — survives restarts/redeploys) use it; otherwise fall back to the
 * in-memory/file store so local dev and un-configured deploys still work.
 *
 * Env (set on the relay host, NEVER in the client):
 *   SUPABASE_URL                 e.g. https://xxxx.supabase.co
 *   SUPABASE_SERVICE_ROLE_KEY    service-role key (or SUPABASE_KEY)
 */
export async function makeLeaderboard(): Promise<LbStore> {
  const url = process.env.SUPABASE_URL?.replace(/\/$/, '');
  const key = process.env.SUPABASE_SERVICE_ROLE_KEY || process.env.SUPABASE_KEY;
  if (url && key) {
    const { SupabaseLeaderboard } = await import('./supabaseLeaderboard.js');
    console.log('[leaderboard] using Supabase Postgres store');
    return new SupabaseLeaderboard(url, key);
  }
  console.log('[leaderboard] using in-memory/file store (set SUPABASE_URL + SUPABASE_SERVICE_ROLE_KEY for durable storage)');
  return new Leaderboard();
}
