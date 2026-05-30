/**
 * Run-modifier bundle. Both permanent meta-upgrades (bought between runs) and
 * in-run level-up picks write into the same shape, and the combat/movement code
 * reads from it each frame. One place to add a new stat knob.
 */
export interface RunMods {
  damageMul: number;
  fireRateMul: number;
  reloadMul: number;
  moveSpeedMul: number;
  maxHealthBonus: number;
  critChance: number; // 0..1 chance any hit crits (on top of precise center hits)
  critMul: number; // crit damage multiplier
  lifeSteal: number; // hp restored per kill
  comboWindowBonus: number; // extra seconds before a combo decays
  essenceMul: number; // meta-currency earned at end of run
  dropChance: number; // base chance a kill drops loot
  startPointsBonus: number;
  startWeapon?: string; // weapon id to start the run with (meta unlock)
}

export function defaultMods(): RunMods {
  return {
    damageMul: 1,
    fireRateMul: 1,
    reloadMul: 1,
    moveSpeedMul: 1,
    maxHealthBonus: 0,
    critChance: 0,
    critMul: 2,
    lifeSteal: 0,
    comboWindowBonus: 0,
    essenceMul: 1,
    dropChance: 0.08,
    startPointsBonus: 0,
    startWeapon: undefined,
  };
}

/** Shallow copy for previewing an upgrade without committing it. */
export function cloneMods(m: RunMods): RunMods {
  return { ...m };
}

type FieldMeta = { key: keyof RunMods; label: string; fmt: (v: number) => string };
const pct = (v: number) => `${Math.round(v * 100)}%`;

/** Human-readable metadata for the stat fields run-upgrades can change. */
const FIELDS: FieldMeta[] = [
  { key: "damageMul", label: "Damage", fmt: pct },
  { key: "fireRateMul", label: "Fire Rate", fmt: pct },
  { key: "reloadMul", label: "Reload", fmt: pct },
  { key: "moveSpeedMul", label: "Move Speed", fmt: pct },
  { key: "maxHealthBonus", label: "Bonus HP", fmt: (v) => `+${v}` },
  { key: "critChance", label: "Crit Chance", fmt: pct },
  { key: "critMul", label: "Crit Dmg", fmt: (v) => `${v.toFixed(1)}×` },
  { key: "lifeSteal", label: "Life Steal", fmt: (v) => `${v} HP` },
  { key: "comboWindowBonus", label: "Combo Time", fmt: (v) => `+${v}s` },
  { key: "dropChance", label: "Loot Chance", fmt: pct },
];

export interface ModDelta {
  label: string;
  from: string;
  to: string;
}

/** Diff two mod bundles into a list of changed stats for UI previews. */
export function diffMods(before: RunMods, after: RunMods): ModDelta[] {
  const out: ModDelta[] = [];
  for (const f of FIELDS) {
    const a = before[f.key] as number;
    const b = after[f.key] as number;
    if (a !== b) out.push({ label: f.label, from: f.fmt(a), to: f.fmt(b) });
  }
  return out;
}
