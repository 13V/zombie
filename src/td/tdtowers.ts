/**
 * Tower-Defense TOWERS — catalog, upgrade ladder, target priorities, targeting.
 *
 * Pure data + logic (no THREE / no DOM), unit-testable. The renderer reads
 * TD_TOWERS for build options, calls towerStats() each shot, and uses pickTarget
 * with the tower's chosen TdTargetMode. Five archetypes, each the answer to a
 * different creep (research-driven: Bloons targeting + archetype counters):
 *   arrow  — fast single-target darts. Reliable DPS; shreds runners.
 *   cannon — slow heavy AREA splash; ignores armor. Crowd + armored answer.
 *   frost  — slows + light damage. Control; multiplies your damage.
 *   sniper — long range, big single hits; ignores armor; defaults to Strong.
 *            The boss/armored answer.
 *   pylon  — DETECTOR: reveals camo creeps in range so other towers can hit
 *            them, plus a little splash. The camo answer.
 */

export type TdTowerId = "arrow" | "frost" | "cannon" | "sniper" | "pylon";

/** Per-tower target priority (Bloons standard set). */
export type TdTargetMode = "first" | "last" | "strong" | "close";
export const TD_TARGET_MODES: TdTargetMode[] = ["first", "last", "strong", "close"];
export function tdTargetLabel(m: TdTargetMode): string {
  return m === "first" ? "First" : m === "last" ? "Last" : m === "strong" ? "Strong" : "Close";
}

export interface TdTowerDef {
  id: TdTowerId;
  name: string;
  cost: number;       // gold to build (tier 1)
  range: number;
  fireRate: number;   // shots per second
  damage: number;
  splash: number;     // splash radius (0 = single target)
  slow: number;       // slow factor applied on hit (0 = none)
  slowTime: number;   // seconds the slow lasts
  pierce: boolean;    // true = ignores creep armor
  detect: boolean;    // true = reveals camo creeps within range
  defaultTarget: TdTargetMode;
  color: number;
  desc: string;
}

export const TD_TOWERS: Record<TdTowerId, TdTowerDef> = {
  arrow: {
    id: "arrow", name: "Arrow Tower", cost: 50,
    range: 11, fireRate: 2.4, damage: 12, splash: 0, slow: 0, slowTime: 0,
    pierce: false, detect: false, defaultTarget: "first",
    color: 0x9fe0a0, desc: "Fast single-target darts. Cheap, reliable DPS — great on runners.",
  },
  frost: {
    id: "frost", name: "Frost Tower", cost: 75,
    range: 9, fireRate: 1.2, damage: 6, splash: 0, slow: 0.5, slowTime: 1.6,
    pierce: false, detect: false, defaultTarget: "first",
    color: 0x7fd4ff, desc: "Chills creeps to half speed. Light damage, huge tempo.",
  },
  pylon: {
    id: "pylon", name: "Detector Pylon", cost: 90,
    range: 10, fireRate: 1.0, damage: 5, splash: 2.0, slow: 0, slowTime: 0,
    pierce: false, detect: true, defaultTarget: "close",
    color: 0xc89bff, desc: "Reveals CAMO creeps in range so your towers can hit them. Light splash.",
  },
  cannon: {
    id: "cannon", name: "Cannon", cost: 110,
    range: 9.5, fireRate: 0.75, damage: 30, splash: 3.2, slow: 0, slowTime: 0,
    pierce: true, detect: false, defaultTarget: "first",
    color: 0xff9d5c, desc: "Heavy shells with area splash; ignores armor. Clears swarms & armored.",
  },
  sniper: {
    id: "sniper", name: "Sniper Nest", cost: 150,
    range: 22, fireRate: 0.6, damage: 95, splash: 0, slow: 0, slowTime: 0,
    pierce: true, detect: false, defaultTarget: "strong",
    color: 0xffd24a, desc: "Long range, huge single hits; ignores armor. The boss answer.",
  },
};

export const TD_TOWER_IDS: TdTowerId[] = ["arrow", "frost", "pylon", "cannon", "sniper"];

/** Max upgrade tier (1 = freshly built). */
export const TD_MAX_TIER = 3;

export function tdTower(id: TdTowerId): TdTowerDef { return TD_TOWERS[id]; }

/** Gold to upgrade FROM the given tier to the next; null at max tier. */
export function tdUpgradeCost(id: TdTowerId, tier: number): number | null {
  if (tier >= TD_MAX_TIER) return null;
  return Math.round(TD_TOWERS[id].cost * (tier === 1 ? 0.85 : 1.4));
}

/** Gold refunded when a tower is sold — 75% of total invested, rounded. */
export function tdSellValue(id: TdTowerId, tier: number): number {
  let spent = TD_TOWERS[id].cost;
  for (let t = 1; t < tier; t++) spent += tdUpgradeCost(id, t) ?? 0;
  return Math.round(spent * 0.75);
}

/** Live stats at a given tier: damage/range/fireRate grow per tier. */
export function towerStats(id: TdTowerId, tier: number): {
  range: number; fireRate: number; damage: number; splash: number; slow: number; slowTime: number;
} {
  const d = TD_TOWERS[id];
  const t = Math.max(1, Math.min(TD_MAX_TIER, tier));
  const dmgMul = 1 + (t - 1) * 0.7;     // +70% damage per tier
  const rangeMul = 1 + (t - 1) * 0.12;  // +12% range per tier
  const rateMul = 1 + (t - 1) * 0.18;   // +18% fire rate per tier
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
export interface TdTargetable {
  id: number;
  pos: { x: number; z: number };
  dist: number;        // arc-length along the lane (First = max, Last = min)
  hp: number;
  alive: boolean;
  targetable: boolean; // false for un-revealed camo creeps
}

/**
 * Pick the creep a tower should shoot, honoring its target priority, among
 * alive + targetable creeps within `range` of (tx,tz):
 *   first  — furthest along the lane (max dist)   [default]
 *   last   — least far along (min dist)
 *   strong — highest HP (ties → furthest along)
 *   close  — nearest to the tower
 * Returns its id, or -1 if nothing valid is in range.
 */
export function pickTarget(tx: number, tz: number, range: number, creeps: TdTargetable[], mode: TdTargetMode = "first"): number {
  const r2 = range * range;
  let bestId = -1;
  let bestScore = -Infinity;
  for (const c of creeps) {
    if (!c.alive || !c.targetable) continue;
    const dx = c.pos.x - tx, dz = c.pos.z - tz;
    const d2 = dx * dx + dz * dz;
    if (d2 > r2) continue;
    let score: number;
    if (mode === "first") score = c.dist;
    else if (mode === "last") score = -c.dist;
    else if (mode === "close") score = -d2;
    else score = c.hp * 1e6 + c.dist; // strong, ties → first
    if (score > bestScore) { bestScore = score; bestId = c.id; }
  }
  return bestId;
}
