import * as THREE from "three";
import { VoxelChar } from "../voxelChar";
import { TD_PATH, pathLength, pointAt, headingAt, type Vec2 } from "./tdpath";

/**
 * Tower-Defense CREEP (enemy) manager.
 *
 * Creeps are voxel walkers that march along the fixed `TD_PATH` lane from the
 * spawn (off the west edge) to your base. Like the survival-mode `Zombie` and
 * the Bed Wars raiders they ride the shared `VoxelChar` rig (zombie:true for the
 * shambling, arms-forward silhouette + gait), but unlike free-roaming bots they
 * do NOT steer — each creep advances by a single scalar arc-length `dist` along
 * the lane (see tdpath.ts). `pointAt(dist)` gives its world position, and when
 * that report comes back `done` the creep has reached the base ("leaked").
 *
 * The integrator owns the scene, wave pacing, towers and the gold economy. This
 * module owns only the creeps. Towers read `enemies()` to pick targets and call
 * `damage()` / `applySlow()` / `damageNear()`; the kill bounty for every creep
 * killed surfaces EXACTLY ONCE through the next `update()` return value, so the
 * integrator can credit gold without double-counting.
 */

// ---- tuning (exposed as consts so the integrator can read the numbers) ----
/** XZ radius of a creep, used for splash / proximity hit tests. */
export const CREEP_RADIUS = 0.8;
/** Base body / head tint of a plain creep (a sickly green). */
export const BASE_BODY = 0x4caf50;
export const BASE_HEAD = 0x2e7d32;
/** Per-kind tints + scale. Unknown kinds fall back to the base green at 1x. */
export const KIND_TINTS: Record<string, { body: number; head: number; scale: number }> = {
  // fast: pale, smaller, twitchy runner
  fast: { body: 0xb2ff59, head: 0x76ff03, scale: 0.8 },
  // tank: bruised purple, chunky
  tank: { body: 0x7e57c2, head: 0x4527a0, scale: 1.35 },
  // boss: angry red, looming
  boss: { body: 0xd32f2f, head: 0x7f0000, scale: 1.9 },
};
/** Eye tint shared by all creeps. */
export const CREEP_EYE = 0x111111;
/** Duration (seconds) of the red hit-flash pulse on damage. */
export const FLASH_TIME = 0.12;

/** Pre-computed full arc length of the lane (constant for the fixed TD_PATH).
 *  Exposed so the integrator can size wave timing / progress bars off it. */
export const PATH_LEN = pathLength(TD_PATH);

/** What the integrator hands `spawn()` to define one creep. */
export interface TdSpawnSpec {
  hp: number; // starting / max HP
  speed: number; // arc-length units travelled per second (before slow)
  bounty: number; // gold awarded to the integrator when this creep is killed
  kind?: string; // visual variant: "fast" | "tank" | "boss" | (default)
}

/** A live-creep snapshot row for tower targeting (see `enemies()`). */
export interface TdEnemyView {
  id: number;
  pos: THREE.Vector3; // live position vector (the creep's own, not a copy)
  hp: number;
  maxHp: number; // for health-bar rendering / overkill checks
  dist: number; // arc-length travelled — target the largest to defend the base
  alive: boolean;
}

/** One live creep: its rig, lane progress, HP and transient timers. */
interface Creep {
  id: number;
  char: VoxelChar;
  pos: THREE.Vector3; // live world position (kept in sync with char.root)
  dist: number; // arc-length travelled along TD_PATH
  hp: number;
  maxHp: number;
  speed: number;
  bounty: number;
  flash: number; // remaining hit-flash time
  slowFactor: number; // active speed multiplier (1 = none)
  slowTime: number; // seconds remaining on the active slow
}

/**
 * Manager for every creep currently on the lane. Add `.group` to the scene,
 * `spawn()` per wave, `update(dt)` each frame (reading its return for leaks +
 * kill bounties), and route tower hits through `damage` / `damageNear` /
 * `applySlow`. Everything is removed + disposed on `clear()` (mode leave).
 */
export class TdEnemies {
  readonly group = new THREE.Group();
  private creeps: Creep[] = [];
  private nextId = 1;
  /** Bounties of creeps killed since the last `update()` drain — surfaced once. */
  private pendingBounties: number[] = [];

  constructor(scene: THREE.Scene) {
    scene.add(this.group);
  }

  /** Total number of creeps tracked (all are live; dead ones are removed). */
  get count(): number {
    return this.creeps.length;
  }

  /** Number of live creeps (hp > 0). Dead creeps are disposed immediately, so
   *  this currently equals `count`; kept distinct for caller intent + clarity. */
  get aliveCount(): number {
    let n = 0;
    for (const c of this.creeps) if (c.hp > 0) n++;
    return n;
  }

  /**
   * Spawn one creep at the lane start (`pointAt(0)`) with `dist = 0` and full
   * HP. The body/head are tinted (and the rig scaled) per `spec.kind`: a sickly
   * green by default, with distinct looks for "fast" / "tank" / "boss".
   */
  spawn(spec: TdSpawnSpec): void {
    const tint = (spec.kind && KIND_TINTS[spec.kind]) || { body: BASE_BODY, head: BASE_HEAD, scale: 1 };
    // zombie:true gives the shambling, arms-forward creep silhouette + gait.
    const char = new VoxelChar({ body: tint.body, head: tint.head, eye: CREEP_EYE, zombie: true });
    char.setColor(tint.body, tint.head); // also tints legs to match the body
    char.root.scale.setScalar(tint.scale);
    char.play("walk");

    const start = pointAt(0, TD_PATH);
    const pos = new THREE.Vector3(start.x, 0, start.z);
    char.root.position.copy(pos);
    this.group.add(char.root);

    this.creeps.push({
      id: this.nextId++,
      char,
      pos,
      dist: 0,
      hp: spec.hp,
      maxHp: spec.hp,
      speed: spec.speed,
      bounty: spec.bounty,
      flash: 0,
      slowFactor: 1,
      slowTime: 0,
    });
  }

  /**
   * Advance every creep along the lane by `speed * slow * dt`, position + face
   * it, tick its anim + timers, and reap creeps that reached the base.
   *
   * Returns `{ leaked, bounties }`:
   *  - `leaked` — how many creeps walked into the base this frame (they are
   *    removed + disposed; the integrator should subtract base lives).
   *  - `bounties` — the bounty value of every creep KILLED since the previous
   *    `update()` (by `damage`/`damageNear`), drained here so each kill is
   *    credited EXACTLY once. Leaked creeps pay no bounty.
   */
  update(dt: number): { leaked: number; bounties: number[] } {
    let leaked = 0;
    // iterate back-to-front so splice-on-leak doesn't skip the next creep
    for (let i = this.creeps.length - 1; i >= 0; i--) {
      const c = this.creeps[i];

      // expire the active slow, then advance by the (possibly slowed) speed
      if (c.slowTime > 0) {
        c.slowTime -= dt;
        if (c.slowTime <= 0) c.slowFactor = 1;
      }
      c.dist += c.speed * c.slowFactor * dt;

      const p = pointAt(c.dist, TD_PATH);
      if (p.done) {
        // reached the base — leaked. Remove + dispose; no bounty.
        this.disposeCreep(c);
        this.creeps.splice(i, 1);
        leaked++;
        continue;
      }

      c.pos.set(p.x, 0, p.z);
      c.char.root.position.copy(c.pos);

      // face the lane heading (atan2(dx,dz) matches the rig's forward +Z)
      const h = headingAt(c.dist, TD_PATH);
      c.char.root.rotation.y = Math.atan2(h.dx, h.dz);
      c.char.play("walk");

      // decay the hit flash (red emissive pulse on tower impact)
      if (c.flash > 0) {
        c.flash -= dt;
        c.char.setHitFlash(Math.max(0, c.flash / FLASH_TIME));
      }

      c.char.update(dt);
    }

    // drain the pending kill bounties so each surfaces exactly once
    let bounties: number[];
    if (this.pendingBounties.length > 0) {
      bounties = this.pendingBounties;
      this.pendingBounties = [];
    } else {
      bounties = [];
    }
    return { leaked, bounties };
  }

  /**
   * Snapshot of live creeps for tower targeting. `pos` is each creep's LIVE
   * position vector (not a copy) and `dist` is its arc-length, so a tower can
   * target whichever creep is furthest along (largest `dist`) to best defend
   * the base. The returned array is fresh each call; the rows are lightweight.
   */
  enemies(): TdEnemyView[] {
    const out: TdEnemyView[] = [];
    for (const c of this.creeps) {
      out.push({ id: c.id, pos: c.pos, hp: c.hp, maxHp: c.maxHp, dist: c.dist, alive: c.hp > 0 });
    }
    return out;
  }

  /**
   * Apply `dmg` to the creep with `id` (e.g. a single-target tower shot) and
   * flash it. If this drops its HP to <= 0 the creep is removed + disposed and
   * its bounty is queued for the next `update()` return. Returns true iff this
   * hit was the killing blow; false if the creep survived or `id` is unknown.
   */
  damage(id: number, dmg: number): boolean {
    const idx = this.indexOf(id);
    if (idx < 0) return false;
    const c = this.creeps[idx];
    c.hp -= dmg;
    c.flash = FLASH_TIME;
    c.char.setHitFlash(1);
    if (c.hp <= 0) {
      this.kill(idx);
      return true;
    }
    return false;
  }

  /**
   * Splash damage (e.g. a cannon tower): damage every live creep within
   * `radius` (XZ) of `pos`. Killed creeps are removed + disposed and their
   * bounties queued for the next `update()`. Returns the number KILLED.
   */
  damageNear(pos: THREE.Vector3, radius: number, dmg: number): number {
    const r2 = radius * radius;
    let kills = 0;
    // back-to-front so kill-splice doesn't skip the next creep
    for (let i = this.creeps.length - 1; i >= 0; i--) {
      const c = this.creeps[i];
      const dx = c.pos.x - pos.x;
      const dz = c.pos.z - pos.z;
      if (dx * dx + dz * dz > r2) continue;
      c.hp -= dmg;
      c.flash = FLASH_TIME;
      c.char.setHitFlash(1);
      if (c.hp <= 0) {
        this.kill(i);
        kills++;
      }
    }
    return kills;
  }

  /**
   * Apply a slow to the creep with `id` for `seconds`: while active, the creep
   * advances at `factor` of its normal speed (e.g. 0.5 for a frost tower).
   * Slows do not stack additively — the STRONGEST (smallest factor) active slow
   * wins, and its remaining duration is refreshed to at least `seconds`.
   */
  applySlow(id: number, factor: number, seconds: number): void {
    const idx = this.indexOf(id);
    if (idx < 0) return;
    const c = this.creeps[idx];
    // take the strongest active slow; if a slow is already running, keep the
    // stronger factor and extend the timer to the longer of the two.
    if (c.slowTime > 0) {
      c.slowFactor = Math.min(c.slowFactor, factor);
      c.slowTime = Math.max(c.slowTime, seconds);
    } else {
      c.slowFactor = factor;
      c.slowTime = seconds;
    }
  }

  /** Remove + dispose every creep and reset ids + pending bounties (mode leave). */
  clear(): void {
    for (const c of this.creeps) this.disposeCreep(c);
    this.creeps.length = 0;
    this.pendingBounties.length = 0;
    this.nextId = 1;
  }

  /** Index of the creep with `id`, or -1. */
  private indexOf(id: number): number {
    for (let i = 0; i < this.creeps.length; i++) {
      if (this.creeps[i].id === id) return i;
    }
    return -1;
  }

  /** Reap the creep at `idx`: queue its bounty, dispose, drop from the list. */
  private kill(idx: number): void {
    const c = this.creeps[idx];
    this.pendingBounties.push(c.bounty);
    this.disposeCreep(c);
    this.creeps.splice(idx, 1);
  }

  /** Detach a creep's rig and free its GPU resources (VoxelChar has no dispose). */
  private disposeCreep(c: Creep): void {
    this.group.remove(c.char.root);
    c.char.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat?.dispose?.();
    });
  }
}

// `Vec2` is imported to anchor the path types to tdpath's contract.
export type { Vec2 };
