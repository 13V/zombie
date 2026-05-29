import * as THREE from "three";
import { PLAYER } from "./config";
import { COLORS, toyMaterial } from "./palette";

/**
 * The little hero figure. Capsule-ish toy body with a "nose" indicating facing,
 * plus a muzzle anchor that bullets fire from. Handles movement, aim, health.
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

  private body: THREE.Mesh;
  private bob = 0;

  constructor(scene: THREE.Scene) {
    const mat = toyMaterial(COLORS.player);
    this.body = new THREE.Mesh(new THREE.CapsuleGeometry(PLAYER.radius, 0.7, 4, 12), mat);
    this.body.position.y = 0.95;
    this.body.castShadow = true;
    this.group.add(this.body);

    // a little cream "cap" so the figure reads as a character
    const cap = new THREE.Mesh(
      new THREE.SphereGeometry(PLAYER.radius * 0.75, 12, 10),
      toyMaterial(COLORS.playerAccent),
    );
    cap.position.y = 1.6;
    cap.castShadow = true;
    this.group.add(cap);

    // facing nose / "gun" nub
    const nose = new THREE.Mesh(
      new THREE.BoxGeometry(0.25, 0.25, 0.7),
      toyMaterial(0x3a2f25),
    );
    nose.position.set(0, 1.0, -0.7);
    this.group.add(nose);

    this.group.position.copy(this.pos);
    scene.add(this.group);
  }

  damage(amount: number) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.timeSinceHit = 0;
    if (this.health <= 0) this.alive = false;
  }

  /** Move by `axis` (camera-relative right/forward), aim toward `aimPoint`. */
  update(dt: number, moveX: number, moveZ: number, aimPoint: THREE.Vector3) {
    if (!this.alive) return;

    const speed = PLAYER.speed * this.speedMul;
    this.pos.x += moveX * speed * dt;
    this.pos.z += moveZ * speed * dt;

    // aim toward the cursor's ground point
    const dx = aimPoint.x - this.pos.x;
    const dz = aimPoint.z - this.pos.z;
    if (dx * dx + dz * dz > 0.0004) {
      this.aimDir.set(dx, 0, dz).normalize();
      this.group.rotation.y = Math.atan2(this.aimDir.x, this.aimDir.z);
    }

    // gentle walk bob for the toy feel
    const moving = moveX !== 0 || moveZ !== 0;
    this.bob += dt * (moving ? 12 : 4);
    this.body.position.y = 0.95 + (moving ? Math.abs(Math.sin(this.bob)) * 0.08 : 0);

    // health regen after a beat
    this.timeSinceHit += dt;
    if (this.timeSinceHit > PLAYER.regenDelay && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + PLAYER.regenRate * dt);
    }

    this.group.position.copy(this.pos);

    // muzzle in world space, slightly in front of the figure
    this.muzzle.copy(this.pos).addScaledVector(this.aimDir, 0.9);
    this.muzzle.y = 1.0;
  }

  reset() {
    this.pos.set(0, 0, 0);
    this.group.position.copy(this.pos);
    this.health = PLAYER.maxHealth;
    this.maxHealth = PLAYER.maxHealth;
    this.timeSinceHit = 99;
    this.alive = true;
    this.speedMul = 1;
    this.reloadMul = 1;
  }
}
