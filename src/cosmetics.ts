/**
 * Visual-only player skins — a full cosmetic roster (no stat effect), the skins
 * counterpart to the pet collection. Each skin recolors the voxel hero's body +
 * head; higher rarities also carry a `glow` (emissive) so legendary/mythic skins
 * shine in the field. Bought once with Essence, then equipped freely.
 */
import type { HatStyle, BackStyle } from "./voxelChar";

export type SkinRarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";

export interface Skin {
  id: string;
  name: string;
  body: number;
  head: number;
  rarity: SkinRarity;
  cost: number; // Essence; 0 = owned from the start
  /** Emissive glow colour for the live model + preview (high rarities only). */
  glow?: number;
  // ---- cosmetic kit: real headwear + back accessories (not just recolours) ----
  hat?: HatStyle;
  hatColor?: number;
  back?: BackStyle;
  backColor?: number;
  // ---- outfit detail (multi-zone clothing); pants/shoes/belt auto-derive if unset ----
  pants?: number;
  shoes?: number;
  belt?: number;
  gloves?: number;
  emblem?: number; // glowing chest emblem
  /** Themed texture pattern painted on the torso (stars/scales/bones/…). */
  pattern?: "stars" | "stripes" | "scales" | "bones" | "bandage" | "circuit" | "runes" | "plate";
  /** Outfit template — gives a designed garment (hoodie/jacket/dress/…) not a flat shirt. */
  outfit?: "tee" | "hoodie" | "jacket" | "dress" | "robe" | "armor" | "tank" | "suit" | "tunic";
  /** Secondary garment / accent colour (hood trim, zipper inner, sash, tabard…). */
  trim?: number;
  /** Bare-leg shorts vs full pants. */
  legwear?: "pants" | "shorts";
}

export const SKINS: Skin[] = [
  // ===== COMMON — survivors & starters =====
  { id: "classic", name: "Classic", body: 0x4a78d6, head: 0xfff4d6, rarity: "common", cost: 0, outfit: "tee", legwear: "shorts" },
  { id: "recruit", name: "Recruit", body: 0x6b7280, head: 0xe8d6a8, rarity: "common", cost: 0, hat: "cap", hatColor: 0x4a525e, outfit: "jacket" },
  { id: "ranger", name: "Ranger", body: 0x3f7d4a, head: 0xe8d6a8, rarity: "common", cost: 40, hat: "cap", hatColor: 0x2f5d3a, outfit: "tunic" },
  { id: "scout", name: "Scout", body: 0x9a7b4a, head: 0xf0e0c0, rarity: "common", cost: 40, hat: "cap", hatColor: 0x6a4a2a, outfit: "tee", legwear: "shorts" },
  { id: "medic", name: "Medic", body: 0xeef1f3, head: 0xffe0d0, rarity: "common", cost: 50, hat: "helmet", hatColor: 0xff5a5a, emblem: 0xff3a3a, outfit: "jacket" },
  { id: "diver", name: "Skyfarer", body: 0x5aa9e0, head: 0xeaf6ff, rarity: "common", cost: 50, hat: "antenna", hatColor: 0x6ad7ff, outfit: "suit" },

  // ===== UNCOMMON — critters & characters =====
  { id: "kitty", name: "Tabby", body: 0xe09a4a, head: 0xffe0b0, rarity: "uncommon", cost: 90, hat: "ears", hatColor: 0xe09a4a, outfit: "hoodie" },
  { id: "bunny", name: "Cottontail", body: 0xf4eef0, head: 0xfff4f0, rarity: "uncommon", cost: 90, hat: "ears", hatColor: 0xffffff, back: "pack", backColor: 0xffd6e6, outfit: "hoodie" },
  { id: "frog", name: "Frogling", body: 0x5fae3a, head: 0x9ad05a, rarity: "uncommon", cost: 100, hat: "antenna", hatColor: 0x7ad14a, outfit: "tee", legwear: "shorts" },
  { id: "jester", name: "Jester", body: 0x8a3a8a, head: 0xffe0ea, rarity: "uncommon", cost: 110, hat: "bow", hatColor: 0xff9ec7, outfit: "tunic" },
  { id: "miner", name: "Miner", body: 0x5a6270, head: 0xe8d6a8, rarity: "uncommon", cost: 110, hat: "helmet", hatColor: 0xffd24a, back: "pack", backColor: 0x3a4250, outfit: "jacket" },
  { id: "punk", name: "Punk", body: 0x2a2a36, head: 0xf0d2c0, rarity: "uncommon", cost: 120, hat: "mohawk", hatColor: 0xff3a7a, outfit: "jacket" },
  { id: "rosewood", name: "Rosewood", body: 0xd06a8a, head: 0xffe0ea, rarity: "uncommon", cost: 120, hat: "bow", hatColor: 0xff9ec7, back: "cape", backColor: 0xd06a8a, outfit: "dress" },

  // ===== RARE — classes & undead =====
  { id: "knight", name: "Knight", body: 0x8a93a0, head: 0xc8d2dc, rarity: "rare", cost: 200, hat: "helmet", hatColor: 0xb6c0cc, back: "cape", backColor: 0xb23a3a, pattern: "plate", outfit: "armor" },
  { id: "wizard", name: "Wizard", body: 0x3a4ea0, head: 0xe8d6c0, rarity: "rare", cost: 210, hat: "wizard", hatColor: 0x3a3a8a, pattern: "runes", outfit: "robe" },
  { id: "ninja", name: "Ninja", body: 0x1c1c24, head: 0x2a2a36, rarity: "rare", cost: 210, hat: "hood", hatColor: 0x14141c, outfit: "suit" },
  { id: "pirate", name: "Buccaneer", body: 0x6a3a2a, head: 0xe8c0a0, rarity: "rare", cost: 220, hat: "pirate", hatColor: 0x2a2018, back: "cape", backColor: 0x8a2a2a, outfit: "jacket" },
  { id: "skeleton", name: "Rattlebones", body: 0xe8e4d8, head: 0xfff8ee, rarity: "rare", cost: 230, hat: "none", pattern: "bones", outfit: "tee" },
  { id: "mummy", name: "Mummy", body: 0xd8cba0, head: 0xe8dcc0, rarity: "rare", cost: 230, hat: "none", back: "cape", backColor: 0xc8b88a, pattern: "bandage", outfit: "robe" },
  { id: "robot", name: "Mk-II Bot", body: 0x8a93a0, head: 0xb6c0cc, rarity: "rare", cost: 240, hat: "antenna", hatColor: 0xff5a4a, back: "pack", backColor: 0x5a6270, emblem: 0x6ad7ff, pattern: "circuit", outfit: "suit" },

  // ===== EPIC — heroes & elements =====
  { id: "astronaut", name: "Astronaut", body: 0xeef1f3, head: 0xbfe2f0, rarity: "epic", cost: 380, hat: "helmet", hatColor: 0xffffff, back: "jetpack", backColor: 0xcfd6dc, pattern: "plate", outfit: "suit" },
  { id: "samurai", name: "Samurai", body: 0x9a2a2a, head: 0xf0d2c0, rarity: "epic", cost: 390, hat: "helmet", hatColor: 0x2a2a36, back: "cape", backColor: 0x9a2a2a, pattern: "plate", outfit: "armor" },
  { id: "vampire", name: "Vampire", body: 0x2a1420, head: 0xe8dcea, rarity: "epic", cost: 400, hat: "tophat", hatColor: 0x140a14, back: "cape", backColor: 0x7a1a2a, pattern: "runes", outfit: "jacket" },
  { id: "pumpkin", name: "Pumpkin King", body: 0x3a2a1a, head: 0xff7a2a, rarity: "epic", cost: 400, hat: "crown", hatColor: 0x5a8a2a, outfit: "tunic" },
  { id: "cyborg", name: "Cyborg", body: 0x2a3450, head: 0x9fb6ff, rarity: "epic", cost: 410, hat: "visor", hatColor: 0x6ad7ff, back: "jetpack", backColor: 0x3a4660, emblem: 0x6ad7ff, pattern: "circuit", outfit: "suit" },
  { id: "pharaoh", name: "Pharaoh", body: 0x2a3a8a, head: 0xffd24a, rarity: "epic", cost: 420, hat: "crown", hatColor: 0xffe14a, back: "cape", backColor: 0x2a3a8a, emblem: 0xffe14a, pattern: "runes", outfit: "robe" },
  { id: "glacier", name: "Glacier", body: 0x6fd0ff, head: 0xffffff, rarity: "epic", cost: 420, hat: "helmet", hatColor: 0xeaf6ff, back: "wings", backColor: 0xbfeaff, pattern: "scales", outfit: "armor" },
  { id: "inferno", name: "Inferno", body: 0xff4a2a, head: 0xffd24a, rarity: "epic", cost: 430, hat: "horns", hatColor: 0xff7a2a, back: "jetpack", backColor: 0x6f3822, pattern: "scales", outfit: "armor" },
  { id: "midas", name: "Midas", body: 0xffcf52, head: 0xfff4d6, rarity: "epic", cost: 450, hat: "crown", hatColor: 0xffe14a, back: "cape", backColor: 0xffcf52, emblem: 0xffe14a, pattern: "plate", outfit: "armor" },

  // ===== LEGENDARY — mythics of the realm (glow) =====
  { id: "phoenix", name: "Phoenix", body: 0xff6a2a, head: 0xffe14a, rarity: "legendary", cost: 700, glow: 0xff7a2a, hat: "crown", hatColor: 0xffe14a, back: "wings", backColor: 0xff7a2a, emblem: 0xffd24a, outfit: "armor" },
  { id: "angel", name: "Seraph", body: 0xfff4e0, head: 0xffe9b0, rarity: "legendary", cost: 700, glow: 0xfff0c0, hat: "halo", hatColor: 0xffe14a, back: "wings", backColor: 0xffffff, outfit: "dress" },
  { id: "demon", name: "Demon", body: 0x7a1420, head: 0xff5a4a, rarity: "legendary", cost: 720, glow: 0xff3a2a, hat: "horns", hatColor: 0x2a0a0e, back: "cape", backColor: 0x2a0a0e, emblem: 0xff3a2a, outfit: "jacket" },
  { id: "reaper", name: "Reaper", body: 0x14141c, head: 0x4a4a5e, rarity: "legendary", cost: 750, glow: 0x7af7c0, hat: "hood", hatColor: 0x0a0a10, back: "cape", backColor: 0x0a0a10, outfit: "robe" },
  { id: "lich", name: "Lich King", body: 0x1a2a3a, head: 0x6ad7c0, rarity: "legendary", cost: 780, glow: 0x6ad7ff, hat: "crown", hatColor: 0x6ad7ff, back: "cape", backColor: 0x1a2a3a, emblem: 0x6ad7ff, pattern: "runes", outfit: "robe" },
  { id: "dragonlord", name: "Dragonlord", body: 0x2a6a3a, head: 0xc8ff8a, rarity: "legendary", cost: 820, glow: 0x9aff5a, hat: "horns", hatColor: 0x1a4a2a, back: "wings", backColor: 0x2a6a3a, emblem: 0x9aff5a, pattern: "scales", outfit: "armor" },
  { id: "aurora", name: "Aurora", body: 0x4ad6c0, head: 0xc8a0ff, rarity: "legendary", cost: 820, glow: 0x6ad7ff, hat: "halo", hatColor: 0x9fe8ff, back: "wings", backColor: 0x6ad7ff, outfit: "dress" },

  // ===== MYTHIC — cosmic apex (bright glow) =====
  { id: "cosmic", name: "Cosmic", body: 0x2a1a5e, head: 0xff9ec7, rarity: "mythic", cost: 1300, glow: 0xc792ea, hat: "wizard", hatColor: 0x4a2a8e, back: "wings", backColor: 0xc792ea, emblem: 0xffd24a, pattern: "stars", outfit: "robe" },
  { id: "prismatic", name: "Prismatic", body: 0xff5a7a, head: 0x6ad7ff, rarity: "mythic", cost: 1500, glow: 0xffd24a, hat: "halo", hatColor: 0xffd24a, back: "wings", backColor: 0xff5a7a, emblem: 0x7be08a, pattern: "stripes", outfit: "hoodie" },
  { id: "voidemperor", name: "Void Emperor", body: 0x140a26, head: 0x8a5ad6, rarity: "mythic", cost: 1600, glow: 0x9a5ad6, hat: "crown", hatColor: 0x9a5ad6, back: "cape", backColor: 0x140a26, emblem: 0xc792ea, pattern: "runes", outfit: "robe" },
  { id: "starseraph", name: "Star Seraph", body: 0xeaf0ff, head: 0x9fe8ff, rarity: "mythic", cost: 1700, glow: 0x7af7ff, hat: "halo", hatColor: 0x7af7ff, back: "wings", backColor: 0xffffff, emblem: 0x7af7ff, pattern: "stars", outfit: "dress" },
  { id: "eclipse", name: "Eclipse", body: 0x0e0e14, head: 0xffd24a, rarity: "mythic", cost: 1800, glow: 0xffe14a, hat: "crown", hatColor: 0xffe14a, back: "wings", backColor: 0x0e0e14, emblem: 0xffe14a, outfit: "armor" },
];

export function findSkin(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}
