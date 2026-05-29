import * as THREE from "three";
import { ROUNDS, ZOMBIE } from "./config";
import { Zombie } from "./zombie";
import { Arena } from "./arena";
import { AssetManager } from "./assets";

type Phase = "pre" | "active" | "intermission";

/**
 * Owns the zombie pool and drives the round loop: spawn a budget of zombies,
 * wait until they're cleared, take a breather, then escalate.
 */
export class RoundManager {
  readonly zombies: Zombie[] = [];
  round = 0;
  phase: Phase = "pre";

  private toSpawn = 0;
  private curHealth = ZOMBIE.baseHealth;
  private curSpeed = ZOMBIE.baseSpeed;
  private spawnTimer = 0;
  private intermissionTimer = 0;
  private edge = new THREE.Vector3();

  onRoundStart?: (round: number) => void;
  onIntermission?: (nextRound: number) => void;

  constructor(private scene: THREE.Scene, private assets: AssetManager) {}

  get aliveCount(): number {
    let n = 0;
    for (const z of this.zombies) if (z.alive) n++;
    return n;
  }

  /** Kick off round 1. */
  start() {
    this.beginRound(1);
  }

  private beginRound(n: number) {
    this.round = n;
    this.toSpawn = ROUNDS.baseCount + (n - 1) * ROUNDS.countPerRound;
    this.curHealth = ZOMBIE.baseHealth + (n - 1) * ZOMBIE.healthPerRound;
    this.curSpeed = Math.min(ZOMBIE.speedCap, ZOMBIE.baseSpeed + (n - 1) * ZOMBIE.speedPerRound);
    this.spawnTimer = 0;
    this.phase = "active";
    this.onRoundStart?.(n);
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
    z.spawn(this.edge, this.curHealth, this.curSpeed);
    this.toSpawn--;
  }

  update(dt: number, arena: Arena, playerPos: THREE.Vector3) {
    if (this.phase === "active") {
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
      if (z.alive) z.update(dt, playerPos, this.zombies);
      else if (z.dying) z.updateDying(dt);
    }
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
