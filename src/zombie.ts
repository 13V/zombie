import * as THREE from "three";
import { ZOMBIE } from "./config";
import { COLORS, toyMaterial } from "./palette";
import { AssetManager, Character } from "./assets";

const _tmp = new THREE.Vector3();

/**
 * A cute-menacing undead. Uses a GLB character (with walk/death animations) when
 * loaded; otherwise a primitive wobble-figure. Steers toward the player, keeps
 * separation from neighbours, and hits on contact. On death it plays a death
 * animation (if available) as a brief corpse before being recycled.
 */
export class Zombie {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3();
  readonly vel = new THREE.Vector3();

  health = ZOMBIE.baseHealth;
  speed = ZOMBIE.baseSpeed;
  alive = false;
  /** Visually dying (playing a death anim) but no longer a gameplay threat. */
  dying = false;
  private deathTimer = 0;
  touchCooldown = 0;

  private char: Character | null;
  private body?: THREE.Mesh; // primitive fallback
  private head?: THREE.Mesh;
  private wobble = Math.random() * Math.PI * 2;

  constructor(assets: AssetManager) {
    this.char = assets.createCharacter("zombie");
    if (!this.char) this.buildPrimitive();
    else this.group.add(this.char.root);
    this.group.visible = false;
  }

  private buildPrimitive() {
    this.body = new THREE.Mesh(
      new THREE.CapsuleGeometry(ZOMBIE.radius, 0.6, 4, 10),
      toyMaterial(COLORS.zombie),
    );
    this.body.position.y = 0.85;
    this.body.castShadow = true;
    this.group.add(this.body);

    this.head = new THREE.Mesh(
      new THREE.SphereGeometry(ZOMBIE.radius * 0.65, 10, 8),
      toyMaterial(COLORS.zombieDark),
    );
    this.head.position.y = 1.45;
    this.head.castShadow = true;
    this.group.add(this.head);
  }

  spawn(at: THREE.Vector3, health: number, speed: number) {
    this.pos.copy(at);
    this.pos.y = 0;
    this.health = health;
    this.speed = speed;
    this.alive = true;
    this.dying = false;
    this.deathTimer = 0;
    this.touchCooldown = 0;
    this.wobble = Math.random() * Math.PI * 2;
    this.group.rotation.set(0, 0, 0);
    if (this.body) (this.body.material as THREE.MeshStandardMaterial).color.set(COLORS.zombie);
    if (this.char) this.char.play("walk");
    this.group.position.copy(this.pos);
    this.group.visible = true;
  }

  /** Returns true if it just died from this hit. */
  hit(damage: number): boolean {
    if (!this.alive) return false;
    this.health -= damage;
    if (this.body) {
      const m = this.body.material as THREE.MeshStandardMaterial;
      const f = Math.max(0, this.health / ZOMBIE.baseHealth);
      m.color.lerpColors(new THREE.Color(COLORS.zombieDark), new THREE.Color(COLORS.zombie), f);
    }
    if (this.health <= 0) {
      this.alive = false;
      if (this.char?.hasAnim("death")) {
        this.dying = true;
        this.deathTimer = 1.4;
        this.char.play("death", { once: true });
      } else {
        this.group.visible = false;
      }
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

    if (this.char) {
      this.char.update(dt);
    } else {
      // primitive wobble walk
      this.wobble += dt * 9;
      this.group.position.y = Math.abs(Math.sin(this.wobble)) * 0.12;
      this.group.rotation.z = Math.sin(this.wobble) * 0.12;
    }
  }

  /** Advance the death animation; hide + recycle when the corpse times out. */
  updateDying(dt: number) {
    if (!this.dying) return;
    this.char?.update(dt);
    this.deathTimer -= dt;
    if (this.deathTimer <= 0) {
      this.dying = false;
      this.group.visible = false;
    }
  }
}
