/**
 * Tiny Dead — token reward backend (REFERENCE SKELETON).
 *
 * This is the trusted authority the static game client cannot be. It owns the
 * earnings ledger and is the ONLY thing that signs treasury payouts. The client
 * (src/token.ts + src/wallet.ts) can only (a) read claimable and (b) forward a
 * wallet-signed claim request; it can never mint or authorize value.
 *
 * WHAT'S REAL HERE:  signature verification, replay protection, the ledger,
 * the claim flow, and a real SPL transfer when a treasury key is configured.
 * WHAT'S STUBBED (do before production — see README):
 *   - durable DB (this uses a JSON file; swap for Postgres/SQLite)
 *   - server-authoritative gameplay/score validation feeding /credit
 *   - anti-Sybil / bot / wash-trade detection, withdrawal limits, KYC, geofence
 *   - provably-fair box RNG hardening (commit-reveal here; consider on-chain VRF)
 *   - hot/cold treasury split + a global daily-outflow circuit breaker
 */
import express from "express";
import cors from "cors";
import nacl from "tweetnacl";
import bs58 from "bs58";
import fs from "fs";
import crypto from "crypto";
import {
  Connection,
  Keypair,
  PublicKey,
  clusterApiUrl,
} from "@solana/web3.js";
import {
  getOrCreateAssociatedTokenAccount,
  transfer,
} from "@solana/spl-token";

// ---- config (from env) ----------------------------------------------------
const PORT = Number(process.env.PORT ?? 8787);
const ADMIN_SECRET = process.env.ADMIN_SECRET ?? ""; // protects /credit & /box
const RPC_URL = process.env.SOLANA_RPC ?? clusterApiUrl("devnet");
const TOKEN_MINT = process.env.TOKEN_MINT ?? ""; // SPL mint address of $TOKEN
const TREASURY_SECRET = process.env.TREASURY_SECRET ?? ""; // base58 secret key
const CLAIM_MAX_AGE_MS = 2 * 60 * 1000; // signed intents expire after 2 min
const DAILY_WITHDRAW_CAP = Number(process.env.DAILY_WITHDRAW_CAP ?? 1000);
const LEDGER_PATH = process.env.LEDGER_PATH ?? "./ledger.json";

// ---- ledger (JSON-file placeholder — REPLACE WITH A REAL DB) ---------------
interface Account {
  claimable: number;
  claimedTotal: number;
  withdrawnToday: number;
  dayStamp: string;
  usedSignatures: string[]; // replay guard
}
type Ledger = Record<string, Account>;

function loadLedger(): Ledger {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_PATH, "utf8")) as Ledger;
  } catch {
    return {};
  }
}
function saveLedger(l: Ledger) {
  fs.writeFileSync(LEDGER_PATH, JSON.stringify(l, null, 2));
}
function acct(l: Ledger, addr: string): Account {
  const today = new Date().toISOString().slice(0, 10);
  const a = (l[addr] ??= { claimable: 0, claimedTotal: 0, withdrawnToday: 0, dayStamp: today, usedSignatures: [] });
  if (a.dayStamp !== today) {
    a.dayStamp = today;
    a.withdrawnToday = 0;
  }
  return a;
}

// ---- solana payout (real when TREASURY_SECRET + TOKEN_MINT set) ------------
function treasury(): Keypair | null {
  if (!TREASURY_SECRET) return null;
  return Keypair.fromSecretKey(bs58.decode(TREASURY_SECRET));
}

/** Send `amount` whole tokens of $TOKEN from treasury to `toOwner`. */
async function payout(toOwner: string, amount: number): Promise<string> {
  const signer = treasury();
  if (!signer || !TOKEN_MINT) {
    // No chain configured yet — return a dry-run id so the flow is testable.
    return "DRYRUN-" + crypto.randomBytes(8).toString("hex");
  }
  const conn = new Connection(RPC_URL, "confirmed");
  const mint = new PublicKey(TOKEN_MINT);
  const dest = new PublicKey(toOwner);
  const from = await getOrCreateAssociatedTokenAccount(conn, signer, mint, signer.publicKey);
  const to = await getOrCreateAssociatedTokenAccount(conn, signer, mint, dest);
  // NOTE: assumes 0 decimals for clarity. Use mint decimals in production.
  const sig = await transfer(conn, signer, from.address, to.address, signer, amount);
  return sig;
}

// ---- signature verification -----------------------------------------------
/** True if `signature` (base64) over `message` was made by `address` (base58). */
function verifySig(address: string, message: string, signatureB64: string): boolean {
  try {
    const pub = bs58.decode(address);
    const sig = Buffer.from(signatureB64, "base64");
    const msg = new TextEncoder().encode(message);
    return nacl.sign.detached.verify(msg, sig, pub);
  } catch {
    return false;
  }
}

/** Pull the `ts:` field out of the signed message and check it's fresh. */
function freshTimestamp(message: string): boolean {
  const m = message.match(/ts:\s*(\d+)/);
  if (!m) return false;
  const age = Date.now() - Number(m[1]);
  return age >= 0 && age < CLAIM_MAX_AGE_MS;
}

// ---- app ------------------------------------------------------------------
const app = express();
app.use(cors()); // TODO: restrict origin to your game domain in production
app.use(express.json());

app.get("/health", (_req, res) => res.json({ ok: true }));

/** Server-authoritative claimable balance for a wallet. */
app.get("/claimable", (req, res) => {
  const address = String(req.query.address ?? "");
  if (!address) return res.status(400).json({ error: "address required" });
  const l = loadLedger();
  res.json({ claimable: acct(l, address).claimable });
});

/**
 * Credit verified earnings to a wallet. ADMIN-ONLY: your server-authoritative
 * game logic (marketplace sale settled, box opened, season prize) calls this —
 * NEVER the game client. Guarded by ADMIN_SECRET.
 */
app.post("/credit", (req, res) => {
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET || !ADMIN_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { address, amount } = req.body ?? {};
  if (typeof address !== "string" || typeof amount !== "number" || !(amount > 0)) {
    return res.status(400).json({ error: "address + positive amount required" });
  }
  const l = loadLedger();
  acct(l, address).claimable += amount;
  saveLedger(l);
  res.json({ ok: true, claimable: l[address].claimable });
});

/**
 * Provably-fair mystery-box open (commit-reveal). ADMIN/authenticated only —
 * the box outcome is decided HERE, never on the client. This is a skeleton:
 * harden with per-user server seeds, published commits, and on-chain VRF for
 * high-value tiers.
 */
app.post("/box/open", (req, res) => {
  if (req.headers["x-admin-secret"] !== ADMIN_SECRET || !ADMIN_SECRET) {
    return res.status(403).json({ error: "forbidden" });
  }
  const { address, serverSeed, clientSeed, nonce } = req.body ?? {};
  if (!address || !serverSeed || !clientSeed) return res.status(400).json({ error: "seeds required" });
  const roll = crypto.createHmac("sha256", String(serverSeed)).update(`${clientSeed}:${nonce ?? 0}`).digest();
  const p = roll.readUInt32BE(0) / 0xffffffff; // 0..1, verifiable post-reveal
  const tier = p < 0.005 ? "mythic" : p < 0.05 ? "legendary" : p < 0.2 ? "epic" : p < 0.5 ? "rare" : "common";
  res.json({ ok: true, tier, p, commit: crypto.createHash("sha256").update(String(serverSeed)).digest("hex") });
});

/**
 * Claim: client proves wallet ownership; server decides the amount from ITS
 * ledger and signs the treasury transfer. The client never states an amount.
 */
app.post("/claim", async (req, res) => {
  const { address, message, signature } = req.body ?? {};
  if (typeof address !== "string" || typeof message !== "string" || typeof signature !== "string") {
    return res.status(400).json({ error: "address, message, signature required" });
  }
  if (!message.includes(`address: ${address}`)) return res.status(400).json({ error: "message/address mismatch" });
  if (!freshTimestamp(message)) return res.status(400).json({ error: "signed request expired — try again" });
  if (!verifySig(address, message, signature)) return res.status(401).json({ error: "bad signature" });

  const l = loadLedger();
  const a = acct(l, address);
  if (a.usedSignatures.includes(signature)) return res.status(409).json({ error: "already used" });

  const amount = a.claimable;
  if (amount <= 0) return res.status(200).json({ ok: false, error: "nothing to claim" });
  if (a.withdrawnToday + amount > DAILY_WITHDRAW_CAP) {
    return res.status(429).json({ error: `daily withdraw cap (${DAILY_WITHDRAW_CAP}) reached` });
  }

  // Reserve before paying so a crash can't double-pay (idempotency via nonce).
  a.usedSignatures.push(signature);
  if (a.usedSignatures.length > 50) a.usedSignatures.shift();
  a.claimable = 0;
  a.claimedTotal += amount;
  a.withdrawnToday += amount;
  saveLedger(l);

  try {
    const txid = await payout(address, amount);
    res.json({ ok: true, claimed: amount, txid });
  } catch (e) {
    // refund the ledger on payout failure
    a.claimable += amount;
    a.claimedTotal -= amount;
    a.withdrawnToday -= amount;
    saveLedger(l);
    res.status(502).json({ error: "payout failed: " + (e as Error).message });
  }
});

app.listen(PORT, () => console.log(`token-backend listening on :${PORT} (rpc=${RPC_URL})`));
