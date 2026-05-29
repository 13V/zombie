import * as THREE from "three";
import { ZOMBIE } from "./config";
import { COLORS, toyMaterial } from "./palette";

const _tmp = new THREE.Vector3();

/**
 * A cute-menacing undead. Walks toward the player with a wobble, separates from
 * neighbours so the horde doesn't collapse to a point, and hits on contact.
 */
export class Zombie {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();

  health = ZOMBIE.baseHealth;
  speed = ZOMBIE.baseSpeed;
  alive = false;
  touchCooldown = 0;

  private body: THREE.Mesh;
  private wobble = Math.random() * Math.PI * 2;

  constructor() {
    this.body = new THREE.Mesh(
      new THREE.CapsuleGeometry(ZOMBIE.radius, 0.6, 4, 10),
      toyMaterial(COLORS.zombie),
    );
    this.body.position.y = 0.85;
    this.body.castShadow = true;
    this.group.add(this.body);

    // dark little eyes nub so it reads as a creature with a front
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(ZOMBIE.radius * 0.65, 10, 8),
      toyMaterial(COLORS.zombieDark),
    );
    head.position.y = 1.45;
    head.castShadow = true;
    this.group.add(head);

    this.group.visible = false;
  }

  spawn(at: THREE.Vector3, health: number, speed: number) {
    this.pos.copy(at);
    this.pos.y = 0;
    this.health = health;
    this.speed = speed;
    this.alive = true;
    this.touchCooldown = 0;
    this.wobble = Math.random() * Math.PI * 2;
    (this.body.material as THREE.MeshStandardMaterial).color.set(COLORS.zombie);
    this.group.position.copy(this.pos);
    this.group.visible = true;
  }

  /** Returns true if it just died from this hit. */
  hit(damage: number): boolean {
    if (!this.alive) return false;
    this.health -= damage;
    // flash toward dark when hurt
    const m = this.body.material as THREE.MeshStandardMaterial;
    m.color.lerpColors(new THREE.Color(COLORS.zombieDark), new THREE.Color(COLORS.zombie), Math.max(0, this.health / ZOMBIE.baseHealth));
    if (this.health <= 0) {
      this.alive = false;
      this.group.visible = false;
      return true;
    }
    return false;
  }

  update(dt: number, target: THREE.Vector3, others: Zombie[]) {
    if (!this.alive) return;
    if (this.touchCooldown > 0) this.touchCooldown -= dt;

    // steer toward player
    _tmp.copy(target).sub(this.pos);
    _tmp.y = 0;
    const dist = _tmp.length();
    if (dist > 0.0001) _tmp.divideScalar(dist);
    this.vel.copy(_tmp).multiplyScalar(this.speed);

    // separation from nearby zombies
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

    // wobble walk
    this.wobble += dt * 9;
    this.group.position.copy(this.pos);
    this.group.position.y = Math.abs(Math.sin(this.wobble)) * 0.12;
    this.group.rotation.z = Math.sin(this.wobble) * 0.12;
    this.group.rotation.y = Math.atan2(_tmp.x, _tmp.z);
  }
}
