import * as THREE from "three";
import { ELITE, ZOMBIE, ZOMBIE_TYPES, ZombieType } from "./config";
import { AssetManager, CharacterRig } from "./assets";
import { VoxelChar } from "./voxelChar";
import type { SpatialGrid } from "./grid";

const _tmp = new THREE.Vector3();
let _nextId = 1;

/**
 * Elite affix: a behavior + colored visual tell layered onto a late-game
 * zombie. NOT just bonus HP — each one changes how the zombie threatens you.
 *  - blazing: leaves a burning trail under itself (DoT to a player on it).
 *  - glacial: chills the player on contact; shatters into a freeze AoE on death.
 *  - overloading: carries a shield (absorbed before HP) and bursts AoE on death.
 */
export type Affix = "blazing" | "glacial" | "overloading";

/** Per-affix tell color (emissive + aura ring) — picked to read at a glance. */
const AFFIX_COLOR: Record<Affix, number> = {
  blazing: 0xff6a1f,
  glacial: 0x6ad7ff,
  overloading: 0xc792ea,
};

// One shared flat ring geometry for the affix aura, reused by every affixed
// zombie (scaled per-instance). Process-wide singleton — never disposed; pooled
// zombies just toggle visibility. Three shared materials, one per affix color.
const _auraGeo = new THREE.RingGeometry(0.55, 0.85, 18);
_auraGeo.rotateX(-Math.PI / 2);
const _auraMat: Record<Affix, THREE.Material> = {
  blazing: new THREE.MeshBasicMaterial({ color: AFFIX_COLOR.blazing, transparent: true, opacity: 0.6, depthWrite: false }),
  glacial: new THREE.MeshBasicMaterial({ color: AFFIX_COLOR.glacial, transparent: true, opacity: 0.6, depthWrite: false }),
  overloading: new THREE.MeshBasicMaterial({ color: AFFIX_COLOR.overloading, transparent: true, opacity: 0.6, depthWrite: false }),
};

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
  // ---- anti-camp specials ----
  splitInto?: string;
  splitCount = 0;
  private summonInterval = 0;
  summonCount = 0;
  private summonTimer = 0;
  /** Set true on a frame a summoner wants to raise adds; main reads + clears it. */
  wantsSummon = false;

  // per-spawn variant state
  touchDamage = ZOMBIE.touchDamage;
  scoreMul = 1;
  puffColor = 0x8fcf6f;
  /** Loot Goblin: flees the player instead of chasing, and pays a jackpot on
   *  death (main reads `bounty`). Set by rounds.spawnGoblin(). */
  fleer = false;
  bounty = false;
  explodes = false;
  blastRadius = 0;
  blastDamage = 0;

  // ---- elite affix state ----
  /** Active affix (null on a plain zombie). Read by main for on-hit/on-death FX. */
  affix: Affix | null = null;
  /** Remaining shield (overloading) absorbed before HP; 0 when none. */
  shield = 0;
  private maxShield = 0;
  /** Throttle for blazing trail emission; main reads `burnTrailReady`. */
  private burnTimer = 0;
  /** Set on a frame a blazing zombie wants to drop a burn patch; main clears it. */
  burnTrailReady = false;
  private aura?: THREE.Mesh;

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
    this.fleer = false;
    this.bounty = false;
    this.explodes = type.blastRadius !== undefined;
    this.blastRadius = type.blastRadius ?? 0;
    this.blastDamage = type.blastDamage ?? 0;
    // flying state
    this.splitInto = type.splitInto;
    this.splitCount = type.splitCount ?? 0;
    this.summonInterval = type.summonInterval ?? 0;
    this.summonCount = type.summonCount ?? 0;
    this.summonTimer = type.summonInterval ?? 0;
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

    // clear any affix from a previous life (pooled reuse)
    this.clearAffix();

    this.group.rotation.set(0, 0, 0);
    this.char.play("walk");
    this.group.position.copy(this.pos);
    this.group.visible = true;
  }

  /**
   * Tag this (already-spawned) zombie with an elite affix: behavior + a colored
   * tell. Glacial/blazing buff stats slightly; overloading grants a shield. The
   * aura ring + emissive tint make it readable. Caller (rounds) decides fraction
   * + cap; this just applies. Returns the affix so callers can count it.
   */
  applyAffix(affix: Affix): Affix {
    this.affix = affix;
    const color = AFFIX_COLOR[affix];
    // recolor the body emissive to the affix color (keeps the variant's body hue)
    if (this.char instanceof VoxelChar) this.char.setColor(this.puffColor, this.puffColor, color);
    // lazy-build the shared aura ring; toggle on + recolor via shared material
    if (!this.aura) {
      this.aura = new THREE.Mesh(_auraGeo, _auraMat[affix]);
      this.aura.position.y = 0.06;
      this.group.add(this.aura);
    }
    this.aura.material = _auraMat[affix];
    this.aura.visible = true;
    if (affix === "overloading") {
      this.maxShield = this.maxHealth * ELITE.overloadShield;
      this.shield = this.maxShield;
    } else if (affix === "blazing") {
      this.speed *= 1.1; // a touch faster so the trail actually chases you
    } else if (affix === "glacial") {
      this.health *= 1.25; // glacial is the "anchor" — slightly tankier
      this.maxHealth = this.health;
    }
    this.scoreMul *= 1.6; // affixed kills are worth more
    return affix;
  }

  /** Strip any affix back to a plain zombie (called on pooled respawn). */
  private clearAffix() {
    this.affix = null;
    this.shield = 0;
    this.maxShield = 0;
    this.burnTimer = 0;
    this.burnTrailReady = false;
    if (this.aura) this.aura.visible = false;
  }

  /**
   * Death-burst descriptor for affixed zombies (glacial shatter / overloading
   * blast), or null. main applies the AoE so it shares the explosion/FX paths.
   */
  deathAoe(): { radius: number; damage: number; slow: number; color: number } | null {
    if (this.affix === "glacial") {
      return { radius: ELITE.glacialShatterRadius, damage: 0, slow: ELITE.glacialSlow, color: AFFIX_COLOR.glacial };
    }
    if (this.affix === "overloading") {
      return { radius: ELITE.overloadAoeRadius, damage: ELITE.overloadAoeDamage, slow: 0, color: AFFIX_COLOR.overloading };
    }
    return null;
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
    // Overloading shield soaks damage before HP (self-contained; main needs no
    // special-case here — it keeps calling hit() as normal).
    if (this.shield > 0) {
      const soaked = Math.min(this.shield, damage);
      this.shield -= soaked;
      damage -= soaked;
      if (damage <= 0) {
        this.flash = 0.12;
        return false;
      }
    }
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

    // Blazing: periodically flag a burn patch under itself for main to drop.
    if (this.affix === "blazing") {
      this.burnTimer -= dt;
      if (this.burnTimer <= 0) {
        this.burnTimer = 0.35;
        this.burnTrailReady = true;
      }
    }
    // spin the affix aura for a little life
    if (this.aura && this.aura.visible) this.aura.rotation.y += dt * 1.5;

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
    // Summoner keeps its distance (flees if the player gets close) + raises adds.
    let approach = 1;
    if (this.fleer) {
      // Loot Goblin: always sprint directly AWAY from the player. Add a slow
      // lateral weave so it juke-runs instead of beelining into a corner.
      approach = -1;
      const weave = Math.sin(this.wobble) * 0.5;
      this.wobble += dt * 3;
      _tmp.set(_tmp.x + -_tmp.z * weave, 0, _tmp.z + _tmp.x * weave);
      const l = _tmp.length() || 1;
      _tmp.divideScalar(l);
    } else if (this.summonInterval > 0) {
      if (dist < 7) approach = -0.6; // back away to stay a priority-but-annoying target
      this.summonTimer -= dt;
      if (this.summonTimer <= 0) {
        this.summonTimer = this.summonInterval;
        this.wantsSummon = true;
      }
    }
    this.vel.copy(_tmp).multiplyScalar(speed * approach);

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
      if (this.aura) this.aura.visible = false;
    }
  }
}
