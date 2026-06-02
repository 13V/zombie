/**
 * Tower-Defense WAVES + economy. Pure logic (no THREE / no DOM), unit-testable.
 *
 * Research-driven pacing (Bloons): a gentle on-ramp, then ONE new creep
 * archetype introduced every few waves on a telegraphed wave, spiky elite/boss
 * rounds every 5th wave, and a hardened boss finale. Each archetype demands a
 * different tower answer:
 *   runner  → fast single-target (arrow)
 *   swarm   → AoE/splash (cannon)
 *   armored → piercing damage (cannon/sniper) — armor shrugs off normal hits
 *   camo    → a detector pylon to reveal it
 *   regrow  → burst it down before it heals (sniper/cannon)
 *   boss    → single-target boss damage + a slow (sniper + frost)
 */

import type { TdSpawnSpec } from "./tdenemy";

/** Starting resources for a run. */
export const TD_START_GOLD = 220;
export const TD_START_LIVES = 20;
/** Waves to survive to win (Solo). */
export const TD_TOTAL_WAVES = 18;

/** End-of-wave clear bonus (flat + scaling), per the BTD6 round-bonus model. */
export function waveClearBonus(wave: number): number {
  return 18 + 6 * Math.max(1, Math.floor(wave));
}

/** Seconds between individual creep spawns within a wave (faster later). */
export function spawnInterval(wave: number): number {
  return Math.max(0.32, 0.9 - wave * 0.03);
}

/** HP of a "standard" creep at wave n (geometric ramp ~+14%/wave). */
function baseHp(wave: number): number {
  return Math.round(24 * Math.pow(1.14, wave - 1));
}

/** Public accessor for the standard creep HP at a wave (used by the Duel sends). */
export function creepHpAt(wave: number): number {
  return baseHp(Math.max(1, Math.floor(wave)));
}

/**
 * The creeps for wave `n` (1-based). Builds an archetype mix per the pacing
 * schedule and attaches the traits (armor/camo/regen) that gate the counter.
 */
export function buildWave(n: number): TdSpawnSpec[] {
  const wave = Math.max(1, Math.floor(n));
  const hp = baseHp(wave);
  const speed = 2.3 + wave * 0.04;
  const out: TdSpawnSpec[] = [];
  const bounty = (h: number) => Math.max(2, Math.round(h * 0.08));

  const isBoss = wave % 5 === 0;

  // ---- boss / elite waves (every 5th) ----
  if (isBoss) {
    const bhp = Math.round(hp * (wave >= 15 ? 16 : 10));
    out.push({ hp: bhp, speed: speed * 0.6, bounty: Math.round(bhp * 0.05), kind: "boss",
      armor: wave >= 15 ? 0.3 : 0, regen: wave >= 10 ? hp * 0.5 : 0, leakDmg: 12 });
    // escort pack
    const escorts = 5 + Math.floor(wave / 5) * 2;
    for (let i = 0; i < escorts; i++) {
      out.push({ hp: Math.round(hp * 0.8), speed: speed * 1.3, bounty: bounty(hp * 0.8), kind: "fast", leakDmg: 1 });
    }
    return out;
  }

  // ---- normal waves: a base pack + the archetype(s) unlocked by this wave ----
  const count = 6 + wave * 2;
  for (let i = 0; i < count; i++) {
    // swarm filler from wave 3+: a quarter are fast runners
    const fast = wave >= 3 && i % 4 === 3;
    out.push({
      hp: Math.round(hp * (fast ? 0.65 : 1)),
      speed: speed * (fast ? 1.5 : 1),
      bounty: bounty(hp * (fast ? 0.65 : 1)),
      kind: fast ? "fast" : undefined,
    });
  }

  // ARMORED debuts ~wave 6: needs piercing (cannon/sniper)
  if (wave >= 6) {
    const n2 = 2 + Math.floor((wave - 6) / 2);
    for (let i = 0; i < n2; i++) {
      out.push({ hp: Math.round(hp * 1.4), speed: speed * 0.85, bounty: bounty(hp * 1.4), kind: "armored", armor: 0.6, leakDmg: 2 });
    }
  }
  // CAMO debuts ~wave 8: needs a detector pylon
  if (wave >= 8) {
    const n2 = 2 + Math.floor((wave - 8) / 3);
    for (let i = 0; i < n2; i++) {
      out.push({ hp: Math.round(hp * 0.7), speed: speed * 1.15, bounty: bounty(hp * 0.7), kind: "camo", camo: true, leakDmg: 1 });
    }
  }
  // REGROW debuts ~wave 11: self-heals, must be burst down
  if (wave >= 11) {
    const n2 = 2 + Math.floor((wave - 11) / 3);
    for (let i = 0; i < n2; i++) {
      out.push({ hp: Math.round(hp * 1.1), speed: speed * 0.95, bounty: bounty(hp * 1.1), kind: "regrow", regen: hp * 0.25, leakDmg: 2 });
    }
  }
  return out;
}

/** Total creeps in wave n (for HUD progress). */
export function waveSize(n: number): number {
  return buildWave(n).length;
}

/** Aggregate "threat" of a wave = total effective HP — used by the Duel mode to
 *  size how much defense the AI opponent needs to clear it without leaking. */
export function waveThreat(n: number): number {
  let t = 0;
  for (const s of buildWave(n)) t += s.hp * (1 + (s.armor ?? 0)); // armor inflates effective HP
  return Math.round(t);
}
