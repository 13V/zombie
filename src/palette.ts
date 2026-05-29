import * as THREE from "three";

// The cozy toy-diorama palette + shared material helpers.
export const COLORS = {
  player: 0x5b8cff,
  playerAccent: 0xfff4d6,
  zombie: 0x9fcaa0,
  zombieDark: 0x6f9d76,
  bullet: 0xffe28a,
  wall: 0xc8b48c,
  wallTop: 0xb39e74,
  prop: 0xb98a64,
  boxGold: 0xffcf52,
  perkTough: 0xff6f91,
  perkQuick: 0x6ad7ff,
  wallBuy: 0xc9ff7a,
  damageNumber: 0xfff1c1,
};

/** Soft, slightly matte material — the toy-plastic look. */
export function toyMaterial(color: number, opts: { emissive?: number; emissiveIntensity?: number } = {}) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.78,
    metalness: 0.0,
    emissive: opts.emissive ?? 0x000000,
    emissiveIntensity: opts.emissiveIntensity ?? 1,
    flatShading: false,
  });
}

/** Glowy accent material for interactables (picked up by bloom). */
export function glowMaterial(color: number, intensity = 0.9) {
  return new THREE.MeshStandardMaterial({
    color,
    roughness: 0.5,
    metalness: 0.0,
    emissive: color,
    emissiveIntensity: intensity,
  });
}
