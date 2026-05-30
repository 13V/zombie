import * as THREE from "three";
import { voxelMaterial, glowMaterial } from "./palette";

/**
 * Companion pets bought with gold. Each is a small floating voxel critter that
 * orbits the player, auto-targets the nearest zombie, and fires real bullets
 * through the shared BulletSystem (so all collision / damage / FX come free).
 *
 * Pets are the late-game chaos + the gold sink: stack several and the screen
 * fills with autonomous fire.
 */

export interface PetDef {
  id: string;
  name: string;
  desc: string;
  cost: number; // gold
  color: number;
  /** Secondary tone (belly/accent) — falls back to a darkened color if unset. */
  accent?: number;
  /** Bullet damage, fire interval (s), bullet color/scale, special behavior. */
  damage: number;
  interval: number;
  bulletColor: number;
  bulletScale: number;
  pierce: number;
  splashRadius: number;
  splashDamage: number;
  homing: number;
  /** Visual builder tag. */
  shape: "bee" | "drone" | "dragon" | "ghost" | "turret" | "wisp" | "piggy" | "totem";
  range: number; // how far it will engage
  /** Non-combat roles. "banker": earns gold over time + on kills nearby.
   *  "buffer": boosts other pets' damage. (default = combat shooter) */
  role?: "banker" | "buffer";
  /** banker: gold per second passively. buffer: +damage fraction to other pets. */
  roleValue?: number;
  /** At `evolveLevel`, the pet transforms into the `evolvesTo` def (bigger,
   *  stronger model + new behavior). The big idle payoff. */
  evolveLevel?: number;
  evolvesTo?: string;
}

/** Evolved pet forms — not buyable directly; a base pet evolves into these. */
export const PET_EVOLUTIONS: PetDef[] = [
  {
    id: "beebot_evo", name: "Queen Bee", desc: "A royal swarm of stingers", cost: 0, color: 0xffcf3a, accent: 0x2a2a2a,
    damage: 22, interval: 0.32, bulletColor: 0xffe14a, bulletScale: 0.7, pierce: 2, splashRadius: 0, splashDamage: 0, homing: 1, shape: "bee", range: 18,
  },
  {
    id: "turret_evo", name: "War Drone", desc: "Twin piercing autocannons", cost: 0, color: 0x9fb6ff, accent: 0x2a3450,
    damage: 70, interval: 0.45, bulletColor: 0x9fe8ff, bulletScale: 1.3, pierce: 5, splashRadius: 0, splashDamage: 0, homing: 0, shape: "turret", range: 22,
  },
  {
    id: "ghost_evo", name: "Reaper", desc: "Wide haunting splash", cost: 0, color: 0x9a5ad6, accent: 0xf3e6ff,
    damage: 55, interval: 0.7, bulletColor: 0xc792ea, bulletScale: 1.7, pierce: 1, splashRadius: 3.0, splashDamage: 50, homing: 1, shape: "ghost", range: 18,
  },
  {
    id: "dragon_evo", name: "Elder Dragon", desc: "Devastating fireball barrage", cost: 0, color: 0xff3a2a, accent: 0xffd24a,
    damage: 140, interval: 0.45, bulletColor: 0xff7a3a, bulletScale: 2.0, pierce: 4, splashRadius: 3.4, splashDamage: 110, homing: 1, shape: "dragon", range: 24,
  },
];

export function findAnyPet(id: string): PetDef | undefined {
  return PETS.find((p) => p.id === id) ?? PET_EVOLUTIONS.find((p) => p.id === id);
}

export const PETS: PetDef[] = [
  {
    id: "beebot", name: "Bee Buddy", desc: "Fires homing stingers", cost: 300, color: 0xffd24a, accent: 0x2a2a2a,
    damage: 14, interval: 0.5, bulletColor: 0xffe14a, bulletScale: 0.6, pierce: 1, splashRadius: 0, splashDamage: 0, homing: 1, shape: "bee", range: 16,
    evolveLevel: 10, evolvesTo: "beebot_evo",
  },
  {
    id: "wisp", name: "Spark Wisp", desc: "Rapid little zaps", cost: 450, color: 0x6ad7ff, accent: 0xeaffff,
    damage: 10, interval: 0.28, bulletColor: 0x9fe8ff, bulletScale: 0.5, pierce: 0, splashRadius: 0, splashDamage: 0, homing: 0, shape: "wisp", range: 15,
  },
  {
    id: "turret", name: "Mini Turret", desc: "Heavy piercing rounds", cost: 700, color: 0x8a98a8, accent: 0x3a4450,
    damage: 40, interval: 0.7, bulletColor: 0xffc06a, bulletScale: 1.1, pierce: 3, splashRadius: 0, splashDamage: 0, homing: 0, shape: "turret", range: 18,
    evolveLevel: 10, evolvesTo: "turret_evo",
  },
  {
    id: "ghost", name: "Boo Ghost", desc: "Spooky splash orbs", cost: 900, color: 0xc792ea, accent: 0xf3e6ff,
    damage: 30, interval: 0.9, bulletColor: 0xc792ea, bulletScale: 1.3, pierce: 0, splashRadius: 2.0, splashDamage: 24, homing: 1, shape: "ghost", range: 16,
    evolveLevel: 10, evolvesTo: "ghost_evo",
  },
  {
    id: "dragon", name: "Baby Dragon", desc: "Spits explosive fireballs", cost: 1600, color: 0xff5a3a, accent: 0xffd24a,
    damage: 70, interval: 0.6, bulletColor: 0xff7a3a, bulletScale: 1.5, pierce: 2, splashRadius: 2.6, splashDamage: 60, homing: 1, shape: "dragon", range: 20,
    evolveLevel: 10, evolvesTo: "dragon_evo",
  },
  // ---- non-combat roles (the idle-economy hooks) ----
  {
    id: "piggy", name: "Piggy Bank", desc: "Earns gold while you play", cost: 600, color: 0xff9ec7, accent: 0xffd6e6,
    damage: 0, interval: 1, bulletColor: 0xffd24a, bulletScale: 0.5, pierce: 0, splashRadius: 0, splashDamage: 0, homing: 0, shape: "piggy", range: 0,
    role: "banker", roleValue: 1.2, // gold/sec at level 1
  },
  {
    id: "totem", name: "Power Totem", desc: "+25% damage to your other pets", cost: 1200, color: 0x7be0c0, accent: 0xffd24a,
    damage: 0, interval: 1, bulletColor: 0x7be0c0, bulletScale: 0.5, pierce: 0, splashRadius: 0, splashDamage: 0, homing: 0, shape: "totem", range: 0,
    role: "buffer", roleValue: 0.25,
  },
];

export function findPet(id: string): PetDef | undefined {
  return PETS.find((p) => p.id === id);
}

/** Gold cost to take a pet from `level` to `level+1` (escalating). */
export function petLevelCost(def: PetDef, level: number): number {
  return Math.round(def.cost * 0.5 * Math.pow(1.35, level - 1));
}

/** Damage multiplier from a pet's level (+18%/level, compounding feel). */
export function petDamageMul(level: number): number {
  return 1 + (level - 1) * 0.18;
}
/** Fire-rate (interval) multiplier — pets fire faster as they level (caps). */
export function petIntervalMul(level: number): number {
  return Math.max(0.5, 1 - (level - 1) * 0.04);
}

/** Darken a hex color by `f` (0..1). */
function darken(c: number, f: number): number {
  const r = ((c >> 16) & 255) * (1 - f);
  const g = ((c >> 8) & 255) * (1 - f);
  const b = (c & 255) * (1 - f);
  return (Math.round(r) << 16) | (Math.round(g) << 8) | Math.round(b);
}

/** A live pet orbiting the player. */
export class Pet {
  readonly group = new THREE.Group();
  private body = new THREE.Group(); // animated inner body (bob/breathe/recoil)
  private wingL?: THREE.Mesh;
  private wingR?: THREE.Mesh;
  private aura?: THREE.Mesh; // pulsing glow (wisp/ghost)
  private muzzle?: THREE.Mesh; // fire-flash node
  private cd: number;
  private bob: number;
  private flap = 0;
  private recoil = 0; // 0..1, decays — pulls the body back when firing
  private flashLife = 0;
  level: number;
  private baseScale = 0.7;

  constructor(readonly def: PetDef, private orbitAngle: number, level = 1) {
    this.level = Math.max(1, level);
    this.cd = Math.random() * def.interval;
    this.bob = Math.random() * Math.PI * 2;
    this.flap = Math.random() * Math.PI * 2;
    this.group.add(this.body);
    this.build();
    this.applyLevelVisuals();
  }

  /** Pet fires faster + (in main) hits harder as it levels. */
  get interval(): number {
    return this.def.interval * petIntervalMul(this.level);
  }
  get damageMul(): number {
    return petDamageMul(this.level);
  }

  /** Visible growth: pet gets bigger + glows brighter with level. */
  setLevel(level: number) {
    this.level = Math.max(1, level);
    this.applyLevelVisuals();
  }
  private applyLevelVisuals() {
    // grows ~6%/level up to ~+60%; emissive ramps so high pets glow hot.
    this.baseScale = 0.7 * (1 + Math.min(0.6, (this.level - 1) * 0.06));
    this.group.scale.setScalar(this.baseScale);
    const glowBoost = Math.min(1.6, 0.9 + (this.level - 1) * 0.12);
    this.group.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.MeshStandardMaterial | undefined;
      if (m && m.emissive && (m.emissive.r + m.emissive.g + m.emissive.b) > 0) {
        m.emissiveIntensity = glowBoost;
      }
    });
  }

  private build() {
    const col = this.def.color;
    const acc = this.def.accent ?? darken(col, 0.4);
    const body = voxelMaterial(col);
    const accent = voxelMaterial(acc);
    const glow = glowMaterial(col, 0.9);
    const dark = voxelMaterial(0x141414);
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material, into = this.body) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      into.add(m);
      return m;
    };
    switch (this.def.shape) {
      case "bee":
        box(0.5, 0.42, 0.5, 0, 0, 0, body);
        box(0.52, 0.1, 0.52, 0, 0.08, 0, accent); // stripe
        box(0.52, 0.1, 0.52, 0, -0.1, 0, accent);
        box(0.1, 0.1, 0.06, -0.12, 0.04, 0.26, dark); // eyes
        box(0.1, 0.1, 0.06, 0.12, 0.04, 0.26, dark);
        box(0.06, 0.16, 0.06, -0.07, 0.26, 0.2, dark); // antennae
        box(0.06, 0.16, 0.06, 0.07, 0.26, 0.2, dark);
        this.wingL = box(0.26, 0.04, 0.34, -0.34, 0.16, 0, glowMaterial(0xeaffff, 0.6));
        this.wingR = box(0.26, 0.04, 0.34, 0.34, 0.16, 0, glowMaterial(0xeaffff, 0.6));
        this.muzzle = box(0.1, 0.1, 0.1, 0, 0, 0.34, glow);
        break;
      case "wisp":
        this.aura = box(0.52, 0.52, 0.52, 0, 0, 0, glowMaterial(col, 0.5));
        box(0.32, 0.32, 0.32, 0, 0, 0, glow);
        box(0.16, 0.16, 0.16, 0, 0.34, 0, glow); // spark crown
        box(0.08, 0.08, 0.05, -0.1, 0.02, 0.2, dark);
        box(0.08, 0.08, 0.05, 0.1, 0.02, 0.2, dark);
        this.muzzle = box(0.08, 0.08, 0.08, 0, 0, 0.28, glowMaterial(0xffffff, 1.2));
        break;
      case "turret":
        box(0.5, 0.18, 0.5, 0, -0.26, 0, accent); // base
        box(0.6, 0.4, 0.6, 0, 0, 0, body);
        box(0.62, 0.1, 0.62, 0, 0.18, 0, accent); // collar
        box(0.18, 0.18, 0.6, 0, 0.06, 0.42, dark); // barrel
        box(0.1, 0.1, 0.06, -0.14, 0.08, 0.32, glow); // sight
        this.muzzle = box(0.16, 0.16, 0.1, 0, 0.06, 0.74, glow);
        break;
      case "ghost":
        this.aura = box(0.62, 0.7, 0.62, 0, 0, 0, glowMaterial(col, 0.35));
        box(0.48, 0.58, 0.48, 0, 0.02, 0, glowMaterial(col, 0.7));
        box(0.16, 0.2, 0.06, -0.13, 0.12, 0.24, dark); // big spooky eyes
        box(0.16, 0.2, 0.06, 0.13, 0.12, 0.24, dark);
        box(0.12, 0.12, 0.12, -0.16, -0.3, 0, glowMaterial(col, 0.7)); // tails
        box(0.12, 0.12, 0.12, 0.16, -0.3, 0, glowMaterial(col, 0.7));
        this.muzzle = box(0.12, 0.12, 0.12, 0, 0.0, 0.3, glow);
        break;
      case "dragon":
        box(0.62, 0.5, 0.82, 0, 0, 0, body);
        box(0.62, 0.14, 0.8, 0, -0.2, 0, accent); // belly
        box(0.42, 0.42, 0.42, 0, 0.18, 0.5, body); // head
        box(0.16, 0.14, 0.16, 0, 0.1, 0.74, accent); // snout
        box(0.1, 0.12, 0.06, -0.14, 0.28, 0.62, dark); // eyes
        box(0.1, 0.12, 0.06, 0.14, 0.28, 0.62, dark);
        box(0.07, 0.14, 0.07, -0.1, 0.42, 0.46, accent); // horns
        box(0.07, 0.14, 0.07, 0.1, 0.42, 0.46, accent);
        box(0.14, 0.14, 0.4, 0, -0.05, -0.5, body); // tail
        this.wingL = box(0.5, 0.06, 0.42, -0.5, 0.22, -0.08, glowMaterial(acc, 0.5));
        this.wingR = box(0.5, 0.06, 0.42, 0.5, 0.22, -0.08, glowMaterial(acc, 0.5));
        this.muzzle = box(0.16, 0.16, 0.16, 0, 0.12, 0.86, glowMaterial(0xffd24a, 1.4));
        break;
      case "piggy":
        box(0.6, 0.46, 0.7, 0, 0, 0, body); // round body
        box(0.18, 0.18, 0.14, 0, 0.02, 0.4, accent); // snout
        box(0.05, 0.05, 0.04, -0.05, 0.02, 0.47, dark); // nostrils
        box(0.05, 0.05, 0.04, 0.05, 0.02, 0.47, dark);
        box(0.07, 0.08, 0.04, -0.12, 0.06, 0.34, dark); // eyes
        box(0.07, 0.08, 0.04, 0.12, 0.06, 0.34, dark);
        box(0.12, 0.12, 0.04, -0.16, 0.26, 0.18, body); // ears
        box(0.12, 0.12, 0.04, 0.16, 0.26, 0.18, body);
        box(0.22, 0.06, 0.02, 0, 0.16, -0.02, glowMaterial(0xffd24a, 1.0)); // coin slot
        box(0.12, 0.1, 0.02, 0, 0, -0.36, accent); // curly tail
        break;
      case "totem":
        box(0.4, 0.2, 0.4, 0, -0.3, 0, accent); // base
        box(0.46, 0.46, 0.46, 0, 0, 0, body); // mask block
        box(0.5, 0.12, 0.5, 0, 0.26, 0, glowMaterial(this.def.color, 0.9)); // glowing top ring
        box(0.1, 0.14, 0.05, -0.12, 0.04, 0.24, glowMaterial(0xffd24a, 1.2)); // glowing eyes
        box(0.1, 0.14, 0.05, 0.12, 0.04, 0.24, glowMaterial(0xffd24a, 1.2));
        this.aura = box(0.7, 0.7, 0.7, 0, 0, 0, glowMaterial(this.def.color, 0.3)); // buff aura
        break;
      default:
        box(0.5, 0.5, 0.5, 0, 0, 0, body);
    }
    if (this.muzzle) this.muzzle.scale.setScalar(0.01); // hidden until firing
  }

  /** Visually react to firing — recoil punch + muzzle flash. */
  private onFire() {
    this.recoil = 1;
    this.flashLife = 0.12;
  }

  /**
   * Update orbit + animation + fire. Returns a shot when it fires this frame.
   */
  update(dt: number, playerX: number, playerZ: number, idx: number, total: number, target: { x: number; z: number } | null): { ox: number; oz: number; dx: number; dz: number } | null {
    // orbit around the player
    this.orbitAngle += dt * 1.4;
    const slot = (idx / Math.max(1, total)) * Math.PI * 2;
    const r = 1.8;
    const ox = playerX + Math.cos(this.orbitAngle + slot) * r;
    const oz = playerZ + Math.sin(this.orbitAngle + slot) * r;
    this.bob += dt * 4;
    this.group.position.set(ox, 1.4 + Math.sin(this.bob) * 0.12, oz);

    // ---- idle animation ----
    this.flap += dt * (this.wingL ? 26 : 8); // bees/dragons flap fast
    if (this.wingL && this.wingR) {
      const a = Math.sin(this.flap) * (this.def.shape === "dragon" ? 0.5 : 0.9);
      this.wingL.rotation.z = a;
      this.wingR.rotation.z = -a;
    }
    if (this.aura) {
      const p = 1 + Math.sin(this.bob * 1.3) * 0.12;
      this.aura.scale.setScalar(p);
      (this.aura.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.4 + (Math.sin(this.bob * 2) + 1) * 0.2;
    }
    // breathe + recoil: body squashes back when it just fired
    this.recoil = Math.max(0, this.recoil - dt * 5);
    const breathe = 1 + Math.sin(this.bob * 0.8) * 0.04;
    this.body.scale.set(breathe, breathe, breathe * (1 - this.recoil * 0.25));
    this.body.position.z = -this.recoil * 0.12;
    // muzzle flash
    if (this.muzzle) {
      this.flashLife = Math.max(0, this.flashLife - dt);
      const f = this.flashLife / 0.12;
      this.muzzle.scale.setScalar(0.01 + f * 1.1);
    }

    // face + fire at target
    this.cd -= dt;
    if (target) {
      const dx = target.x - ox;
      const dz = target.z - oz;
      const dist = Math.hypot(dx, dz);
      this.group.rotation.y = Math.atan2(dx, dz);
      if (dist <= this.def.range && this.cd <= 0) {
        this.cd = this.interval;
        this.onFire();
        const len = dist || 1;
        return { ox, oz, dx: dx / len, dz: dz / len };
      }
    }
    return null;
  }
}
