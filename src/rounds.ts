import * as THREE from "three";
import { ELITE, ROUNDS, SPECIAL_ROUNDS, ZOMBIE, ZOMBIE_TYPES, ZombieType } from "./config";
import { Affix, Zombie } from "./zombie";
import { Arena } from "./arena";
import { AssetManager } from "./assets";
import { SpatialGrid } from "./grid";

type Phase = "pre" | "active" | "intermission";

/**
 * A "special" round flavoring. `id` is stable for logic, `name` drives the loud
 * HUD banner, `tint` (CSS color) recolors the screen/fog while it's live, and
 * `restrictTo`/`biasTo` reshape the roster (see pickType). `guaranteedDrop`
 * tells the integrator to grant a good drop on clear (drops are another agent's
 * domain — we only raise the flag).
 */
export interface SpecialRound {
  id: string;
  name: string;
  tint?: string;
  /** Only spawn these type ids (the whole roster for this round). */
  restrictTo?: string[];
  /** Heavily favor these type ids in the weighted pick (but still allow others). */
  biasTo?: string[];
  /** Signal to main.ts: drop something good when the round clears. */
  guaranteedDrop?: boolean;
}

/**
 * Owns the zombie pool and drives the round loop: spawn a budget of zombies,
 * wait until they're cleared, take a breather, then escalate.
 */
export class RoundManager {
  readonly zombies: Zombie[] = [];
  /** Per-frame spatial index of alive zombies (rebuilt in update). */
  readonly grid = new SpatialGrid();
  round = 0;
  phase: Phase = "pre";

  private toSpawn = 0;
  private curHealth = ZOMBIE.baseHealth;
  private curSpeed = ZOMBIE.baseSpeed;
  private spawnTimer = 0;
  private intermissionTimer = 0;
  private edge = new THREE.Vector3();
  // round-scaled difficulty state (computed in beginRound)
  private curMaxAlive = ROUNDS.maxAliveBase;
  private curSpawnInterval = ROUNDS.spawnIntervalBase;
  private isSwarm = false;
  /** Lowered on mobile to protect the frame budget (set from main.ts). */
  maxAliveCeiling = ROUNDS.maxAliveCap;

  private bossPending = false;

  /** The active round's special flavoring (null on a plain round). */
  private special: SpecialRound | null = null;

  /** Continuous difficulty director coefficient (see item 4: rises with round +
   *  run time). Used to bias affix frequency. Placeholder until updated in
   *  update(); a round-only floor keeps it sane before time accrues. */
  difficultyCoeff = 0;

  onRoundStart?: (round: number) => void;
  onIntermission?: (nextRound: number) => void;
  onBossSpawn?: (boss: Zombie) => void;

  constructor(private scene: THREE.Scene, private assets: AssetManager) {}

  get aliveCount(): number {
    let n = 0;
    for (const z of this.zombies) if (z.alive) n++;
    return n;
  }

  /** The living round boss, if one is on the field. */
  get boss(): Zombie | undefined {
    return this.zombies.find((z) => z.alive && z.isBoss);
  }

  /** Every 5th round is a boss round. */
  get isBossRound(): boolean {
    return this.round > 0 && this.round % 5 === 0;
  }

  /** This round is a fast "swarm/dog" round. */
  get isSwarmRound(): boolean {
    return this.isSwarm;
  }

  /**
   * The active special round's surfaced descriptor (id/name/tint), or null on a
   * plain round. main.ts shows the banner + screen tint off this and reads
   * `guaranteedDrop` to gate the hound-round reward.
   */
  get specialRound(): SpecialRound | null {
    return this.special;
  }

  /**
   * Classify a round number into its special flavoring (or null). Pure so it can
   * be unit-tested and previewed. Boss rounds (every 5th) take precedence as
   * Hound Rounds; showcases rotate on their own offset cadence and skip any
   * round that's already a boss/hound round.
   */
  static classifySpecial(n: number): SpecialRound | null {
    if (n <= 0) return null;
    const sp = SPECIAL_ROUNDS;
    // Hound Round: fastest existing type only, themed tint, guaranteed drop.
    if (n % sp.houndEvery === 0) {
      const fastest = RoundManager.fastestTypeId();
      return {
        id: "hound",
        name: "HOUND ROUND",
        tint: sp.houndTint,
        restrictTo: [fastest],
        guaranteedDrop: true,
      };
    }
    // Showcase rounds: rotate Sky Terror / Summoner Siege / Splitter Swarm.
    if ((n + sp.showcaseOffset) % sp.showcaseEvery === 0) {
      const idx = Math.floor((n + sp.showcaseOffset) / sp.showcaseEvery) % sp.showcases.length;
      const sc = sp.showcases[idx];
      const ids = RoundManager.typeIdsForRoles(sc.roles, n);
      if (ids.length === 0) return null; // nothing eligible yet — stay plain
      return { id: sc.id, name: sc.name, tint: sc.tint, biasTo: ids };
    }
    return null;
  }

  /** Id of the single fastest non-boss roster type (Hound Round roster). */
  private static fastestTypeId(): string {
    let best = ZOMBIE_TYPES[0];
    for (const t of ZOMBIE_TYPES) {
      if (t.from >= 999) continue; // skip non-spawnable internal types (splitling)
      if (t.speedMul > best.speedMul) best = t;
    }
    return best.id;
  }

  /** Type ids matching a showcase's roles that are eligible by round `n`. */
  private static typeIdsForRoles(roles: ("flying" | "summon" | "split")[], n: number): string[] {
    return ZOMBIE_TYPES.filter((t) => {
      if (t.from > n) return false;
      for (const r of roles) {
        if (r === "flying" && t.flying) return true;
        if (r === "summon" && (t.summonInterval ?? 0) > 0) return true;
        if (r === "split" && t.splitInto) return true;
      }
      return false;
    }).map((t) => t.id);
  }

  /** Kick off round 1. */
  start() {
    this.beginRound(1);
  }

  private beginRound(n: number) {
    this.round = n;
    // Tag this round's special flavoring (null on a plain round). Surfaced to
    // main.ts via `specialRound` for the banner + screen tint + drop flag.
    this.special = RoundManager.classifySpecial(n);
    const inflect = ZOMBIE.hpInflection;
    const past = Math.max(0, n - inflect); // rounds past the inflection point

    // HP: additive through the inflection, then compounds ×hpGrowth/round.
    const linHP = ZOMBIE.baseHealth + (n - 1) * ZOMBIE.healthPerRound;
    if (n <= inflect) {
      this.curHealth = linHP;
    } else {
      const baseHP = ZOMBIE.baseHealth + (inflect - 1) * ZOMBIE.healthPerRound;
      this.curHealth = baseHP * Math.pow(ZOMBIE.hpGrowth, past);
    }
    this.curSpeed = Math.min(ZOMBIE.speedCap, ZOMBIE.baseSpeed + (n - 1) * ZOMBIE.speedPerRound);

    // Round-scaled ceilings: cap rises + spawns speed up past the inflection.
    this.curMaxAlive = Math.min(this.maxAliveCeiling, ROUNDS.maxAliveBase + past * ROUNDS.maxAlivePerRound);
    this.curSpawnInterval = Math.max(ROUNDS.spawnIntervalMin, ROUNDS.spawnIntervalBase - past * ROUNDS.spawnIntervalDecay);

    // Swarm/dog round: short burst of fast/weak enemies from all sides.
    this.isSwarm = n >= ROUNDS.swarmEvery && n % ROUNDS.swarmEvery === 0 && n % 5 !== 0;
    let count = ROUNDS.baseCount + (n - 1) * ROUNDS.countPerRound;
    if (this.isSwarm) {
      count = Math.round(count * 0.7);
      this.curMaxAlive = Math.min(this.maxAliveCeiling + 8, Math.round(this.curMaxAlive * 1.4));
      this.curSpawnInterval *= 0.5; // twice as fast
    }
    this.toSpawn = count;

    this.spawnTimer = 0;
    this.phase = "active";
    this.bossPending = n % 5 === 0;
    this.onRoundStart?.(n);
  }

  private spawnBoss(arena: Arena) {
    let z = this.zombies.find((q) => !q.alive && !q.dying) ?? this.zombies.find((q) => !q.alive);
    if (!z) {
      z = new Zombie(this.assets);
      this.scene.add(z.group);
      this.zombies.push(z);
    }
    arena.randomEdgePoint(this.edge);
    // spawn as the toughest eligible type, then crank it into a boss
    z.spawn(this.edge, this.curHealth, this.curSpeed * 0.7, ZOMBIE_TYPES[ZOMBIE_TYPES.length - 1]);
    z.promoteToBoss(this.curHealth * (6 + this.round), 2.6);
    this.bossPending = false;
    this.onBossSpawn?.(z);
  }

  /**
   * Pick a zombie type eligible at the current round. Tougher tiers unlock
   * later and consume their weight slice; the basic Shambler (index 0) fills
   * whatever probability is left.
   */
  // tanky "elite" tiers that the elite-weight ramp boosts in the 10->20 band
  private static ELITE_IDS = new Set(["brute", "armored", "abomination", "splitter", "necro"]);

  /**
   * Pick a zombie type via PROPER weighted sampling over eligible types, so the
   * mix stays sane no matter how many types have unlocked. The basic Shambler
   * keeps a guaranteed share (so mid-rounds arent a pure wall of specials), and
   * elites get a small ramp from R10.
   */
  private pickType(): ZombieType {
    // Themed showcase rounds bias the pick hard toward the theme's type ids
    // (still allowing a thin spread of others so the horde reads as a horde).
    const bias = this.special?.biasTo;
    const eliteBonus = Math.max(0, Math.min(0.35, (this.round - 9) * 0.03));
    // Shambler always keeps a baseline slice that shrinks as rounds climb but
    // never vanishes, so basics are always part of the horde. On a biased round
    // the shambler share is cut right down so the theme dominates.
    const shamblerWeight = bias ? 0.06 : Math.max(0.25, 0.9 - (this.round - 1) * 0.04);
    let total = shamblerWeight;
    for (let i = 1; i < ZOMBIE_TYPES.length; i++) {
      const t = ZOMBIE_TYPES[i];
      if (this.round < t.from) continue;
      total += this.typeWeight(t, eliteBonus, bias);
    }
    let r = Math.random() * total;
    if ((r -= shamblerWeight) < 0) return ZOMBIE_TYPES[0];
    for (let i = 1; i < ZOMBIE_TYPES.length; i++) {
      const t = ZOMBIE_TYPES[i];
      if (this.round < t.from) continue;
      const w = this.typeWeight(t, eliteBonus, bias);
      if ((r -= w) < 0) return t;
    }
    return ZOMBIE_TYPES[0];
  }

  /** Sampling weight for a type, folding in the elite ramp + any showcase bias. */
  private typeWeight(t: ZombieType, eliteBonus: number, bias: string[] | undefined): number {
    let w = t.weight * (RoundManager.ELITE_IDS.has(t.id) ? 1 + eliteBonus : 1);
    if (bias) w *= bias.includes(t.id) ? 8 : 0.15; // heavy thumb on the scale
    return w;
  }

  private spawnOne(arena: Arena) {
    // Prefer a fully-idle zombie; avoid snatching one mid death-animation.
    let z = this.zombies.find((q) => !q.alive && !q.dying) ?? this.zombies.find((q) => !q.alive);
    if (!z) {
      z = new Zombie(this.assets);
      this.scene.add(z.group);
      this.zombies.push(z);
    }
    arena.randomEdgePoint(this.edge);
    const restrict = this.special?.restrictTo;
    if (restrict && restrict.length) {
      // Hound Round: roster locked to the fastest type — lean HP, extra pace, so
      // it reads as a relentless pack rather than a damage wall.
      const id = restrict[(Math.random() * restrict.length) | 0];
      const t = ZOMBIE_TYPES.find((q) => q.id === id) ?? ZOMBIE_TYPES[0];
      z.spawn(this.edge, this.curHealth * 0.55, this.curSpeed * 1.25, t);
    } else if (this.isSwarm) {
      // swarm round: weak + fast, from anywhere (full surround)
      z.spawn(this.edge, this.curHealth * 0.5, this.curSpeed * 1.35, ZOMBIE_TYPES[0]);
    } else {
      z.spawn(this.edge, this.curHealth, this.curSpeed, this.pickType());
    }
    this.maybeAffix(z);
    this.toSpawn--;
  }

  /** Count of currently-alive affixed zombies (cap + HUD use). */
  get affixedAlive(): number {
    let n = 0;
    for (const z of this.zombies) if (z.alive && z.affix) n++;
    return n;
  }

  /** Roll an elite affix onto a freshly-spawned zombie, respecting the cap +
   *  round/difficulty-scaled fraction. Bosses + flying swarmers are skipped. */
  private maybeAffix(z: Zombie) {
    if (this.round < ELITE.fromRound || z.isBoss) return;
    if (this.affixedAlive >= ELITE.maxAlive) return;
    const frac = Math.min(
      ELITE.maxFraction,
      ELITE.baseFraction + (this.round - ELITE.fromRound) * ELITE.fractionPerRound + this.difficultyCoeff * ELITE.coeffBoost,
    );
    if (Math.random() >= frac) return;
    const roll = Math.random();
    const affix: Affix = roll < 0.34 ? "blazing" : roll < 0.67 ? "glacial" : "overloading";
    z.applyAffix(affix);
  }

  /** Grab an idle pooled zombie (or grow the pool). */
  private freeZombie(): Zombie {
    let z = this.zombies.find((q) => !q.alive && !q.dying) ?? this.zombies.find((q) => !q.alive);
    if (!z) {
      z = new Zombie(this.assets);
      this.scene.add(z.group);
      this.zombies.push(z);
    }
    return z;
  }

  /** Necromancer summon: raise a few fast crawlers near the summoner. */
  private summonAdds(from: Zombie, count: number) {
    if (this.aliveCount >= this.curMaxAlive + 6) return; // respect the cap (+small slack)
    const crawler = ZOMBIE_TYPES.find((t) => t.id === "crawler") ?? ZOMBIE_TYPES[0];
    for (let i = 0; i < count; i++) {
      const z = this.freeZombie();
      this.edge.set(from.pos.x + (Math.random() - 0.5) * 3, 0, from.pos.z + (Math.random() - 0.5) * 3);
      z.spawn(this.edge, this.curHealth * 0.6, this.curSpeed * 1.1, crawler);
    }
  }

  /** Splitter death: spawn its smaller copies at the corpse. Called by main. */
  splitOn(z: Zombie) {
    if (!z.splitInto || z.splitCount <= 0) return;
    if (this.aliveCount >= this.curMaxAlive + 6) return;
    const t = ZOMBIE_TYPES.find((q) => q.id === z.splitInto);
    if (!t) return;
    for (let i = 0; i < z.splitCount; i++) {
      const c = this.freeZombie();
      this.edge.set(z.pos.x + (Math.random() - 0.5) * 1.6, 0, z.pos.z + (Math.random() - 0.5) * 1.6);
      c.spawn(this.edge, this.curHealth, this.curSpeed, t);
    }
  }

  update(dt: number, arena: Arena, playerPositions: THREE.Vector3[]) {
    // Rebuild the spatial grid once per frame; zombies + combat systems query it.
    this.grid.rebuild(this.zombies);
    if (this.phase === "active") {
      // boss rounds: drop the boss in first, then the supporting horde
      if (this.bossPending) this.spawnBoss(arena);
      if (this.toSpawn > 0) {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0 && this.aliveCount < this.curMaxAlive) {
          this.spawnOne(arena);
          this.spawnTimer = this.curSpawnInterval;
        }
      } else if (this.aliveCount === 0) {
        this.phase = "intermission";
        this.intermissionTimer = ROUNDS.intermission;
        this.onIntermission?.(this.round + 1);
      }
    } else if (this.phase === "intermission") {
      this.intermissionTimer -= dt;
      if (this.intermissionTimer <= 0) this.beginRound(this.round + 1);
    }

    // move + animate the living horde; advance death animations for corpses
    for (const z of this.zombies) {
      if (z.alive) {
        const target = this.nearestPlayer(z.pos, playerPositions);
        if (target) {
          z.update(dt, target, this.grid);
          arena.resolveObstacles(z.pos, ZOMBIE.radius);
          z.group.position.x = z.pos.x;
          z.group.position.z = z.pos.z;
          if (z.wantsSummon) {
            z.wantsSummon = false;
            this.summonAdds(z, z.summonCount);
          }
        }
      } else if (z.dying) {
        z.updateDying(dt);
      }
    }
  }

  private nearestPlayer(pos: THREE.Vector3, players: THREE.Vector3[]): THREE.Vector3 | null {
    let best: THREE.Vector3 | null = null;
    let bestD = Infinity;
    for (const p of players) {
      const dx = p.x - pos.x;
      const dz = p.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) {
        bestD = d;
        best = p;
      }
    }
    return best;
  }

  reset() {
    for (const z of this.zombies) {
      z.alive = false;
      z.dying = false;
      z.group.visible = false;
    }
    this.round = 0;
    this.phase = "pre";
    this.toSpawn = 0;
    this.special = null;
  }
}
