// Central tuning knobs for gameplay + look. Tweak here, not in the systems.

export const WORLD = {
  /** Half-extent of the playable island (in voxels / world units from center). */
  half: 20,
  // Distant haze the color of the sky horizon, so far clouds fade softly.
  fogColor: 0xd9eeff,
  fogNear: 70,
  fogFar: 150,
};

export const CAMERA = {
  fov: 32, // long lens => flat, miniature/diorama feel
  // Offset from the player: high + behind, ~38° elevation for a 3/4 iso look.
  offset: { x: 0, y: 24, z: 30 },
  follow: 6, // higher = snappier follow
};

export const PLAYER = {
  radius: 0.55,
  speed: 8,
  maxHealth: 100,
  regenDelay: 4, // seconds after last hit before regen begins
  regenRate: 24, // hp per second
  touchInvuln: 0.0,
};

export const ZOMBIE = {
  radius: 0.6,
  // HP is ADDITIVE through the inflection round, then COMPOUNDS multiplicatively
  // (CoD's exact trick: a 10%/round wall at R10 that's smooth at the seam but
  // never gets lapped by player DPS). See rounds.ts beginRound().
  baseHealth: 60,
  healthPerRound: 22,
  hpInflection: 9, // round after which HP goes multiplicative
  hpGrowth: 1.1, // per-round HP multiplier past the inflection (1.08–1.12 sweet spot)
  baseSpeed: 2.4,
  speedPerRound: 0.1, // nudged up so kiting gets riskier through 10→20
  speedCap: 5.4,
  touchDamage: 12,
  touchInterval: 0.6, // seconds between hits while in contact
  separation: 2.0, // how hard they push apart so they don't stack
};

export const ROUNDS = {
  baseCount: 6, // zombies in round 1
  countPerRound: 4, // extra zombies per round
  intermission: 4, // breather between rounds (seconds)
  // The three ceilings are now ROUND-SCALED (the real fix for late-game farming):
  // a flat cap lets rising DPS empty the screen; a rising cap + faster spawns
  // fill it. Difficulty from density + geometry, not just HP.
  maxAliveBase: 32, // cap through the inflection round
  maxAlivePerRound: 3, // +per round past inflection
  maxAliveCap: 60, // desktop ceiling (mobile uses a lower one — see main.ts)
  spawnIntervalBase: 0.9, // seconds between spawns through inflection
  spawnIntervalMin: 0.4, // floor of the spawn-interval ramp
  spawnIntervalDecay: 0.05, // -per round past inflection
  swarmEvery: 7, // every Nth round is a fast "swarm/dog" round
};

export const SCORE = {
  hit: 10,
  kill: 40,
  roundBonusBase: 80,
  roundBonusPerRound: 20,
  startingPoints: 500,
};

export const COSTS = {
  wallBuy: 1000,
  mysteryBox: 950,
  perkTough: 2500,
  perkQuick: 2000,
  packAPunch: 2500,
  gobblegum: 1500,
  debris: 750,
};

/** A zombie variant. Multipliers stack on the round's base health/speed. */
export interface ZombieType {
  id: string;
  name: string;
  /** Earliest round this type can appear. */
  from: number;
  /** Spawn chance once eligible (the basic Shambler fills whatever's left). */
  weight: number;
  healthMul: number;
  speedMul: number;
  scale: number;
  touchDamage: number;
  scoreMul: number;
  body: number;
  head: number;
  /** If set, detonates on death dealing AoE to a nearby player. */
  blastRadius?: number;
  blastDamage?: number;
  // ---- flying mobs (the aerial threat layer) ----
  /** Flies at `flyHeight` above the ground; ignores separation from grounded mobs. */
  flying?: boolean;
  flyHeight?: number;
  /** "dive": swoops to the ground to attack then pulls up. "ranged": hovers at a
   *  standoff distance and lobs a projectile. (default = drifts in like a melee flier) */
  airMode?: "dive" | "ranged" | "swarm";
  /** On death, spawn this many copies of `splitInto` (a type id) at reduced HP. */
  splitInto?: string;
  splitCount?: number;
  /** Summoner: every `summonInterval`s, raise `summonCount` shamblers nearby. */
  summonInterval?: number;
  summonCount?: number;
}

/**
 * The 10-strong undead roster, weakest → strongest. Each tier unlocks at a
 * later round and the round's flat health ramp stacks on top, so the horde gets
 * both more numerous AND individually beefier the deeper you go.
 */
export const ZOMBIE_TYPES: ZombieType[] = [
  { id: "shambler", name: "Shambler", from: 1, weight: 0.0, healthMul: 1.0, speedMul: 1.0, scale: 1.0, touchDamage: 10, scoreMul: 1.0, body: 0x8fcf6f, head: 0x5f9d4a },
  { id: "walker", name: "Walker", from: 2, weight: 0.26, healthMul: 1.35, speedMul: 0.95, scale: 1.05, touchDamage: 12, scoreMul: 1.1, body: 0x73b85a, head: 0x4c8038 },
  { id: "runner", name: "Runner", from: 3, weight: 0.22, healthMul: 0.7, speedMul: 1.9, scale: 0.82, touchDamage: 9, scoreMul: 1.2, body: 0xe8923a, head: 0xc9701f },
  { id: "crawler", name: "Crawler", from: 4, weight: 0.16, healthMul: 0.5, speedMul: 1.5, scale: 0.6, touchDamage: 8, scoreMul: 1.2, body: 0xbcae3c, head: 0x8f8424 },
  { id: "brute", name: "Brute", from: 5, weight: 0.16, healthMul: 4.0, speedMul: 0.7, scale: 1.55, touchDamage: 26, scoreMul: 3.0, body: 0xc0452f, head: 0x8f2f1f },
  { id: "bomber", name: "Bomber", from: 6, weight: 0.14, healthMul: 0.9, speedMul: 1.15, scale: 0.95, touchDamage: 12, scoreMul: 2.0, body: 0x9b6ad6, head: 0x6e4a9e, blastRadius: 3.6, blastDamage: 34 },
  { id: "spitter", name: "Spitter", from: 7, weight: 0.13, healthMul: 1.2, speedMul: 1.1, scale: 1.0, touchDamage: 14, scoreMul: 1.6, body: 0x3fbf9a, head: 0x278f72 },
  { id: "armored", name: "Armored", from: 8, weight: 0.13, healthMul: 6.5, speedMul: 0.6, scale: 1.35, touchDamage: 22, scoreMul: 3.5, body: 0x6c7a8a, head: 0x44505c },
  { id: "banshee", name: "Banshee", from: 9, weight: 0.13, healthMul: 0.85, speedMul: 2.4, scale: 0.9, touchDamage: 16, scoreMul: 2.2, body: 0xe85aa6, head: 0xb53a7e },
  { id: "abomination", name: "Abomination", from: 10, weight: 0.15, healthMul: 13.0, speedMul: 0.6, scale: 2.0, touchDamage: 42, scoreMul: 6.0, body: 0x7a1f1f, head: 0x4a0f0f, blastRadius: 4.2, blastDamage: 55 },
  // ---- flying mobs (aerial threat layer; forces dodging + priority targeting) ----
  { id: "vulture", name: "Vulture", from: 6, weight: 0.13, healthMul: 0.8, speedMul: 1.6, scale: 0.9, touchDamage: 20, scoreMul: 2.2, body: 0x6a5a7a, head: 0x9a7aa0, flying: true, flyHeight: 3.2, airMode: "dive" },
  { id: "gnat", name: "Gnat Swarm", from: 5, weight: 0.16, healthMul: 0.35, speedMul: 1.5, scale: 0.5, touchDamage: 7, scoreMul: 1.4, body: 0x9fb04a, head: 0x7a8a30, flying: true, flyHeight: 2.4, airMode: "swarm" },
  { id: "stinger", name: "Stinger", from: 9, weight: 0.12, healthMul: 0.9, speedMul: 1.0, scale: 0.85, touchDamage: 12, scoreMul: 2.4, body: 0xd6a23a, head: 0xb5841f, flying: true, flyHeight: 3.0, airMode: "ranged" },
  // ---- anti-camp grounded specials ----
  { id: "splitter", name: "Splitter", from: 9, weight: 0.12, healthMul: 2.2, speedMul: 0.9, scale: 1.2, touchDamage: 16, scoreMul: 2.4, body: 0x4ec98f, head: 0x2f8a60, splitInto: "splitling", splitCount: 2 },
  { id: "splitling", name: "Splitling", from: 999, weight: 0, healthMul: 0.6, speedMul: 1.4, scale: 0.7, touchDamage: 9, scoreMul: 0.8, body: 0x4ec98f, head: 0x2f8a60 },
  { id: "necro", name: "Necromancer", from: 12, weight: 0.1, healthMul: 2.6, speedMul: 0.7, scale: 1.15, touchDamage: 14, scoreMul: 3.5, body: 0x6e4a9e, head: 0x3a2456, summonInterval: 5, summonCount: 3 },
];

/** Gobblegum-style power-ups from the bubblegum machine. `duration` 0 = instant. */
export interface GumDef {
  id: string;
  name: string;
  short: string;
  duration: number;
  color: number;
}

export const GUMS: GumDef[] = [
  { id: "doublePoints", name: "Double Points", short: "2X", duration: 30, color: 0xffd24a },
  { id: "instakill", name: "Insta-Kill", short: "INSTA", duration: 25, color: 0xff5d8f },
  { id: "rapidFire", name: "Rapid Fire", short: "RAPID", duration: 20, color: 0x6ad7ff },
  { id: "sugarRush", name: "Sugar Rush", short: "SPEED", duration: 25, color: 0x8fcf6f },
  { id: "fullPockets", name: "Full Pockets", short: "AMMO", duration: 0, color: 0xc792ea },
];
