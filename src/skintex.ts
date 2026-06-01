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

  // ===== OUTFIT (torso + arms + legs) — a designed garment, not a flat shirt =====
  paintOutfit(p, skin, { tone, shirt, pants, shoes, glove });
}

const FACES = ["top", "bottom", "right", "front", "left", "back"] as const;
type SideFace = "front" | "back" | "left" | "right";
const SIDES: SideFace[] = ["front", "back", "left", "right"];

function paintOutfit(p: Painter, skin: Skin, c: { tone: number; shirt: number; pants: number; shoes: number; glove: number }) {
  const { tone, shirt, pants, shoes, glove } = c;
  const trim = skin.trim ?? lighter(shirt, 1.45);
  const tmpl = skin.outfit ?? "tee";
  const dressLike = tmpl === "dress" || tmpl === "robe";
  const shorts = skin.legwear === "shorts" || tmpl === "tank";

  const fillPart = (part: keyof typeof ATLAS, color: number, seed: number, vg = 0.26) => {
    let s = seed;
    for (const f of FACES) p.shade(p.px(part, f), color, (s += 29), { vGrad: vg });
  };
  const onSides = (part: keyof typeof ATLAS, fn: (r: Rect, f: SideFace) => void) => {
    for (const f of SIDES) fn(p.px(part, f), f);
  };

  // ---- TORSO ----
  fillPart("body", shirt, 200);
  onSides("body", ([X, Y, W, H], f) => {
    // neck/collar hole (skin tone) at top centre
    p.rect(X + Math.floor(W * 0.32), Y, Math.ceil(W * 0.36), 2, tone, 0.9);
    p.rect(X, Y, W, 1, lighter(shirt, 1.3), 1); // shoulder seam highlight
    if (skin.pattern && f === "front") pattern(p, skin.pattern, [X, Y + 3, W, H - 7], skin.glow ?? skin.emblem ?? trim);
  });
  const [bX, bY, bW, bH] = p.px("body", "front");
  const [kX, kY, kW, kH] = p.px("body", "back");
  switch (tmpl) {
    case "hoodie": {
      // hood roll, kangaroo pocket, drawstrings, zipper
      for (const [X, Y, W] of [[bX, bY, bW], [kX, kY, kW]]) p.rect(X, Y, W, 3, darker(shirt, 0.82), 1); // hood roll
      p.rect(bX + Math.floor(bW * 0.46), bY + 3, 1, 6, trim); p.rect(bX + Math.floor(bW * 0.54), bY + 3, 1, 6, trim); // drawstrings
      p.rect(bX + Math.floor(bW * 0.2), bY + Math.floor(bH * 0.5), Math.floor(bW * 0.6), Math.floor(bH * 0.22), darker(shirt, 0.85), 1); // pocket
      p.rect(bX + Math.floor(bW * 0.2), bY + Math.floor(bH * 0.5), Math.floor(bW * 0.6), 1, lighter(shirt, 1.2), 1); // pocket lip
      p.rect(bX + Math.floor(bW / 2), bY + 3, 1, bH - 7, darker(shirt, 0.7), 1); // zipper
      break;
    }
    case "jacket": {
      // open jacket showing inner shirt + lapels + zipper
      p.rect(bX + Math.floor(bW * 0.36), bY + 2, Math.ceil(bW * 0.28), bH - 6, trim, 1); // inner panel
      p.rect(bX + Math.floor(bW / 2), bY + 2, 1, bH - 6, darker(trim, 0.7), 1); // zipper
      p.rect(bX + Math.floor(bW * 0.28), bY + 1, 3, 5, darker(shirt, 0.8), 1); // lapel L
      p.rect(bX + Math.floor(bW * 0.62), bY + 1, 3, 5, darker(shirt, 0.8), 1); // lapel R
      break;
    }
    case "dress": case "robe": {
      // bodice + a waist sash (legs continue the garment below)
      p.rect(bX, bY + Math.floor(bH * 0.62), bW, 3, trim, 1);
      p.rect(kX, kY + Math.floor(bH * 0.62), kW, 3, trim, 1);
      if (tmpl === "robe") { p.rect(bX + Math.floor(bW * 0.44), bY + 2, Math.ceil(bW * 0.12), bH - 6, trim, 1); pattern(p, "runes", [bX + Math.floor(bW * 0.42), bY + 4, Math.ceil(bW * 0.16), bH - 10], skin.glow ?? trim); }
      break;
    }
    case "armor": {
      pattern(p, "plate", [bX, bY + 2, bW, bH - 6], lighter(shirt, 1.2));
      p.rect(bX + Math.floor(bW * 0.38), bY + 2, Math.ceil(bW * 0.24), bH - 5, trim, 1); // tabard
      break;
    }
    case "tank": {
      // bare shoulders/sides (skin), two straps over them
      for (const [X, Y, W, H] of [[bX, bY, bW, bH], [kX, kY, kW, kH]]) {
        p.rect(X, Y, Math.floor(W * 0.22), Math.floor(H * 0.3), tone, 1);
        p.rect(X + W - Math.floor(W * 0.22), Y, Math.floor(W * 0.22), Math.floor(H * 0.3), tone, 1);
        p.rect(X + Math.floor(W * 0.22), Y, 2, Math.floor(H * 0.3), shirt, 1); // strap L
        p.rect(X + W - Math.floor(W * 0.22) - 2, Y, 2, Math.floor(H * 0.3), shirt, 1); // strap R
      }
      break;
    }
    case "suit": {
      p.rect(bX, bY + 1, bW, 2, lighter(shirt, 1.4), 1); // collar ring
      p.rect(bX, bY + Math.floor(bH * 0.4), bW, 2, trim, 1); // accent stripe
      p.rect(bX + Math.floor(bW * 0.34), bY + Math.floor(bH * 0.18), Math.ceil(bW * 0.32), Math.floor(bH * 0.16), 0x1a2230, 1); // chest panel
      for (let i = 0; i < 3; i++) p.rect(bX + Math.floor(bW * 0.4) + i * 2, bY + Math.floor(bH * 0.22), 1, 1, [0xff5a5a, 0x7be08a, 0x6ad7ff][i], 1);
      break;
    }
    case "tunic": {
      p.rect(bX + Math.floor(bW * 0.44), bY, 3, Math.floor(bH * 0.4), tone, 1); // V-neck
      break;
    }
    default: { // tee — short sleeves handled below + a hem
      p.rect(bX, bY + bH - 3, bW, 1, darker(shirt, 0.8), 1);
      p.rect(kX, kY + bH - 3, kW, 1, darker(shirt, 0.8), 1);
      break;
    }
  }
  // belt + buckle (skip for dresses/robes which flow to a hem) + emblem
  if (!dressLike) onSides("body", ([X, Y, W, H]) => {
    p.rect(X, Y + H - 4, W, 3, skin.trim && tmpl === "tunic" ? trim : 0x241a12, 1);
    p.rect(X + Math.floor(W / 2) - 2, Y + H - 4, 4, 3, 0xd8c060, 1);
  });
  if (skin.emblem !== undefined) {
    const cx = bX + Math.floor(bW / 2), cy = bY + Math.floor(bH * 0.4), rr = Math.floor(bW * 0.18);
    p.rect(cx - rr, cy - rr, rr * 2, rr * 2, skin.emblem, 0.5);
    p.rect(cx - rr + 1, cy - rr + 1, rr * 2 - 2, rr * 2 - 2, skin.emblem, 1);
    p.rect(cx - 1, cy - rr, 2, rr * 2, lighter(skin.emblem, 1.6), 1);
    p.rect(cx - rr, cy - 1, rr * 2, 2, lighter(skin.emblem, 1.6), 1);
  }

  // ---- ARMS ----
  const longSleeve = !(tmpl === "tee" || tmpl === "tank");
  fillPart("arm", shirt, 320);
  onSides("arm", ([X, Y, W, H]) => {
    p.rect(X, Y, W, 2, lighter(shirt, 1.25), 1); // shoulder cap
    if (tmpl === "armor") { p.rect(X, Y, W, 4, lighter(shirt, 1.45), 1); p.rect(X, Y + 4, W, 1, 0xd8dde4, 1); } // pauldron
    if (tmpl === "suit") p.rect(X, Y + Math.floor(H * 0.45), W, 2, trim, 1); // elbow ring
    const cuffH = longSleeve ? Math.floor(H * 0.26) : Math.floor(H * 0.55); // short sleeve shows more bare arm
    if (!longSleeve) { // bare forearm (skin) for tee/tank
      for (let y = Y + (H - cuffH); y < Y + H; y++) for (let x = 0; x < W; x++) p.rect(X + x, y, 1, 1, tone, 0.96);
      p.rect(X, Y + (H - cuffH), W, 1, darker(shirt, 0.8), 1); // sleeve hem
    }
    // glove/cuff at the wrist
    const gH = Math.floor(H * 0.22);
    for (let y = Y + H - gH; y < Y + H; y++) for (let x = 0; x < W; x++) p.rect(X + x, y, 1, 1, glove, 1);
    p.rect(X, Y + H - gH, W, 1, lighter(glove, 1.3), 1);
  });
  p.shade(p.px("arm", "bottom"), tone, 355, { ao: false }); // palm

  // ---- LEGS ----
  const legBase = dressLike ? shirt : pants;
  fillPart("leg", legBase, 420);
  onSides("leg", ([X, Y, W, H]) => {
    if (dressLike) { // skirt/robe fabric flowing to a trim hem
      for (let y = Y; y < Y + H; y++) for (let x = 0; x < W; x++) p.rect(X + x, y, 1, 1, legBase, 1.05 - (y - Y) / H * 0.3);
      p.rect(X, Y + H - 3, W, 2, trim, 1); // hem
      return;
    }
    p.rect(X, Y + 1, W, 2, darker(legBase, 0.82), 1); // waistband
    if (shorts) { // bare lower legs (skin) for shorts
      const sh = Math.floor(H * 0.42);
      for (let y = Y + (H - sh); y < Y + H; y++) for (let x = 0; x < W; x++) p.rect(X + x, y, 1, 1, tone, 0.96);
      p.rect(X, Y + (H - sh), W, 1, darker(legBase, 0.7), 1); // shorts hem
    } else {
      p.rect(X, Y + Math.floor(H * 0.46), W, 2, darker(legBase, 0.8), 1); // knee seam
      if (tmpl === "armor") { p.rect(X, Y + Math.floor(H * 0.5), W, 1, 0xd8dde4, 1); } // greave
    }
    const bootH = Math.floor(H * 0.3);
    for (let y = Y + H - bootH; y < Y + H; y++) for (let x = 0; x < W; x++) p.rect(X + x, y, 1, 1, shoes, 1 - (y - (Y + H - bootH)) * 0.03);
    p.rect(X, Y + H - bootH, W, 1, lighter(shoes, 1.6), 1); // boot trim
  });
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
