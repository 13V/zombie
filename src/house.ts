import * as THREE from "three";
import { voxelMaterial, toyMaterial, glowMaterial, VOX } from "./palette";

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
  | "wall" | "floor" | "roof" | "door" | "window" | "fence" | "tree" | "lamp" | "flower";

export interface HousePart {
  kind: PartKind;
  /** Grid cell on the plot (gx,gz in [-2..2]) + stack height (gy). */
  gx: number;
  gy: number;
  gz: number;
  color?: number;
}

export interface HouseData {
  parts: HousePart[];
}

/** Palette of placeable parts shown in the build bar. */
export const HOUSE_PARTS: { kind: PartKind; label: string; color: number; tall?: boolean }[] = [
  { kind: "floor", label: "Floor", color: VOX.path ?? 0xc9a96e },
  { kind: "wall", label: "Wall", color: VOX.houseWall ?? 0xede4d0, tall: true },
  { kind: "roof", label: "Roof", color: VOX.roofRed ?? 0xb6452f },
  { kind: "door", label: "Door", color: 0x8a5a32, tall: true },
  { kind: "window", label: "Window", color: 0x9fe8ff, tall: true },
  { kind: "fence", label: "Fence", color: 0xb6a273 },
  { kind: "tree", label: "Tree", color: 0x5fb04a, tall: true },
  { kind: "lamp", label: "Lamp", color: 0xffd24a, tall: true },
  { kind: "flower", label: "Flower", color: 0xff8fb0 },
];

const CELL = 1.2; // world size of a plot grid cell

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
      parts.push({ kind: o.kind as PartKind, gx, gy, gz, color: typeof o.color === "number" ? o.color : undefined });
    }
  }
  if (parts.length > 400) parts.length = 400; // hard cap so a forged blob can't bloat
  return { parts };
}
