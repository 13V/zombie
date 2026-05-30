import * as THREE from "three";
import { ROUNDS, ZOMBIE, ZOMBIE_TYPES, ZombieType } from "./config";
import { Zombie } from "./zombie";
import { Arena } from "./arena";
import { AssetManager } from "./assets";
import { SpatialGrid } from "./grid";

type Phase = "pre" | "active" | "intermission";

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

  private bossPending = false;

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

  /** Kick off round 1. */
  start() {
    this.beginRound(1);
  }

  private beginRound(n: number) {
    this.round = n;
    this.toSpawn = ROUNDS.baseCount + (n - 1) * ROUNDS.countPerRound;
    this.curHealth = ZOMBIE.baseHealth + (n - 1) * ZOMBIE.healthPerRound + ZOMBIE.healthPerRoundSq * (n - 1) * (n - 1);
    this.curSpeed = Math.min(ZOMBIE.speedCap, ZOMBIE.baseSpeed + (n - 1) * ZOMBIE.speedPerRound);
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
  private pickType(): ZombieType {
    let r = Math.random();
    // iterate strongest → weakest so the deadliest eligible tier absorbs the
    // tail once later-round weights sum past 1.
    for (let i = ZOMBIE_TYPES.length - 1; i >= 1; i--) {
      const t = ZOMBIE_TYPES[i];
      if (this.round < t.from) continue;
      if (r < t.weight) return t;
      r -= t.weight;
    }
    return ZOMBIE_TYPES[0];
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
    z.spawn(this.edge, this.curHealth, this.curSpeed, this.pickType());
    this.toSpawn--;
  }

  update(dt: number, arena: Arena, playerPositions: THREE.Vector3[]) {
    // Rebuild the spatial grid once per frame; zombies + combat systems query it.
    this.grid.rebuild(this.zombies);
    if (this.phase === "active") {
      // boss rounds: drop the boss in first, then the supporting horde
      if (this.bossPending) this.spawnBoss(arena);
      if (this.toSpawn > 0) {
        this.spawnTimer -= dt;
        if (this.spawnTimer <= 0 && this.aliveCount < ROUNDS.maxAlive) {
          this.spawnOne(arena);
          this.spawnTimer = ROUNDS.spawnInterval;
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
  }
}
