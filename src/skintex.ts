import * as THREE from "three";
import { findSkin, type Skin } from "./cosmetics";

/**
 * True pixel-texture skins (Minecraft-style). A skin is a 64×64 pixel canvas,
 * painted procedurally from the skin's colours + features, then UV-mapped onto
 * the hero's box parts (see voxelChar.applyTexture). Crisp NearestFilter pixels.
 *
 * ATLAS = the classic 64×64 region layout (head/body/arm/leg, 6 faces each).
 * voxelChar imports this to set each box's UVs; the painter fills the same rects.
 */
export const ATLAS_SIZE = 64;
type Rect = [number, number, number, number]; // x,y,w,h in atlas pixels
type Faces = { top: Rect; bottom: Rect; right: Rect; front: Rect; left: Rect; back: Rect };
export const ATLAS: { head: Faces; body: Faces; arm: Faces; leg: Faces } = {
  head: { top: [8, 0, 8, 8], bottom: [16, 0, 8, 8], right: [0, 8, 8, 8], front: [8, 8, 8, 8], left: [16, 8, 8, 8], back: [24, 8, 8, 8] },
  body: { top: [20, 16, 8, 4], bottom: [28, 16, 8, 4], right: [16, 20, 4, 12], front: [20, 20, 8, 12], left: [28, 20, 4, 12], back: [32, 20, 8, 12] },
  arm: { top: [44, 16, 4, 4], bottom: [48, 16, 4, 4], right: [40, 20, 4, 12], front: [44, 20, 4, 12], left: [48, 20, 4, 12], back: [52, 20, 4, 12] },
  leg: { top: [4, 16, 4, 4], bottom: [8, 16, 4, 4], right: [0, 20, 4, 12], front: [4, 20, 4, 12], left: [8, 20, 4, 12], back: [12, 20, 4, 12] },
};

const cache = new Map<string, THREE.Texture>();

function rgb(c: number): [number, number, number] {
  return [(c >> 16) & 0xff, (c >> 8) & 0xff, c & 0xff];
}
function mul(c: number, f: number): string {
  const [r, g, b] = rgb(c);
  return `rgb(${Math.min(255, Math.round(r * f))},${Math.min(255, Math.round(g * f))},${Math.min(255, Math.round(b * f))})`;
}

/** Fill a face rect with a base colour + light top / dark bottom shading + a
 *  faint per-pixel dither so the flat boxes read as textured cloth/skin. */
function fillFace(g: CanvasRenderingContext2D, [x, y, w, h]: Rect, color: number, seedBase: number) {
  let seed = seedBase;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  for (let iy = 0; iy < h; iy++) {
    // top rows lighter, bottom rows darker → soft volume
    const grad = 1.12 - (iy / Math.max(1, h - 1)) * 0.3;
    for (let ix = 0; ix < w; ix++) {
      const f = grad * (0.94 + rnd() * 0.12);
      g.fillStyle = mul(color, f);
      g.fillRect(x + ix, y + iy, 1, 1);
    }
  }
}

function px(g: CanvasRenderingContext2D, x: number, y: number, color: string) {
  g.fillStyle = color;
  g.fillRect(x, y, 1, 1);
}

function paint(g: CanvasRenderingContext2D, skin: Skin) {
  const skinTone = skin.head;
  const shirt = skin.body;
  const darker = (c: number, f = 0.6) => ((Math.floor(((c >> 16) & 0xff) * f) << 16) | (Math.floor(((c >> 8) & 0xff) * f) << 8) | Math.floor((c & 0xff) * f));
  const pants = skin.pants ?? darker(skin.body, 0.62);
  const shoes = skin.shoes ?? 0x2a2018;
  const hair = darker(skin.head, 0.5);
  const A = ATLAS;

  // ---- HEAD: skin tone everywhere, then hair cap + a face on the front ----
  let s = 11;
  for (const r of Object.values(A.head)) fillFace(g, r as Rect, skinTone, (s += 17));
  // hair: full top, + a 3px fringe down the front/sides/back
  fillFace(g, A.head.top, hair, 71);
  for (const f of ["front", "left", "right", "back"] as const) {
    const [x, y, w] = A.head[f];
    for (let iy = 0; iy < 3; iy++) for (let ix = 0; ix < w; ix++) px(g, x + ix, y + iy, mul(hair, 1 - iy * 0.08));
  }
  // face on the front: brows, eyes (white + pupil), nose, mouth
  const [fx, fy] = A.head.front;
  const white = "#f4f4f4", dark = mul(0x222222, 1), pupil = mul(skin.glow ?? 0x223a6a, 1);
  for (const ex of [1, 5]) {
    px(g, fx + ex, fy + 3, white); px(g, fx + ex + 1, fy + 3, white);
    px(g, fx + ex + (ex === 1 ? 1 : 0), fy + 3, pupil); // pupil
    px(g, fx + ex, fy + 2, dark); px(g, fx + ex + 1, fy + 2, dark); // brow
  }
  px(g, fx + 3, fy + 4, mul(skinTone, 0.8)); px(g, fx + 4, fy + 4, mul(skinTone, 0.8)); // nose shade
  for (let ix = 2; ix <= 5; ix++) px(g, fx + ix, fy + 6, mul(0x6a3a2a, 1)); // mouth

  // ---- BODY: shirt with a collar + optional chest emblem ----
  s = 200;
  for (const r of Object.values(A.body)) fillFace(g, r as Rect, shirt, (s += 23));
  // collar (top row of front/back lighter)
  for (const f of ["front", "back"] as const) {
    const [x, y, w] = A.body[f];
    for (let ix = 0; ix < w; ix++) px(g, x + ix, y, mul(shirt, 1.25));
  }
  // belt near the bottom
  for (const f of ["front", "back", "left", "right"] as const) {
    const [x, y, w, h] = A.body[f];
    for (let ix = 0; ix < w; ix++) { px(g, x + ix, y + h - 2, mul(0x2a2018, 1)); }
    px(g, x + Math.floor(w / 2), y + h - 2, mul(0xd8c060, 1)); // buckle hint
  }
  if (skin.emblem !== undefined) {
    const [bx, by] = A.body.front;
    for (let iy = 0; iy < 2; iy++) for (let ix = 0; ix < 2; ix++) px(g, bx + 3 + ix, by + 4 + iy, mul(skin.emblem, 1));
  }

  // ---- ARMS: sleeve (shirt) over a skin-tone hand ----
  s = 300;
  for (const r of Object.values(A.arm)) fillFace(g, r as Rect, shirt, (s += 19));
  for (const f of ["front", "back", "left", "right"] as const) {
    const [x, y, w, h] = A.arm[f];
    for (let iy = h - 3; iy < h; iy++) for (let ix = 0; ix < w; ix++) px(g, x + ix, y + iy, mul(skinTone, 0.95 - (iy - (h - 3)) * 0.05));
  }
  fillFace(g, A.arm.bottom, skinTone, 333); // palm

  // ---- LEGS: pants over shoes ----
  s = 400;
  for (const r of Object.values(A.leg)) fillFace(g, r as Rect, pants, (s += 13));
  for (const f of ["front", "back", "left", "right"] as const) {
    const [x, y, w, h] = A.leg[f];
    for (let iy = h - 3; iy < h; iy++) for (let ix = 0; ix < w; ix++) px(g, x + ix, y + iy, mul(shoes, 1 - (iy - (h - 3)) * 0.08));
  }
  fillFace(g, A.leg.bottom, shoes, 444); // sole
}

/** A pixel-texture for the given skin (cached per id). NearestFilter = crisp. */
export function skinTexture(skinId: string): THREE.Texture | null {
  const hit = cache.get(skinId);
  if (hit) return hit;
  let c: HTMLCanvasElement;
  try {
    c = document.createElement("canvas");
  } catch {
    return null;
  }
  c.width = ATLAS_SIZE;
  c.height = ATLAS_SIZE;
  const g = c.getContext("2d");
  if (!g) return null;
  g.imageSmoothingEnabled = false;
  paint(g, findSkin(skinId));
  const tex = new THREE.CanvasTexture(c);
  tex.magFilter = THREE.NearestFilter;
  tex.minFilter = THREE.NearestFilter;
  tex.generateMipmaps = false;
  tex.colorSpace = THREE.SRGBColorSpace;
  cache.set(skinId, tex);
  return tex;
}
