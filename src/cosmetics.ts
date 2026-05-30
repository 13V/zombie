/**
 * Visual-only player skins (Kintara-style cosmetics: no stat effect). Bought
 * once with Essence, then equipped freely. Recolors the voxel hero's body +
 * head, so they're cheap to add — just a palette entry.
 */
export interface Skin {
  id: string;
  name: string;
  body: number;
  head: number;
  cost: number; // Essence; 0 = owned from the start
}

export const SKINS: Skin[] = [
  { id: "classic", name: "Classic", body: 0x4a78d6, head: 0xfff4d6, cost: 0 },
  { id: "ranger", name: "Ranger", body: 0x3f7d4a, head: 0xe8d6a8, cost: 80 },
  { id: "crimson", name: "Crimson", body: 0xb23a3a, head: 0xf0d2c0, cost: 120 },
  { id: "frost", name: "Frost", body: 0x4aa6d6, head: 0xeaf6ff, cost: 120 },
  { id: "shadow", name: "Shadow", body: 0x2a2a36, head: 0x6a6a80, cost: 200 },
  { id: "royal", name: "Royal", body: 0x6e4a9e, head: 0xffd24a, cost: 200 },
  { id: "toxic", name: "Toxic", body: 0x7ad14a, head: 0xd6ff8a, cost: 250 },
  { id: "gold", name: "Midas", body: 0xffcf52, head: 0xfff4d6, cost: 400 },
];

export function findSkin(id: string): Skin {
  return SKINS.find((s) => s.id === id) ?? SKINS[0];
}
