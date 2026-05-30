import * as THREE from "three";
import { voxelMaterial, glowMaterial } from "./palette";

/**
 * Companion pets bought with gold. Each is a small floating voxel critter that
 * orbits the player, auto-targets the nearest zombie, and fires real bullets
 * through the shared BulletSystem (so all collision / damage / FX come free).
 *
 * Pets are the late-game chaos + the gold sink: stack several and the screen
 * fills with autonomous fire. The roster is deliberately deep (50+) so the
 * idle-simulator loop always has a next thing to chase across six rarities.
 */

export type PetShape =
  | "bee" | "drone" | "dragon" | "ghost" | "turret" | "wisp" | "piggy" | "totem"
  | "slime" | "golem" | "mushroom" | "frog" | "crystal" | "star" | "cat"
  | "eye" | "serpent" | "phoenix" | "ufo" | "orb";

export type Rarity = "common" | "uncommon" | "rare" | "epic" | "legendary" | "mythic";

export const RARITY_ORDER: Rarity[] = ["common", "uncommon", "rare", "epic", "legendary", "mythic"];
export const RARITY_COLOR: Record<Rarity, string> = {
  common: "#b8c2cc",
  uncommon: "#6fdc8c",
  rare: "#5aa9ff",
  epic: "#c792ea",
  legendary: "#ffb84a",
  mythic: "#ff5a7a",
};
export const RARITY_LABEL: Record<Rarity, string> = {
  common: "Common", uncommon: "Uncommon", rare: "Rare",
  epic: "Epic", legendary: "Legendary", mythic: "Mythic",
};

export interface PetDef {
  id: string;
  name: string;
  desc: string;
  cost: number; // gold
  color: number;
  /** Secondary tone (belly/accent) — falls back to a darkened color if unset. */
  accent?: number;
  /** Bullet damage, fire interval (s), bullet color/scale, special behavior. */
  damage: number;
  interval: number;
  bulletColor: number;
  bulletScale: number;
  pierce: number;
  splashRadius: number;
  splashDamage: number;
  homing: number;
  /** Visual builder tag. */
  shape: PetShape;
  range: number; // how far it will engage
  rarity?: Rarity;
  /** Non-combat roles. "banker": earns gold over time + on kills nearby.
   *  "buffer": boosts other pets' damage. (default = combat shooter) */
  role?: "banker" | "buffer";
  /** banker: gold per second passively. buffer: +damage fraction to other pets. */
  roleValue?: number;
  /** At `evolveLevel`, the pet transforms into the `evolvesTo` def (bigger,
   *  stronger model + new behavior). The big idle payoff. */
  evolveLevel?: number;
  evolvesTo?: string;
}

type PetInit = Partial<PetDef> &
  Pick<PetDef, "id" | "name" | "desc" | "cost" | "color" | "shape" | "rarity">;

/** Terse factory — fills sensible combat defaults so each entry stays readable. */
function mk(p: PetInit): PetDef {
  return {
    damage: 0,
    interval: 1,
    bulletColor: p.color,
    bulletScale: 1,
    pierce: 0,
    splashRadius: 0,
    splashDamage: 0,
    homing: 0,
    range: 16,
    ...p,
  };
}

/** Evolved pet forms — not buyable directly; a base pet evolves into these. */
export const PET_EVOLUTIONS: PetDef[] = [
  mk({ id: "beebot_evo", name: "Queen Bee", desc: "A royal swarm of stingers", cost: 0, rarity: "rare", color: 0xffcf3a, accent: 0x2a2a2a,
    damage: 22, interval: 0.32, bulletColor: 0xffe14a, bulletScale: 0.7, pierce: 2, homing: 1, shape: "bee", range: 18 }),
  mk({ id: "turret_evo", name: "War Drone", desc: "Twin piercing autocannons", cost: 0, rarity: "rare", color: 0x9fb6ff, accent: 0x2a3450,
    damage: 70, interval: 0.45, bulletColor: 0x9fe8ff, bulletScale: 1.3, pierce: 5, shape: "turret", range: 22 }),
  mk({ id: "ghost_evo", name: "Reaper", desc: "Wide haunting splash", cost: 0, rarity: "rare", color: 0x9a5ad6, accent: 0xf3e6ff,
    damage: 55, interval: 0.7, bulletColor: 0xc792ea, bulletScale: 1.7, pierce: 1, splashRadius: 3.0, splashDamage: 50, homing: 1, shape: "ghost", range: 18 }),
  mk({ id: "dragon_evo", name: "Elder Dragon", desc: "Devastating fireball barrage", cost: 0, rarity: "epic", color: 0xff3a2a, accent: 0xffd24a,
    damage: 140, interval: 0.45, bulletColor: 0xff7a3a, bulletScale: 2.0, pierce: 4, splashRadius: 3.4, splashDamage: 110, homing: 1, shape: "dragon", range: 24 }),
];

export const PETS: PetDef[] = [
  // ───────────────────────── COMMON ─────────────────────────
  mk({ id: "ladybug", name: "Ladybug", desc: "Quick little nibbles", cost: 200, rarity: "common", color: 0xff5a4a, accent: 0x2a2a2a,
    damage: 11, interval: 0.45, bulletColor: 0xff8a6a, bulletScale: 0.55, shape: "bee", range: 14 }),
  mk({ id: "slime_g", name: "Green Slime", desc: "Splatty acid blobs", cost: 250, rarity: "common", color: 0x6fdc8c, accent: 0x3a8a5a,
    damage: 9, interval: 0.6, bulletColor: 0x9bf0b0, bulletScale: 0.7, splashRadius: 1.2, splashDamage: 6, shape: "slime", range: 12 }),
  mk({ id: "pebble", name: "Pebble Pup", desc: "Lobs heavy stones", cost: 280, rarity: "common", color: 0x9a8a78, accent: 0x4a4038,
    damage: 16, interval: 0.9, bulletColor: 0xc8b89a, bulletScale: 0.8, pierce: 1, shape: "golem", range: 12 }),
  mk({ id: "beebot", name: "Bee Buddy", desc: "Fires homing stingers", cost: 300, rarity: "common", color: 0xffd24a, accent: 0x2a2a2a,
    damage: 14, interval: 0.5, bulletColor: 0xffe14a, bulletScale: 0.6, pierce: 1, homing: 1, shape: "bee", range: 16,
    evolveLevel: 10, evolvesTo: "beebot_evo" }),
  mk({ id: "sproutling", name: "Sproutling", desc: "Pelts thorny seeds", cost: 300, rarity: "common", color: 0x8fcf5a, accent: 0xc8a06a,
    damage: 10, interval: 0.55, bulletColor: 0xbfe87a, bulletScale: 0.6, shape: "mushroom", range: 13 }),
  mk({ id: "firefly", name: "Firefly", desc: "Rapid green sparks", cost: 350, rarity: "common", color: 0x9be86a, accent: 0xeaffd6,
    damage: 8, interval: 0.3, bulletColor: 0xcfff8a, bulletScale: 0.45, shape: "wisp", range: 14 }),
  mk({ id: "tadpole", name: "Tadpole", desc: "Spits little bubbles", cost: 380, rarity: "common", color: 0x5ad6b0, accent: 0xd6fff0,
    damage: 11, interval: 0.5, bulletColor: 0x8ff0d6, bulletScale: 0.55, shape: "frog", range: 13 }),
  mk({ id: "batling", name: "Batling", desc: "Homing screech bolts", cost: 400, rarity: "common", color: 0x6a6a8a, accent: 0x2a2a3a,
    damage: 9, interval: 0.5, bulletColor: 0xa0a0d0, bulletScale: 0.5, homing: 1, shape: "ghost", range: 14 }),
  mk({ id: "wisp", name: "Spark Wisp", desc: "Rapid little zaps", cost: 450, rarity: "common", color: 0x6ad7ff, accent: 0xeaffff,
    damage: 10, interval: 0.28, bulletColor: 0x9fe8ff, bulletScale: 0.5, shape: "wisp", range: 15 }),
  mk({ id: "coin_chick", name: "Coin Chick", desc: "Earns a trickle of gold", cost: 500, rarity: "common", color: 0xffe07a, accent: 0xffd6a0,
    shape: "piggy", range: 0, role: "banker", roleValue: 0.8 }),

  // ───────────────────────── UNCOMMON ─────────────────────────
  mk({ id: "piggy", name: "Piggy Bank", desc: "Earns gold while you play", cost: 600, rarity: "uncommon", color: 0xff9ec7, accent: 0xffd6e6,
    shape: "piggy", range: 0, role: "banker", roleValue: 1.2 }),
  mk({ id: "kitling", name: "Kit Cat", desc: "Fast clawing darts", cost: 650, rarity: "uncommon", color: 0xffb87a, accent: 0x4a3a2a,
    damage: 20, interval: 0.45, bulletColor: 0xffd6a0, bulletScale: 0.6, shape: "cat", range: 15 }),
  mk({ id: "turret", name: "Mini Turret", desc: "Heavy piercing rounds", cost: 700, rarity: "uncommon", color: 0x8a98a8, accent: 0x3a4450,
    damage: 40, interval: 0.7, bulletColor: 0xffc06a, bulletScale: 1.1, pierce: 3, shape: "turret", range: 18,
    evolveLevel: 10, evolvesTo: "turret_evo" }),
  mk({ id: "toadstool", name: "Toadstool", desc: "Bursting spore caps", cost: 700, rarity: "uncommon", color: 0xff5a6a, accent: 0xffe0e0,
    damage: 24, interval: 0.7, bulletColor: 0xff8a9a, bulletScale: 0.9, splashRadius: 1.6, splashDamage: 12, shape: "mushroom", range: 14 }),
  mk({ id: "crystalite", name: "Crystalite", desc: "Piercing shards", cost: 750, rarity: "uncommon", color: 0x6ad7ff, accent: 0xeaffff,
    damage: 22, interval: 0.5, bulletColor: 0x9fe8ff, bulletScale: 0.7, pierce: 2, shape: "crystal", range: 16 }),
  mk({ id: "peeper", name: "Peeper", desc: "Homing gaze bolts", cost: 780, rarity: "uncommon", color: 0xff9ec7, accent: 0xfff0f6,
    damage: 28, interval: 0.6, bulletColor: 0xffc0e0, bulletScale: 0.7, homing: 1, shape: "eye", range: 17 }),
  mk({ id: "scout_drone", name: "Scout Drone", desc: "Pierce-tipped bursts", cost: 850, rarity: "uncommon", color: 0x9fb6ff, accent: 0x2a3450,
    damage: 26, interval: 0.55, bulletColor: 0xcfe0ff, bulletScale: 0.8, pierce: 1, shape: "drone", range: 18 }),
  mk({ id: "starlet", name: "Starlet", desc: "Twinkling fast shots", cost: 900, rarity: "uncommon", color: 0xffe14a, accent: 0xfffbd0,
    damage: 18, interval: 0.4, bulletColor: 0xfff080, bulletScale: 0.6, shape: "star", range: 16 }),
  mk({ id: "garden_snake", name: "Garden Snake", desc: "Piercing venom spit", cost: 950, rarity: "uncommon", color: 0x8fd65a, accent: 0x3a6a2a,
    damage: 30, interval: 0.65, bulletColor: 0xbfe87a, bulletScale: 0.8, pierce: 2, shape: "serpent", range: 16 }),
  mk({ id: "emberling", name: "Emberling", desc: "Little fire bursts", cost: 1000, rarity: "uncommon", color: 0xff7a4a, accent: 0xffd24a,
    damage: 30, interval: 0.6, bulletColor: 0xffa05a, bulletScale: 0.9, splashRadius: 1.4, splashDamage: 14, shape: "dragon", range: 16 }),

  // ───────────────────────── RARE ─────────────────────────
  mk({ id: "ghost", name: "Boo Ghost", desc: "Spooky splash orbs", cost: 1200, rarity: "rare", color: 0xc792ea, accent: 0xf3e6ff,
    damage: 30, interval: 0.9, bulletColor: 0xc792ea, bulletScale: 1.3, splashRadius: 2.0, splashDamage: 24, homing: 1, shape: "ghost", range: 16,
    evolveLevel: 10, evolvesTo: "ghost_evo" }),
  mk({ id: "sapphire_shard", name: "Sapphire Shard", desc: "Deep piercing beams", cost: 1500, rarity: "rare", color: 0x5aa9ff, accent: 0xeaf4ff,
    damage: 55, interval: 0.55, bulletColor: 0x9fd0ff, bulletScale: 0.9, pierce: 3, shape: "crystal", range: 18 }),
  mk({ id: "dragon", name: "Baby Dragon", desc: "Spits explosive fireballs", cost: 1600, rarity: "rare", color: 0xff5a3a, accent: 0xffd24a,
    damage: 70, interval: 0.6, bulletColor: 0xff7a3a, bulletScale: 1.5, pierce: 2, splashRadius: 2.6, splashDamage: 60, homing: 1, shape: "dragon", range: 20,
    evolveLevel: 10, evolvesTo: "dragon_evo" }),
  mk({ id: "shadow_cat", name: "Shadow Cat", desc: "Blistering shadow claws", cost: 1700, rarity: "rare", color: 0x7a6aff, accent: 0x1a1430,
    damage: 50, interval: 0.4, bulletColor: 0xb0a0ff, bulletScale: 0.7, pierce: 1, shape: "cat", range: 17 }),
  mk({ id: "stone_golem", name: "Stone Golem", desc: "Crushing boulder slams", cost: 1800, rarity: "rare", color: 0x8a98a8, accent: 0x3a4450,
    damage: 80, interval: 1.0, bulletColor: 0xc8d0d8, bulletScale: 1.3, pierce: 2, splashRadius: 1.8, splashDamage: 30, shape: "golem", range: 14 }),
  mk({ id: "lil_saucer", name: "Lil' Saucer", desc: "Homing plasma pings", cost: 2000, rarity: "rare", color: 0x9fe8ff, accent: 0x3a4450,
    damage: 40, interval: 0.45, bulletColor: 0xeaffff, bulletScale: 0.7, homing: 1, shape: "ufo", range: 20 }),
  mk({ id: "money_toad", name: "Money Toad", desc: "Burps up steady gold", cost: 2000, rarity: "rare", color: 0x6fdc8c, accent: 0xffd24a,
    shape: "frog", range: 0, role: "banker", roleValue: 2.4 }),
  mk({ id: "phoenix_chick", name: "Phoenix Chick", desc: "Piercing ember feathers", cost: 2200, rarity: "rare", color: 0xff7a3a, accent: 0xffd24a,
    damage: 45, interval: 0.5, bulletColor: 0xffb05a, bulletScale: 0.8, pierce: 2, shape: "phoenix", range: 18 }),
  mk({ id: "nova_star", name: "Nova Star", desc: "Bursting starlight", cost: 2400, rarity: "rare", color: 0xffd24a, accent: 0xfffbd0,
    damage: 48, interval: 0.45, bulletColor: 0xfff080, bulletScale: 0.9, splashRadius: 1.8, splashDamage: 22, shape: "star", range: 18 }),
  mk({ id: "totem", name: "Power Totem", desc: "+25% damage to your other pets", cost: 2600, rarity: "rare", color: 0x7be0c0, accent: 0xffd24a,
    shape: "totem", range: 0, role: "buffer", roleValue: 0.25 }),

  // ───────────────────────── EPIC ─────────────────────────
  mk({ id: "specter", name: "Specter", desc: "Wide haunting splash", cost: 3500, rarity: "epic", color: 0x9a5ad6, accent: 0xf3e6ff,
    damage: 90, interval: 0.7, bulletColor: 0xc792ea, bulletScale: 1.5, splashRadius: 2.6, splashDamage: 60, homing: 1, shape: "ghost", range: 18 }),
  mk({ id: "thunder_orb", name: "Thunder Orb", desc: "Machine-gun lightning", cost: 3800, rarity: "epic", color: 0x9fe8ff, accent: 0xffffff,
    damage: 70, interval: 0.3, bulletColor: 0xeaffff, bulletScale: 0.7, pierce: 2, shape: "orb", range: 18 }),
  mk({ id: "inferno_drake", name: "Inferno Drake", desc: "Roaring fireball storm", cost: 4000, rarity: "epic", color: 0xff3a2a, accent: 0xffd24a,
    damage: 120, interval: 0.55, bulletColor: 0xff7a3a, bulletScale: 1.7, pierce: 3, splashRadius: 3.0, splashDamage: 90, homing: 1, shape: "dragon", range: 22 }),
  mk({ id: "prism_totem", name: "Prism Totem", desc: "+45% damage to your other pets", cost: 4200, rarity: "epic", color: 0xc792ea, accent: 0xffd24a,
    shape: "totem", range: 0, role: "buffer", roleValue: 0.45 }),
  mk({ id: "heavy_turret", name: "Heavy Turret", desc: "Armor-piercing shells", cost: 4500, rarity: "epic", color: 0x7a8aa8, accent: 0x2a3450,
    damage: 130, interval: 0.7, bulletColor: 0xffc06a, bulletScale: 1.4, pierce: 5, shape: "turret", range: 22 }),
  mk({ id: "void_eye", name: "Void Eye", desc: "Homing void lances", cost: 4800, rarity: "epic", color: 0x9a5ad6, accent: 0x1a1030,
    damage: 100, interval: 0.6, bulletColor: 0xc0a0ff, bulletScale: 1.0, homing: 1, splashRadius: 2.0, splashDamage: 40, shape: "eye", range: 20 }),
  mk({ id: "golden_piggy", name: "Golden Piggy", desc: "Mints serious gold", cost: 5000, rarity: "epic", color: 0xffd24a, accent: 0xfff0b0,
    shape: "piggy", range: 0, role: "banker", roleValue: 5 }),
  mk({ id: "seraph_star", name: "Seraph Star", desc: "Holy starlight nova", cost: 5200, rarity: "epic", color: 0xffffff, accent: 0xffe14a,
    damage: 120, interval: 0.45, bulletColor: 0xfffbd0, bulletScale: 1.2, splashRadius: 2.2, splashDamage: 55, shape: "star", range: 20 }),
  mk({ id: "crystal_wyrm", name: "Crystal Wyrm", desc: "Shattering shard breath", cost: 5500, rarity: "epic", color: 0x6ad7ff, accent: 0xeaffff,
    damage: 150, interval: 0.6, bulletColor: 0x9fe8ff, bulletScale: 1.6, pierce: 4, splashRadius: 2.6, splashDamage: 80, homing: 1, shape: "dragon", range: 22 }),
  mk({ id: "solar_phoenix", name: "Solar Phoenix", desc: "Blazing rebirth flares", cost: 6000, rarity: "epic", color: 0xffb84a, accent: 0xff5a3a,
    damage: 140, interval: 0.5, bulletColor: 0xffd24a, bulletScale: 1.3, pierce: 3, splashRadius: 2.4, splashDamage: 70, shape: "phoenix", range: 20 }),

  // ───────────────────────── LEGENDARY ─────────────────────────
  mk({ id: "reaper_lord", name: "Reaper Lord", desc: "Soul-harvest splash", cost: 8500, rarity: "legendary", color: 0x7a3aff, accent: 0xf3e6ff,
    damage: 220, interval: 0.65, bulletColor: 0xc0a0ff, bulletScale: 1.9, splashRadius: 3.4, splashDamage: 140, homing: 1, shape: "ghost", range: 22 }),
  mk({ id: "celestial_dragon", name: "Celestial Dragon", desc: "Starfire devastation", cost: 9000, rarity: "legendary", color: 0x9fe8ff, accent: 0xffd24a,
    damage: 260, interval: 0.55, bulletColor: 0xeaffff, bulletScale: 1.9, pierce: 5, splashRadius: 3.2, splashDamage: 160, homing: 1, shape: "dragon", range: 24 }),
  mk({ id: "divine_totem", name: "Divine Totem", desc: "+70% damage to your other pets", cost: 9500, rarity: "legendary", color: 0xffffff, accent: 0xffd24a,
    shape: "totem", range: 0, role: "buffer", roleValue: 0.7 }),
  mk({ id: "omni_cannon", name: "Omni Cannon", desc: "Ridiculous pierce barrage", cost: 10000, rarity: "legendary", color: 0xffd24a, accent: 0x2a3450,
    damage: 320, interval: 0.6, bulletColor: 0xfff080, bulletScale: 1.8, pierce: 8, shape: "turret", range: 26 }),
  mk({ id: "galaxy_orb", name: "Galaxy Orb", desc: "Hyper-rapid star bolts", cost: 11000, rarity: "legendary", color: 0xc792ea, accent: 0xffffff,
    damage: 200, interval: 0.28, bulletColor: 0xeaccff, bulletScale: 1.1, pierce: 4, splashRadius: 2.0, splashDamage: 80, shape: "orb", range: 22 }),
  mk({ id: "fortune_dragon", name: "Fortune Dragon", desc: "Hoards gold by the second", cost: 12000, rarity: "legendary", color: 0xffd24a, accent: 0xff5a3a,
    shape: "dragon", range: 0, role: "banker", roleValue: 9 }),
  mk({ id: "eclipse_phoenix", name: "Eclipse Phoenix", desc: "Apocalyptic firestorm", cost: 14000, rarity: "legendary", color: 0xff5a7a, accent: 0xffd24a,
    damage: 340, interval: 0.5, bulletColor: 0xff8aa0, bulletScale: 1.7, pierce: 5, splashRadius: 3.0, splashDamage: 180, homing: 1, shape: "phoenix", range: 24 }),

  // ───────────────────────── MYTHIC ─────────────────────────
  mk({ id: "cosmic_serpent", name: "Cosmic Serpent", desc: "Ten-pierce cosmic venom", cost: 22000, rarity: "mythic", color: 0x7a3aff, accent: 0x9fe8ff,
    damage: 500, interval: 0.5, bulletColor: 0xc0a0ff, bulletScale: 1.8, pierce: 10, splashRadius: 2.6, splashDamage: 200, homing: 1, shape: "serpent", range: 26 }),
  mk({ id: "midas_golem", name: "Midas Golem", desc: "Turns the carnage to gold", cost: 26000, rarity: "mythic", color: 0xffd24a, accent: 0xfff0b0,
    shape: "golem", range: 0, role: "banker", roleValue: 20 }),
  mk({ id: "void_sovereign", name: "Void Sovereign", desc: "Reality-ending fireballs", cost: 30000, rarity: "mythic", color: 0x3a1a5a, accent: 0xff3aff,
    damage: 800, interval: 0.5, bulletColor: 0xff3aff, bulletScale: 2.2, pierce: 8, splashRadius: 4.0, splashDamage: 400, homing: 1, shape: "dragon", range: 28 }),
];

export function findPet(id: string): PetDef | undefined {
  return PETS.find((p) => p.id === id);
}
export function findAnyPet(id: string): PetDef | undefined {
  return PETS.find((p) => p.id === id) ?? PET_EVOLUTIONS.find((p) => p.id === id);
}

/** Gold cost to take a pet from `level` to `level+1` (escalating). */
export function petLevelCost(def: PetDef, level: number): number {
  return Math.round(def.cost * 0.5 * Math.pow(1.35, level - 1));
}

/** Damage multiplier from a pet's level (+18%/level, compounding feel). */
export function petDamageMul(level: number): number {
  return 1 + (level - 1) * 0.18;
}
/** Fire-rate (interval) multiplier — pets fire faster as they level (caps). */
export function petIntervalMul(level: number): number {
  return Math.max(0.5, 1 - (level - 1) * 0.04);
}

/** Darken a hex color by `f` (0..1). */
function darken(c: number, f: number): number {
  const r = ((c >> 16) & 255) * (1 - f);
  const g = ((c >> 8) & 255) * (1 - f);
  const b = (c & 255) * (1 - f);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** A live pet orbiting the player. */
export class Pet {
  readonly group = new THREE.Group();
  private body = new THREE.Group(); // animated inner body (bob/breathe/recoil)
  private wingL?: THREE.Mesh;
  private wingR?: THREE.Mesh;
  private aura?: THREE.Mesh; // pulsing glow (wisp/ghost)
  private muzzle?: THREE.Mesh; // fire-flash node
  private cd: number;
  private bob: number;
  private flap = 0;
  private recoil = 0; // 0..1, decays — pulls the body back when firing
  private flashLife = 0;
  level: number;
  private baseScale = 0.7;

  constructor(readonly def: PetDef, private orbitAngle: number, level = 1) {
    this.level = Math.max(1, level);
    this.cd = Math.random() * def.interval;
    this.bob = Math.random() * Math.PI * 2;
    this.flap = Math.random() * Math.PI * 2;
    this.group.add(this.body);
    this.build();
    this.applyLevelVisuals();
  }

  /** Pet fires faster + (in main) hits harder as it levels. */
  get interval(): number {
    return this.def.interval * petIntervalMul(this.level);
  }
  get damageMul(): number {
    return petDamageMul(this.level);
  }

  /** Visible growth: pet gets bigger + glows brighter with level. */
  setLevel(level: number) {
    this.level = Math.max(1, level);
    this.applyLevelVisuals();
  }
  private applyLevelVisuals() {
    // grows ~6%/level up to ~+60%; emissive ramps so high pets glow hot.
    this.baseScale = 0.7 * (1 + Math.min(0.6, (this.level - 1) * 0.06));
    this.group.scale.setScalar(this.baseScale);
    const glowBoost = Math.min(1.6, 0.9 + (this.level - 1) * 0.12);
    this.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0) {
        m.emissiveIntensity = glowBoost;
      }
    });
  }

  private build() {
    const col = this.def.color;
    const acc = this.def.accent ?? darken(col, 0.4);
    const body = voxelMaterial(col);
    const accent = voxelMaterial(acc);
    const glow = glowMaterial(col, 0.9);
    const dark = voxelMaterial(0x141414);
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, into = this.body) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      into.add(m);
      return m;
    };
    // ── cute kit: big sparkly eyes, rosy cheeks, little smiles ──
    // The single biggest "awww" lever on voxel critters is oversized eyes with
    // a white shine pixel + blush — every shape gets them.
    const shine = voxelMaterial(0xffffff);
    const blush = glowMaterial(0xff8fb0, 0.55);
    const eye = (x: number, y: number, z: number, s = 0.14, into = this.body) => {
      box(s, s * 1.35, 0.05, x, y, z, dark, into); // big round pupil
      box(s * 0.46, s * 0.5, 0.04, x - s * 0.26, y + s * 0.42, z + 0.02, shine, into); // catch-light sparkle
    };
    const cheeks = (y: number, z: number, dx = 0.21, into = this.body) => {
      box(0.1, 0.07, 0.04, -dx, y, z, blush, into);
      box(0.1, 0.07, 0.04, dx, y, z, blush, into);
    };
    const smile = (y: number, z: number, w = 0.12, into = this.body) => {
      box(w, 0.04, 0.04, 0, y, z, dark, into);
    };
    switch (this.def.shape) {
      case "bee":
        box(0.52, 0.48, 0.5, 0, 0, 0, body); // rounder chubby body
        box(0.54, 0.1, 0.52, 0, 0.08, 0, accent); // stripe
        box(0.54, 0.1, 0.52, 0, -0.12, 0, accent);
        eye(-0.13, 0.07, 0.26);
        eye(0.13, 0.07, 0.26);
        cheeks(-0.06, 0.27);
        smile(-0.11, 0.27);
        box(0.05, 0.15, 0.05, -0.07, 0.3, 0.16, dark); // antennae
        box(0.05, 0.15, 0.05, 0.07, 0.3, 0.16, dark);
        box(0.08, 0.08, 0.08, -0.07, 0.4, 0.16, glow); // bobble tips
        box(0.08, 0.08, 0.08, 0.07, 0.4, 0.16, glow);
        this.wingL = box(0.26, 0.04, 0.34, -0.34, 0.16, 0, glowMaterial(0xeaffff, 0.6));
        this.wingR = box(0.26, 0.04, 0.34, 0.34, 0.16, 0, glowMaterial(0xeaffff, 0.6));
        this.muzzle = box(0.1, 0.1, 0.1, 0, 0, 0.34, glow);
        break;
      case "wisp":
        this.aura = box(0.52, 0.52, 0.52, 0, 0, 0, glowMaterial(col, 0.5));
        box(0.34, 0.34, 0.34, 0, 0, 0, glow);
        box(0.16, 0.16, 0.16, 0, 0.34, 0, glow); // spark crown
        eye(-0.1, 0.03, 0.2, 0.11);
        eye(0.1, 0.03, 0.2, 0.11);
        cheeks(-0.08, 0.21, 0.18);
        smile(-0.09, 0.21, 0.1);
        this.muzzle = box(0.08, 0.08, 0.08, 0, 0, 0.28, glowMaterial(0xffffff, 1.2));
        break;
      case "turret":
        box(0.5, 0.18, 0.5, 0, -0.26, 0, accent); // base
        box(0.6, 0.42, 0.6, 0, 0, 0, body);
        box(0.62, 0.1, 0.62, 0, 0.2, 0, accent); // collar
        box(0.2, 0.2, 0.4, 0, 0.18, 0.4, dark); // stubby barrel
        eye(-0.15, 0, 0.31, 0.15);
        eye(0.15, 0, 0.31, 0.15);
        cheeks(-0.13, 0.32, 0.24);
        smile(-0.16, 0.32, 0.12);
        this.muzzle = box(0.16, 0.16, 0.1, 0, 0.18, 0.62, glow);
        break;
      case "ghost":
        this.aura = box(0.62, 0.7, 0.62, 0, 0, 0, glowMaterial(col, 0.35));
        box(0.48, 0.58, 0.48, 0, 0.02, 0, glowMaterial(col, 0.7));
        eye(-0.13, 0.12, 0.24, 0.16); // big adorable peepers
        eye(0.13, 0.12, 0.24, 0.16);
        cheeks(-0.04, 0.25);
        smile(-0.08, 0.25, 0.1);
        box(0.12, 0.12, 0.12, -0.16, -0.3, 0, glowMaterial(col, 0.7)); // tails
        box(0.12, 0.12, 0.12, 0.16, -0.3, 0, glowMaterial(col, 0.7));
        this.muzzle = box(0.12, 0.12, 0.12, 0, 0.0, 0.3, glow);
        break;
      case "dragon":
        box(0.58, 0.46, 0.6, 0, -0.04, -0.06, body); // smaller chibi body
        box(0.58, 0.14, 0.58, 0, -0.22, -0.06, accent); // belly
        box(0.5, 0.5, 0.48, 0, 0.22, 0.46, body); // big chibi head
        box(0.2, 0.16, 0.16, 0, 0.12, 0.72, accent); // snout
        eye(-0.15, 0.28, 0.68, 0.16); // huge baby eyes
        eye(0.15, 0.28, 0.68, 0.16);
        cheeks(0.14, 0.71, 0.24);
        box(0.07, 0.13, 0.07, -0.12, 0.5, 0.42, accent); // little horns
        box(0.07, 0.13, 0.07, 0.12, 0.5, 0.42, accent);
        box(0.14, 0.14, 0.36, 0, -0.08, -0.46, body); // tail
        box(0.18, 0.12, 0.06, 0, -0.16, -0.66, accent); // tail tip
        this.wingL = box(0.5, 0.06, 0.42, -0.48, 0.18, -0.18, glowMaterial(acc, 0.5));
        this.wingR = box(0.5, 0.06, 0.42, 0.48, 0.18, -0.18, glowMaterial(acc, 0.5));
        this.muzzle = box(0.16, 0.16, 0.16, 0, 0.14, 0.84, glowMaterial(0xffd24a, 1.4));
        break;
      case "piggy":
        box(0.62, 0.5, 0.7, 0, 0, 0, body); // round chubby body
        box(0.2, 0.2, 0.14, 0, 0, 0.4, accent); // big snout
        box(0.05, 0.06, 0.04, -0.06, 0, 0.47, dark); // nostrils
        box(0.05, 0.06, 0.04, 0.06, 0, 0.47, dark);
        eye(-0.14, 0.1, 0.34, 0.12); // sparkly eyes
        eye(0.14, 0.1, 0.34, 0.12);
        cheeks(0.0, 0.35, 0.26);
        box(0.13, 0.13, 0.04, -0.17, 0.28, 0.18, body); // floppy ears
        box(0.13, 0.13, 0.04, 0.17, 0.28, 0.18, body);
        box(0.22, 0.06, 0.02, 0, 0.18, -0.02, glowMaterial(0xffd24a, 1.0)); // coin slot
        box(0.1, 0.1, 0.05, 0, -0.02, -0.37, accent); // curly tail
        break;
      case "totem":
        box(0.4, 0.2, 0.4, 0, -0.3, 0, accent); // base
        box(0.48, 0.48, 0.46, 0, 0, 0, body); // mask block
        box(0.52, 0.12, 0.5, 0, 0.27, 0, glowMaterial(this.def.color, 0.9)); // glowing top ring
        eye(-0.12, 0.05, 0.24, 0.13); // big friendly eyes
        eye(0.12, 0.05, 0.24, 0.13);
        cheeks(-0.04, 0.25);
        smile(-0.08, 0.25, 0.12);
        this.aura = box(0.7, 0.7, 0.7, 0, 0, 0, glowMaterial(this.def.color, 0.3)); // buff aura
        break;
      case "drone":
        box(0.5, 0.34, 0.46, 0, 0.06, 0, body); // rounder little body
        box(0.54, 0.08, 0.5, 0, 0.22, 0, accent); // top plate
        box(0.12, 0.12, 0.12, -0.3, 0.18, 0.18, glow); // rotor lights
        box(0.12, 0.12, 0.12, 0.3, 0.18, 0.18, glow);
        box(0.12, 0.12, 0.12, -0.3, 0.18, -0.18, glow);
        box(0.12, 0.12, 0.12, 0.3, 0.18, -0.18, glow);
        eye(-0.12, 0.08, 0.24, 0.13); // big lens eyes
        eye(0.12, 0.08, 0.24, 0.13);
        cheeks(-0.04, 0.25, 0.22);
        box(0.14, 0.1, 0.2, 0, -0.12, 0.28, dark); // little gun
        this.muzzle = box(0.13, 0.13, 0.1, 0, -0.12, 0.42, glow);
        break;
      case "slime":
        this.aura = box(0.66, 0.5, 0.66, 0, -0.02, 0, glowMaterial(col, 0.3));
        box(0.6, 0.4, 0.6, 0, -0.04, 0, glowMaterial(col, 0.45));
        box(0.46, 0.52, 0.46, 0, 0.1, 0, body); // wobbly blob top
        box(0.12, 0.1, 0.1, 0, 0.36, 0, glowMaterial(0xffffff, 0.7)); // shiny drip highlight
        eye(-0.12, 0.12, 0.22, 0.13); // big jelly eyes
        eye(0.12, 0.12, 0.22, 0.13);
        cheeks(0.02, 0.23, 0.2);
        smile(-0.02, 0.23, 0.1);
        this.muzzle = box(0.12, 0.12, 0.12, 0, 0.02, 0.32, glow);
        break;
      case "golem":
        box(0.6, 0.58, 0.6, 0, 0.02, 0, body);
        box(0.66, 0.2, 0.66, 0, -0.24, 0, accent); // base
        eye(-0.14, 0.1, 0.3, 0.15); // big gentle-giant eyes
        eye(0.14, 0.1, 0.3, 0.15);
        cheeks(-0.06, 0.31, 0.26);
        smile(-0.1, 0.31, 0.14);
        box(0.16, 0.28, 0.16, -0.4, -0.08, 0, body); // arms
        box(0.16, 0.28, 0.16, 0.4, -0.08, 0, body);
        this.muzzle = box(0.16, 0.16, 0.12, 0, -0.04, 0.34, glow);
        break;
      case "mushroom":
        box(0.34, 0.36, 0.34, 0, -0.08, 0, accent); // chubby stem
        box(0.62, 0.32, 0.62, 0, 0.2, 0, body); // cap
        box(0.13, 0.13, 0.13, -0.16, 0.24, 0.16, glowMaterial(0xffffff, 0.8)); // spots
        box(0.13, 0.13, 0.13, 0.16, 0.24, -0.1, glowMaterial(0xffffff, 0.8));
        eye(-0.11, -0.06, 0.18, 0.12); // eyes on the stem face
        eye(0.11, -0.06, 0.18, 0.12);
        cheeks(-0.14, 0.18, 0.18);
        smile(-0.16, 0.18, 0.1);
        this.muzzle = box(0.12, 0.12, 0.12, 0, -0.02, 0.22, glow);
        break;
      case "frog":
        box(0.58, 0.36, 0.5, 0, 0, 0, body);
        box(0.58, 0.14, 0.5, 0, -0.14, 0, accent); // belly
        box(0.2, 0.2, 0.18, -0.16, 0.22, 0.04, body); // big eye bulges
        box(0.2, 0.2, 0.18, 0.16, 0.22, 0.04, body);
        eye(-0.16, 0.23, 0.16, 0.12); // sparkly froggy eyes
        eye(0.16, 0.23, 0.16, 0.12);
        cheeks(0.0, 0.16, 0.22);
        smile(-0.02, 0.06, 0.22); // wide froggy grin
        box(0.14, 0.1, 0.14, -0.24, -0.12, 0.1, body); // feet
        box(0.14, 0.1, 0.14, 0.24, -0.12, 0.1, body);
        this.muzzle = box(0.1, 0.1, 0.1, 0, 0, 0.3, glow);
        break;
      case "crystal":
        this.aura = box(0.6, 0.7, 0.6, 0, 0, 0, glowMaterial(col, 0.35));
        box(0.34, 0.6, 0.34, 0, 0.06, 0, glowMaterial(col, 0.8)); // central shard
        box(0.18, 0.4, 0.18, -0.22, -0.08, 0, glowMaterial(col, 0.7));
        box(0.18, 0.4, 0.18, 0.22, -0.08, 0, glowMaterial(col, 0.7));
        box(0.16, 0.16, 0.16, 0, 0.4, 0, glow); // tip
        eye(-0.09, 0.06, 0.18, 0.11); // little gem face
        eye(0.09, 0.06, 0.18, 0.11);
        cheeks(-0.04, 0.19, 0.16);
        smile(-0.06, 0.19, 0.08);
        this.muzzle = box(0.12, 0.12, 0.12, 0, 0.06, 0.24, glowMaterial(0xffffff, 1.2));
        break;
      case "star":
        this.aura = box(0.6, 0.6, 0.2, 0, 0, 0, glowMaterial(col, 0.4));
        box(0.58, 0.16, 0.16, 0, 0, 0, glow); // cross spikes
        box(0.16, 0.58, 0.16, 0, 0, 0, glow);
        box(0.4, 0.4, 0.14, 0, 0, 0, glowMaterial(col, 0.9)); // core
        eye(-0.1, 0.04, 0.1, 0.11); // twinkly star eyes
        eye(0.1, 0.04, 0.1, 0.11);
        cheeks(-0.08, 0.12, 0.16);
        smile(-0.1, 0.12, 0.1);
        this.muzzle = box(0.12, 0.12, 0.12, 0, 0, 0.18, glowMaterial(0xffffff, 1.3));
        break;
      case "cat":
        box(0.52, 0.46, 0.5, 0, 0, 0, body);
        box(0.5, 0.12, 0.5, 0, -0.2, 0, accent);
        box(0.15, 0.18, 0.05, -0.16, 0.3, 0.04, body); // perky ears
        box(0.15, 0.18, 0.05, 0.16, 0.3, 0.04, body);
        box(0.08, 0.1, 0.04, -0.16, 0.32, 0.06, blush); // inner ears
        box(0.08, 0.1, 0.04, 0.16, 0.32, 0.06, blush);
        eye(-0.13, 0.06, 0.25, 0.14); // big kitty eyes
        eye(0.13, 0.06, 0.25, 0.14);
        cheeks(-0.06, 0.26);
        box(0.06, 0.05, 0.05, 0, -0.04, 0.27, blush); // tiny nose
        smile(-0.1, 0.27, 0.1);
        box(0.1, 0.1, 0.34, 0, -0.02, -0.4, body); // tail
        box(0.1, 0.1, 0.1, 0, 0.12, -0.52, accent); // tail tip
        this.muzzle = box(0.1, 0.1, 0.1, 0, -0.02, 0.3, glow);
        break;
      case "eye":
        this.aura = box(0.6, 0.6, 0.6, 0, 0, 0, glowMaterial(col, 0.3));
        box(0.5, 0.52, 0.5, 0, 0, 0, glowMaterial(0xffffff, 0.5)); // round sclera
        box(0.28, 0.3, 0.1, 0, -0.02, 0.22, glowMaterial(col, 0.9)); // big iris
        box(0.16, 0.16, 0.06, 0, -0.03, 0.3, dark); // pupil
        box(0.08, 0.08, 0.04, -0.06, 0.06, 0.33, shine); // big catch-light
        box(0.05, 0.05, 0.04, 0.05, -0.08, 0.33, shine); // second sparkle
        box(0.5, 0.1, 0.46, 0, 0.27, 0.02, accent); // soft eyelid
        cheeks(-0.16, 0.26, 0.24);
        this.muzzle = box(0.12, 0.12, 0.12, 0, -0.18, 0.3, glow);
        break;
      case "serpent":
        box(0.44, 0.42, 0.44, 0, 0.08, 0.2, body); // bigger cute head
        box(0.18, 0.13, 0.08, 0, 0.04, 0.44, accent); // snout
        eye(-0.12, 0.14, 0.36, 0.12); // sparkly snake eyes
        eye(0.12, 0.14, 0.36, 0.12);
        cheeks(0.02, 0.38, 0.18);
        box(0.07, 0.04, 0.06, 0, 0.0, 0.48, glowMaterial(0xff5a6a, 0.8)); // little tongue
        box(0.3, 0.3, 0.3, 0, -0.02, -0.1, body); // segments
        box(0.24, 0.24, 0.26, 0, -0.06, -0.4, accent);
        box(0.18, 0.18, 0.22, 0, -0.08, -0.64, body);
        this.muzzle = box(0.1, 0.1, 0.1, 0, 0.06, 0.52, glow);
        break;
      case "phoenix":
        box(0.4, 0.44, 0.4, 0, -0.04, 0, body);
        box(0.32, 0.32, 0.3, 0, 0.32, 0.04, body); // big chibi head
        box(0.12, 0.1, 0.1, 0, 0.3, 0.22, accent); // beak
        eye(-0.1, 0.36, 0.18, 0.12); // big baby-bird eyes
        eye(0.1, 0.36, 0.18, 0.12);
        cheeks(0.26, 0.2, 0.16);
        box(0.1, 0.16, 0.1, 0, 0.52, 0.02, glow); // crest
        box(0.14, 0.1, 0.34, 0, -0.12, -0.34, glowMaterial(col, 0.7)); // tail flame
        this.wingL = box(0.5, 0.06, 0.4, -0.42, 0.0, -0.04, glowMaterial(col, 0.6));
        this.wingR = box(0.5, 0.06, 0.4, 0.42, 0.0, -0.04, glowMaterial(col, 0.6));
        this.muzzle = box(0.12, 0.12, 0.12, 0, 0.3, 0.3, glowMaterial(0xffd24a, 1.4));
        break;
      case "ufo":
        box(0.7, 0.12, 0.7, 0, 0, 0, accent); // disc
        box(0.42, 0.28, 0.42, 0, 0.16, 0, glowMaterial(0xffffff, 0.45)); // tall glass dome
        eye(-0.1, 0.16, 0.2, 0.12); // tiny pilot peeking out
        eye(0.1, 0.16, 0.2, 0.12);
        cheeks(0.08, 0.21, 0.16);
        smile(0.06, 0.21, 0.1);
        box(0.12, 0.12, 0.12, -0.28, -0.02, 0.18, glow); // running lights
        box(0.12, 0.12, 0.12, 0.28, -0.02, 0.18, glow);
        box(0.12, 0.12, 0.12, -0.28, -0.02, -0.18, glow);
        box(0.12, 0.12, 0.12, 0.28, -0.02, -0.18, glow);
        this.aura = box(0.3, 0.4, 0.3, 0, -0.24, 0, glowMaterial(col, 0.4)); // tractor beam
        this.muzzle = box(0.14, 0.14, 0.14, 0, -0.1, 0.34, glowMaterial(0x9fe8ff, 1.2));
        break;
      case "orb":
        this.aura = box(0.6, 0.6, 0.6, 0, 0, 0, glowMaterial(col, 0.4));
        box(0.42, 0.42, 0.42, 0, 0, 0, glow);
        box(0.6, 0.1, 0.1, 0, 0, 0, glowMaterial(0xffffff, 0.7)); // rings
        box(0.1, 0.6, 0.1, 0, 0, 0, glowMaterial(0xffffff, 0.7));
        box(0.1, 0.1, 0.6, 0, 0, 0, glowMaterial(0xffffff, 0.7));
        eye(-0.1, 0.03, 0.21, 0.11); // little glowing face
        eye(0.1, 0.03, 0.21, 0.11);
        cheeks(-0.06, 0.22, 0.16);
        smile(-0.08, 0.22, 0.1);
        this.muzzle = box(0.14, 0.14, 0.14, 0, 0, 0.3, glowMaterial(0xffffff, 1.4));
        break;
      default:
        box(0.5, 0.5, 0.5, 0, 0, 0, body);
    }
    if (this.muzzle) this.muzzle.scale.setScalar(0.01); // hidden until firing
  }

  /** Visually react to firing — recoil punch + muzzle flash. */
  private onFire() {
    this.recoil = 1;
    this.flashLife = 0.12;
  }

  /**
   * Update orbit + animation + fire. Returns a shot when it fires this frame.
   */
  update(dt: number, playerX: number, playerZ: number, idx: number, total: number, target: { x: number; z: number } | null): { ox: number; oz: number; dx: number; dz: number } | null {
    // orbit around the player
    this.orbitAngle += dt * 1.4;
    const slot = (idx / Math.max(1, total)) * Math.PI * 2;
    const r = 1.8;
    const ox = playerX + Math.cos(this.orbitAngle + slot) * r;
    const oz = playerZ + Math.sin(this.orbitAngle + slot) * r;
    this.bob += dt * 4;
    this.group.position.set(ox, 1.4 + Math.sin(this.bob) * 0.12, oz);

    // ---- idle animation ----
    this.flap += dt * (this.wingL ? 26 : 8); // bees/dragons flap fast
    if (this.wingL && this.wingR) {
      const a = Math.sin(this.flap) * (this.def.shape === "dragon" ? 0.5 : 0.9);
      this.wingL.rotation.z = a;
      this.wingR.rotation.z = -a;
    }
    if (this.aura) {
      const p = 1 + Math.sin(this.bob * 1.3) * 0.12;
      this.aura.scale.setScalar(p);
      (this.aura.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.4 + (Math.sin(this.bob * 2) + 1) * 0.2;
    }
    // breathe + recoil: body squashes back when it just fired
    this.recoil = Math.max(0, this.recoil - dt * 5);
    const breathe = 1 + Math.sin(this.bob * 0.8) * 0.04;
    this.body.scale.set(breathe, breathe, breathe * (1 - this.recoil * 0.25));
    this.body.position.z = -this.recoil * 0.12;
    // muzzle flash
    if (this.muzzle) {
      this.flashLife = Math.max(0, this.flashLife - dt);
      const f = this.flashLife / 0.12;
      this.muzzle.scale.setScalar(0.01 + f * 1.1);
    }

    // face + fire at target
    this.cd -= dt;
    if (target) {
      const dx = target.x - ox;
      const dz = target.z - oz;
      const dist = Math.hypot(dx, dz);
      this.group.rotation.y = Math.atan2(dx, dz);
      if (dist <= this.def.range && this.cd <= 0) {
        this.cd = this.interval;
        this.onFire();
        const len = dist || 1;
        return { ox, oz, dx: dx / len, dz: dz / len };
      }
    }
    return null;
  }
}
