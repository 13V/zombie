import { RunMods } from "./mods";

/**
 * In-run level-up picks. After each round you choose 1 of 3, and the effects
 * stack across the run — this is what makes one run diverge from the next (the
 * build fantasy). Upgrades repeat/stack, so a run can lean hard into one stat.
 */
export type Tier = "common" | "rare" | "legendary";

export interface RunUpgrade {
  id: string;
  name: string;
  desc: string;
  icon: string; // emoji glyph for quick visual identity
  color: string; // accent color (hex)
  tier: Tier;
  apply: (m: RunMods) => void;
}

export const RUN_UPGRADES: RunUpgrade[] = [
  // ---- common ----
  { id: "dmg", name: "Hollow Points", desc: "+20% damage", icon: "💥", color: "#ff6a4a", tier: "common", apply: (m) => (m.damageMul += 0.2) },
  { id: "rof", name: "Trigger Finger", desc: "+15% fire rate", icon: "🔥", color: "#ffb13a", tier: "common", apply: (m) => (m.fireRateMul += 0.15) },
  { id: "reload", name: "Quick Hands", desc: "+25% reload speed", icon: "🌀", color: "#6ad7ff", tier: "common", apply: (m) => (m.reloadMul += 0.25) },
  { id: "speed", name: "Track Shoes", desc: "+12% move speed", icon: "👟", color: "#7be08a", tier: "common", apply: (m) => (m.moveSpeedMul += 0.12) },
  { id: "hp", name: "Thick Skin", desc: "+25 max HP", icon: "❤️", color: "#ff7a9a", tier: "common", apply: (m) => (m.maxHealthBonus += 25) },
  { id: "crit", name: "Eagle Eye", desc: "+10% crit chance", icon: "🎯", color: "#ffe14a", tier: "common", apply: (m) => (m.critChance += 0.1) },
  { id: "combo", name: "Killing Spree", desc: "Combos last +1s", icon: "⚡", color: "#c792ea", tier: "common", apply: (m) => (m.comboWindowBonus += 1) },
  { id: "luck", name: "Lucky Charm", desc: "+5% loot drop chance", icon: "🍀", color: "#8fd0ff", tier: "common", apply: (m) => (m.dropChance += 0.05) },
  // ---- rare, run-defining ----
  { id: "lifesteal", name: "Vampirism", desc: "Heal 4 HP per kill", icon: "🧛", color: "#ff4a6a", tier: "rare", apply: (m) => (m.lifeSteal += 4) },
  { id: "critdmg", name: "Executioner", desc: "+1.0× crit damage", icon: "☠️", color: "#ffd24a", tier: "rare", apply: (m) => (m.critMul += 1) },
  { id: "berserk", name: "Berserker", desc: "+35% dmg, +20% fire rate", icon: "😡", color: "#ff5a3a", tier: "rare", apply: (m) => { m.damageMul += 0.35; m.fireRateMul += 0.2; } },
  { id: "glasscannon", name: "Glass Cannon", desc: "+50% dmg, +25% crit", icon: "💎", color: "#ff8af0", tier: "rare", apply: (m) => { m.damageMul += 0.5; m.critChance += 0.25; } },
  // ---- behavior upgrades: change HOW you play ----
  { id: "multishot", name: "Split Barrel", desc: "+1 projectile per shot", icon: "🎇", color: "#8fd0ff", tier: "rare", apply: (m) => (m.bonusPellets += 1) },
  { id: "bigbullets", name: "Heavy Rounds", desc: "+40% bullet size", icon: "🔵", color: "#9fb6ff", tier: "common", apply: (m) => (m.bulletScaleMul += 0.4) },
  { id: "pierce", name: "Armor Piercing", desc: "Shots pierce +1 enemy", icon: "🏹", color: "#cbd5e0", tier: "common", apply: (m) => (m.pierceBonus += 1) },
  { id: "ricochet", name: "Ricochet", desc: "Shots bounce to +1 enemy", icon: "🪀", color: "#6ad7ff", tier: "rare", apply: (m) => (m.ricochet += 1) },
  { id: "homing", name: "Smart Rounds", desc: "Bullets curve toward enemies", icon: "🧲", color: "#a0e0ff", tier: "rare", apply: (m) => (m.homing = 1) },
  { id: "explosive", name: "Explosive Rounds", desc: "Bullets explode on impact (+radius)", icon: "💣", color: "#ff8a3a", tier: "rare", apply: (m) => (m.explosiveRadius += 1.4) },
  { id: "detonate", name: "Chain Reaction", desc: "Kills make zombies explode", icon: "🧨", color: "#ff6a4a", tier: "rare", apply: (m) => (m.detonate += 2.2) },
  { id: "chain", name: "Chain Lightning", desc: "Hits arc to +1 nearby enemy", icon: "⚡", color: "#9fe8ff", tier: "rare", apply: (m) => (m.chainCount += 1) },
  { id: "frost", name: "Frostbite", desc: "Hits slow zombies by 35%", icon: "❄️", color: "#bfe8ff", tier: "common", apply: (m) => (m.cryoSlow = Math.max(m.cryoSlow, 0.35)) },
  { id: "thorns", name: "Spiked Armor", desc: "Touching zombies take 30 dmg", icon: "🌵", color: "#7be08a", tier: "common", apply: (m) => (m.thorns += 30) },
  { id: "dodge", name: "Evasion", desc: "+15% chance to dodge a hit", icon: "💨", color: "#cfe8ff", tier: "common", apply: (m) => (m.dodge = Math.min(0.6, m.dodge + 0.15)) },
  { id: "healnova", name: "Bloom", desc: "Heal +14 HP every 10 kills", icon: "🌸", color: "#ff9ec4", tier: "common", apply: (m) => (m.healNova += 14) },
  { id: "adrenaline", name: "Adrenaline", desc: "Fire faster the lower your HP", icon: "🔥", color: "#ff7a5a", tier: "rare", apply: (m) => (m.adrenaline = 1) },

  // ---- legendary: rare jackpots ----
  { id: "apex", name: "Apex Predator", desc: "+60% dmg, +30% fire rate, +5 lifesteal", icon: "👑", color: "#ffcf3a", tier: "legendary", apply: (m) => { m.damageMul += 0.6; m.fireRateMul += 0.3; m.lifeSteal += 5; } },
  { id: "jackpot", name: "Jackpot", desc: "+20% loot, +1.5× crit dmg, +15% crit", icon: "🎰", color: "#ffd24a", tier: "legendary", apply: (m) => { m.dropChance += 0.2; m.critMul += 1.5; m.critChance += 0.15; } },
  { id: "juggernaut", name: "Juggernaut", desc: "+80 max HP, +20% dmg, +20% speed", icon: "🛡️", color: "#7be0c0", tier: "legendary", apply: (m) => { m.maxHealthBonus += 80; m.damageMul += 0.2; m.moveSpeedMul += 0.2; } },
  { id: "stormcaller", name: "Stormcaller", desc: "Chain +1, ricochet +1, +20% fire rate", icon: "🌩️", color: "#9fe8ff", tier: "legendary", apply: (m) => { m.chainCount += 1; m.ricochet += 1; m.fireRateMul += 0.2; } },
  { id: "swarmlord", name: "Swarm Lord", desc: "+2 projectiles, homing, +1 pierce", icon: "🐝", color: "#ffd24a", tier: "legendary", apply: (m) => { m.bonusPellets += 2; m.homing = 1; m.pierceBonus += 1; } },
];

const TIER_WEIGHT: Record<Tier, number> = { common: 1, rare: 0.5, legendary: 0.14 };

/** Roll `n` distinct upgrade cards, weighting rarer tiers lower. */
export function rollUpgrades(n = 3): RunUpgrade[] {
  const picks: RunUpgrade[] = [];
  const used = new Set<string>();
  let guard = 0;
  while (picks.length < n && guard++ < 400) {
    const u = RUN_UPGRADES[Math.floor(Math.random() * RUN_UPGRADES.length)];
    if (used.has(u.id)) continue;
    if (Math.random() > TIER_WEIGHT[u.tier]) continue; // weighted rejection by tier
    used.add(u.id);
    picks.push(u);
  }
  // top up with anything distinct if weighting starved us
  if (picks.length < n) {
    for (const u of RUN_UPGRADES) {
      if (picks.length >= n) break;
      if (!used.has(u.id)) { used.add(u.id); picks.push(u); }
    }
  }
  return picks;
}
