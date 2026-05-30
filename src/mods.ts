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
