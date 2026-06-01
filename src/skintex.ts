import * as THREE from "three";
import { findSkin, type Skin } from "./cosmetics";

/**
 * True pixel-texture skins (Minecraft-style, but high-detail). A skin is a
 * procedurally-painted pixel canvas UV-mapped onto the hero's box parts (see
 * voxelChar.applyTexture). The UV LAYOUT is the classic 64-unit atlas; the canvas
 * renders at RES× that (256²) so each face has lots of pixels for shading, a real
 * face, armour/fabric, themed patterns, boots & gloves — crisp NearestFilter.
 */
export const ATLAS_SIZE = 64; // UV layout units (unchanged — keeps UVs normalized)
const RES = 4; // pixels per UV unit → 256×256 canvas (16× the detail of vanilla)

type Rect = [number, number, number, number];
type Faces = { top: Rect; bottom: Rect; right: Rect; front: Rect; left: Rect; back: Rect };
export const ATLAS: { head: Faces; body: Faces; arm: Faces; leg: Faces } = {
  head: { top: [8, 0, 8, 8], bottom: [16, 0, 8, 8], right: [0, 8, 8, 8], front: [8, 8, 8, 8], left: [16, 8, 8, 8], back: [24, 8, 8, 8] },
  body: { top: [20, 16, 8, 4], bottom: [28, 16, 8, 4], right: [16, 20, 4, 12], front: [20, 20, 8, 12], left: [28, 20, 4, 12], back: [32, 20, 8, 12] },
  arm: { top: [44, 16, 4, 4], bottom: [48, 16, 4, 4], right: [40, 20, 4, 12], front: [44, 20, 4, 12], left: [48, 20, 4, 12], back: [52, 20, 4, 12] },
  leg: { top: [4, 16, 4, 4], bottom: [8, 16, 4, 4], right: [0, 20, 4, 12], front: [4, 20, 4, 12], left: [8, 20, 4, 12], back: [12, 20, 4, 12] },
};

const cache = new Map<string, THREE.Texture>();

const clamp = (v: number) => Math.max(0, Math.min(255, Math.round(v)));
function css(c: number, f = 1, a = 1): string {
  const r = clamp(((c >> 16) & 0xff) * f), g = clamp(((c >> 8) & 0xff) * f), b = clamp((c & 0xff) * f);
  return a >= 1 ? `rgb(${r},${g},${b})` : `rgba(${r},${g},${b},${a})`;
}
const darker = (c: number, f = 0.6) => (clamp(((c >> 16) & 0xff) * f) << 16) | (clamp(((c >> 8) & 0xff) * f) << 8) | clamp((c & 0xff) * f);
const lighter = (c: number, f = 1.3) => darker(c, f);

class Painter {
  g: CanvasRenderingContext2D;
  constructor(g: CanvasRenderingContext2D) { this.g = g; }
  /** pixel rect for an atlas face */
  px(part: keyof typeof ATLAS, face: keyof Faces): Rect {
    const [x, y, w, h] = ATLAS[part][face];
    return [x * RES, y * RES, w * RES, h * RES];
  }
  rect(x: number, y: number, w: number, h: number, color: number, f = 1, a = 1) {
    this.g.fillStyle = css(color, f, a);
    this.g.fillRect(x, y, w, h);
  }
  /** fill a face with vertical light→shade + fabric noise + a soft dark AO border */
  shade(r: Rect, color: number, seedBase: number, opts: { ao?: boolean; vGrad?: number } = {}) {
    const [X, Y, W, H] = r;
    let seed = seedBase | 1;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const vg = opts.vGrad ?? 0.26;
    for (let py = 0; py < H; py++) {
      const grad = 1.1 - (py / Math.max(1, H - 1)) * vg;
      for (let px = 0; px < W; px++) {
        const n = 0.95 + rnd() * 0.1;
        this.rect(X + px, Y + py, 1, 1, color, grad * n);
      }
    }
    if (opts.ao !== false) {
      // 1px ambient-occlusion border so parts read as separated volumes
      for (let px = 0; px < W; px++) { this.rect(X + px, Y, 1, 1, color, 0.7); this.rect(X + px, Y + H - 1, 1, 1, color, 0.62); }
      for (let py = 0; py < H; py++) { this.rect(X, Y + py, 1, 1, color, 0.78); this.rect(X + W - 1, Y + py, 1, 1, color, 0.78); }
    }
  }
}

// ---- themed pattern overlays drawn on the torso (and sometimes the head) ----
function pattern(p: Painter, name: string, r: Rect, accent: number) {
  const [X, Y, W, H] = r;
  const g = p.g;
  let seed = 7;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  switch (name) {
    case "stars":
      for (let i = 0; i < 14; i++) { const x = X + Math.floor(rnd() * W), y = Y + Math.floor(rnd() * H); p.rect(x, y, 1, 1, 0xffffff, 1); if (rnd() < 0.5) { p.rect(x - 1, y, 1, 1, accent, 1); p.rect(x + 1, y, 1, 1, accent, 1); p.rect(x, y - 1, 1, 1, accent, 1); p.rect(x, y + 1, 1, 1, accent, 1); } }
      break;
    case "stripes":
      for (let i = 0; i < W; i += 3) { g.globalAlpha = 0.35; p.rect(X + i, Y, 2, H, lighter(accent, 1.2), 1); g.globalAlpha = 1; }
      break;
    case "scales":
      for (let y = Y + 2; y < Y + H; y += 3) for (let x = X + 1 + ((y % 6 === 0) ? 0 : 2); x < X + W; x += 4) { p.rect(x, y, 3, 2, darker(accent, 0.8), 1); p.rect(x, y, 3, 1, lighter(accent, 1.2), 1); }
      break;
    case "bones": // ribcage
      for (let y = Y + 6; y < Y + H - 6; y += 5) { p.rect(X + 3, y, W - 6, 2, 0xf4efe0, 1); }
      p.rect(X + Math.floor(W / 2) - 1, Y + 4, 3, H - 12, 0xe8e0cc, 1); // sternum
      break;
    case "bandage":
      for (let y = Y; y < Y + H; y += 4) { g.globalAlpha = 0.5; p.rect(X, y, W, 2, darker(accent, 0.8), 1); g.globalAlpha = 1; }
      break;
    case "circuit":
      for (let i = 0; i < 8; i++) { const x = X + 2 + Math.floor(rnd() * (W - 4)), y = Y + 2 + Math.floor(rnd() * (H - 4)); p.rect(x, y, Math.floor(rnd() * 6) + 2, 1, accent, 1); p.rect(x, y, 1, Math.floor(rnd() * 6) + 2, accent, 1); p.rect(x, y, 2, 2, lighter(accent, 1.4), 1); }
      break;
    case "runes":
      for (let i = 0; i < 5; i++) { const x = X + 3 + Math.floor(rnd() * (W - 6)), y = Y + 3 + Math.floor(rnd() * (H - 6)); p.rect(x, y, 1, 4, accent, 1); p.rect(x - 1, y + 1, 3, 1, accent, 1); p.rect(x - 1, y + 3, 3, 1, accent, 1); }
      break;
    case "plate": // armour plates with rivets
      p.rect(X + 2, Y + 3, W - 4, Math.floor(H * 0.5), lighter(accent, 1.18), 1);
      p.rect(X + 2, Y + 3, W - 4, 1, lighter(accent, 1.5), 1);
      for (const cx of [X + 4, X + W - 5]) for (const cy of [Y + 5, Y + Math.floor(H * 0.5)]) p.rect(cx, cy, 2, 2, 0xd8dde4, 1);
      break;
    default: break;
  }
}

function paint(g: CanvasRenderingContext2D, skin: Skin) {
  const p = new Painter(g);
  const tone = skin.head;
  const shirt = skin.body;
  const pants = skin.pants ?? darker(skin.body, 0.6);
  const shoes = skin.shoes ?? 0x241a12;
  const hair = darker(skin.head, 0.45);
  const glove = skin.gloves ?? darker(shirt, 0.7);

  // ===== HEAD =====
  let s = 13;
  for (const f of ["top", "bottom", "right", "front", "left", "back"] as const) p.shade(p.px("head", f), tone, (s += 31), { vGrad: 0.18 });
  // hair: full crown + a fringe down every side
  p.shade(p.px("head", "top"), hair, 91, { ao: false });
  for (const f of ["front", "left", "right", "back"] as const) {
    const [X, Y, W] = p.px("head", f);
    const fr = f === "front" ? 4 * RES : 3 * RES;
    for (let y = 0; y < fr; y++) for (let x = 0; x < W; x++) p.rect(X + x, Y + y, 1, 1, hair, 1 - (y / fr) * 0.25);
  }
  // ---- face on the front ----
  {
    const [X, Y, W, H] = p.px("head", "front");
    const ex = [X + Math.floor(W * 0.2), X + Math.floor(W * 0.62)];
    const ey = Y + Math.floor(H * 0.46);
    const ew = Math.floor(W * 0.18), eh = Math.floor(H * 0.2);
    const iris = skin.glow ?? 0x3a6abf;
    for (const eyeX of ex) {
      p.rect(eyeX - 1, ey - 2, ew + 2, 1, 0x3a2a22, 1); // brow
      p.rect(eyeX, ey, ew, eh, 0xf6f6f6, 1); // sclera
      p.rect(eyeX + Math.floor(ew * 0.25), ey, Math.ceil(ew * 0.6), eh, iris, 1); // iris
      p.rect(eyeX + Math.floor(ew * 0.4), ey + 1, 2, eh - 1, 0x181018, 1); // pupil
      p.rect(eyeX + Math.floor(ew * 0.3), ey, 1, 1, 0xffffff, 1); // highlight
    }
    // nose + cheeks + mouth
    p.rect(X + Math.floor(W * 0.46), ey + eh + 1, 2, 2, tone, 0.78);
    p.rect(ex[0] - 1, ey + eh + 1, 2, 2, 0xff8a8a, 0.35); // blush
    p.rect(ex[1] + ew - 1, ey + eh + 1, 2, 2, 0xff8a8a, 0.35);
    const mY = Y + Math.floor(H * 0.74);
    p.rect(X + Math.floor(W * 0.34), mY, Math.floor(W * 0.32), 2, 0x7a3a30, 1);
  }

  // ===== BODY =====
  s = 200;
  for (const f of ["top", "bottom", "right", "front", "left", "back"] as const) p.shade(p.px("body", f), shirt, (s += 23));
  // collar + chest seam on the front/back
  for (const f of ["front", "back"] as const) {
    const [X, Y, W, H] = p.px("body", f);
    p.rect(X, Y, W, 2, lighter(shirt, 1.3), 1); // collar
    p.rect(X + Math.floor(W / 2) - 1, Y + 2, 1, H - 8, shirt, 0.75); // seam
    if (skin.pattern) pattern(p, skin.pattern, [X, Y + 2, W, H - 8], skin.glow ?? skin.emblem ?? lighter(shirt, 1.4));
  }
  // belt + buckle, and a glowing chest emblem
  for (const f of ["front", "back", "left", "right"] as const) {
    const [X, Y, W, H] = p.px("body", f);
    p.rect(X, Y + H - 4, W, 3, 0x241a12, 1);
    p.rect(X + Math.floor(W / 2) - 2, Y + H - 4, 4, 3, 0xd8c060, 1); // buckle
  }
  if (skin.emblem !== undefined) {
    const [X, Y, W, H] = p.px("body", "front");
    const cx = X + Math.floor(W / 2), cy = Y + Math.floor(H * 0.42), rr = Math.floor(W * 0.18);
    p.rect(cx - rr, cy - rr, rr * 2, rr * 2, skin.emblem, 0.5);
    p.rect(cx - rr + 1, cy - rr + 1, rr * 2 - 2, rr * 2 - 2, skin.emblem, 1);
    p.rect(cx - 1, cy - rr, 2, rr * 2, lighter(skin.emblem, 1.6), 1);
    p.rect(cx - rr, cy - 1, rr * 2, 2, lighter(skin.emblem, 1.6), 1);
  }

  // ===== ARMS: shoulder pad + sleeve + bracer + glove hand =====
  s = 320;
  for (const f of ["top", "bottom", "right", "front", "left", "back"] as const) p.shade(p.px("arm", f), shirt, (s += 17));
  for (const f of ["front", "back", "left", "right"] as const) {
    const [X, Y, W, H] = p.px("arm", f);
    p.rect(X, Y, W, 3, lighter(shirt, 1.25), 1); // shoulder pad highlight
    p.rect(X, Y + H - Math.floor(H * 0.3), W, 2, glove, 1); // bracer cuff
    for (let y = Y + H - Math.floor(H * 0.28); y < Y + H; y++) for (let x = 0; x < W; x++) p.rect(X + x, y, 1, 1, glove, 0.95 - (y - (Y + H - Math.floor(H * 0.28))) * 0.03); // glove
  }
  p.shade(p.px("arm", "bottom"), glove, 355, { ao: false });

  // ===== LEGS: pants + knee + boots =====
  s = 420;
  for (const f of ["top", "bottom", "right", "front", "left", "back"] as const) p.shade(p.px("leg", f), pants, (s += 13));
  for (const f of ["front", "back", "left", "right"] as const) {
    const [X, Y, W, H] = p.px("leg", f);
    p.rect(X, Y + Math.floor(H * 0.45), W, 2, darker(pants, 0.8), 1); // knee seam
    p.rect(X + 1, Y + Math.floor(H * 0.42), W - 2, 3, lighter(pants, 1.15), 1); // knee pad
    const bootH = Math.floor(H * 0.3);
    for (let y = Y + H - bootH; y < Y + H; y++) for (let x = 0; x < W; x++) p.rect(X + x, y, 1, 1, shoes, 1 - (y - (Y + H - bootH)) * 0.03);
    p.rect(X, Y + H - bootH, W, 1, lighter(shoes, 1.6), 1); // boot top trim
  }
  p.shade(p.px("leg", "bottom"), darker(shoes, 0.7), 444, { ao: false }); // sole
}

/** A high-detail pixel texture for the given skin (cached per id). */
export function skinTexture(skinId: string): THREE.Texture | null {
  const hit = cache.get(skinId);
  if (hit) return hit;
  let c: HTMLCanvasElement;
  try { c = document.createElement("canvas"); } catch { return null; }
  c.width = ATLAS_SIZE * RES;
  c.height = ATLAS_SIZE * RES;
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
