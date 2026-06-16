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
  name: string;
  round: number;
  score: number;
  ts: number; // ms epoch the row was recorded (tiebreak / recency)
}

const FILE = process.env.LEADERBOARD_FILE || './leaderboard.json';
const CAP = 100; // rows kept/served
const MAX_NAME = 16;
const MAX_ROUND = 100_000; // generous ceiling; rejects obviously forged values
const MAX_SCORE = 1_000_000_000;

/** Strip control chars / collapse whitespace / cap a display name → "Anon"
 *  fallback. Filters by code point so there are no control-char regex literals. */
function cleanName(raw: unknown): string {
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

function clampInt(v: unknown, max: number): number {
  const n = typeof v === 'number' ? v : Number(v);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.min(max, Math.floor(n));
}

export class Leaderboard {
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
          .map((r) => ({ name: cleanName(r?.name), round: clampInt(r?.round, MAX_ROUND), score: clampInt(r?.score, MAX_SCORE), ts: clampInt(r?.ts, Number.MAX_SAFE_INTEGER) }))
          .filter((r) => r.round > 0)
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
  top(limit = CAP): ScoreRow[] {
    return this.rows.slice(0, Math.min(limit, CAP));
  }

  /**
   * Record a finished run. Keeps only each name's BEST run (higher round, then
   * higher score) so the board can't be flooded by one player. Returns the
   * inserted/updated row's 0-based rank, or -1 if it didn't make the board.
   */
  submit(input: { name?: unknown; round?: unknown; score?: unknown }): { ok: boolean; rank: number } {
    const row: ScoreRow = {
      name: cleanName(input.name),
      round: clampInt(input.round, MAX_ROUND),
      score: clampInt(input.score, MAX_SCORE),
      ts: Date.now(),
    };
    if (row.round <= 0) return { ok: false, rank: -1 };

    const existing = this.rows.find((r) => r.name === row.name);
    if (existing) {
      // only replace if this run is strictly better than the name's current best
      const better = row.round > existing.round || (row.round === existing.round && row.score > existing.score);
      if (!better) return { ok: true, rank: this.rows.indexOf(existing) };
      existing.round = row.round;
      existing.score = row.score;
      existing.ts = row.ts;
    } else {
      this.rows.push(row);
    }
    this.resort();
    this.scheduleSave();
    const rank = this.rows.findIndex((r) => r.name === row.name);
    return { ok: true, rank };
  }
}
