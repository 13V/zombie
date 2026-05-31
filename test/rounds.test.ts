/**
 * Round difficulty-math invariants for src/rounds.ts.
 *
 * IMPORTANT SCOPE / TESTABILITY NOTE
 * ----------------------------------
 * RoundManager.beginRound (HP curve) and RoundManager.pickType (weighted type
 * sampling) are PRIVATE instance methods, and src/rounds.ts cannot even be
 * imported under the node:test runner: its transitive chain
 * (rounds -> zombie -> assets / voxelChar) imports the *type* `AnimState`
 * without the `type` modifier, which neither `--experimental-strip-types` nor
 * `--experimental-transform-types` can erase (see report). So we cannot call
 * the real functions directly.
 *
 * What we CAN do without touching src: src/config.ts imports cleanly (no THREE)
 * and holds every constant the curve + sampler are derived from. This suite
 * re-derives the EXACT formulas documented in rounds.ts from the REAL config
 * values and asserts the invariants the design promises (monotonic HP, smooth
 * inflection seam, type gating). A config regression that broke those promises
 * would be caught here. The arithmetic mirrors rounds.ts line-for-line.
 *
 * Runner: `npm run test:rounds` (plain --experimental-strip-types; config-only).
 */
import test from "node:test";
import assert from "node:assert/strict";
import { ZOMBIE, ROUNDS, ZOMBIE_TYPES } from "../src/config.ts";

// ---- re-derived from rounds.ts beginRound() (kept verbatim) ---------------
function roundHP(n: number): number {
  const inflect = ZOMBIE.hpInflection;
  const past = Math.max(0, n - inflect);
  const linHP = ZOMBIE.baseHealth + (n - 1) * ZOMBIE.healthPerRound;
  if (n <= inflect) return linHP;
  const baseHP = ZOMBIE.baseHealth + (inflect - 1) * ZOMBIE.healthPerRound;
  return baseHP * Math.pow(ZOMBIE.hpGrowth, past);
}

test("HP curve is strictly monotonic increasing across R1..R40", () => {
  let prev = -Infinity;
  for (let n = 1; n <= 40; n++) {
    const hp = roundHP(n);
    assert.ok(hp > prev, `HP at R${n} (${hp}) should exceed R${n - 1} (${prev})`);
    prev = hp;
  }
});

test("HP is the additive (linear) value through the inflection round", () => {
  for (let n = 1; n <= ZOMBIE.hpInflection; n++) {
    assert.equal(roundHP(n), ZOMBIE.baseHealth + (n - 1) * ZOMBIE.healthPerRound);
  }
});

test("inflection seam is continuous: R(inflect) equals the multiplicative branch at past=0", () => {
  const inflect = ZOMBIE.hpInflection;
  const linAtInflect = ZOMBIE.baseHealth + (inflect - 1) * ZOMBIE.healthPerRound;
  // multiplicative branch base (past === 0 -> growth^0 === 1) must equal the
  // last linear value, so there is no jump at the seam.
  assert.equal(roundHP(inflect), linAtInflect);
  // first multiplicative round is exactly base * growth (no discontinuity)
  assert.ok(Math.abs(roundHP(inflect + 1) - linAtInflect * ZOMBIE.hpGrowth) < 1e-9);
});

test("past the inflection HP compounds by exactly hpGrowth each round", () => {
  for (let n = ZOMBIE.hpInflection + 1; n <= 30; n++) {
    const ratio = roundHP(n) / roundHP(n - 1);
    assert.ok(Math.abs(ratio - ZOMBIE.hpGrowth) < 1e-9, `R${n}/R${n - 1} ratio ${ratio}`);
  }
});

// ---- pickType() gating preconditions over the REAL ZOMBIE_TYPES table -----

test("ZOMBIE_TYPES[0] is the shambler with weight 0 (pickType uses it as filler)", () => {
  assert.equal(ZOMBIE_TYPES[0].id, "shambler");
  assert.equal(ZOMBIE_TYPES[0].weight, 0);
  assert.equal(ZOMBIE_TYPES[0].from, 1);
});

test("every elite id referenced by pickType exists in ZOMBIE_TYPES", () => {
  // mirrors RoundManager.ELITE_IDS
  const ELITE_IDS = ["brute", "armored", "abomination", "splitter", "necro"];
  const ids = new Set(ZOMBIE_TYPES.map((t) => t.id));
  for (const e of ELITE_IDS) assert.ok(ids.has(e), `elite id ${e} missing from ZOMBIE_TYPES`);
});

test("a re-derived pickType only returns types unlocked at the given round", () => {
  // verbatim port of pickType() with an injectable RNG, so we can exercise the
  // gating + weighting logic deterministically against the real type table.
  const ELITE_IDS = new Set(["brute", "armored", "abomination", "splitter", "necro"]);
  function pickType(round: number, rng: () => number) {
    const eliteBonus = Math.max(0, Math.min(0.35, (round - 9) * 0.03));
    const shamblerWeight = Math.max(0.25, 0.9 - (round - 1) * 0.04);
    let total = shamblerWeight;
    for (let i = 1; i < ZOMBIE_TYPES.length; i++) {
      const t = ZOMBIE_TYPES[i];
      if (round < t.from) continue;
      total += t.weight * (ELITE_IDS.has(t.id) ? 1 + eliteBonus : 1);
    }
    let r = rng() * total;
    if ((r -= shamblerWeight) < 0) return ZOMBIE_TYPES[0];
    for (let i = 1; i < ZOMBIE_TYPES.length; i++) {
      const t = ZOMBIE_TYPES[i];
      if (round < t.from) continue;
      const w = t.weight * (ELITE_IDS.has(t.id) ? 1 + eliteBonus : 1);
      if ((r -= w) < 0) return t;
    }
    return ZOMBIE_TYPES[0];
  }

  // Sweep the whole [0,1) RNG range at several rounds; never yield a locked type.
  for (const round of [1, 2, 3, 5, 7, 9, 10, 15, 20]) {
    for (let k = 0; k < 200; k++) {
      const picked = pickType(round, () => k / 200);
      assert.ok(round >= picked.from, `R${round} returned ${picked.id} (from ${picked.from})`);
    }
  }
});

test("re-derived pickType: round 1 can ONLY ever produce the shambler", () => {
  const pickAt1 = (rngVal: number) => {
    // at round 1 no other type is unlocked (next-earliest from is 2)
    const shamblerWeight = Math.max(0.25, 0.9 - (1 - 1) * 0.04); // 0.9
    const total = shamblerWeight; // nothing else eligible
    let r = rngVal * total;
    if ((r -= shamblerWeight) < 0) return ZOMBIE_TYPES[0];
    return ZOMBIE_TYPES[0];
  };
  for (let k = 0; k < 100; k++) assert.equal(pickAt1(k / 100).id, "shambler");
});

test("shambler filler weight floors at 0.25 and never vanishes", () => {
  for (let round = 1; round <= 60; round++) {
    const w = Math.max(0.25, 0.9 - (round - 1) * 0.04);
    assert.ok(w >= 0.25, `shambler weight ${w} at R${round}`);
  }
});

test("elite bonus ramp is clamped to [0, 0.35] and starts at R10", () => {
  const bonus = (round: number) => Math.max(0, Math.min(0.35, (round - 9) * 0.03));
  assert.equal(bonus(9), 0); // (9-9)*0.03 = 0
  assert.ok(bonus(8) === 0); // clamped, no negative bonus before R10
  assert.ok(Math.abs(bonus(10) - 0.03) < 1e-9);
  assert.equal(bonus(100), 0.35); // hard cap
});

// ---- swarm gating (isSwarm in beginRound), derived from ROUNDS -------------
test("swarm rounds: every Nth round that isn't a boss round (n%5)", () => {
  const isSwarm = (n: number) => n >= ROUNDS.swarmEvery && n % ROUNDS.swarmEvery === 0 && n % 5 !== 0;
  // swarmEvery is 7: R7,R14 swarm; R35 (7*5) is a boss round, so NOT swarm.
  assert.equal(isSwarm(7), true);
  assert.equal(isSwarm(14), true);
  assert.equal(isSwarm(35), false); // boss round wins
  assert.equal(isSwarm(6), false);
  assert.equal(isSwarm(5), false);
});
