import * as THREE from "three";
import { Audio } from "./audio";
import { JUICE } from "./config";

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
  /** Visual rarity tier 0..4 (common→legendary) — drives glow/beam/chime juice. */
  tier: number;
}

// Weighted loot table — commons drip steadily, the spicy ones are rare jackpots.
// `tier` mirrors loot.ts rarity tiers for the pickup-juice scaling (glow/beam/chime).
const TABLE: DropDef[] = [
  { kind: "ammo", label: "MAX AMMO", color: 0x6ad7ff, weight: 26, tier: 0 },
  { kind: "points", label: "BONUS", color: 0xffe14a, weight: 24, tier: 0 },
  { kind: "heal", label: "MEDKIT", color: 0x66e06a, weight: 20, tier: 1 },
  { kind: "doublePoints", label: "2X POINTS", color: 0xffd24a, weight: 12, tier: 2 },
  { kind: "rapidFire", label: "RAPID FIRE", color: 0x6ad7ff, weight: 10, tier: 2 },
  { kind: "instakill", label: "INSTA-KILL", color: 0xff5d8f, weight: 6, tier: 3 },
  { kind: "nuke", label: "NUKE", color: 0xff7a3a, weight: 4, tier: 4 },
  { kind: "treasure", label: "TREASURE", color: 0xffc94a, weight: 4, tier: 4 },
];
const TOTAL_WEIGHT = TABLE.reduce((s, d) => s + d.weight, 0);

interface Drop {
  group: THREE.Group;
  gem: THREE.Mesh;
  glow: THREE.Sprite;
  beam: THREE.Sprite; // vertical light column, only shown for epic+ tiers
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
  private beamTex = makeBeam(); // shared vertical-gradient sprite for epic+ beams

  constructor(private scene: THREE.Scene, private audio?: Audio) {}

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
      // vertical light column for epic+ drops; hidden until a high-tier spawn.
      const beam = new THREE.Sprite(
        new THREE.SpriteMaterial({ map: this.beamTex, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending }),
      );
      beam.scale.set(JUICE.beamWidth, JUICE.beamHeight, 1);
      beam.position.y = JUICE.beamHeight * 0.5;
      beam.visible = false;
      group.add(beam, glow, gem);
      d = { group, gem, glow, beam, def: TABLE[0], life: 0, bob: 0, active: false };
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
    this.dress(d);
    d.group.position.set(pos.x, 0, pos.z);
    d.life = LIFETIME;
    d.bob = Math.random() * Math.PI * 2;
    d.active = true;
    d.group.visible = true;
    this.scene.add(d.group);
    this.audio?.pickup(d.def.tier); // rising chime, pitched by rarity tier
  }

  /** Apply the def's color + rarity-tiered glow size / epic+ light beam. */
  private dress(d: Drop) {
    const mat = d.gem.material as THREE.MeshStandardMaterial;
    mat.color.set(d.def.color);
    mat.emissive.set(d.def.color);
    const gs = JUICE.glowByRarity[Math.max(0, Math.min(4, d.def.tier))];
    const gm = d.glow.material as THREE.SpriteMaterial;
    gm.color.set(d.def.color);
    d.glow.scale.set(gs, gs, 1);
    const beamOn = d.def.tier >= JUICE.beamFromTier;
    d.beam.visible = beamOn;
    if (beamOn) (d.beam.material as THREE.SpriteMaterial).color.set(d.def.color);
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

/**
 * Vertical light-beam sprite: a soft column bright at the base, fading to nothing
 * at the top + edges. Generated once and tinted per-drop via material color.
 */
function makeBeam(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 32;
  c.height = 128;
  const g = c.getContext("2d")!;
  // horizontal falloff (soft edges) × vertical falloff (fades upward)
  const grad = g.createLinearGradient(0, 128, 0, 0);
  grad.addColorStop(0, "rgba(255,255,255,0.75)");
  grad.addColorStop(0.5, "rgba(255,255,255,0.28)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 32, 128);
  // taper the sides so it reads as a beam, not a slab
  const edge = g.createLinearGradient(0, 0, 32, 0);
  edge.addColorStop(0, "rgba(0,0,0,1)");
  edge.addColorStop(0.5, "rgba(0,0,0,0)");
  edge.addColorStop(1, "rgba(0,0,0,1)");
  g.globalCompositeOperation = "destination-out";
  g.fillStyle = edge;
  g.fillRect(0, 0, 32, 128);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}
