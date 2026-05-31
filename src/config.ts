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
  regenRate: 14, // hp per second (lowered from 24 — full-regen kiting was too safe)
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
  speedCap: 6.2, // raised from 5.4 — late-game horde can close the gap on a kiter
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
  maxAlivePerRound: 3, // +per round past inflection (keeps ramping past R20 now the cap is higher)
  maxAliveCap: 100, // desktop ceiling, raised from 60 (mobile uses a lower one — see main.ts)
  spawnIntervalBase: 0.9, // seconds between spawns through inflection
  spawnIntervalMin: 0.4, // floor of the spawn-interval ramp
  spawnIntervalDecay: 0.05, // -per round past inflection
  swarmEvery: 7, // every Nth round is a fast "swarm/dog" round
};

export const PETS_TUNING = {
  /** Max ACTIVE combat pets spawned at once (owning more is fine — see spawnPets).
   *  Bankers/buffers are non-combat and don't count toward this. */
  activeSquadCap: 5,
  /** Hard clamp on the total Power-Totem buffer multiplier applied to pet damage.
   *  Stops 3 stacked totems at L20 from turning into a 7x one-shot. */
  buffCap: 2.5,
  /** Per-kill gold drip so COMBAT is the primary gold faucet (scaled by scoreMul). */
  killGoldBase: 2,
  /** Banker gold/sec is flattened: roleValue * (1 + level*this) instead of *level. */
  bankerLevelScale: 0.08,
  /** Cap on gold a banker squad can mint per round (idle income, not a firehose). */
  bankerGoldPerRoundCap: 1500,
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

// ── IDLE & PRESTIGE TUNING ──
// Soft-currency idle/ascension economy. ALL rewards are gold/essence (soft);
// nothing here ever mints token — active shooting stays the primary faucet.
// The pure math lives in src/idle.ts; these are the only knobs to tweak.
export const IDLE = {
  /** Offline accrues at HALF the active banker rate, so logging in and SHOOTING
   *  always beats idling. (Spec-locked at 0.5 — don't raise without re-tuning.) */
  offlineRate: 0.5,
  /** Max offline window that pays out, in ms. 8h: a generous overnight catch-up
   *  that still can't replace a few active runs. */
  offlineCapMs: 8 * 60 * 60 * 1000,
  /** Don't bother showing the "While You Were Away" screen for trivial amounts
   *  (a quick tab-out). Below this many gold we credit silently. */
  welcomeBackMinGold: 25,
};

export const PRESTIGE = {
  /** AdVenture-Capitalist √ shape: prestige = floor(sqrt(lifetimeGold / X)).
   *  X = 50_000 ⇒ the FIRST ascension lands once lifetime gold crosses ~50k,
   *  which with bankers + kill-gold is roughly a 2–3h investment. The √ means
   *  each additional prestige point costs quadratically more lifetime gold
   *  (50k, 200k, 450k, 800k …), so early ascensions feel fast and it self-paces. */
  x: 50_000,
  /** Permanent gold/essence multiplier = 1 + prestige * k. k = 0.10 ⇒ +10% per
   *  ascension point — meaningful but never runaway (no compounding). */
  k: 0.1,
};

export const STREAK = {
  /** Soft daily-login reward, scaled by streak length (capped). Gold + a pinch
   *  of essence so a streak is worth keeping but never cashable. */
  baseGold: 100,
  goldPerDay: 50, // + this * min(count, capDays)
  capDays: 14, // streak reward stops growing past two weeks
  baseEssence: 2,
  essencePerDay: 1,
  essenceCap: 20,
  /** A "freeze" forgives ONE missed UTC day so a single skip won't reset the
   *  streak. Grant 1 every `freezeGrantEvery` days; never bank more than max. */
  freezeGrantEvery: 5,
  freezeMax: 2,
};

/** A finishable daily quest. `metric` keys into the run/lifetime delta settled
 *  at run-end (see main.ts settleDaily). All rewards are soft gold/essence. */
export interface DailyQuestDef {
  id: string;
  name: string;
  metric: "runs" | "kills" | "gold";
  goal: number;
  gold: number;
  essence: number;
}

export const DAILY_QUESTS: DailyQuestDef[] = [
  { id: "play", name: "Do 1 run", metric: "runs", goal: 1, gold: 150, essence: 3 },
  { id: "cull", name: "Kill 200 zombies", metric: "kills", goal: 200, gold: 250, essence: 5 },
  { id: "earn", name: "Earn 500 gold", metric: "gold", goal: 500, gold: 200, essence: 4 },
];

// ── SPECIAL ROUNDS & DIFFICULTY ──
// Knobs for the special-round system (rounds.ts), the elite-affix layer
// (zombie.ts), the difficulty director, and the opt-in Curse multiplier. Added
// as a self-contained block so the integrator can tune without touching the
// combat/economy exports above.

/** Cadence + theming for special rounds. Hound every Nth; showcases every Mth,
 *  offset so they never collide with a hound or boss round. */
export const SPECIAL_ROUNDS = {
  houndEvery: 5, // every Nth round is a Hound Round (fastest type only)
  showcaseEvery: 4, // every Mth round is a rotating themed showcase
  showcaseOffset: 2, // phase offset so showcases dodge hound/boss rounds
  /** Hound Round tint (CSS color) for the screen/fog wash. */
  houndTint: "#b53a2a",
  /** Rotating showcase themes, picked round-robin by showcase index. */
  showcases: [
    { id: "skyTerror", name: "SKY TERROR", tint: "#5a3a8a", roles: ["flying"] },
    { id: "summonerSiege", name: "SUMMONER SIEGE", tint: "#3a6a4a", roles: ["summon"] },
    { id: "splitterSwarm", name: "SPLITTER SWARM", tint: "#2f8a60", roles: ["split"] },
  ] as { id: string; name: string; tint: string; roles: ("flying" | "summon" | "split")[] }[],
};

/** Elite affix layer: late-game zombies get a behavior affix + colored tell. */
export const ELITE = {
  /** Round before which no affixes appear at all. */
  fromRound: 8,
  /** Base fraction of eligible spawns that get an affix at fromRound. */
  baseFraction: 0.06,
  /** Extra fraction per round past fromRound (clamped by maxFraction). */
  fractionPerRound: 0.015,
  maxFraction: 0.32,
  /** Hard cap on simultaneously-alive affixed zombies (perf + readability). */
  maxAlive: 10,
  /** Difficulty-coeff weight folded into the affix fraction. */
  coeffBoost: 0.12,
  // Per-affix tuning.
  blazingBurnDps: 10, // burn-trail DPS to the player standing in it
  glacialSlow: 0.45, // player slow fraction on hit
  glacialSlowDur: 1.6,
  glacialShatterRadius: 3.2, // freeze AoE on death
  overloadShield: 0.5, // fraction of an extra healthbar as shield
  overloadAoeRadius: 4.0,
  overloadAoeDamage: 30,
} as const;

/** Continuous difficulty director: a coefficient that climbs with round + time,
 *  surfaced as escalating zombie-themed tier names on the HUD banner. */
export const DIFFICULTY = {
  /** Coeff contribution per round. */
  perRound: 0.05,
  /** Coeff contribution per minute of run time. */
  perMinute: 0.08,
  /** Tiers (ascending). `at` is the coeff threshold the tier unlocks at. */
  tiers: [
    { at: 0.0, name: "RESTLESS", color: "#8fcf6f" },
    { at: 0.6, name: "HUNGRY", color: "#ffd24a" },
    { at: 1.1, name: "RAVENOUS", color: "#e8923a" },
    { at: 1.7, name: "FERAL", color: "#ff5d8f" },
    { at: 2.4, name: "APOCALYPSE", color: "#c0452f" },
  ] as { at: number; name: string; color: string }[],
};

/** Opt-in Curse multiplier (risk → reward). Raising it makes enemies faster /
 *  tankier / spawn quicker AND lifts score+loot by the same proportion. */
export const CURSE = {
  min: 1.0,
  max: 3.0,
  step: 0.25,
  /** How much of the curse delta feeds each stat (1 = full proportional). */
  hpScale: 1.0,
  speedScale: 0.5, // speed is touchier — half-weight so it stays playable
  spawnScale: 0.6, // faster spawns, but not punishingly so
  /** Reward multiplier = 1 + (curse-1) * rewardScale. */
  rewardScale: 1.0,
};

// ── JUICE & LOOT TUNING ──
// Feel/feedback constants for the audio + number-pop + pickup + chest/pity
// systems (audio.ts, feedback.ts, drops.ts, loot.ts). NON-CASHABLE: these only
// affect cosmetics/soft-currency feedback, never the gold↔token bridge.
export const JUICE = {
  // Tiered floating number-pops (feedback.ts).
  critColor: "#ffe14a", // crits: bright gold
  comboColor: "#ff8a3a", // combo-scaled hits: hot orange
  critScale: 1.6, // size multiplier for crits
  comboScale: 1.25, // size multiplier for combo (xN) hits
  popPunch: 1.7, // initial punch-out scale, eases to 1
  popPunchTime: 0.12, // seconds of punch-out ease
  popArc: 1.3, // horizontal drift speed (sideways arc)

  // Rarity-tiered pickup juice (drops.ts). Glow scale per rarity tier 0..4.
  glowByRarity: [1.9, 2.1, 2.4, 2.9, 3.4] as const,
  beamFromTier: 3, // epic+ (tier index ≥3) get a vertical light beam
  beamHeight: 5.5,
  beamWidth: 0.7,
  chimeBaseHz: 523, // C5 — pickup chime root, pitched up per rarity tier
} as const;

// Cascading multi-item treasure chest (drops.ts + loot.ts). Vampire-Survivors
// style quantity cascade, Luck-scaled. Probabilities are checked in order.
export const CHEST = {
  fiveChance: 0.03, // base p(5 items)
  threeChance: 0.1, // base p(3 items) if the 5-roll misses
  luckFiveBonus: 0.04, // +p(5) per luck point (clamped)
  luckThreeBonus: 0.06, // +p(3) per luck point (clamped)
  fanSpread: 1.6, // radius items fan out to
  fanLift: 4.0, // upward pop velocity of the fan
} as const;

// Pity / bad-luck protection (loot.ts). Raises the luck fed to rollRarity as a
// rare-less streak grows; resets on rare+. SOFT-CURRENCY/COSMETIC ONLY — never
// wire pity to anything cashable (see loot.ts token-bridge note).
export const PITY = {
  rareThreshold: 2, // rarity index ≥ this counts as "rare+" and resets pity
  perKillLuck: 0.06, // luck added per dry kill
  maxLuck: 2.5, // cap so pity can't trivialize legendaries
} as const;

// ── PET DEPTH ──
// Depth layer on top of the existing PETS_TUNING envelope: per-role combat
// "verbs", same-role/combo squad synergies, dupe→star ascension, and the
// shiny/collection cosmetic chase. EVERYTHING here is SMALL + capped and lives
// strictly inside the last balance pass's late-game ceiling (squad cap 5,
// buffCap 2.5, no one-shots). NON-CASHABLE: the collection reward pays soft
// essence only — never tokens, never the gold↔token bridge.
export const PET_DEPTH = {
  /** Per-combatRole behavior knobs (updatePets/firePetAbility). All tiny + flat
   *  so they read as a "verb", never a power spike. */
  roles: {
    tank: {
      orbitRange: 4, // +engage range (units) — soaks/draws fire a bit wider
      aggroPull: 1.0, // pets target zombies near the tank first (handled implicitly via range)
    },
    drainer: {
      healPerKill: 0.6, // HP restored to the player per kill this pet lands
      healCapPerRound: 120, // hard cap on drainer heal per round (anti-immortal)
    },
    bomber: {
      bonusSplashRadius: 0.8, // added to the bullet's splashRadius
      bonusSplashFrac: 0.35, // splash damage = bullet damage * this (if it had none)
    },
    sniper: {
      bonusRange: 4, // +engage range
      critRange: 14, // beyond this distance, the shot is flagged a crit
      critMul: 1.5, // crit damage multiplier on distant shots (modest)
    },
    harvester: {
      goldPerKill: 1, // flat bonus gold per kill this pet lands
      goldCapPerRound: 400, // cap on harvester bonus gold per round
    },
    saboteur: {
      slow: 0.25, // brief slow fraction applied to what it hits/kills near
      slowDur: 1.2, // seconds
    },
  },

  /** Squad synergies: when the ACTIVE squad has 2+ of a combatRole (or a defined
   *  combo) grant a small squad-wide bonus. The TOTAL synergy multiplier is
   *  hard-clamped by `synergyDamageCap` so stacking comps can't break the
   *  buffCap envelope. */
  synergy: {
    /** Per-pair (2+) same-role bonuses. */
    twoSnipers: { range: 3 }, // 2+ snipers → +range for all combat pets
    twoBombers: { splashFrac: 0.2 }, // 2+ bombers → +splash on all combat pets
    twoTanks: { damageMul: 0.08 }, // 2+ tanks → small squad damage (held line)
    twoDrainers: { lifesteal: 0.4 }, // 2+ drainers → extra heal/kill squad-wide
    twoHarvesters: { gold: 1 }, // 2+ harvesters → +gold/kill squad-wide
    twoSaboteurs: { slow: 0.1 }, // 2+ saboteurs → deeper slow
    /** Named combos (one of each). */
    tankDrainer: { lifesteal: 0.5 }, // tank + drainer → +lifesteal (front-line vamp)
    sniperSaboteur: { critMul: 0.15 }, // sniper + saboteur → +crit on slowed targets
    bomberHarvester: { gold: 1 }, // bomber + harvester → gold from splash kills
    /** Hard cap on the cumulative synergy DAMAGE multiplier (stays under buffCap). */
    synergyDamageCap: 1.25,
    /** Hard cap on cumulative synergy lifesteal (HP/kill) so it never trivializes. */
    synergyLifestealCap: 2.0,
  },

  /** Dupe → star ascension. Buying a pet you already own converts the purchase
   *  into a star (stored in petProgress[id]._stars). Stars unlock skill bumps,
   *  NOT raw stat creep — capped at `maxStars`. */
  stars: {
    maxStars: 5,
    /** Damage bonus per star (flat, small): +`dmgPerStar` each star, capped. */
    dmgPerStar: 0.04, // +4%/star → +20% at 5★ (well within envelope)
    /** Star thresholds that unlock an extra role kicker (see updatePets). */
    roleKickAt: 3, // 3★+ : the pet's role behavior gets a small bump
    eliteKickAt: 5, // 5★ : a second, capped kicker
    /** Cost to convert a dupe into a star = base pet cost * this. */
    convertCostMul: 1.0,
  },

  /** Shiny/chroma cosmetic chase + collection-completion reward. PURELY visual
   *  + soft-currency; never affects power or pays tokens. */
  cosmetic: {
    shinyOdds: 0.02, // 2% chance a freshly-bought pet rolls shiny (petProgress._shiny=1)
    /** Collection-completion milestones: own N distinct pets → soft essence. */
    milestones: [
      { own: 10, essence: 5 },
      { own: 20, essence: 12 },
      { own: 30, essence: 25 },
      { own: 40, essence: 50 },
      { own: 50, essence: 100 },
    ] as { own: number; essence: number }[],
  },
} as const;
