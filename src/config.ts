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
  baseHealth: 60,
  healthPerRound: 18,
  baseSpeed: 2.4,
  speedPerRound: 0.08,
  speedCap: 5.2,
  touchDamage: 12,
  touchInterval: 0.6, // seconds between hits while in contact
  separation: 2.0, // how hard they push apart so they don't stack
};

export const ROUNDS = {
  baseCount: 6, // zombies in round 1
  countPerRound: 3, // extra zombies per round
  maxAlive: 28, // hard cap of simultaneous zombies on screen
  spawnInterval: 0.9, // seconds between spawns
  intermission: 4, // breather between rounds (seconds)
};

export const SCORE = {
  hit: 10,
  kill: 50,
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
};

/**
 * Special zombie variants (COD-style). Multipliers stack on the round's base
 * health/speed. `from` is the earliest round each can appear; `weight` is its
 * relative spawn chance once eligible (normal zombies fill the rest).
 */
export const SPECIALS = {
  runner: {
    from: 4, weight: 0.22, healthMul: 0.6, speedMul: 1.9, scale: 0.82,
    touchDamage: 9, scoreMul: 1, body: 0xe8923a, head: 0xc9701f,
  },
  brute: {
    from: 6, weight: 0.16, healthMul: 4.0, speedMul: 0.7, scale: 1.55,
    touchDamage: 26, scoreMul: 3, body: 0xc0452f, head: 0x8f2f1f,
  },
  bomber: {
    from: 8, weight: 0.14, healthMul: 0.9, speedMul: 1.15, scale: 0.95,
    touchDamage: 12, scoreMul: 2, body: 0x9b6ad6, head: 0x6e4a9e,
    /** On death: AoE that hurts the player if close. */
    blastRadius: 3.6, blastDamage: 34,
  },
} as const;
