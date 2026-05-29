import * as THREE from "three";
import { PLAYER } from "./config";
import { COLORS, toyMaterial } from "./palette";
import { AssetManager, Character } from "./assets";

/**
 * The little hero figure. Uses a GLB character (with animations) when one is
 * loaded; otherwise builds a primitive toy figure. Handles movement, aim, health.
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

  private char: Character | null;
  private body?: THREE.Mesh; // only used by the primitive fallback
  private bob = 0;

  constructor(scene: THREE.Scene, assets: AssetManager) {
    this.char = assets.createCharacter("player");
    if (this.char) {
      this.group.add(this.char.root);
    } else {
      this.buildPrimitive();
    }
    this.group.position.copy(this.pos);
    scene.add(this.group);
  }

  private buildPrimitive() {
    this.body = new THREE.Mesh(
      new THREE.CapsuleGeometry(PLAYER.radius, 0.7, 4, 12),
      toyMaterial(COLORS.player),
    );
    this.body.position.y = 0.95;
    this.body.castShadow = true;
    this.group.add(this.body);

    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(PLAYER.radius * 0.75, 12, 10),
      toyMaterial(COLORS.playerAccent),
    );
    cap.position.y = 1.6;
    cap.castShadow = true;
    this.group.add(cap);

    const nose = new THREE.Mesh(new THREE.BoxGeometry(0.25, 0.25, 0.7), toyMaterial(0x3a2f25));
    nose.position.set(0, 1.0, -0.7);
    this.group.add(nose);
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
      this.char?.update(dt);
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
    if (this.char) {
      this.char.play(moving ? "walk" : "idle");
      this.char.update(dt);
    } else if (this.body) {
      this.bob += dt * (moving ? 12 : 4);
      this.body.position.y = 0.95 + (moving ? Math.abs(Math.sin(this.bob)) * 0.08 : 0);
    }

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
    this.char?.play("idle");
    this.char?.update(dt);
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
