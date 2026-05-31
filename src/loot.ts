/**
 * Tradable loot economy. Zombies (rarely) and bosses (always) drop collectible
 * ITEMS with a rarity and a gold value. Players sell items for GOLD — the
 * in-game soft currency. This is the closed economy that, at token launch,
 * bridges to a real on-chain marketplace (gold ⇄ $TOKEN, handled by a backend).
 *
 * Everything here is client-side and honest: gold is earned by playing and
 * spent in-game. No real value is created or moved by this file.
 */

import { CHEST } from "./config";

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary";

export interface RarityInfo {
  name: Rarity;
  color: number; // swatch / glow color
  label: string;
  /** Relative drop weight (commons frequent, legendaries scarce). */
  weight: number;
  /** Gold value range [min,max] when sold to the vendor. */
  gold: [number, number];
}

export const RARITIES: Record<Rarity, RarityInfo> = {
  common: { name: "common", color: 0xb6c2cc, label: "Common", weight: 60, gold: [5, 12] },
  uncommon: { name: "uncommon", color: 0x6fce5f, label: "Uncommon", weight: 30, gold: [14, 30] },
  rare: { name: "rare", color: 0x4ea0ff, label: "Rare", weight: 12, gold: [35, 70] },
  epic: { name: "epic", color: 0xc792ea, label: "Epic", weight: 4, gold: [90, 180] },
  legendary: { name: "legendary", color: 0xffc94a, label: "Legendary", weight: 1, gold: [260, 520] },
};

/** Flavorful loot names by slot — cosmetic only (no stats), pure trade goods. */
const ITEM_NAMES = [
  "Scrap Plating", "Rusty Cog", "Voxel Shard", "Cursed Tooth", "Brass Goggles",
  "Bone Charm", "Glow Vial", "Tin Crown", "Cracked Core", "Hex Coin",
  "Spore Pod", "Iron Sigil", "Ember Stone", "Frost Lens", "Relic Fragment",
];

export interface LootItem {
  id: string; // unique instance id
  name: string;
  rarity: Rarity;
  gold: number; // sell value
}

let _nextId = 1;

/** Pick a rarity by weight, biased up by `luck` (0 = base, higher = better). */
export function rollRarity(luck = 0): Rarity {
  const entries = Object.values(RARITIES);
  // luck multiplies the weight of rarer tiers
  const total = entries.reduce((s, r, i) => s + r.weight * (1 + luck * i * 0.5), 0);
  let x = Math.random() * total;
  for (let i = 0; i < entries.length; i++) {
    const w = entries[i].weight * (1 + luck * i * 0.5);
    if (x < w) return entries[i].name;
    x -= w;
  }
  return "common";
}

/** Create a fresh loot item of a given (or rolled) rarity. */
export function makeItem(rarity?: Rarity): LootItem {
  const r = rarity ?? rollRarity();
  const info = RARITIES[r];
  const [lo, hi] = info.gold;
  const gold = Math.round(lo + Math.random() * (hi - lo));
  const name = ITEM_NAMES[Math.floor(Math.random() * ITEM_NAMES.length)];
  return { id: `i${_nextId++}`, name, rarity: r, gold };
}

export function rarityColorHex(r: Rarity): string {
  return `#${RARITIES[r].color.toString(16).padStart(6, "0")}`;
}

/**
 * Treasure-chest quantity cascade (Vampire-Survivors model): roll for a big
 * jackpot first, then a medium one, else a single item. `luck` (0+) nudges the
 * jackpot odds up. Returns the number of items the chest yields (1 / 3 / 5).
 * Pure rarity/cosmetic outcome — NON-CASHABLE soft economy only.
 */
export function rollChestQuantity(luck = 0): number {
  const five = CHEST.fiveChance + luck * CHEST.luckFiveBonus;
  const three = CHEST.threeChance + luck * CHEST.luckThreeBonus;
  if (Math.random() < five) return 5;
  if (Math.random() < three) return 3;
  return 1;
}
