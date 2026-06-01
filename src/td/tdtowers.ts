/**
 * Tower-Defense TOWERS — the catalog, upgrade ladder, and targeting math.
 *
 * Pure data + logic (no THREE / no DOM), so the catalog and the rules unit-test
 * cleanly under node:test. The renderer reads TD_TOWERS for build options and
 * calls towerStats() each shot; the integrator owns the meshes + projectiles.
 *
 * Three archetypes:
 *   cannon — slow, heavy, AREA splash. The crowd-clearer.
 *   frost  — chilly, light damage, SLOWS what it hits. Force-multiplier.
 *   arrow  — fast, single-target, long range. The reliable DPS.
 */

export type TdTowerId = "cannon" | "frost" | "arrow";

export interface TdTowerDef {
  id: TdTowerId;
  name: string;
  cost: number;       // gold to build (tier 1)
  range: number;      // world units
  fireRate: number;   // shots per second
  damage: number;
  splash: number;     // splash radius (0 = single target)
  slow: number;       // slow factor applied on hit (0 = none; e.g. 0.5 = half speed)
  slowTime: number;   // seconds the slow lasts
  color: number;      // turret tint
  desc: string;
}

/** Canonical, ascending by cost. */
export const TD_TOWERS: Record<TdTowerId, TdTowerDef> = {
  arrow: {
    id: "arrow", name: "Arrow Tower", cost: 50,
    range: 11, fireRate: 2.2, damage: 12, splash: 0, slow: 0, slowTime: 0,
    color: 0x9fe0a0, desc: "Fast single-target darts. Reliable, cheap DPS.",
  },
  frost: {
    id: "frost", name: "Frost Tower", cost: 75,
    range: 9, fireRate: 1.1, damage: 6, splash: 0, slow: 0.5, slowTime: 1.6,
    color: 0x7fd4ff, desc: "Chills creeps to half speed. Light damage, huge tempo.",
  },
  cannon: {
    id: "cannon", name: "Cannon", cost: 110,
    range: 9.5, fireRate: 0.7, damage: 34, splash: 3.2, slow: 0, slowTime: 0,
    color: 0xff9d5c, desc: "Slow, heavy shells with area splash. Clears the crowd.",
  },
};

export const TD_TOWER_IDS: TdTowerId[] = ["arrow", "frost", "cannon"];

/** Max upgrade tier (1 = freshly built). */
export const TD_MAX_TIER = 3;

export function tdTower(id: TdTowerId): TdTowerDef { return TD_TOWERS[id]; }

/**
 * Gold to upgrade FROM the given tier to the next (tier 1→2, 2→3). Scales off
 * the base cost; null once max tier is reached.
 */
export function tdUpgradeCost(id: TdTowerId, tier: number): number | null {
  if (tier >= TD_MAX_TIER) return null;
  return Math.round(TD_TOWERS[id].cost * (tier === 1 ? 0.8 : 1.3));
}

/** Gold refunded when a tower is sold — total invested × 0.6, rounded. */
export function tdSellValue(id: TdTowerId, tier: number): number {
  let spent = TD_TOWERS[id].cost;
  for (let t = 1; t < tier; t++) spent += tdUpgradeCost(id, t) ?? 0;
  return Math.round(spent * 0.6);
}

/** Live stats at a given tier: damage and range grow per tier; fire rate too. */
export function towerStats(id: TdTowerId, tier: number): { range: number; fireRate: number; damage: number; splash: number; slow: number; slowTime: number } {
  const d = TD_TOWERS[id];
  const t = Math.max(1, Math.min(TD_MAX_TIER, tier));
  const dmgMul = 1 + (t - 1) * 0.7;     // +70% damage per tier
  const rangeMul = 1 + (t - 1) * 0.12;  // +12% range per tier
  const rateMul = 1 + (t - 1) * 0.15;   // +15% fire rate per tier
  return {
    range: d.range * rangeMul,
    fireRate: d.fireRate * rateMul,
    damage: d.damage * dmgMul,
    splash: d.splash,
    slow: d.slow,
    slowTime: d.slowTime,
  };
}

/** A creep as seen by a tower's targeting. */
export interface TdTargetable { id: number; pos: { x: number; z: number }; dist: number; alive: boolean }

/**
 * Pick the creep a tower should shoot: the one FURTHEST along the path (highest
 * `dist`, i.e. closest to leaking) that is alive and within `range` of the
 * tower at (tx,tz). Returns its id, or -1 if nothing is in range.
 */
export function pickTarget(tx: number, tz: number, range: number, creeps: TdTargetable[]): number {
  const r2 = range * range;
  let bestId = -1;
  let bestDist = -1;
  for (const c of creeps) {
    if (!c.alive) continue;
    const dx = c.pos.x - tx, dz = c.pos.z - tz;
    if (dx * dx + dz * dz > r2) continue;
    if (c.dist > bestDist) { bestDist = c.dist; bestId = c.id; }
  }
  return bestId;
}
