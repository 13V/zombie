import * as THREE from "three";
import { PLAYER } from "./config";
import { COLORS } from "./palette";
import { AssetManager, CharacterRig } from "./assets";
import { VoxelChar } from "./voxelChar";

/**
 * The little hero. Driven by a CharacterRig — a voxel blocky figure by default
 * (the committed style), or a KayKit GLB if one is dropped in. Handles movement,
 * aim, health.
 */
export class Player {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3(0, 0, 0);
  readonly muzzle = new THREE.Vector3();
  /** Unit aim direction on the XZ plane. */
  readonly aimDir = new THREE.Vector3(0, 0, -1);

  health = PLAYER.maxHealth;
  maxHealth = PLAYER.maxHealth;
  timeSinceHit = 99;
  alive = true;

  // buffs (perks)
  speedMul = 1;
  reloadMul = 1;

  private char: CharacterRig;

  constructor(scene: THREE.Scene, assets: AssetManager) {
    this.char =
      assets.createCharacter("player") ??
      new VoxelChar({ body: COLORS.player, head: COLORS.playerAccent, eye: 0x222222, hat: 0xf2c14e, gun: true });
    this.group.add(this.char.root);
    this.group.position.copy(this.pos);
    scene.add(this.group);
  }

  damage(amount: number) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.timeSinceHit = 0;
    if (this.health <= 0) this.alive = false;
  }

  /** Active gameplay update: move by `(moveX, moveZ)`, aim toward `aimPoint`. */
  update(dt: number, moveX: number, moveZ: number, aimPoint: THREE.Vector3) {
    if (!this.alive) {
      this.char.update(dt);
      return;
    }

    const speed = PLAYER.speed * this.speedMul;
    this.pos.x += moveX * speed * dt;
    this.pos.z += moveZ * speed * dt;

    const dx = aimPoint.x - this.pos.x;
    const dz = aimPoint.z - this.pos.z;
    if (dx * dx + dz * dz > 0.0004) {
      this.aimDir.set(dx, 0, dz).normalize();
      this.group.rotation.y = Math.atan2(this.aimDir.x, this.aimDir.z);
    }

    const moving = moveX !== 0 || moveZ !== 0;
    this.char.play(moving ? "walk" : "idle");
    this.char.update(dt);

    this.timeSinceHit += dt;
    if (this.timeSinceHit > PLAYER.regenDelay && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + PLAYER.regenRate * dt);
    }

    this.group.position.copy(this.pos);
    this.muzzle.copy(this.pos).addScaledVector(this.aimDir, 0.9);
    this.muzzle.y = 1.0;
  }

  /** Used on the menu / paused screens so the figure keeps breathing. */
  idle(dt: number) {
    this.char.play("idle");
    this.char.update(dt);
  }

  reset() {
    this.pos.set(0, 0, 0);
    this.group.position.copy(this.pos);
    this.group.rotation.y = 0;
    this.health = PLAYER.maxHealth;
    this.maxHealth = PLAYER.maxHealth;
    this.timeSinceHit = 99;
    this.alive = true;
    this.speedMul = 1;
    this.reloadMul = 1;
  }
}
