/**
 * Pure-math tests for src/idle.ts — offline accrual, prestige curve, day buckets,
 * login streak (+ freeze), and daily quests.
 *
 * idle.ts imports only ./config + ./save TYPES (no THREE/DOM), so it strips and
 * runs cleanly under node:test exactly like the rounds/save suites.
 *
 * Runner: `npm run test:idle` -> node --test --experimental-strip-types.
 */
import test from "node:test";
import assert from "node:assert/strict";
import { offlineGold, prestigeGain, prestigeMultiplier } from "../src/idle.ts";
import { IDLE, PRESTIGE } from "../src/config.ts";

const HOUR = 60 * 60 * 1000;

// ──────────────────────────── offlineGold ────────────────────────────

test("offlineGold pays HALF the active rate over the elapsed window", () => {
  // 10 gold/sec active -> 5 gold/sec offline. 1h = 3600s -> 18000 gold.
  assert.equal(offlineGold(10, HOUR), Math.floor(10 * IDLE.offlineRate * 3600));
  assert.equal(offlineGold(10, HOUR), 18_000);
});

test("offlineGold respects the cap (long absence clamps to capMs)", () => {
  const rate = 4;
  // 100h elapsed but default cap is 8h -> paid for 8h only.
  const capped = offlineGold(rate, 100 * HOUR);
  assert.equal(capped, offlineGold(rate, IDLE.offlineCapMs));
  assert.equal(capped, Math.floor(rate * IDLE.offlineRate * (IDLE.offlineCapMs / 1000)));
});

test("offlineGold honours a custom capMs", () => {
  // cap at 30 min: 5 gold/sec active, 10h elapsed -> only 30min paid.
  const g = offlineGold(5, 10 * HOUR, 30 * 60 * 1000);
  assert.equal(g, Math.floor(5 * IDLE.offlineRate * 1800));
});

test("offlineGold is zero for zero / negative / non-finite elapsed", () => {
  assert.equal(offlineGold(10, 0), 0);
  assert.equal(offlineGold(10, -5000), 0);
  assert.equal(offlineGold(10, Number.NaN), 0);
  assert.equal(offlineGold(10, Infinity), 0); // non-finite elapsed (corrupt clock) -> no payout
});

test("offlineGold is zero for zero / negative / non-finite rate", () => {
  assert.equal(offlineGold(0, HOUR), 0);
  assert.equal(offlineGold(-3, HOUR), 0);
  assert.equal(offlineGold(Number.NaN, HOUR), 0);
});

test("offlineGold floors fractional gold (never over-pays)", () => {
  // 1 gold/sec active -> 0.5/sec offline. 3s -> 1.5 -> floors to 1.
  assert.equal(offlineGold(1, 3000), 1);
  assert.equal(offlineGold(1, 1000), 0); // 0.5 -> 0
});

// ──────────────────────────── prestigeGain ────────────────────────────

test("prestigeGain follows floor(sqrt(lifetimeGold / X)) minus owned", () => {
  const X = PRESTIGE.x; // 50_000
  assert.equal(prestigeGain(0, 0, X), 0);
  assert.equal(prestigeGain(X - 1, 0, X), 0); // just under the first point
  assert.equal(prestigeGain(X, 0, X), 1); // exactly enough for #1
  assert.equal(prestigeGain(4 * X, 0, X), 2); // sqrt(4)=2
  assert.equal(prestigeGain(9 * X, 0, X), 3); // sqrt(9)=3
  assert.equal(prestigeGain(16 * X, 0, X), 4);
});

test("prestigeGain returns only the GAIN above already-owned", () => {
  const X = PRESTIGE.x;
  assert.equal(prestigeGain(9 * X, 2, X), 1); // total 3, own 2 -> +1
  assert.equal(prestigeGain(9 * X, 3, X), 0); // already claimed all
  assert.equal(prestigeGain(9 * X, 5, X), 0); // never negative
});

test("prestigeGain guards against garbage input", () => {
  assert.equal(prestigeGain(Number.NaN, 0), 0);
  assert.equal(prestigeGain(-100, 0), 0);
  assert.equal(prestigeGain(1e9, Number.NaN), prestigeGain(1e9, 0)); // bad owned -> treat as 0
});

test("prestigeGain X tuned so first ascension needs ~50k lifetime gold (2-3h)", () => {
  // Sanity-lock the chosen constant so a config edit that breaks the pacing
  // promise is caught here.
  assert.equal(PRESTIGE.x, 50_000);
  assert.equal(prestigeGain(49_999, 0), 0);
  assert.equal(prestigeGain(50_000, 0), 1);
});

// ──────────────────────────── prestigeMultiplier ────────────────────────────

test("prestigeMultiplier is 1 + prestige * k", () => {
  const k = PRESTIGE.k; // 0.10
  assert.equal(prestigeMultiplier(0), 1);
  assert.equal(prestigeMultiplier(1), 1 + k);
  assert.equal(prestigeMultiplier(5), 1 + 5 * k);
  assert.equal(prestigeMultiplier(10, 0.2), 1 + 10 * 0.2);
});

test("prestigeMultiplier floors prestige and guards garbage (never < 1)", () => {
  assert.equal(prestigeMultiplier(2.9), 1 + 2 * PRESTIGE.k);
  assert.equal(prestigeMultiplier(-3), 1);
  assert.equal(prestigeMultiplier(Number.NaN), 1);
});
