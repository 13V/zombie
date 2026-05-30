import * as THREE from "three";
import { COLORS, glowMaterial } from "./palette";
import { GunStyle } from "./gunModels";

export interface WeaponDef {
  id: string;
  name: string;
  /** Held-model + Mystery Chest look. */
  style: GunStyle;
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
  // ---- wonder-weapon extras (all optional) ----
  /** Zombies a single shot can punch through before dying. */
  pierce?: number;
  /** AoE applied at each impact point. */
  splashRadius?: number;
  splashDamage?: number;
  /** Tracer tint + size. */
  bulletColor?: number;
  bulletScale?: number;
  /** Flagged for HUD / box flavor. */
  wonder?: boolean;
}

export const WEAPONS: Record<string, WeaponDef> = {
  peashooter: {
    id: "peashooter", name: "Peashooter", style: "pistol", damage: 28, fireRate: 4,
    magSize: 12, reserve: Infinity, pellets: 1, spread: 0.01,
    bulletSpeed: 60, auto: false, reloadTime: 1.1,
    bulletColor: 0xffe28a, bulletScale: 1,
  },
  buzzgun: {
    id: "buzzgun", name: "Buzzgun", style: "smg", damage: 22, fireRate: 11,
    magSize: 32, reserve: 256, pellets: 1, spread: 0.05,
    bulletSpeed: 64, auto: true, reloadTime: 1.6,
    bulletColor: 0xfff1b0, bulletScale: 0.8,
  },
  scattershot: {
    id: "scattershot", name: "Scattershot", style: "shotgun", damage: 18, fireRate: 1.4,
    magSize: 6, reserve: 48, pellets: 8, spread: 0.22,
    bulletSpeed: 52, auto: false, reloadTime: 2.2,
    bulletColor: 0xffc06a, bulletScale: 0.85,
  },
  boomstick: {
    id: "boomstick", name: "Boomstick", style: "cannon", damage: 90, fireRate: 2.2,
    magSize: 8, reserve: 64, pellets: 1, spread: 0.015,
    bulletSpeed: 70, auto: false, reloadTime: 1.5,
    bulletColor: 0xffa23a, bulletScale: 1.5,
  },
  marksman: {
    id: "marksman", name: "Marksman", style: "rifle", damage: 140, fireRate: 1.1,
    magSize: 5, reserve: 40, pellets: 1, spread: 0.0,
    bulletSpeed: 90, auto: false, reloadTime: 1.8,
    bulletColor: 0x9fe8ff, bulletScale: 1.1,
  },

  // ---- wonder weapons: rare, spectacular, but finite ammo so they can't
  // carry you to round 100 on their own. ----
  arc: {
    id: "arc", name: "Arc Cannon", style: "arc", damage: 110, fireRate: 6,
    magSize: 40, reserve: 240, pellets: 1, spread: 0.03,
    bulletSpeed: 82, auto: true, reloadTime: 1.8,
    pierce: 6, splashRadius: 2.2, splashDamage: 55,
    bulletColor: 0x6ad7ff, bulletScale: 1.4, wonder: true,
  },
  singularity: {
    id: "singularity", name: "Singularity", style: "singularity", damage: 180, fireRate: 1.4,
    magSize: 5, reserve: 30, pellets: 1, spread: 0.0,
    bulletSpeed: 44, auto: false, reloadTime: 2.4,
    splashRadius: 4.6, splashDamage: 240,
    bulletColor: 0xc792ea, bulletScale: 2.2, wonder: true,
  },
  pyroclasm: {
    id: "pyroclasm", name: "Pyroclasm", style: "pyroclasm", damage: 55, fireRate: 9,
    magSize: 64, reserve: 384, pellets: 1, spread: 0.06,
    bulletSpeed: 64, auto: true, reloadTime: 2.0,
    pierce: 1, splashRadius: 1.8, splashDamage: 42,
    bulletColor: 0xff7a3a, bulletScale: 1.3, wonder: true,
  },
};

/** Look up a weapon's gun style by display name (handles the "X +" PaP variant). */
const NAME_STYLE = new Map<string, GunStyle>();
for (const d of Object.values(WEAPONS)) NAME_STYLE.set(d.name, d.style);
export function styleForWeaponName(name: string): GunStyle {
  return NAME_STYLE.get(name) ?? NAME_STYLE.get(name.replace(/ \+$/, "")) ?? "pistol";
}

/** Normal weapons the Prize Wheel can hand out. */
export const BOX_POOL = ["buzzgun", "scattershot", "boomstick", "marksman"];
/** The crazy ones — rolled rarely by the wheel. */
export const WONDER_POOL = ["arc", "singularity", "pyroclasm"];

export interface SpawnOpts {
  speed: number;
  damage: number;
  pierce: number;
  splashRadius: number;
  splashDamage: number;
  color: number;
  scale: number;
}

export interface Bullet {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  damage: number;
  alive: boolean;
  pierce: number;
  splashRadius: number;
  splashDamage: number;
  /** Zombie ids already struck (so a piercing round won't re-hit one). */
  hit: Set<number>;
}

const _UP = new THREE.Vector3(0, 1, 0);
const _dir = new THREE.Vector3();

/** Spawns, moves, recycles bullet meshes. Collision is resolved by the caller. */
export class BulletSystem {
  readonly bullets: Bullet[] = [];
  private pool: Bullet[] = [];
  // A stretched capsule reads as a whizzing tracer once aligned to velocity.
  private geo = new THREE.CapsuleGeometry(0.07, 0.5, 4, 8);

  constructor(private scene: THREE.Scene) {}

  spawn(origin: THREE.Vector3, dir: THREE.Vector3, opts: SpawnOpts) {
    let b = this.pool.pop();
    if (!b) {
      const mesh = new THREE.Mesh(this.geo, glowMaterial(opts.color, 1.8));
      mesh.castShadow = false;
      b = {
        mesh, vel: new THREE.Vector3(), life: 0, damage: 0, alive: false,
        pierce: 0, splashRadius: 0, splashDamage: 0, hit: new Set<number>(),
      };
    }
    const mat = b.mesh.material as THREE.MeshStandardMaterial;
    mat.color.set(opts.color);
    mat.emissive.set(opts.color);

    b.mesh.position.copy(origin);
    b.vel.copy(dir).normalize().multiplyScalar(opts.speed);
    b.life = 1.3;
    b.damage = opts.damage;
    b.pierce = opts.pierce;
    b.splashRadius = opts.splashRadius;
    b.splashDamage = opts.splashDamage;
    b.hit.clear();
    b.alive = true;
    b.mesh.visible = true;
    b.mesh.scale.set(opts.scale, opts.scale * 1.4, opts.scale);
    // Orient the capsule's long (Y) axis along the flight direction.
    b.mesh.quaternion.setFromUnitVectors(_UP, _dir.copy(b.vel).normalize());
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
      splashDamage: d.splashDamage ? Math.round(d.splashDamage * 2) : d.splashDamage,
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

  /** Refill mag + reserve to factory spec (Full Pockets gum). */
  refill() {
    this.ammo = this.def.magSize;
    this.reserve = this.def.reserve;
    this.reloading = false;
  }

  /** Attempt to fire toward `dir`; spawns bullets and returns true if it shot. */
  tryFire(origin: THREE.Vector3, dir: THREE.Vector3, bullets: BulletSystem, fireRateMul = 1): boolean {
    if (this.cooldown > 0 || this.reloading) return false;
    if (this.ammo <= 0) {
      this.reload();
      return false;
    }
    this.ammo--;
    this.cooldown = 1 / (this.def.fireRate * fireRateMul);

    const d = this.def;
    const opts: SpawnOpts = {
      speed: d.bulletSpeed,
      damage: d.damage,
      pierce: d.pierce ?? 0,
      splashRadius: d.splashRadius ?? 0,
      splashDamage: d.splashDamage ?? 0,
      color: d.bulletColor ?? COLORS.bullet,
      scale: d.bulletScale ?? 1,
    };

    const base = new THREE.Vector3(dir.x, 0, dir.z).normalize();
    for (let p = 0; p < d.pellets; p++) {
      const a = (Math.random() * 2 - 1) * d.spread;
      const dd = base.clone().applyAxisAngle(_UP, a);
      bullets.spawn(origin, dd, opts);
    }
    if (this.ammo <= 0) this.reload();
    return true;
  }
}
