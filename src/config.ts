// Central tuning knobs for gameplay + look. Tweak here, not in the systems.

export const WORLD = {
  /** Half-extent of the playable square arena (world units from center to wall). */
  half: 24,
  fogColor: 0xf3e9d6,
  fogNear: 38,
  fogFar: 96,
  groundColor: 0xd9c9a3,
};

export const CAMERA = {
  fov: 34, // long lens => flat, miniature/diorama feel
  // Offset from the player (high + behind). Tuned for the iso-ish toy look.
  offset: { x: 0, y: 30, z: 22 },
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
};
