import * as THREE from "three";
import { voxelMaterial, toyMaterial, glowMaterial, VOX } from "./palette";
import { Pet, findAnyPet } from "./pets";

/**
 * Player housing on the island. A house is a small, server-persisted layout of
 * voxel "parts" placed on a 6x6 plot pad. Kept intentionally simple + data-
 * driven so it round-trips as JSON to the backend (and falls back to
 * localStorage when no backend is configured).
 *
 * The MODEL (HouseData) is pure data; the VIEW (HouseView) builds meshes from
 * it. main.ts owns placement input + save/load.
 */

export type PartKind =
  | "wall" | "floor" | "roof" | "door" | "window" | "fence" | "tree" | "lamp" | "flower"
  // furniture
  | "bed" | "table" | "chair" | "rug"
  // yard
  | "lamppost" | "bush" | "path"
  // show-off
  | "banner" | "statue" | "perch" | "trophy";

export interface HousePart {
  kind: PartKind;
  /** Grid cell on the plot (gx,gz in [-2..2]) + stack height (gy). */
  gx: number;
  gy: number;
  gz: number;
  color?: number;
  /** 4-way yaw, rot*90° (0..3). Optional — absent means 0. */
  rot?: 0 | 1 | 2 | 3;
  /** For a "perch": which owned pet to display (pet def id). */
  petId?: string;
  /** For a "trophy": tier 0..3 = Bronze/Silver/Gold/Diamond. */
  tier?: 0 | 1 | 2 | 3;
}

export interface HouseData {
  parts: HousePart[];
}

/** Build-bar categories (tabs). */
export type PartCat = "structure" | "furniture" | "yard" | "showoff";
export const PART_CATS: { id: PartCat; label: string }[] = [
  { id: "structure", label: "Structure" },
  { id: "furniture", label: "Furniture" },
  { id: "yard", label: "Yard" },
  { id: "showoff", label: "Show-off" },
];

/** Paint swatches offered in build mode (cozy toy palette). */
export const HOUSE_SWATCHES: number[] = [
  0xede4d0, 0xb6452f, 0x8a5a32, 0x9fe8ff, 0x5fb04a, 0xffd24a,
  0xff8fb0, 0x7a6cff, 0xff7a3a, 0x44d0c0, 0xffffff, 0x33363f,
];

/** Palette of placeable parts shown in the build bar. */
export const HOUSE_PARTS: { kind: PartKind; label: string; color: number; tall?: boolean; cat: PartCat }[] = [
  { kind: "floor", label: "Floor", color: VOX.path ?? 0xc9a96e, cat: "structure" },
  { kind: "wall", label: "Wall", color: VOX.houseWall ?? 0xede4d0, tall: true, cat: "structure" },
  { kind: "roof", label: "Roof", color: VOX.roofRed ?? 0xb6452f, cat: "structure" },
  { kind: "door", label: "Door", color: 0x8a5a32, tall: true, cat: "structure" },
  { kind: "window", label: "Window", color: 0x9fe8ff, tall: true, cat: "structure" },
  { kind: "fence", label: "Fence", color: 0xb6a273, cat: "structure" },
  { kind: "tree", label: "Tree", color: 0x5fb04a, tall: true, cat: "yard" },
  { kind: "lamp", label: "Lamp", color: 0xffd24a, tall: true, cat: "yard" },
  { kind: "flower", label: "Flower", color: 0xff8fb0, cat: "yard" },
  // furniture
  { kind: "bed", label: "Bed", color: 0x6c8cff, cat: "furniture" },
  { kind: "table", label: "Table", color: 0x9a6b3f, cat: "furniture" },
  { kind: "chair", label: "Chair", color: 0xc98a4a, cat: "furniture" },
  { kind: "rug", label: "Rug", color: 0xd14b6a, cat: "furniture" },
  // yard
  { kind: "lamppost", label: "Lamppost", color: 0xffe08a, tall: true, cat: "yard" },
  { kind: "bush", label: "Bush", color: 0x4f9a3e, cat: "yard" },
  { kind: "path", label: "Path", color: 0xc9a96e, cat: "yard" },
  // show-off
  { kind: "banner", label: "Banner", color: 0xd14b6a, tall: true, cat: "showoff" },
  { kind: "statue", label: "Statue", color: 0xcfd3da, tall: true, cat: "showoff" },
  { kind: "perch", label: "Pet Perch", color: 0xc7a86b, cat: "showoff" },
  { kind: "trophy", label: "Trophy", color: 0xffcf3f, cat: "showoff" },
];

const CELL = 1.2; // world size of a plot grid cell

/** Trophy tiers, gated by best round. Index = tier. */
export const TROPHY_TIERS: { label: string; color: number; minRound: number }[] = [
  { label: "Bronze", color: 0xcd7f32, minRound: 1 },
  { label: "Silver", color: 0xc7ccd6, minRound: 6 },
  { label: "Gold", color: 0xffcf3f, minRound: 11 },
  { label: "Diamond", color: 0x7fe3ff, minRound: 16 },
];

/** Highest trophy tier (0..3) earned for a given best round. */
export function trophyTierForRound(bestRound: number): 0 | 1 | 2 | 3 {
  let t: 0 | 1 | 2 | 3 = 0;
  for (let i = 0; i < TROPHY_TIERS.length; i++) if (bestRound >= TROPHY_TIERS[i].minRound) t = i as 0 | 1 | 2 | 3;
  return t;
}

/** A simple starter house so a fresh plot isn't empty when claimed. */
export function starterHouse(): HouseData {
  const parts: HousePart[] = [];
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) parts.push({ kind: "floor", gx: x, gy: 0, gz: z });
  // walls around the back + sides
  for (let x = -1; x <= 1; x++) parts.push({ kind: "wall", gx: x, gy: 1, gz: -1 });
  parts.push({ kind: "wall", gx: -1, gy: 1, gz: 0 }, { kind: "wall", gx: 1, gy: 1, gz: 0 });
  parts.push({ kind: "door", gx: 0, gy: 1, gz: 1 });
  parts.push({ kind: "window", gx: -1, gy: 1, gz: 1 }, { kind: "window", gx: 1, gy: 1, gz: 1 });
  for (let x = -1; x <= 1; x++) for (let z = -1; z <= 1; z++) parts.push({ kind: "roof", gx: x, gy: 2, gz: z });
  parts.push({ kind: "lamp", gx: 2, gy: 1, gz: 2 }, { kind: "flower", gx: -2, gy: 0, gz: 2 });
  return { parts };
}

/** Renders a HouseData onto a plot anchor; rebuildable when the layout changes. */
export class HouseView {
  readonly group = new THREE.Group();

  constructor(scene: THREE.Scene, anchor: THREE.Vector3) {
    this.group.position.copy(anchor);
    this.group.position.y = 0.2; // sit on the plot pad
    scene.add(this.group);
  }

  /** Rebuild all meshes from data (called on load + after each edit). */
  render(data: HouseData) {
    for (let i = this.group.children.length - 1; i >= 0; i--) {
      const c = this.group.children[i];
      this.group.remove(c);
    }
    for (const p of data.parts) this.addPart(p);
  }

  private addPart(p: HousePart) {
    const x = p.gx * CELL;
    const z = p.gz * CELL;
    const yBase = p.gy * CELL;
    const def = HOUSE_PARTS.find((d) => d.kind === p.kind);
    const color = p.color ?? def?.color ?? 0xcccccc;
    let mesh: THREE.Object3D;
    switch (p.kind) {
      case "floor":
        mesh = new THREE.Mesh(new THREE.BoxGeometry(CELL, 0.2, CELL), voxelMaterial(color));
        mesh.position.set(x, yBase + 0.1, z);
        break;
      case "wall":
        mesh = new THREE.Mesh(new THREE.BoxGeometry(CELL, CELL, 0.2), toyMaterial(color));
        mesh.position.set(x, yBase + CELL / 2, z);
        break;
      case "roof": {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(CELL * 1.05, 0.3, CELL * 1.05), voxelMaterial(color));
        mesh.position.set(x, yBase + 0.15, z);
        break;
      }
      case "door":
        mesh = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.7, CELL, 0.22), toyMaterial(color));
        mesh.position.set(x, yBase + CELL / 2, z);
        break;
      case "window":
        mesh = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.7, CELL * 0.6, 0.22), glowMaterial(color, 0.5));
        mesh.position.set(x, yBase + CELL / 2, z);
        break;
      case "fence":
        mesh = new THREE.Mesh(new THREE.BoxGeometry(CELL, 0.5, 0.12), voxelMaterial(color));
        mesh.position.set(x, yBase + 0.35, z);
        break;
      case "tree": {
        const g = new THREE.Group();
        const tk = new THREE.Mesh(new THREE.BoxGeometry(0.3, 1.0, 0.3), voxelMaterial(0x8a5a32));
        tk.position.y = 0.5;
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 1.0), voxelMaterial(color));
        top.position.y = 1.3;
        g.add(tk, top);
        g.position.set(x, yBase, z);
        mesh = g;
        break;
      }
      case "lamp": {
        const g = new THREE.Group();
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.1, 0.16), voxelMaterial(0x444448));
        post.position.y = 0.55;
        const bulb = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), glowMaterial(color, 1.2));
        bulb.position.y = 1.2;
        g.add(post, bulb);
        g.position.set(x, yBase, z);
        mesh = g;
        break;
      }
      case "bed": {
        const g = new THREE.Group();
        const frame = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.9, 0.3, CELL * 0.7), voxelMaterial(0x8a5a32));
        frame.position.y = 0.15;
        const quilt = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.86, 0.18, CELL * 0.5), toyMaterial(color));
        quilt.position.set(0, 0.34, 0.08);
        const pillow = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.7, 0.16, 0.26), toyMaterial(0xffffff));
        pillow.position.set(0, 0.36, -CELL * 0.28);
        g.add(frame, quilt, pillow);
        g.position.set(x, yBase + 0.2, z);
        mesh = g;
        break;
      }
      case "table": {
        const g = new THREE.Group();
        const top = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.7, 0.12, CELL * 0.7), voxelMaterial(color));
        top.position.y = 0.55;
        for (const [lx, lz] of [[-0.28, -0.28], [0.28, -0.28], [-0.28, 0.28], [0.28, 0.28]] as const) {
          const leg = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.1), voxelMaterial(0x6b4a2a));
          leg.position.set(lx * CELL, 0.25, lz * CELL);
          g.add(leg);
        }
        g.add(top);
        g.position.set(x, yBase + 0.2, z);
        mesh = g;
        break;
      }
      case "chair": {
        const g = new THREE.Group();
        const seat = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.4, 0.1, CELL * 0.4), voxelMaterial(color));
        seat.position.y = 0.4;
        const back = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.4, 0.5, 0.1), voxelMaterial(color));
        back.position.set(0, 0.65, -CELL * 0.18);
        g.add(seat, back);
        g.position.set(x, yBase + 0.2, z);
        mesh = g;
        break;
      }
      case "rug":
        mesh = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.95, 0.06, CELL * 0.95), toyMaterial(color));
        mesh.position.set(x, yBase + 0.23, z);
        break;
      case "path":
        mesh = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.95, 0.1, CELL * 0.95), voxelMaterial(color));
        mesh.position.set(x, yBase + 0.05, z);
        break;
      case "bush": {
        const g = new THREE.Group();
        const a = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), voxelMaterial(color));
        a.position.y = 0.25;
        const b = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.4, 0.4), voxelMaterial(color));
        b.position.set(0.25, 0.45, 0.1);
        g.add(a, b);
        g.position.set(x, yBase, z);
        mesh = g;
        break;
      }
      case "lamppost": {
        const g = new THREE.Group();
        const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.8, 0.14), voxelMaterial(0x33363f));
        post.position.y = 0.9;
        const arm = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.12, 0.12), voxelMaterial(0x33363f));
        arm.position.set(0.2, 1.7, 0);
        const lant = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.26), glowMaterial(color, 1.4));
        lant.position.set(0.4, 1.55, 0);
        g.add(post, arm, lant);
        g.position.set(x, yBase, z);
        mesh = g;
        break;
      }
      case "banner": {
        const g = new THREE.Group();
        const pole = new THREE.Mesh(new THREE.BoxGeometry(0.1, CELL * 1.4, 0.1), voxelMaterial(0x6b4a2a));
        pole.position.y = CELL * 0.7;
        const cloth = new THREE.Mesh(new THREE.BoxGeometry(0.7, CELL * 0.9, 0.06), toyMaterial(color));
        cloth.position.set(0.4, CELL * 0.85, 0);
        g.add(pole, cloth);
        g.position.set(x, yBase, z);
        mesh = g;
        break;
      }
      case "statue": {
        const g = new THREE.Group();
        const base = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.6, 0.3, CELL * 0.6), voxelMaterial(0x9aa0ac));
        base.position.y = 0.15;
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.8, 0.3), voxelMaterial(color));
        body.position.y = 0.7;
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), voxelMaterial(color));
        head.position.y = 1.27;
        g.add(base, body, head);
        g.position.set(x, yBase, z);
        mesh = g;
        break;
      }
      case "perch": {
        const g = new THREE.Group();
        // a little plinth…
        const base = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.7, 0.3, CELL * 0.7), voxelMaterial(color));
        base.position.y = 0.15;
        const top = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.55, 0.12, CELL * 0.55), voxelMaterial(0xffffff));
        top.position.y = 0.36;
        g.add(base, top);
        // …showing the owned pet's actual voxel model (reuse pets.ts Pet).
        const def = p.petId ? findAnyPet(p.petId) : undefined;
        if (def) {
          const pet = new Pet(def, 0, 1);
          pet.group.scale.setScalar(0.7);
          pet.group.position.y = 0.42;
          g.add(pet.group);
        }
        g.position.set(x, yBase, z);
        mesh = g;
        break;
      }
      case "trophy": {
        const g = new THREE.Group();
        const tier = TROPHY_TIERS[p.tier ?? 0] ?? TROPHY_TIERS[0];
        const metal = p.color ?? tier.color;
        const plinth = new THREE.Mesh(new THREE.BoxGeometry(CELL * 0.5, 0.3, CELL * 0.5), voxelMaterial(0x3a3d46));
        plinth.position.y = 0.15;
        const stem = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.35, 0.12), glowMaterial(metal, 0.6));
        stem.position.y = 0.47;
        const cup = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.34), glowMaterial(metal, 0.9));
        cup.position.y = 0.82;
        // little handles
        for (const hx of [-0.32, 0.32]) {
          const h = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.26, 0.1), glowMaterial(metal, 0.9));
          h.position.set(hx, 0.82, 0);
          g.add(h);
        }
        g.add(plinth, stem, cup);
        g.position.set(x, yBase, z);
        mesh = g;
        break;
      }
      case "flower":
      default: {
        const g = new THREE.Group();
        const stem = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.4, 0.1), voxelMaterial(0x5fb04a));
        stem.position.y = 0.2;
        const bloom = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), glowMaterial(color, 0.6));
        bloom.position.y = 0.5;
        g.add(stem, bloom);
        g.position.set(x, yBase, z);
        mesh = g;
        break;
      }
    }
    // 4-way yaw: rotate the finished mesh in place about its own cell centre.
    if (p.rot) mesh.rotation.y = (p.rot * Math.PI) / 2;
    this.group.add(mesh);
  }

  dispose(scene: THREE.Scene) {
    scene.remove(this.group);
  }
}

/** Validate/sanitize HouseData coming from storage or the network. */
export function sanitizeHouse(raw: unknown): HouseData {
  const parts: HousePart[] = [];
  const arr = (raw as { parts?: unknown })?.parts;
  if (Array.isArray(arr)) {
    for (const p of arr) {
      if (!p || typeof p !== "object") continue;
      const o = p as Partial<HousePart>;
      if (typeof o.kind !== "string" || !HOUSE_PARTS.some((d) => d.kind === o.kind)) continue;
      const gx = Number(o.gx), gy = Number(o.gy), gz = Number(o.gz);
      if (![gx, gy, gz].every(Number.isFinite)) continue;
      if (Math.abs(gx) > 2 || Math.abs(gz) > 2 || gy < 0 || gy > 4) continue; // clamp to plot
      const rotN = Number(o.rot);
      const rot = Number.isFinite(rotN) ? ((((rotN % 4) + 4) % 4) as 0 | 1 | 2 | 3) : undefined;
      // petId only meaningful on a perch + must name a real pet def
      const petId =
        o.kind === "perch" && typeof o.petId === "string" && findAnyPet(o.petId) ? o.petId : undefined;
      const tierN = Number(o.tier);
      const tier =
        o.kind === "trophy" && Number.isFinite(tierN)
          ? (Math.min(3, Math.max(0, Math.floor(tierN))) as 0 | 1 | 2 | 3)
          : undefined;
      parts.push({
        kind: o.kind as PartKind,
        gx, gy, gz,
        color: typeof o.color === "number" ? o.color : undefined,
        ...(rot ? { rot } : {}),
        ...(petId ? { petId } : {}),
        ...(tier !== undefined ? { tier } : {}),
      });
    }
  }
  if (parts.length > 400) parts.length = 400; // hard cap so a forged blob can't bloat
  return { parts };
}
