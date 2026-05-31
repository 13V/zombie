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
import { offlineGold } from "../src/idle.ts";
import { IDLE } from "../src/config.ts";

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
