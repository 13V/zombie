import * as THREE from "three";
import { ZOMBIE, ZombieType } from "./config";
import { AssetManager, CharacterRig } from "./assets";
import { VoxelChar } from "./voxelChar";

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
  health = ZOMBIE.baseHealth;
  speed = ZOMBIE.baseSpeed;
  alive = false;
  /** Visually dying (playing a death anim) but no longer a gameplay threat. */
  dying = false;
  private deathTimer = 0;
  touchCooldown = 0;

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

    this.typeName = type.name;
    this.health = baseHealth * type.healthMul;
    this.speed = baseSpeed * type.speedMul;
    this.touchDamage = type.touchDamage;
    this.scoreMul = type.scoreMul;
    this.puffColor = type.body;
    this.explodes = type.blastRadius !== undefined;
    this.blastRadius = type.blastRadius ?? 0;
    this.blastDamage = type.blastDamage ?? 0;
    this.group.scale.setScalar(type.scale);
    if (this.char instanceof VoxelChar) {
      this.char.setColor(type.body, type.head, this.explodes ? type.body : 0x000000);
    }

    this.group.rotation.set(0, 0, 0);
    this.char.play("walk");
    this.group.position.copy(this.pos);
    this.group.visible = true;
  }

  /** Returns true if it just died from this hit. */
  hit(damage: number): boolean {
    if (!this.alive) return false;
    this.health -= damage;
    if (this.health <= 0) {
      this.alive = false;
      this.dying = true;
      this.deathTimer = 1.4;
      this.char.play("death", { once: true });
      return true;
    }
    return false;
  }

  update(dt: number, target: THREE.Vector3, others: Zombie[]) {
    if (!this.alive) return;
    if (this.touchCooldown > 0) this.touchCooldown -= dt;

    _tmp.copy(target).sub(this.pos);
    _tmp.y = 0;
    const dist = _tmp.length();
    if (dist > 0.0001) _tmp.divideScalar(dist);
    this.vel.copy(_tmp).multiplyScalar(this.speed);

    for (const o of others) {
      if (o === this || !o.alive) continue;
      const dx = this.pos.x - o.pos.x;
      const dz = this.pos.z - o.pos.z;
      const d2 = dx * dx + dz * dz;
      const minD = ZOMBIE.separation;
      if (d2 > 0.0001 && d2 < minD * minD) {
        const d = Math.sqrt(d2);
        const push = (minD - d) / minD;
        this.vel.x += (dx / d) * push * this.speed * 1.4;
        this.vel.z += (dz / d) * push * this.speed * 1.4;
      }
    }

    this.pos.addScaledVector(this.vel, dt);
    this.pos.y = 0;
    this.group.position.copy(this.pos);
    this.group.rotation.y = Math.atan2(_tmp.x, _tmp.z);
    this.char.update(dt);
  }

  /** Advance the death animation; hide + recycle when the corpse times out. */
  updateDying(dt: number) {
    if (!this.dying) return;
    this.char.update(dt);
    this.deathTimer -= dt;
    if (this.deathTimer <= 0) {
      this.dying = false;
      this.group.visible = false;
    }
  }
}
