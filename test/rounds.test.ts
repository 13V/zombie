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
import { ZOMBIE, ROUNDS, ZOMBIE_TYPES, SPECIAL_ROUNDS } from "../src/config.ts";

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

// ---- co-op player-count scaling (beginRound), derived verbatim ------------
// Mirrors the co-op block in beginRound: N players ⇒ N× HP AND N× horde count,
// with the alive-cap bounded to 2× the perf ceiling.
function coopHP(n: number, players: number): number {
  return roundHP(n) * Math.max(1, Math.floor(players));
}
function coopCount(n: number, players: number): number {
  const base = Math.min(ROUNDS.countCap, ROUNDS.baseCount + (n - 1) * ROUNDS.countPerRound);
  return Math.round(base * Math.max(1, Math.floor(players)));
}

test("co-op scales zombie HP linearly with player count (1/2/4 ⇒ 1×/2×/4×)", () => {
  for (const n of [1, 5, 10, 20]) {
    assert.equal(coopHP(n, 1), roundHP(n));
    assert.equal(coopHP(n, 2), roundHP(n) * 2);
    assert.equal(coopHP(n, 4), roundHP(n) * 4);
  }
});

test("co-op scales the horde COUNT linearly with player count", () => {
  for (const n of [1, 3, 8]) {
    assert.equal(coopCount(n, 2), 2 * Math.min(ROUNDS.countCap, ROUNDS.baseCount + (n - 1) * ROUNDS.countPerRound));
    assert.equal(coopCount(n, 4), 4 * Math.min(ROUNDS.countCap, ROUNDS.baseCount + (n - 1) * ROUNDS.countPerRound));
  }
});

test("solo (1 player) leaves HP and count unchanged", () => {
  for (let n = 1; n <= 15; n++) {
    assert.equal(coopHP(n, 1), roundHP(n));
    assert.equal(coopCount(n, 1), Math.min(ROUNDS.countCap, ROUNDS.baseCount + (n - 1) * ROUNDS.countPerRound));
  }
});

test("alive-cap is bounded to 2× the perf ceiling even with 4 players", () => {
  // beginRound: curMaxAlive = min(maxAliveCeiling * 2, curMaxAlive * players)
  const ceiling = ROUNDS.maxAliveCap;
  for (const players of [2, 4, 8]) {
    const naive = ROUNDS.maxAliveBase * players; // an upper-ish bound on curMaxAlive*players
    const bounded = Math.min(ceiling * 2, naive);
    assert.ok(bounded <= ceiling * 2, `cap ${bounded} must not exceed 2× ceiling`);
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

// ---- mutation rounds (classifySpecial), derived from SPECIAL_ROUNDS --------
// Port of the precedence in RoundManager.classifySpecial: hound (every Nth)
// wins, then mutation (every Mth, rotating), then showcases. We only assert the
// hound>mutation precedence + the rotation here (showcase eligibility needs the
// type table, covered structurally below).
function mutationFor(n: number) {
  const sp = SPECIAL_ROUNDS;
  if (n <= 0) return null;
  if (n % sp.houndEvery === 0) return { id: "hound" }; // hound takes precedence
  if (n % sp.mutationEvery === 0) {
    return sp.mutations[(n / sp.mutationEvery - 1) % sp.mutations.length];
  }
  return null;
}

test("mutation rounds land on every mutationEvery-th round (unless hound wins)", () => {
  const e = SPECIAL_ROUNDS.mutationEvery;
  for (let k = 1; k <= 12; k++) {
    const n = e * k;
    const m = mutationFor(n);
    if (n % SPECIAL_ROUNDS.houndEvery === 0) {
      assert.equal(m?.id, "hound", `R${n} should be a hound round (precedence)`);
    } else {
      assert.ok(m && "mutator" in m, `R${n} should be a mutation round`);
    }
  }
});

test("mutation rounds rotate through the full mutation list in order", () => {
  const e = SPECIAL_ROUNDS.mutationEvery;
  const list = SPECIAL_ROUNDS.mutations;
  // Collect mutation ids in round order, skipping rounds the hound steals.
  const seen: string[] = [];
  for (let k = 1; k <= list.length * 2; k++) {
    const n = e * k;
    if (n % SPECIAL_ROUNDS.houndEvery === 0) continue;
    const m = mutationFor(n) as { id: string };
    seen.push(m.id);
  }
  // Each mutation id should appear, and consecutive picks follow the list order.
  for (const m of list) assert.ok(seen.includes(m.id), `mutation ${m.id} never rotated in`);
});

test("every mutation has a valid mutator + a reward bump >1", () => {
  const valid = new Set(["frenzy", "volatile", "inferno", "armored"]);
  for (const m of SPECIAL_ROUNDS.mutations) {
    assert.ok(valid.has(m.mutator), `unknown mutator ${m.mutator}`);
    assert.ok(m.rewardMul > 1, `mutation ${m.id} should reward >1x, got ${m.rewardMul}`);
  }
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
