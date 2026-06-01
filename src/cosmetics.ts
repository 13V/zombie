/**
 * Visual-only player skins — a full cosmetic roster (no stat effect), the skins
 * counterpart to the pet collection. Each skin recolors the voxel hero's body +
 * head; higher rarities also carry a `glow` (emissive) so legendary/mythic skins
 * shine in the field. Bought once with Essence, then equipped freely.
 */
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
}

export const SKINS: Skin[] = [
  // ---- common ----
  { id: "classic", name: "Classic", body: 0x4a78d6, head: 0xfff4d6, rarity: "common", cost: 0 },
  { id: "recruit", name: "Recruit", body: 0x6b7280, head: 0xe8d6a8, rarity: "common", cost: 0 },
  { id: "ranger", name: "Ranger", body: 0x3f7d4a, head: 0xe8d6a8, rarity: "common", cost: 40 },
  { id: "dusty", name: "Dust Bowl", body: 0xb08a5a, head: 0xf0e0c0, rarity: "common", cost: 40 },
  { id: "sky", name: "Skyfarer", body: 0x5aa9e0, head: 0xeaf6ff, rarity: "common", cost: 50 },
  // ---- uncommon ----
  { id: "crimson", name: "Crimson", body: 0xb23a3a, head: 0xf0d2c0, rarity: "uncommon", cost: 90 },
  { id: "frost", name: "Frostbite", body: 0x4aa6d6, head: 0xeaf6ff, rarity: "uncommon", cost: 90 },
  { id: "toxic", name: "Toxic", body: 0x7ad14a, head: 0xd6ff8a, rarity: "uncommon", cost: 110 },
  { id: "rose", name: "Rosewood", body: 0xd06a8a, head: 0xffe0ea, rarity: "uncommon", cost: 110 },
  { id: "slate", name: "Slate", body: 0x44505e, head: 0xc8d2dc, rarity: "uncommon", cost: 110 },
  // ---- rare ----
  { id: "shadow", name: "Shadow", body: 0x2a2a36, head: 0x6a6a80, rarity: "rare", cost: 200 },
  { id: "royal", name: "Royal", body: 0x6e4a9e, head: 0xffd24a, rarity: "rare", cost: 200 },
  { id: "ocean", name: "Abyssal", body: 0x1f6f8b, head: 0x9fe8ff, rarity: "rare", cost: 220 },
  { id: "ember", name: "Ember", body: 0xd0542a, head: 0xffcf7a, rarity: "rare", cost: 220 },
  { id: "verdant", name: "Verdant", body: 0x2f8f5a, head: 0xc8ff9a, rarity: "rare", cost: 240 },
  // ---- epic ----
  { id: "midas", name: "Midas", body: 0xffcf52, head: 0xfff4d6, rarity: "epic", cost: 380 },
  { id: "void", name: "Voidwalker", body: 0x1a1426, head: 0x8a5ad6, rarity: "epic", cost: 400 },
  { id: "glacier", name: "Glacier", body: 0x6fd0ff, head: 0xffffff, rarity: "epic", cost: 400 },
  { id: "inferno", name: "Inferno", body: 0xff4a2a, head: 0xffd24a, rarity: "epic", cost: 420 },
  { id: "orchid", name: "Orchid", body: 0xb05ad6, head: 0xffd6f4, rarity: "epic", cost: 420 },
  // ---- legendary (glow) ----
  { id: "phoenix", name: "Phoenix", body: 0xff6a2a, head: 0xffe14a, rarity: "legendary", cost: 700, glow: 0xff7a2a },
  { id: "aurora", name: "Aurora", body: 0x4ad6c0, head: 0xc8a0ff, rarity: "legendary", cost: 700, glow: 0x6ad7ff },
  { id: "obsidian", name: "Obsidian", body: 0x141420, head: 0xff5a7a, rarity: "legendary", cost: 750, glow: 0xff3a6a },
  { id: "celestine", name: "Celestine", body: 0xdfeaff, head: 0x7af7ff, rarity: "legendary", cost: 800, glow: 0x9fe8ff },
  // ---- mythic (bright glow) ----
  { id: "cosmic", name: "Cosmic", body: 0x2a1a5e, head: 0xff9ec7, rarity: "mythic", cost: 1300, glow: 0xc792ea },
  { id: "prismatic", name: "Prismatic", body: 0xff5a7a, head: 0x6ad7ff, rarity: "mythic", cost: 1500, glow: 0xffd24a },
  { id: "eclipse", name: "Eclipse", body: 0x0e0e14, head: 0xffd24a, rarity: "mythic", cost: 1600, glow: 0xffe14a },
];

export function findSkin(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}
