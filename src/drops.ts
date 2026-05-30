import * as THREE from "three";

/** What a pickup does when collected. The Game maps these to real effects. */
export type DropKind =
  | "ammo"
  | "points"
  | "heal"
  | "doublePoints"
  | "rapidFire"
  | "instakill"
  | "nuke"
  | "treasure";

interface DropDef {
  kind: DropKind;
  label: string;
  color: number;
  weight: number; // relative spawn weight (rarer kinds are smaller)
}

// Weighted loot table — commons drip steadily, the spicy ones are rare jackpots.
const TABLE: DropDef[] = [
  { kind: "ammo", label: "MAX AMMO", color: 0x6ad7ff, weight: 26 },
  { kind: "points", label: "BONUS", color: 0xffe14a, weight: 24 },
  { kind: "heal", label: "MEDKIT", color: 0x66e06a, weight: 20 },
  { kind: "doublePoints", label: "2X POINTS", color: 0xffd24a, weight: 12 },
  { kind: "rapidFire", label: "RAPID FIRE", color: 0x6ad7ff, weight: 10 },
  { kind: "instakill", label: "INSTA-KILL", color: 0xff5d8f, weight: 6 },
  { kind: "nuke", label: "NUKE", color: 0xff7a3a, weight: 4 },
  { kind: "treasure", label: "TREASURE", color: 0xffc94a, weight: 4 },
];
const TOTAL_WEIGHT = TABLE.reduce((s, d) => s + d.weight, 0);

interface Drop {
  group: THREE.Group;
  gem: THREE.Mesh;
  glow: THREE.Sprite;
  def: DropDef;
  life: number;
  bob: number;
  active: boolean;
}

const MAX_DROPS = 24;
const LIFETIME = 14;
const PICKUP_RADIUS = 1.3;

/** Pooled, bobbing loot pickups dropped by zombies. */
export class Drops {
  private pool: Drop[] = [];
  private gemGeo = new THREE.OctahedronGeometry(0.32, 0);
  private glowTex = makeGlow();

  constructor(private scene: THREE.Scene) {}

  private rollDef(forceGood: boolean): DropDef {
    if (forceGood) {
      // boss/treasure rolls bias to the exciting half of the table
      const good = TABLE.filter((d) => d.weight <= 12);
      return good[Math.floor(Math.random() * good.length)];
    }
    let r = Math.random() * TOTAL_WEIGHT;
    for (const d of TABLE) {
      if (r < d.weight) return d;
      r -= d.weight;
    }
    return TABLE[0];
  }

  private obtain(): Drop | undefined {
    let d = this.pool.find((x) => !x.active);
    if (!d) {
      if (this.pool.length >= MAX_DROPS) return undefined;
      const group = new THREE.Group();
      const gem = new THREE.Mesh(
        this.gemGeo,
        new THREE.MeshStandardMaterial({ roughness: 0.3, metalness: 0.1, emissiveIntensity: 0.8 }),
      );
      gem.position.y = 0.7;
      const glow = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.glowTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      glow.scale.set(2.2, 2.2, 1);
      glow.position.y = 0.7;
      group.add(glow, gem);
      d = { group, gem, glow, def: TABLE[0], life: 0, bob: 0, active: false };
      this.pool.push(d);
    }
    return d;
  }

  /** Maybe spawn a drop at a kill location, given the run's drop chance. */
  maybeSpawn(pos: THREE.Vector3, chance: number, force = false): void {
    if (!force && Math.random() > chance) return;
    const d = this.obtain();
    if (!d) return;
    d.def = this.rollDef(force);
    const mat = d.gem.material as THREE.MeshStandardMaterial;
    mat.color.set(d.def.color);
    mat.emissive.set(d.def.color);
    (d.glow.material as THREE.SpriteMaterial).color.set(d.def.color);
    d.group.position.set(pos.x, 0, pos.z);
    d.life = LIFETIME;
    d.bob = Math.random() * Math.PI * 2;
    d.active = true;
    d.group.visible = true;
    this.scene.add(d.group);
  }

  /**
   * Advance pickups; collect any the player walks over. Calls `onCollect` with
   * the kind + label + color so the HUD/audio can react.
   */
  update(dt: number, playerPos: THREE.Vector3, onCollect: (kind: DropKind, label: string, color: number) => void): void {
    for (const d of this.pool) {
      if (!d.active) continue;
      d.life -= dt;
      d.bob += dt * 3;
      d.gem.rotation.y += dt * 2;
      d.gem.position.y = 0.7 + Math.sin(d.bob) * 0.12;
      d.glow.position.y = d.gem.position.y;
      // blink out in the final 3s so it's clear it's about to vanish
      if (d.life < 3) d.group.visible = Math.sin(d.life * 12) > -0.3;
      if (d.life <= 0) {
        this.retire(d);
        continue;
      }
      const dx = d.group.position.x - playerPos.x;
      const dz = d.group.position.z - playerPos.z;
      if (dx * dx + dz * dz < PICKUP_RADIUS * PICKUP_RADIUS) {
        onCollect(d.def.kind, d.def.label, d.def.color);
        this.retire(d);
      }
    }
  }

  private retire(d: Drop) {
    d.active = false;
    d.group.visible = false;
    this.scene.remove(d.group);
  }

  clear() {
    for (const d of this.pool) if (d.active) this.retire(d);
  }
}

/** Soft radial glow sprite texture, generated once. */
function makeGlow(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createRadialGradient(32, 32, 0, 32, 32, 32);
  grad.addColorStop(0, "rgba(255,255,255,0.9)");
  grad.addColorStop(0.4, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 64, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
