import * as THREE from "three";
import { voxelMaterial, glowMaterial } from "./palette";

/**
 * Distinct little voxel gun models, one per weapon "style". Used both as the
 * weapon the player holds and as the prizes that tumble out of the Mystery
 * Chest. Local frame: grip near the origin, barrel pointing toward +Z.
 */
export type GunStyle =
  | "pistol" | "smg" | "shotgun" | "cannon" | "rifle"
  | "arc" | "singularity" | "pyroclasm"
  | "confetti" | "potato" | "fish" | "chicken" | "beejar" | "bfg";

interface Part {
  s: [number, number, number]; // scale (box size)
  p: [number, number, number]; // position
  c: number; // color
  glow?: boolean; // emissive (caught by bloom)
}

const UNIT = new THREE.BoxGeometry(1, 1, 1);

const STYLES: Record<GunStyle, Part[]> = {
  pistol: [
    { s: [0.16, 0.16, 0.34], p: [0, 0, 0.2], c: 0x2b2b30 },
    { s: [0.09, 0.09, 0.16], p: [0, 0.02, 0.4], c: 0x46464c },
    { s: [0.12, 0.2, 0.13], p: [0, -0.15, 0.04], c: 0x3a2f25 },
  ],
  smg: [
    { s: [0.16, 0.2, 0.5], p: [0, 0, 0.26], c: 0x303036 },
    { s: [0.08, 0.08, 0.2], p: [0, 0.03, 0.56], c: 0x4a4a50 },
    { s: [0.1, 0.28, 0.12], p: [0, -0.2, 0.2], c: 0x202024 },
    { s: [0.11, 0.18, 0.12], p: [0, -0.14, 0.05], c: 0x2a2a2e },
  ],
  shotgun: [
    { s: [0.08, 0.08, 0.62], p: [-0.05, 0.02, 0.36], c: 0x3a3a3e },
    { s: [0.08, 0.08, 0.62], p: [0.05, 0.02, 0.36], c: 0x3a3a3e },
    { s: [0.16, 0.16, 0.3], p: [0, -0.02, 0.06], c: 0x5a3a22 },
    { s: [0.1, 0.16, 0.1], p: [0, -0.13, 0.12], c: 0x4a3019 },
  ],
  cannon: [
    { s: [0.27, 0.27, 0.46], p: [0, 0.02, 0.33], c: 0x44444a },
    { s: [0.33, 0.33, 0.1], p: [0, 0.02, 0.58], c: 0xffcf52 },
    { s: [0.15, 0.18, 0.26], p: [0, -0.06, 0.06], c: 0x3a2f25 },
    { s: [0.12, 0.18, 0.12], p: [0, -0.14, 0.12], c: 0x2a2018 },
  ],
  rifle: [
    { s: [0.07, 0.07, 0.88], p: [0, 0.03, 0.52], c: 0x3a3e36 },
    { s: [0.14, 0.16, 0.4], p: [0, 0, 0.2], c: 0x33372f },
    { s: [0.07, 0.07, 0.2], p: [0, 0.15, 0.24], c: 0x202020 },
    { s: [0.05, 0.05, 0.05], p: [0, 0.15, 0.36], c: 0x6ad7ff, glow: true },
    { s: [0.11, 0.18, 0.12], p: [0, -0.14, 0.06], c: 0x2a2a26 },
  ],
  arc: [
    { s: [0.18, 0.2, 0.46], p: [0, 0, 0.25], c: 0x26323a },
    { s: [0.1, 0.1, 0.24], p: [0, 0.03, 0.54], c: 0x2a3a44 },
    { s: [0.24, 0.24, 0.06], p: [0, 0.03, 0.4], c: 0x6ad7ff, glow: true },
    { s: [0.26, 0.26, 0.06], p: [0, 0.03, 0.52], c: 0x6ad7ff, glow: true },
    { s: [0.11, 0.18, 0.12], p: [0, -0.14, 0.06], c: 0x1f2a30 },
  ],
  singularity: [
    { s: [0.18, 0.2, 0.44], p: [0, 0, 0.23], c: 0x2a2436 },
    { s: [0.28, 0.28, 0.28], p: [0, 0.04, 0.56], c: 0xc792ea, glow: true },
    { s: [0.11, 0.18, 0.12], p: [0, -0.14, 0.05], c: 0x221d2e },
  ],
  pyroclasm: [
    { s: [0.18, 0.22, 0.52], p: [0, 0, 0.27], c: 0x33271f },
    { s: [0.1, 0.1, 0.22], p: [0, 0.03, 0.6], c: 0x442f22 },
    { s: [0.05, 0.12, 0.3], p: [-0.11, 0.03, 0.32], c: 0xff7a3a, glow: true },
    { s: [0.05, 0.12, 0.3], p: [0.11, 0.03, 0.32], c: 0xff7a3a, glow: true },
    { s: [0.11, 0.18, 0.12], p: [0, -0.14, 0.07], c: 0x2a201a },
  ],

  // ---- wacky guns ----
  confetti: [
    { s: [0.2, 0.2, 0.32], p: [0, 0, 0.2], c: 0x6e4a9e }, // party tube
    { s: [0.36, 0.36, 0.14], p: [0, 0.02, 0.42], c: 0xffd24a, glow: true }, // flared muzzle
    { s: [0.08, 0.08, 0.08], p: [0.08, 0.06, 0.48], c: 0x6ad7ff, glow: true }, // confetti bits
    { s: [0.08, 0.08, 0.08], p: [-0.07, -0.02, 0.46], c: 0xff5d8f, glow: true },
    { s: [0.12, 0.2, 0.13], p: [0, -0.15, 0.04], c: 0x3a2f25 },
  ],
  potato: [
    { s: [0.17, 0.17, 0.62], p: [0, 0.02, 0.33], c: 0x5a3a22 }, // brown pipe
    { s: [0.22, 0.22, 0.2], p: [0, 0.03, 0.62], c: 0xc9a05a }, // loaded spud
    { s: [0.16, 0.18, 0.3], p: [0, -0.02, 0.14], c: 0x4a3019 },
    { s: [0.11, 0.18, 0.12], p: [0, -0.15, 0.05], c: 0x2a2018 },
  ],
  fish: [
    { s: [0.24, 0.36, 0.5], p: [0, 0.06, 0.32], c: 0x6aa0c0 }, // fish body
    { s: [0.06, 0.3, 0.2], p: [0, 0.06, 0.62], c: 0x4a80a0 }, // tail fin
    { s: [0.28, 0.12, 0.12], p: [0, 0.18, 0.34], c: 0x5a90b0 }, // top fin
    { s: [0.08, 0.08, 0.08], p: [0.1, 0.12, 0.14], c: 0xffffff, glow: true }, // eye
    { s: [0.1, 0.18, 0.12], p: [0, -0.16, 0.02], c: 0x3a2f25 }, // handle
  ],
  chicken: [
    { s: [0.22, 0.28, 0.42], p: [0, 0.04, 0.28], c: 0xffe14a }, // yellow body
    { s: [0.16, 0.18, 0.16], p: [0, 0.2, 0.5], c: 0xffe14a }, // head
    { s: [0.1, 0.07, 0.12], p: [0, 0.18, 0.62], c: 0xff8a3a, glow: true }, // beak
    { s: [0.06, 0.12, 0.12], p: [0, 0.32, 0.48], c: 0xff5d6c, glow: true }, // comb
    { s: [0.1, 0.18, 0.12], p: [0, -0.14, 0.02], c: 0x3a2f25 },
  ],
  beejar: [
    { s: [0.28, 0.36, 0.32], p: [0, 0.05, 0.26], c: 0xbfe0e8 }, // glass jar
    { s: [0.3, 0.08, 0.34], p: [0, 0.26, 0.26], c: 0x8a6a3a }, // lid
    { s: [0.07, 0.07, 0.07], p: [0.07, 0.06, 0.28], c: 0xffd24a, glow: true }, // bees
    { s: [0.07, 0.07, 0.07], p: [-0.06, 0.12, 0.24], c: 0xffd24a, glow: true },
    { s: [0.07, 0.07, 0.07], p: [0.02, 0.0, 0.3], c: 0xffd24a, glow: true },
    { s: [0.11, 0.18, 0.12], p: [0, -0.15, 0.06], c: 0x2a2a2e },
  ],
  bfg: [
    { s: [0.32, 0.32, 0.5], p: [0, 0, 0.28], c: 0x2a3a2e },
    { s: [0.4, 0.4, 0.28], p: [0, 0.02, 0.58], c: 0x3a4a3e }, // big barrel
    { s: [0.24, 0.24, 0.26], p: [0, 0.02, 0.64], c: 0x8fcf6f, glow: true }, // core
    { s: [0.07, 0.26, 0.32], p: [-0.22, 0.02, 0.32], c: 0x4ec98f, glow: true }, // fins
    { s: [0.07, 0.26, 0.32], p: [0.22, 0.02, 0.32], c: 0x4ec98f, glow: true },
    { s: [0.13, 0.22, 0.13], p: [0, -0.17, 0.06], c: 0x1f2a22 },
  ],
};

/** Build a fresh gun model group for a style (defaults to a pistol). */
export function buildGun(style: GunStyle): THREE.Group {
  const g = new THREE.Group();
  for (const part of STYLES[style] ?? STYLES.pistol) {
    const mat = part.glow ? glowMaterial(part.c, 1.1) : voxelMaterial(part.c);
    const m = new THREE.Mesh(UNIT, mat);
    m.scale.set(part.s[0], part.s[1], part.s[2]);
    m.position.set(part.p[0], part.p[1], part.p[2]);
    m.castShadow = !part.glow;
    g.add(m);
  }
  return g;
}
