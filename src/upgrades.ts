import { RunMods } from "./mods";

/**
 * In-run level-up picks. After each round you choose 1 of 3, and the effects
 * stack across the run — this is what makes one run diverge from the next (the
 * build fantasy). Upgrades repeat/stack, so a run can lean hard into one stat.
 */
export interface RunUpgrade {
  id: string;
  name: string;
  desc: string;
  /** Visual weight: common | rare. Rare cards are stronger + rarer. */
  rarity: "common" | "rare";
  apply: (m: RunMods) => void;
}

export const RUN_UPGRADES: RunUpgrade[] = [
  { id: "dmg", name: "Hollow Points", desc: "+20% damage", rarity: "common", apply: (m) => (m.damageMul += 0.2) },
  { id: "rof", name: "Trigger Finger", desc: "+15% fire rate", rarity: "common", apply: (m) => (m.fireRateMul += 0.15) },
  { id: "reload", name: "Quick Hands", desc: "+25% reload speed", rarity: "common", apply: (m) => (m.reloadMul += 0.25) },
  { id: "speed", name: "Track Shoes", desc: "+12% move speed", rarity: "common", apply: (m) => (m.moveSpeedMul += 0.12) },
  { id: "hp", name: "Thick Skin", desc: "+25 max HP (and heal)", rarity: "common", apply: (m) => (m.maxHealthBonus += 25) },
  { id: "crit", name: "Eagle Eye", desc: "+10% crit chance", rarity: "common", apply: (m) => (m.critChance += 0.1) },
  { id: "combo", name: "Killing Spree", desc: "Combos last +1s", rarity: "common", apply: (m) => (m.comboWindowBonus += 1) },
  { id: "luck", name: "Lucky Charm", desc: "+5% loot drop chance", rarity: "common", apply: (m) => (m.dropChance += 0.05) },
  // rare, run-defining
  { id: "lifesteal", name: "Vampirism", desc: "Heal 4 HP per kill", rarity: "rare", apply: (m) => (m.lifeSteal += 4) },
  { id: "critdmg", name: "Executioner", desc: "+1.0x crit damage", rarity: "rare", apply: (m) => (m.critMul += 1) },
  { id: "berserk", name: "Berserker", desc: "+35% damage, +20% fire rate", rarity: "rare", apply: (m) => { m.damageMul += 0.35; m.fireRateMul += 0.2; } },
  { id: "glasscannon", name: "Glass Cannon", desc: "+50% damage, +25% crit", rarity: "rare", apply: (m) => { m.damageMul += 0.5; m.critChance += 0.25; } },
];

/** Roll `n` distinct upgrade cards, weighting rares lower. */
export function rollUpgrades(n = 3): RunUpgrade[] {
  const pool = RUN_UPGRADES.filter((u) => (u.rarity === "rare" ? Math.random() < 0.45 : true));
  const bag = pool.length >= n ? pool : [...RUN_UPGRADES];
  const picks: RunUpgrade[] = [];
  const used = new Set<number>();
  while (picks.length < n && used.size < bag.length) {
    const i = Math.floor(Math.random() * bag.length);
    if (used.has(i)) continue;
    used.add(i);
    picks.push(bag[i]);
  }
  return picks;
}
