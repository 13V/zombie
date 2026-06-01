/**
 * Tower-Defense WAVES + economy — how many creeps, how tough, and the payout.
 *
 * Pure logic (no THREE / no DOM), unit-testable. The mode controller asks
 * buildWave(n) for the spawn list of wave n, spaces them by spawnInterval(n),
 * and seeds gold/lives from the starting constants.
 */

import type { TdSpawnSpec } from "./tdenemy";

/** Starting resources for a run. */
export const TD_START_GOLD = 180;
export const TD_START_LIVES = 20;
/** How many waves you must survive to win. */
export const TD_TOTAL_WAVES = 15;
/** Gold awarded for clearing a whole wave (on top of per-kill bounties). */
export const TD_WAVE_CLEAR_BONUS = 25;

/** Seconds between individual creep spawns within a wave (faster later). */
export function spawnInterval(wave: number): number {
  return Math.max(0.35, 0.95 - wave * 0.03);
}

/**
 * The creeps for wave `n` (1-based). Count and HP climb each wave; speed drifts
 * up slowly. Every 5th wave is a BOSS wave — a single fat creep escorted by a
 * pack. Bounty scales with HP so tougher creeps pay more.
 */
export function buildWave(n: number): TdSpawnSpec[] {
  const wave = Math.max(1, Math.floor(n));
  const boss = wave % 5 === 0;
  const out: TdSpawnSpec[] = [];

  const baseHp = 28 + wave * 14;
  const baseSpeed = 2.4 + wave * 0.05;

  if (boss) {
    // a hulking tank...
    const hp = Math.round(baseHp * 9);
    out.push({ hp, speed: baseSpeed * 0.7, bounty: Math.round(hp * 0.12), kind: "boss" });
    // ...with a runner escort
    const escorts = 4 + Math.floor(wave / 5);
    for (let i = 0; i < escorts; i++) {
      const ehp = Math.round(baseHp * 0.8);
      out.push({ hp: ehp, speed: baseSpeed * 1.35, bounty: Math.round(ehp * 0.1), kind: "fast" });
    }
    return out;
  }

  const count = 6 + wave * 2;
  for (let i = 0; i < count; i++) {
    // sprinkle in a faster variant as waves progress
    const fast = wave >= 3 && i % 4 === 3;
    const hp = Math.round(baseHp * (fast ? 0.7 : 1));
    const speed = baseSpeed * (fast ? 1.5 : 1);
    out.push({ hp, speed, bounty: Math.max(2, Math.round(hp * 0.09)), kind: fast ? "fast" : "grunt" });
  }
  return out;
}

/** Total creeps in wave n (handy for the HUD progress readout). */
export function waveSize(n: number): number {
  return buildWave(n).length;
}
