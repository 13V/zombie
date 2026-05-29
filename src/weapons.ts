import * as THREE from "three";
import { COLORS, glowMaterial } from "./palette";

export interface WeaponDef {
  id: string;
  name: string;
  damage: number;
  /** Shots per second. */
  fireRate: number;
  magSize: number;
  /** Reserve ammo; Infinity for the starter pistol. */
  reserve: number;
  /** Projectiles per shot (shotgun > 1). */
  pellets: number;
  /** Half-angle spread in radians. */
  spread: number;
  bulletSpeed: number;
  /** Hold-to-fire vs click-per-shot. */
  auto: boolean;
  reloadTime: number;
}

export const WEAPONS: Record<string, WeaponDef> = {
  peashooter: {
    id: "peashooter", name: "Peashooter", damage: 28, fireRate: 4,
    magSize: 12, reserve: Infinity, pellets: 1, spread: 0.01,
    bulletSpeed: 60, auto: false, reloadTime: 1.1,
  },
  buzzgun: {
    id: "buzzgun", name: "Buzzgun", damage: 22, fireRate: 11,
    magSize: 32, reserve: 256, pellets: 1, spread: 0.05,
    bulletSpeed: 64, auto: true, reloadTime: 1.6,
  },
  scattershot: {
    id: "scattershot", name: "Scattershot", damage: 18, fireRate: 1.4,
    magSize: 6, reserve: 48, pellets: 8, spread: 0.22,
    bulletSpeed: 52, auto: false, reloadTime: 2.2,
  },
  boomstick: {
    id: "boomstick", name: "Boomstick", damage: 90, fireRate: 2.2,
    magSize: 8, reserve: 64, pellets: 1, spread: 0.015,
    bulletSpeed: 70, auto: false, reloadTime: 1.5,
  },
  marksman: {
    id: "marksman", name: "Marksman", damage: 140, fireRate: 1.1,
    magSize: 5, reserve: 40, pellets: 1, spread: 0.0,
    bulletSpeed: 90, auto: false, reloadTime: 1.8,
  },
};

/** Pool of weapons the Mystery Box can hand out. */
export const BOX_POOL = ["buzzgun", "scattershot", "boomstick", "marksman"];

export interface Bullet {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  damage: number;
  alive: boolean;
}

/** Spawns, moves, recycles bullet meshes. Collision is resolved by the caller. */
export class BulletSystem {
  readonly bullets: Bullet[] = [];
  private pool: Bullet[] = [];
  private geo = new THREE.SphereGeometry(0.16, 8, 8);
  private mat = glowMaterial(COLORS.bullet, 1.6);

  constructor(private scene: THREE.Scene) {}

  spawn(origin: THREE.Vector3, dir: THREE.Vector3, speed: number, damage: number) {
    let b = this.pool.pop();
    if (!b) {
      const mesh = new THREE.Mesh(this.geo, this.mat);
      mesh.castShadow = false;
      b = { mesh, vel: new THREE.Vector3(), life: 0, damage: 0, alive: false };
    }
    b.mesh.position.copy(origin);
    b.vel.copy(dir).normalize().multiplyScalar(speed);
    b.life = 1.3;
    b.damage = damage;
    b.alive = true;
    b.mesh.visible = true;
    this.scene.add(b.mesh);
    this.bullets.push(b);
  }

  retire(b: Bullet) {
    if (!b.alive) return;
    b.alive = false;
    b.mesh.visible = false;
    this.scene.remove(b.mesh);
    this.pool.push(b);
  }

  update(dt: number) {
    for (const b of this.bullets) {
      if (!b.alive) continue;
      b.mesh.position.addScaledVector(b.vel, dt);
      b.life -= dt;
      if (b.life <= 0) this.retire(b);
    }
    // Compact the live list.
    for (let i = this.bullets.length - 1; i >= 0; i--) {
      if (!this.bullets[i].alive) this.bullets.splice(i, 1);
    }
  }

  clear() {
    for (const b of this.bullets) this.retire(b);
    this.bullets.length = 0;
  }
}

/** A weapon instance carried by the player: tracks ammo, cooldown, reloading. */
export class Weapon {
  def: WeaponDef;
  ammo: number;
  reserve: number;
  private cooldown = 0;
  reloading = false;
  reloadTimer = 0;
  upgraded = false;

  constructor(def: WeaponDef) {
    this.def = def;
    this.ammo = def.magSize;
    this.reserve = def.reserve;
  }

  get reserveLabel(): string {
    return this.reserve === Infinity ? "∞" : String(this.reserve);
  }

  /**
   * Pack-a-Punch: replace this instance's def with a beefed-up clone (we clone
   * so the shared WEAPONS template is never mutated). Refills on upgrade.
   */
  upgrade(): boolean {
    if (this.upgraded) return false;
    const d = this.def;
    this.def = {
      ...d,
      name: `${d.name} +`,
      damage: Math.round(d.damage * 2.4),
      magSize: Math.ceil(d.magSize * 1.4),
      reserve: d.reserve === Infinity ? Infinity : Math.ceil(d.reserve * 1.5),
      reloadTime: d.reloadTime * 0.85,
    };
    this.ammo = this.def.magSize;
    if (this.reserve !== Infinity) this.reserve = this.def.reserve;
    this.upgraded = true;
    return true;
  }

  update(dt: number, reloadMul: number) {
    if (this.cooldown > 0) this.cooldown -= dt;
    if (this.reloading) {
      this.reloadTimer -= dt * reloadMul;
      if (this.reloadTimer <= 0) this.finishReload();
    }
  }

  private finishReload() {
    this.reloading = false;
    const need = this.def.magSize - this.ammo;
    const take = this.reserve === Infinity ? need : Math.min(need, this.reserve);
    this.ammo += take;
    if (this.reserve !== Infinity) this.reserve -= take;
  }

  reload() {
    if (this.reloading || this.ammo >= this.def.magSize) return;
    if (this.reserve !== Infinity && this.reserve <= 0) return;
    this.reloading = true;
    this.reloadTimer = this.def.reloadTime;
  }

  /** Attempt to fire toward `dir`; spawns bullets and returns true if it shot. */
  tryFire(origin: THREE.Vector3, dir: THREE.Vector3, bullets: BulletSystem): boolean {
    if (this.cooldown > 0 || this.reloading) return false;
    if (this.ammo <= 0) {
      this.reload();
      return false;
    }
    this.ammo--;
    this.cooldown = 1 / this.def.fireRate;

    const base = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    for (let p = 0; p < this.def.pellets; p++) {
      const a = (Math.random() * 2 - 1) * this.def.spread;
      const d = base.clone().applyAxisAngle(new THREE.Vector3(0, 1, 0), a);
      bullets.spawn(origin, d, this.def.bulletSpeed, this.def.damage);
    }
    if (this.ammo <= 0) this.reload();
    return true;
  }
}
