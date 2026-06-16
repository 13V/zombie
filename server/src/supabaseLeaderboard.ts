/**
 * supabaseLeaderboard.ts — durable leaderboard backed by Supabase Postgres.
 *
 * The relay server talks to Supabase via PostgREST using the SERVICE-ROLE key
 * (a server-only secret, never shipped to the browser). Reads hit the REST view;
 * writes go through a Postgres function `submit_score(...)` that does an atomic,
 * race-safe "keep this wallet's best run" upsert. See server/supabase/leaderboard.sql
 * for the table + function the user must create once in the Supabase SQL editor.
 *
 * All input is sanitized/validated here (shared with the in-memory store) before
 * it ever reaches the database. Every call is best-effort: on any failure reads
 * return [] and writes report ok:false, so the game never blocks on the DB.
 */
import { cleanAddr, cleanName, clampInt, CAP, MAX_ROUND, MAX_SCORE, type LbStore, type ScoreRow } from './leaderboard.js';

export class SupabaseLeaderboard implements LbStore {
  private readonly rest: string;
  private readonly headers: Record<string, string>;

  constructor(url: string, key: string) {
    this.rest = `${url}/rest/v1`;
    this.headers = {
      apikey: key,
      authorization: `Bearer ${key}`,
      'content-type': 'application/json',
    };
  }

  async top(limit = CAP): Promise<ScoreRow[]> {
    const n = Math.min(Math.max(1, limit), CAP);
    const q = `${this.rest}/leaderboard?select=addr,name,round,score&order=round.desc,score.desc,ts.desc&limit=${n}`;
    try {
      const res = await fetch(q, { headers: this.headers });
      if (!res.ok) return [];
      const rows = (await res.json()) as ScoreRow[];
      return Array.isArray(rows) ? rows : [];
    } catch {
      return [];
    }
  }

  async submit(input: { addr?: unknown; name?: unknown; round?: unknown; score?: unknown }): Promise<{ ok: boolean; rank: number }> {
    const addr = cleanAddr(input.addr);
    const round = clampInt(input.round, MAX_ROUND);
    const score = clampInt(input.score, MAX_SCORE);
    const name = cleanName(input.name);
    if (!addr || round <= 0) return { ok: false, rank: -1 };
    try {
      const res = await fetch(`${this.rest}/rpc/submit_score`, {
        method: 'POST',
        headers: this.headers,
        body: JSON.stringify({ p_addr: addr, p_name: name, p_round: round, p_score: score }),
      });
      // rank isn't needed by the client (it refetches top()); report success only.
      return { ok: res.ok, rank: -1 };
    } catch {
      return { ok: false, rank: -1 };
    }
  }
}
