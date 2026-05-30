import * as THREE from "three";
import { ZOMBIE, ZOMBIE_TYPES, ZombieType } from "./config";
import { AssetManager, CharacterRig } from "./assets";
import { VoxelChar } from "./voxelChar";
import type { SpatialGrid } from "./grid";

const _tmp = new THREE.Vector3();
let _nextId = 1;

/**
 * A cute-menacing undead, driven by a CharacterRig (voxel blocky by default, or
 * a KayKit GLB if present). Steers toward the player, keeps separation from
 * neighbours, hits on contact, and plays a death animation as a brief corpse
 * before being recycled.
 */
export class Zombie {
  /** Stable id for the frame's hit bookkeeping (piercing bullets). */
  readonly id = _nextId++;
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();

  typeName = "Shambler";
  /** Index into ZOMBIE_TYPES, sent in network snapshots. */
  typeIndex = 0;
  health = ZOMBIE.baseHealth;
  maxHealth = ZOMBIE.baseHealth;
  speed = ZOMBIE.baseSpeed;
  /** Round boss: huge HP, shown with a dedicated HUD health bar. */
  isBoss = false;
  alive = false;
  /** Visually dying (playing a death anim) but no longer a gameplay threat. */
  dying = false;
  private deathTimer = 0;
  touchCooldown = 0;
  /** Decaying knockback velocity + hit-flash timer for game feel. */
  private knock = new THREE.Vector3();
  private flash = 0;
  private slowTimer = 0;
  private slowAmt = 0;
  // ragdoll fling on death: vertical velocity + tumble spin
  private flingY = 0;
  private flingSpin = 0;
  // ---- flying mob state ----
  flying = false;
  private flyHeight = 3;
  private airMode: "dive" | "ranged" | "swarm" = "swarm";
  private diveTimer = 0;
  private diving = false;
  private rangedTimer = 0;
  private wobble = 0;
  /** Set true on a frame a ranged flier wants to fire; main reads + clears it. */
  wantsRangedShot = false;

  // per-spawn variant state
  touchDamage = ZOMBIE.touchDamage;
  scoreMul = 1;
  puffColor = 0x8fcf6f;
  explodes = false;
  blastRadius = 0;
  blastDamage = 0;

  private char: CharacterRig;

  constructor(assets: AssetManager) {
    this.char =
      assets.createCharacter("zombie") ??
      new VoxelChar({ body: 0x8fcf6f, head: 0x5f9d4a, eye: 0x141414, zombie: true });
    this.group.add(this.char.root);
    this.group.visible = false;
  }

  spawn(at: THREE.Vector3, baseHealth: number, baseSpeed: number, type: ZombieType) {
    this.pos.copy(at);
    this.pos.y = 0;
    this.alive = true;
    this.dying = false;
    this.deathTimer = 0;
    this.touchCooldown = 0;
    this.knock.set(0, 0, 0);
    this.slowTimer = 0;
    this.slowAmt = 0;
    this.flingY = 0;
    this.flingSpin = 0;
    this.group.position.y = 0;
    this.group.rotation.z = 0;

    this.typeName = type.name;
    this.typeIndex = Math.max(0, ZOMBIE_TYPES.indexOf(type));
    this.isBoss = false;
    this.health = baseHealth * type.healthMul;
    this.maxHealth = this.health;
    this.speed = baseSpeed * type.speedMul;
    this.touchDamage = type.touchDamage;
    this.scoreMul = type.scoreMul;
    this.puffColor = type.body;
    this.explodes = type.blastRadius !== undefined;
    this.blastRadius = type.blastRadius ?? 0;
    this.blastDamage = type.blastDamage ?? 0;
    // flying state
    this.flying = !!type.flying;
    this.flyHeight = type.flyHeight ?? 3;
    this.airMode = type.airMode ?? "swarm";
    this.diveTimer = 1.5 + Math.random() * 2; // first dive after a beat
    this.diving = false;
    this.rangedTimer = 1 + Math.random() * 1.5;
    this.wobble = Math.random() * Math.PI * 2;
    this.group.scale.setScalar(type.scale);
    if (this.char instanceof VoxelChar) {
      this.char.setColor(type.body, type.head, this.explodes ? type.body : 0x000000);
    }

    this.group.rotation.set(0, 0, 0);
    this.char.play("walk");
    this.group.position.copy(this.pos);
    this.group.visible = true;
  }

  /** Turn a freshly-spawned zombie into a round boss: massive HP + size. */
  promoteToBoss(health: number, scale: number) {
    this.isBoss = true;
    this.typeName = "BOSS";
    this.health = health;
    this.maxHealth = health;
    this.scoreMul *= 4;
    this.touchDamage *= 1.5;
    this.group.scale.setScalar(scale);
  }

  /** Returns true if it just died from this hit. */
  hit(damage: number): boolean {
    if (!this.alive) return false;
    this.health -= damage;
    this.flash = 0.12; // brief white hit-flash
    if (this.health <= 0) {
      this.alive = false;
      this.dying = true;
      this.deathTimer = 1.4;
      this.char.play("death", { once: true });
      return true;
    }
    return false;
  }

  /** Shove the zombie away from a point — visual "bullet force". */
  knockback(fromX: number, fromZ: number, force: number) {
    const dx = this.pos.x - fromX;
    const dz = this.pos.z - fromZ;
    const d = Math.hypot(dx, dz) || 1;
    this.knock.x += (dx / d) * force;
    this.knock.z += (dz / d) * force;
  }

  /** Launch the corpse: pop it up with a tumble spin (called on death). */
  flingDeath(force: number) {
    this.flingY = force;
    this.flingSpin = (Math.random() - 0.5) * 12;
  }

  /** Chill the zombie: move at `(1-amount)` speed for `dur` seconds. */
  applySlow(amount: number, dur: number) {
    this.slowAmt = Math.max(this.slowAmt, amount);
    this.slowTimer = Math.max(this.slowTimer, dur);
  }

  update(dt: number, target: THREE.Vector3, grid: SpatialGrid) {
    if (!this.alive) return;
    if (this.touchCooldown > 0) this.touchCooldown -= dt;

    let speed = this.speed;
    if (this.slowTimer > 0) {
      this.slowTimer -= dt;
      speed *= 1 - this.slowAmt;
      if (this.slowTimer <= 0) this.slowAmt = 0;
    }

    if (this.flying) {
      this.updateFlying(dt, target, speed);
    } else {
      this.updateGround(dt, target, grid, speed);
    }

    if (this.flash > 0) {
      this.flash -= dt;
      if (this.char instanceof VoxelChar) this.char.setHitFlash(Math.max(0, this.flash / 0.12));
    }
    this.char.update(dt);
  }

  private updateGround(dt: number, target: THREE.Vector3, grid: SpatialGrid, speed: number) {
    _tmp.copy(target).sub(this.pos);
    _tmp.y = 0;
    const dist = _tmp.length();
    if (dist > 0.0001) _tmp.divideScalar(dist);
    this.vel.copy(_tmp).multiplyScalar(speed);

    // separation: only check zombies in nearby grid cells (was O(n²))
    const minD = ZOMBIE.separation;
    grid.forNear(this.pos.x, this.pos.z, minD, (o) => {
      if (o === this || !o.alive || o.flying) return;
      const dx = this.pos.x - o.pos.x;
      const dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      if (d2 > 0.0001 && d2 < minD * minD) {
        const d = Math.sqrt(d2);
        const push = (minD - d) / minD;
        this.vel.x += (dx / d) * push * this.speed * 1.4;
        this.vel.z += (dz / d) * push * this.speed * 1.4;
      }
    });

    // apply + decay knockback (visual push, then snaps back to steering)
    this.pos.addScaledVector(this.vel, dt);
    this.pos.x += this.knock.x * dt;
    this.pos.z += this.knock.z * dt;
    this.knock.multiplyScalar(Math.pow(0.0008, dt));
    this.pos.y = 0;
    this.group.position.copy(this.pos);
    this.group.rotation.y = Math.atan2(_tmp.x, _tmp.z);
  }

  /** Flying behavior: hover at height, then dive / lob ranged / swarm-drift. */
  private updateFlying(dt: number, target: THREE.Vector3, speed: number) {
    this.wobble += dt * 4;
    const dx = target.x - this.pos.x;
    const dz = target.z - this.pos.z;
    const dist = Math.hypot(dx, dz) || 1;
    const nx = dx / dist;
    const nz = dz / dist;

    let desiredY = this.flyHeight + Math.sin(this.wobble) * 0.3;

    if (this.airMode === "dive") {
      this.diveTimer -= dt;
      if (this.diving) {
        // swoop straight at the player on the ground, fast
        this.pos.x += nx * speed * 2.2 * dt;
        this.pos.z += nz * speed * 2.2 * dt;
        desiredY = 0.4;
        if (this.pos.y < 0.6 || dist < 0.8) {
          this.diving = false;
          this.diveTimer = 2 + Math.random() * 2;
        }
      } else {
        // reposition above the player, then trigger a dive
        this.pos.x += nx * speed * dt;
        this.pos.z += nz * speed * dt;
        if (this.diveTimer <= 0 && dist < 8) this.diving = true;
      }
    } else if (this.airMode === "ranged") {
      // hover at a standoff distance and lob projectiles
      const standoff = 8;
      const closing = dist > standoff ? 1 : dist < standoff - 1.5 ? -0.8 : 0;
      this.pos.x += nx * speed * closing * dt;
      this.pos.z += nz * speed * closing * dt;
      this.rangedTimer -= dt;
      if (this.rangedTimer <= 0 && dist < 18) {
        this.rangedTimer = 1.8 + Math.random();
        this.wantsRangedShot = true;
      }
    } else {
      // swarm: erratic zig-zag drift toward the player at head height
      const zig = Math.sin(this.wobble * 1.7) * 0.6;
      this.pos.x += (nx + -nz * zig) * speed * dt;
      this.pos.z += (nz + nx * zig) * speed * dt;
    }

    // ease height toward desired; apply light knockback drift
    this.pos.y += (desiredY - this.pos.y) * Math.min(1, dt * 6);
    this.pos.x += this.knock.x * dt;
    this.pos.z += this.knock.z * dt;
    this.knock.multiplyScalar(Math.pow(0.0008, dt));
    this.group.position.copy(this.pos);
    this.group.rotation.y = Math.atan2(nx, nz);
  }

  /** Advance the death animation; hide + recycle when the corpse times out. */
  updateDying(dt: number) {
    if (!this.dying) return;
    if (this.flash > 0) {
      this.flash -= dt;
      if (this.char instanceof VoxelChar) this.char.setHitFlash(Math.max(0, this.flash / 0.12));
    }
    // ragdoll: pop up under gravity + tumble, slide along residual knockback
    if (this.flingY !== 0 || this.group.position.y > 0) {
      this.flingY -= 22 * dt;
      this.group.position.y = Math.max(0, this.group.position.y + this.flingY * dt);
      this.group.position.x += this.knock.x * dt;
      this.group.position.z += this.knock.z * dt;
      this.knock.multiplyScalar(Math.pow(0.0008, dt));
      this.group.rotation.z += this.flingSpin * dt;
      if (this.group.position.y <= 0) {
        this.flingY = 0;
        this.flingSpin = 0;
      }
    }
    this.char.update(dt);
    this.deathTimer -= dt;
    if (this.deathTimer <= 0) {
      this.dying = false;
      this.group.visible = false;
      this.group.position.y = 0;
      this.group.rotation.z = 0;
    }
  }
}
