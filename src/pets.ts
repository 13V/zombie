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
  shape: "bee" | "drone" | "dragon" | "ghost" | "turret" | "wisp";
  range: number; // how far it will engage
}

export const PETS: PetDef[] = [
  {
    id: "beebot", name: "Bee Buddy", desc: "Fires homing stingers", cost: 300, color: 0xffd24a,
    damage: 14, interval: 0.5, bulletColor: 0xffe14a, bulletScale: 0.6, pierce: 1, splashRadius: 0, splashDamage: 0, homing: 1, shape: "bee", range: 16,
  },
  {
    id: "wisp", name: "Spark Wisp", desc: "Rapid little zaps", cost: 450, color: 0x6ad7ff,
    damage: 10, interval: 0.28, bulletColor: 0x9fe8ff, bulletScale: 0.5, pierce: 0, splashRadius: 0, splashDamage: 0, homing: 0, shape: "wisp", range: 15,
  },
  {
    id: "turret", name: "Mini Turret", desc: "Heavy piercing rounds", cost: 700, color: 0x8a98a8,
    damage: 40, interval: 0.7, bulletColor: 0xffc06a, bulletScale: 1.1, pierce: 3, splashRadius: 0, splashDamage: 0, homing: 0, shape: "turret", range: 18,
  },
  {
    id: "ghost", name: "Boo Ghost", desc: "Spooky splash orbs", cost: 900, color: 0xc792ea,
    damage: 30, interval: 0.9, bulletColor: 0xc792ea, bulletScale: 1.3, pierce: 0, splashRadius: 2.0, splashDamage: 24, homing: 1, shape: "ghost", range: 16,
  },
  {
    id: "dragon", name: "Baby Dragon", desc: "Spits explosive fireballs", cost: 1600, color: 0xff5a3a,
    damage: 70, interval: 0.6, bulletColor: 0xff7a3a, bulletScale: 1.5, pierce: 2, splashRadius: 2.6, splashDamage: 60, homing: 1, shape: "dragon", range: 20,
  },
];

export function findPet(id: string): PetDef | undefined {
  return PETS.find((p) => p.id === id);
}

/** A live pet orbiting the player. */
export class Pet {
  readonly group = new THREE.Group();
  private cd: number;
  private bob: number;

  constructor(readonly def: PetDef, private orbitAngle: number) {
    this.cd = Math.random() * def.interval;
    this.bob = Math.random() * Math.PI * 2;
    this.build();
    this.group.scale.setScalar(0.7);
  }

  private build() {
    const body = voxelMaterial(this.def.color);
    const glow = glowMaterial(this.def.color, 0.8);
    const box = (w: number, h: number, d: number, x: number, y: number, z: number, mat: THREE.Material) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), mat);
      m.position.set(x, y, z);
      this.group.add(m);
      return m;
    };
    switch (this.def.shape) {
      case "bee":
        box(0.5, 0.4, 0.5, 0, 0, 0, body);
        box(0.55, 0.12, 0.55, 0, 0.06, 0, voxelMaterial(0x222222));
        box(0.18, 0.04, 0.3, -0.32, 0.18, 0, glow);
        box(0.18, 0.04, 0.3, 0.32, 0.18, 0, glow);
        break;
      case "wisp":
        box(0.4, 0.4, 0.4, 0, 0, 0, glow);
        box(0.18, 0.18, 0.18, 0, 0.32, 0, glow);
        break;
      case "turret":
        box(0.6, 0.4, 0.6, 0, 0, 0, body);
        box(0.2, 0.2, 0.6, 0, 0.08, 0.4, voxelMaterial(0x333a44));
        box(0.5, 0.16, 0.5, 0, -0.24, 0, voxelMaterial(0x556070));
        break;
      case "ghost":
        box(0.5, 0.6, 0.5, 0, 0, 0, glowMaterial(this.def.color, 0.5));
        box(0.12, 0.12, 0.06, -0.12, 0.12, 0.26, voxelMaterial(0x111111));
        box(0.12, 0.12, 0.06, 0.12, 0.12, 0.26, voxelMaterial(0x111111));
        break;
      case "dragon":
        box(0.6, 0.5, 0.8, 0, 0, 0, body);
        box(0.4, 0.4, 0.4, 0, 0.16, 0.5, body); // head
        box(0.5, 0.06, 0.4, -0.45, 0.2, -0.1, glow); // wings
        box(0.5, 0.06, 0.4, 0.45, 0.2, -0.1, glow);
        box(0.14, 0.14, 0.14, 0, 0.18, 0.78, glowMaterial(0xffd24a, 1.2)); // snout glow
        break;
      default:
        box(0.5, 0.5, 0.5, 0, 0, 0, body);
    }
  }

  /**
   * Update orbit + fire. Returns a shot {origin,dir} when it fires this frame,
   * else null. `target` is the nearest zombie position (or null).
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

    // face + fire at target
    this.cd -= dt;
    if (target) {
      const dx = target.x - ox;
      const dz = target.z - oz;
      const dist = Math.hypot(dx, dz);
      this.group.rotation.y = Math.atan2(dx, dz);
      if (dist <= this.def.range && this.cd <= 0) {
        this.cd = this.def.interval;
        const len = dist || 1;
        return { ox, oz, dx: dx / len, dz: dz / len };
      }
    }
    return null;
  }
}
