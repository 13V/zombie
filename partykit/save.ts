import type * as Party from "partykit/server";
import nacl from "tweetnacl";
import bs58 from "bs58";

/**
 * PartyKit "save" party for Tiny Dead — durable, wallet-authenticated cloud saves.
 *
 * One PartyKit room == one Solana wallet address (the room id IS the address).
 * Each room holds exactly one save blob in durable storage, so a player's
 * gold/pets/progress follow their wallet across devices.
 *
 * Reached at: /parties/save/<wallet-address>
 * (the multiplayer relay lives at /parties/main/tinydead — untouched).
 *
 * Auth is a Solana ed25519 wallet signature exchanged for a short-lived bearer
 * token; the token then authorizes save pushes. Reads are public (debug/convenience).
 *
 * Deploy: `cd partykit && npx partykit@latest deploy`
 * Base URL: https://tiny-dead.<your-username>.partykit.dev
 */

const TOKEN_TTL_MS = 6 * 3600_000; // 6 hours
const REPLAY_WINDOW_MS = 300_000; // ±5 minutes
const MAX_BODY_BYTES = 256 * 1024; // 256 KB

const CORS_HEADERS: Record<string, string> = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
  "Access-Control-Allow-Headers": "content-type, authorization",
};

interface TokenRecord {
  exp: number;
}
interface SaveRecord {
  save: unknown;
  updated: number;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json", ...CORS_HEADERS },
  });
}

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** base64url-encode raw bytes (no padding). */
function base64url(bytes: Uint8Array): string {
  let bin = "";
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Decode standard base64 (signatures) into raw bytes. */
function base64Decode(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export default class SaveServer implements Party.Server {
  constructor(readonly room: Party.Room) {}

  async onRequest(req: Party.Request): Promise<Response> {
    // Preflight — answer before doing any work.
    if (req.method === "OPTIONS") {
      return new Response(null, { status: 204, headers: CORS_HEADERS });
    }

    try {
      const url = new URL(req.url);
      // Path is /parties/save/<roomId>[/login]; the segment after the room id
      // (if any) is the sub-route.
      const segments = url.pathname.split("/").filter(Boolean);
      // [...,"parties","save","<roomId>", <sub?>]
      const sub = segments[segments.length - 1] === "login" ? "login" : "";

      if (req.method === "POST" && sub === "login") {
        return await this.handleLogin(req);
      }
      if (req.method === "POST" && sub === "") {
        return await this.handlePush(req);
      }
      if (req.method === "GET" && sub === "") {
        return await this.handleGet();
      }
      return json({ ok: false, error: "not found" }, 404);
    } catch (err) {
      return json(
        { ok: false, error: err instanceof Error ? err.message : "internal error" },
        500,
      );
    }
  }

  // ---- POST /login : verify wallet signature, mint a bearer token ----
  private async handleLogin(req: Party.Request): Promise<Response> {
    const addr = this.room.id;

    let body: { message?: unknown; signature?: unknown };
    try {
      body = await req.json();
    } catch {
      return json({ ok: false, error: "invalid json" }, 401);
    }

    const message = body?.message;
    const signature = body?.signature;
    if (typeof message !== "string" || typeof signature !== "string") {
      return json({ ok: false, error: "missing message/signature" }, 401);
    }

    // Message must match the exact challenge format, with the room's own address
    // and a fresh timestamp inside the replay window.
    const expectedPrefix = `Tiny Dead save sync\naddress: ${addr}\nts: `;
    if (!message.startsWith(expectedPrefix)) {
      return json({ ok: false, error: "bad message format" }, 401);
    }
    const tsStr = message.slice(expectedPrefix.length);
    const ts = Number(tsStr);
    if (!Number.isInteger(ts)) {
      return json({ ok: false, error: "bad timestamp" }, 401);
    }
    if (Math.abs(Date.now() - ts) > REPLAY_WINDOW_MS) {
      return json({ ok: false, error: "stale timestamp" }, 401);
    }

    // Verify the ed25519 signature against the address (decoded as the pubkey).
    let ok = false;
    try {
      const pubkey = bs58.decode(addr);
      if (pubkey.length !== 32) {
        return json({ ok: false, error: "bad address" }, 401);
      }
      const sig = base64Decode(signature);
      const msgBytes = new TextEncoder().encode(message);
      ok = nacl.sign.detached.verify(msgBytes, sig, pubkey);
    } catch {
      return json({ ok: false, error: "bad signature" }, 401);
    }
    if (!ok) {
      return json({ ok: false, error: "signature verification failed" }, 401);
    }

    // Mint a token, persist it, and prune stale tokens opportunistically.
    const rand = new Uint8Array(32);
    crypto.getRandomValues(rand);
    const token = base64url(rand);
    await this.room.storage.put<TokenRecord>("tok:" + token, {
      exp: Date.now() + TOKEN_TTL_MS,
    });
    void this.pruneExpiredTokens();

    const rec = await this.room.storage.get<SaveRecord>("save");
    return json({
      ok: true,
      token,
      save: rec ? rec.save : null,
      updated: rec ? rec.updated : 0,
    });
  }

  // ---- POST / : authorized save push ----
  private async handlePush(req: Party.Request): Promise<Response> {
    const auth = req.headers.get("authorization") || "";
    const m = /^Bearer\s+(.+)$/i.exec(auth.trim());
    if (!m) {
      return json({ ok: false, error: "missing token" }, 401);
    }
    const token = m[1].trim();

    const key = "tok:" + token;
    const tok = await this.room.storage.get<TokenRecord>(key);
    if (!tok || tok.exp <= Date.now()) {
      if (tok) await this.room.storage.delete(key);
      return json({ ok: false, error: "invalid or expired token" }, 401);
    }

    // Read the raw body so we can size-guard before parsing. Measure real UTF-8
    // byte length (not UTF-16 code units) so multibyte payloads are capped right.
    const raw = await req.text();
    if (new TextEncoder().encode(raw).length > MAX_BODY_BYTES) {
      return json({ ok: false, error: "save too large" }, 413);
    }

    let body: { save?: unknown; updated?: unknown };
    try {
      body = JSON.parse(raw);
    } catch {
      return json({ ok: false, error: "invalid json" }, 400);
    }
    if (!isPlainObject(body) || !isPlainObject(body.save)) {
      return json({ ok: false, error: "save must be an object" }, 400);
    }

    // Server clock is authoritative for `updated`.
    const updated = Date.now();
    await this.room.storage.put<SaveRecord>("save", { save: body.save, updated });
    return json({ ok: true, updated });
  }

  // ---- GET / : public read ----
  private async handleGet(): Promise<Response> {
    const rec = await this.room.storage.get<SaveRecord>("save");
    return json({
      ok: true,
      save: rec ? rec.save : null,
      updated: rec ? rec.updated : 0,
    });
  }

  /**
   * Cheap, best-effort cleanup of expired token keys. We only list the small
   * "tok:" prefix (not the whole store) and delete what's clearly stale, so
   * tokens never accumulate without bound. Failures are swallowed — pruning is
   * never allowed to affect the request that triggered it.
   */
  private async pruneExpiredTokens(): Promise<void> {
    try {
      const now = Date.now();
      const toks = await this.room.storage.list<TokenRecord>({ prefix: "tok:" });
      const dead: string[] = [];
      for (const [k, v] of toks) {
        if (!v || v.exp <= now) dead.push(k);
      }
      if (dead.length) await this.room.storage.delete(dead);
    } catch {
      /* best-effort */
    }
  }
}
