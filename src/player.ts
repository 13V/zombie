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
  private muzzleFlash: THREE.Sprite;
  private flashLife = 0;

  constructor(scene: THREE.Scene, assets: AssetManager) {
    this.char =
      assets.createCharacter("player") ??
      new VoxelChar({ body: COLORS.player, head: COLORS.playerAccent, eye: 0x222222, hat: 0xf2c14e, gun: true });
    this.group.add(this.char.root);
    this.group.position.copy(this.pos);

    // pooled muzzle flash: one billboarded glow, toggled per shot (no per-shot allocs)
    const mat = new THREE.SpriteMaterial({
      color: 0xffe9a8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.muzzleFlash = new THREE.Sprite(mat);
    this.muzzleFlash.scale.set(1.1, 1.1, 1);
    this.muzzleFlash.position.set(0, 1.0, 0.9);
    this.group.add(this.muzzleFlash);

    scene.add(this.group);
  }

  /** Pop the muzzle flash (called when a shot actually fires). */
  flash() {
    this.flashLife = 0.06;
    this.muzzleFlash.position.set(0, 1.0, 0.9);
  }

  /** Apply a cosmetic skin (recolors the voxel hero; no-op for GLB rigs). */
  setSkin(body: number, head: number) {
    if (this.char instanceof VoxelChar) this.char.setColor(body, head);
  }

  damage(amount: number) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.timeSinceHit = 0;
    if (this.health <= 0) this.alive = false;
  }

  /** Restore HP (medkits, life-steal), capped at max. */
  heal(amount: number) {
    if (!this.alive) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
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
    this.updateFlash(dt);

    this.timeSinceHit += dt;
    if (this.timeSinceHit > PLAYER.regenDelay && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + PLAYER.regenRate * dt);
    }

    this.group.position.copy(this.pos);
    this.muzzle.copy(this.pos).addScaledVector(this.aimDir, 0.9);
    this.muzzle.y = 1.0;
  }

  private updateFlash(dt: number) {
    const mat = this.muzzleFlash.material as THREE.SpriteMaterial;
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      const k = Math.max(0, this.flashLife / 0.06);
      mat.opacity = k;
      this.muzzleFlash.scale.setScalar(0.8 + (1 - k) * 0.6);
    } else if (mat.opacity !== 0) {
      mat.opacity = 0;
    }
  }

  /** Used on the menu / paused screens so the figure keeps breathing. */
  idle(dt: number) {
    this.char.play("idle");
    this.char.update(dt);
    this.updateFlash(dt);
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
