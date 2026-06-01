import * as THREE from "three";
import { voxelMaterial, glowMaterial, auraMaterial, VOX, COLORS } from "./palette";
import { VoxelChar } from "./voxelChar";
import { makeBubble, makeLabel } from "./islandnet";

/**
 * The Island — a persistent social hub / lobby the player spawns into (think a
 * cozy Roblox-style starting world). You walk around your voxel character here,
 * see other people (multiplayer presence is layered on top via NetPlay), hatch
 * pets at the egg shrines ringing the central fountain, and step into one of the
 * Solo / Duo / Squad portal gates to start a run.
 *
 * This module owns the static world + the interactive "zones" (proximity pads)
 * AND all of the hub's ambient animation (fountain, floating eggs, shimmering
 * portals, torches, banners, drifting motes & clouds). It is deliberately rich:
 * the lobby is the first thing players see, so it earns the polish. Movement,
 * camera and presence are still driven by main.ts so the island can reuse the
 * existing Player / NetClient / camera systems.
 */

export const ISLAND = {
  half: 48, // half-extent of the island ground — a big village square for ~50 players
  shore: 42, // grass radius; beyond this is sand, then water
};

// Shared hub layout (so every builder agrees on where things go as it scales).
const PLAZA_R = 13; // stone town-square radius
const EGG_R = 7.2; // egg-shrine ring radius around the fountain
const GATES = [
  { id: "mode_solo", players: 1 as const, pos: new THREE.Vector3(-15, 0, -13), color: 0x7be08a, label: "SOLO — 1 player", grand: 0 },
  { id: "mode_duo", players: 2 as const, pos: new THREE.Vector3(0, 0, -20), color: 0x6ad7ff, label: "DUO — 2 players (2× harder)", grand: 1 },
  { id: "mode_quad", players: 4 as const, pos: new THREE.Vector3(15, 0, -13), color: 0xff5a3a, label: "SQUAD — 4 players (4× harder)", grand: 2 },
];
const PADS = [
  { id: "join" as const, pos: new THREE.Vector3(12, 0, 8), color: 0x6ad7ff, label: "Join a Friend's Run" },
  { id: "shop" as const, pos: new THREE.Vector3(-12, 0, 8), color: 0xffd24a, label: "Open Shop" },
];
// The village ring — cottages framing the square. `big`/`story` drive size +
// a second storey so the rooftops vary like a real town. xz in world space.
const HOUSES = [
  { x: -15.5, z: 11.5, wall: VOX.plasterWarm, roof: VOX.roofRed, trim: VOX.bark, big: 1, story: 1 }, // Shop
  { x: 15.5, z: 11.5, wall: VOX.houseWall, roof: VOX.roofBlue, trim: VOX.bark, big: 1, story: 1 }, // Inn
  { x: -23, z: 2.5, wall: VOX.plasterSage, roof: VOX.roofDark, trim: VOX.barkDark, big: 0, story: 0 },
  { x: 23, z: 2.5, wall: VOX.plasterWarm, roof: VOX.roofPurple, trim: VOX.barkDark, big: 1, story: 0 },
  { x: -21, z: -7, wall: VOX.houseWall, roof: VOX.roofRed, trim: VOX.bark, big: 0, story: 0 },
  { x: 21, z: -7, wall: VOX.plasterSage, roof: VOX.roofBlue, trim: VOX.barkDark, big: 0, story: 1 },
  { x: -10, z: 18.5, wall: VOX.plasterWarm, roof: VOX.roofPurple, trim: VOX.bark, big: 1, story: 0 },
  { x: 10, z: 18.5, wall: VOX.houseWall, roof: VOX.roofDark, trim: VOX.barkDark, big: 0, story: 1 },
];
const STALLS = [
  { x: -5.5, z: 17, color: VOX.toolbox },
  { x: 0, z: 18.5, color: VOX.barrel },
  { x: 5.5, z: 17, color: VOX.rvStripe },
];
// The Pet Sanctuary — a pavilion where you equip + flex your squad.
const SANCTUARY = new THREE.Vector3(7.5, 0, 9.8);
// every structure footprint foliage must avoid
const CLEAR_PTS = [...GATES, ...PADS].map((d) => d.pos).concat(
  HOUSES.map((h) => new THREE.Vector3(h.x, 0, h.z)),
  STALLS.map((s) => new THREE.Vector3(s.x, 0, s.z)),
  [SANCTUARY],
);

/** An interactive spot on the island the player can walk up to. */
export interface IslandZone {
  id: string;
  kind: "mode" | "join" | "shop" | "egg" | "pets";
  pos: THREE.Vector3;
  radius: number; // proximity radius that triggers the prompt
  label: string; // shown in the proximity prompt
  /** game-mode portals (kind === "mode"): how many players the structure hosts. */
  modePlayers?: 1 | 2 | 4;
  /** egg zones (kind === "egg"): which gacha egg this pedestal hatches. */
  eggId?: string;
}

// ---- animation record types ------------------------------------------------

interface Flame {
  mesh: THREE.Mesh;
  phase: number;
  base: number; // rest scale
}
interface Banner {
  segs: THREE.Mesh[];
  phase: number;
}
interface EggShrine {
  id: string;
  group: THREE.Group; // whole shrine (for proximity scale)
  egg: THREE.Mesh; // the faceted gem-egg (bobs + wobbles)
  aura: THREE.Mesh; // translucent breathing halo
  orbit: THREE.Group; // sparkles revolving around the egg
  beam: THREE.Mesh; // light shaft rising from the egg
  ringGlow: THREE.Mesh; // glowing disc on the pedestal top
  pos: THREE.Vector3;
  phase: number;
  color: number;
  lit: number; // eased proximity highlight 0..1
}
interface CoopRoom {
  group: THREE.Group;
  floor: THREE.Mesh; // glowing floor rune you stand on (pulses)
  rune: THREE.Mesh; // rotating rune ring on the floor
  figures: THREE.Object3D[]; // bobbing party-size figures inside
  pos: THREE.Vector3;
  color: number;
  lit: number;
}
interface Mote {
  mesh: THREE.Mesh;
  baseY: number;
  phase: number;
  speed: number;
  span: number; // vertical travel before looping
}

export class Island {
  readonly group = new THREE.Group();
  readonly zones: IslandZone[] = [];
  private water?: THREE.Mesh;
  private beacons: THREE.Mesh[] = [];
  private t = 0;
  // interactive pads (join/shop), tracked so they bounce-scale when stood on
  private pads: { id: string; group: THREE.Group; ring: THREE.Mesh; pos: THREE.Vector3; lit: number }[] = [];
  private greeter?: VoxelChar;
  private arrow?: THREE.Mesh;
  // animation registries
  private eggs: EggShrine[] = [];
  private rooms: CoopRoom[] = [];
  private flames: Flame[] = [];
  private banners: Banner[] = [];
  private motes: Mote[] = [];
  private clouds: { mesh: THREE.Mesh; speed: number; reset: number }[] = [];
  private fountainDiscs: THREE.Mesh[] = [];
  private fountainJets: THREE.Mesh[] = [];
  private fountainSpire?: THREE.Mesh;
  private lilies: THREE.Mesh[] = [];
  private sanctuaryOrb?: THREE.Mesh; // spinning centerpiece of the Pet Sanctuary
  private sanctuaryHearts?: THREE.Group; // little hearts orbiting it
  private lbCanvas?: HTMLCanvasElement; // leaderboard board face
  private lbTex?: THREE.CanvasTexture;
  private smokes: Mote[] = []; // chimney smoke puffs (reuse the Mote drift record)
  // warm golden-hour mood — applied to the shared scene only while the hub shows
  private scene: THREE.Scene;
  private savedFog: THREE.Scene["fog"] = null;
  private savedBg: THREE.Color | THREE.Texture | null = null;
  private savedEnv = 0.5;
  private moodSaved = false;
  // original intensity/color of the shared scene lights, so the hub can dim +
  // warm them for golden hour and restore them exactly on the way out
  private lightOrig = new Map<THREE.Light, { intensity: number; color: number }>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.buildGround();
    this.buildWater();
    this.buildDecor();
    this.buildBackdrop();
    this.buildPlaza();
    this.buildPaths();
    this.buildFountain();
    this.buildZones();
    this.buildModes();
    this.buildEggs();
    this.buildSanctuary();
    this.buildLeaderboard();
    this.buildHouses();
    this.buildLighting();
    this.buildGreeter();
    this.buildAtmosphere();
    this.buildMoodLights();
    this.applyShadows();
    scene.add(this.group);
    this.group.visible = false; // shown only while in the island state
  }

  setVisible(on: boolean) {
    this.group.visible = on;
    if (on) this.enterMood();
    else this.exitMood();
  }

  // ---- warm golden-hour mood (island-only; restores the arena's look on exit) ----

  private buildMoodLights() {
    // these live under this.group, so they only light the scene while the hub is
    // visible (the renderer skips lights under an invisible parent).
    const hemi = new THREE.HemisphereLight(0xffe2b0, 0x6a5236, 0.45); // warm sky / earthy ground
    const sun = new THREE.DirectionalLight(0xffb066, 0.7); // low amber sunset key
    sun.position.set(-26, 12, 20);
    const rim = new THREE.DirectionalLight(0xffd9a0, 0.25); // soft warm fill
    rim.position.set(14, 8, -18);
    this.group.add(hemi, sun, rim);
  }

  private enterMood() {
    if (!this.moodSaved) {
      this.savedFog = this.scene.fog;
      this.savedBg = this.scene.background as THREE.Color | THREE.Texture | null;
      this.savedEnv = this.scene.environmentIntensity ?? 0.5;
      // snapshot the shared scene lights once (arena's sun/hemi/fill)
      for (const c of this.scene.children) {
        const l = c as THREE.Light;
        if (l.isLight) this.lightOrig.set(l, { intensity: l.intensity, color: l.color.getHex() });
      }
      this.moodSaved = true;
    }
    // warm haze hugging the island + a soft peach sky, dimmed IBL so the warm
    // lights & lantern bloom carry the cozy golden-hour mood.
    this.scene.fog = new THREE.Fog(0xf0bb7a, 34, 110);
    this.scene.background = new THREE.Color(0xf6cf94);
    this.scene.environmentIntensity = 0.34;
    // dim + warm the shared daylight so the scene actually reads golden-hour
    // rather than washing out under the bright neutral arena sun.
    for (const [l, o] of this.lightOrig) {
      const isKey = o.intensity > 1; // the strong directional key
      l.intensity = o.intensity * (isKey ? 0.42 : 0.55);
      l.color.setHex(isKey ? 0xffc486 : 0xffd9ad);
    }
  }

  private exitMood() {
    if (!this.moodSaved) return;
    this.scene.fog = this.savedFog;
    this.scene.background = this.savedBg;
    this.scene.environmentIntensity = this.savedEnv;
    for (const [l, o] of this.lightOrig) {
      l.intensity = o.intensity;
      l.color.setHex(o.color);
    }
  }

  /** Opaque structures cast + receive contact shadows; glassy/glow/transparent
   *  bits (auras, beams, water, clouds, motes) don't. The ground only receives
   *  (tagged noCast) so the big tile field stays out of the shadow map. */
  private applyShadows() {
    this.group.traverse((o) => {
      const mesh = o as THREE.Mesh;
      if (!mesh.isMesh) return;
      const mat = mesh.material as THREE.Material;
      if (Array.isArray(mat) || mat.transparent) return;
      mesh.receiveShadow = true;
      mesh.castShadow = !mesh.userData.noCast;
    });
  }

  /** Keep the player inside the grassy shore (soft circular clamp). */
  clamp(pos: THREE.Vector3) {
    const r = Math.hypot(pos.x, pos.z);
    const max = ISLAND.shore - 1.2;
    if (r > max) {
      pos.x = (pos.x / r) * max;
      pos.z = (pos.z / r) * max;
    }
  }

  /** Nearest zone within its trigger radius (for the walk-up prompt), or null. */
  nearestZone(pos: THREE.Vector3): IslandZone | null {
    let best: IslandZone | null = null;
    let bd = Infinity;
    for (const z of this.zones) {
      const dx = z.pos.x - pos.x;
      const dz = z.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < z.radius * z.radius && d < bd) {
        bd = d;
        best = z;
      }
    }
    return best;
  }

  update(dt: number) {
    if (!this.group.visible) return;
    this.t += dt;
    const t = this.t;

    if (this.water) this.water.position.y = -0.35 + Math.sin(t * 0.8) * 0.05;
    for (const b of this.beacons) {
      const m = b.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.8 + (Math.sin(t * 2.4) + 1) * 0.5;
      b.rotation.y += dt * 1.2;
    }
    if (this.greeter) {
      if (!this.greeter.emoting) this.greeter.emote("wave");
      this.greeter.update(dt);
    }
    if (this.arrow) {
      this.arrow.position.y = 3.6 + Math.sin(t * 2.2) * 0.2;
      this.arrow.rotation.y += dt * 1.5;
    }

    if (this.sanctuaryOrb) {
      this.sanctuaryOrb.rotation.y += dt * 1.1;
      this.sanctuaryOrb.position.y = 2.0 + Math.sin(t * 1.8) * 0.12;
      (this.sanctuaryOrb.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.1 + (Math.sin(t * 2.5) + 1) * 0.3;
    }
    if (this.sanctuaryHearts) {
      this.sanctuaryHearts.rotation.y += dt * 1.6;
      this.sanctuaryHearts.children.forEach((h, i) => { h.position.y = (i % 2 ? 0.15 : -0.1) + Math.sin(t * 3 + i) * 0.08; });
    }

    this.animateFountain(dt);
    this.animateEggs(dt);
    this.animateRooms(dt);
    this.animateFlames();
    this.animateBanners();
    this.animateAtmosphere(dt);
  }

  // ========================================================================
  //  ANIMATION
  // ========================================================================

  private animateFountain(dt: number) {
    const t = this.t;
    if (this.fountainSpire) {
      this.fountainSpire.rotation.y += dt * 0.6;
      this.fountainSpire.position.y = this.fountainSpireBaseY + Math.sin(t * 1.4) * 0.14;
      const m = this.fountainSpire.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 1.1 + (Math.sin(t * 2) + 1) * 0.35;
    }
    this.fountainDiscs.forEach((d, i) => {
      const s = 1 + Math.sin(t * 2.2 + i * 1.3) * 0.04;
      d.scale.set(s, 1, s);
    });
    // jets rise + fall on staggered phases, fading as they peak
    this.fountainJets.forEach((j, i) => {
      const ph = (t * 1.3 + i * 0.5) % 1;
      j.position.y = (j.userData.baseY as number) + ph * 2.0;
      j.scale.y = 0.4 + (1 - ph) * 1.2;
      const m = j.material as THREE.MeshStandardMaterial;
      m.opacity = 0.55 * (1 - ph);
    });
  }

  private animateEggs(dt: number) {
    const t = this.t;
    for (const e of this.eggs) {
      e.group.scale.setScalar(1 + e.lit * 0.08);
      const bob = Math.sin(t * 2 + e.phase) * 0.12;
      e.egg.position.y = 2.05 + bob + e.lit * 0.14;
      // gentle wobble + a faster, livelier spin when a player is close
      e.egg.rotation.y += dt * (0.7 + e.lit * 1.8);
      e.egg.rotation.z = Math.sin(t * 1.7 + e.phase) * 0.12;
      // sparkles orbit; spin up near the player
      e.orbit.position.copy(e.egg.position);
      e.orbit.rotation.y += dt * (1.4 + e.lit * 2.5);
      // aura breathes
      const aS = 1 + Math.sin(t * 2.4 + e.phase) * 0.06 + e.lit * 0.18;
      e.aura.scale.setScalar(aS);
      e.aura.position.y = e.egg.position.y;
      (e.aura.material as THREE.MeshStandardMaterial).opacity = 0.18 + e.lit * 0.22;
      // light shaft shimmer
      const bm = e.beam.material as THREE.MeshStandardMaterial;
      bm.opacity = 0.1 + (Math.sin(t * 3 + e.phase) + 1) * 0.06 + e.lit * 0.2;
      e.beam.rotation.y -= dt * 0.8;
      // pedestal glow disc pulse
      (e.ringGlow.material as THREE.MeshStandardMaterial).emissiveIntensity =
        0.8 + (Math.sin(t * 2.6 + e.phase) + 1) * 0.5 + e.lit * 1.4;
    }
  }

  private animateRooms(dt: number) {
    const t = this.t;
    for (const g of this.rooms) {
      g.group.scale.setScalar(1 + g.lit * 0.02);
      // glowing floor rune pulses (brighter when a player is standing in)
      (g.floor.material as THREE.MeshStandardMaterial).emissiveIntensity =
        0.5 + (Math.sin(t * 2 + g.pos.x) + 1) * 0.2 + g.lit * 0.9;
      // rune ring slowly rotates + pulses
      g.rune.rotation.y += dt * 0.4;
      (g.rune.material as THREE.MeshStandardMaterial).emissiveIntensity =
        0.7 + (Math.sin(t * 2.3 + g.pos.x) + 1) * 0.4 + g.lit * 1.2;
      // figures bob in a little wave
      g.figures.forEach((f, i) => {
        f.position.y = 0.5 + Math.abs(Math.sin(t * 3 + i * 0.9)) * 0.18 + g.lit * 0.1;
      });
    }
  }

  private animateFlames() {
    const t = this.t;
    for (const fl of this.flames) {
      // pseudo-random flicker from layered sines
      const n = Math.sin(t * 13 + fl.phase) * 0.5 + Math.sin(t * 29 + fl.phase * 2) * 0.3;
      const s = fl.base * (1 + n * 0.18);
      fl.mesh.scale.set(s, fl.base * (1.2 + n * 0.35), s);
      (fl.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.4 + n * 0.8;
    }
  }

  private animateBanners() {
    const t = this.t;
    for (const b of this.banners) {
      b.segs.forEach((seg, i) => {
        // lower cloth segments lag, giving a soft ripple down the banner
        seg.rotation.y = Math.sin(t * 2.2 + b.phase + i * 0.6) * (0.12 + i * 0.05);
        seg.position.x = Math.sin(t * 2.2 + b.phase + i * 0.6) * (0.02 + i * 0.015);
      });
    }
  }

  private animateAtmosphere(dt: number) {
    const t = this.t;
    for (const m of this.motes) {
      m.mesh.position.y += dt * m.speed;
      if (m.mesh.position.y > m.baseY + m.span) m.mesh.position.y = m.baseY;
      // gentle horizontal drift as it rises
      m.mesh.position.x += Math.cos(t * 0.5 + m.phase) * dt * 0.25;
      m.mesh.position.z += Math.sin(t * 0.6 + m.phase) * dt * 0.25;
      const f = (m.mesh.position.y - m.baseY) / m.span;
      (m.mesh.material as THREE.MeshStandardMaterial).opacity = Math.sin(f * Math.PI) * 0.9;
    }
    for (const c of this.clouds) {
      c.mesh.position.x += dt * c.speed;
      if (c.mesh.position.x > c.reset) c.mesh.position.x = -c.reset;
    }
    for (const lp of this.lilies) {
      lp.position.y = -0.28 + Math.sin(t * 0.8 + lp.position.x) * 0.05;
      lp.rotation.y += dt * 0.05;
    }
    // chimney smoke drifts up, fattening + fading, then loops back to the stack
    for (const s of this.smokes) {
      s.mesh.position.y += dt * s.speed;
      const f = (s.mesh.position.y - s.baseY) / s.span;
      if (f >= 1) s.mesh.position.y = s.baseY;
      const sc = 1 + f * 1.4;
      s.mesh.scale.setScalar(sc);
      (s.mesh.material as THREE.MeshStandardMaterial).opacity = 0.5 * (1 - Math.max(0, f));
    }
  }

  /**
   * Reactive proximity highlights — pads bounce, and the nearest egg / gate
   * brightens & energizes when the player walks up. Called from main with the
   * live player position each island frame.
   */
  reactPads(playerPos: THREE.Vector3, dt: number) {
    const ease = Math.min(1, dt * 8);
    for (const p of this.pads) {
      const dx = p.pos.x - playerPos.x;
      const dz = p.pos.z - playerPos.z;
      const on = dx * dx + dz * dz < 2.2 * 2.2;
      p.lit += ((on ? 1 : 0) - p.lit) * ease;
      const s = 1 + p.lit * 0.18 + (on ? Math.sin(this.t * 8) * 0.04 : 0);
      p.group.scale.set(s, 1 + p.lit * 0.12, s);
      (p.ring.material as THREE.MeshStandardMaterial).emissiveIntensity = 0.9 + p.lit * 1.6;
    }
    for (const e of this.eggs) {
      const on = e.pos.distanceToSquared(playerPos) < 1.9 * 1.9;
      e.lit += ((on ? 1 : 0) - e.lit) * ease;
    }
    for (const g of this.rooms) {
      const on = g.pos.distanceToSquared(playerPos) < 3.2 * 3.2;
      g.lit += ((on ? 1 : 0) - g.lit) * ease;
    }
  }

  // ========================================================================
  //  WORLD BUILDING
  // ========================================================================

  private buildGround() {
    const g = new THREE.Group();
    const grass = voxelMaterial(VOX.grass);
    const grassDark = voxelMaterial(VOX.grassDark);
    const grassLight = voxelMaterial(VOX.grassLight);
    const sand = voxelMaterial(0xe6d9a8);
    const TILE = 2.5; // slightly chunkier tiles keep the count sane on the bigger island
    const n = Math.ceil(ISLAND.half / TILE);
    let seed = 7;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let ix = -n; ix <= n; ix++) {
      for (let iz = -n; iz <= n; iz++) {
        const x = ix * TILE;
        const z = iz * TILE;
        const r = Math.hypot(x, z);
        if (r > ISLAND.half) continue;
        const onSand = r > ISLAND.shore;
        // occasional sun-kissed highlight tile for a hand-placed, lively lawn
        let mat: THREE.Material;
        if (onSand) mat = sand;
        else if (rnd() < 0.1) mat = grassLight;
        else mat = (ix + iz) % 2 === 0 ? grass : grassDark;
        const h = onSand ? 0.6 : 1.0;
        const tile = new THREE.Mesh(new THREE.BoxGeometry(TILE, h, TILE), mat);
        tile.position.set(x, h / 2 - 0.5, z);
        tile.userData.noCast = true; // receives shadow, but kept out of the shadow map
        g.add(tile);
      }
    }
    this.group.add(g);
  }

  private buildWater() {
    const geo = new THREE.CircleGeometry(120, 48);
    const mat = new THREE.MeshStandardMaterial({
      color: VOX.water, transparent: true, opacity: 0.86, roughness: 0.3, metalness: 0.0,
    });
    const w = new THREE.Mesh(geo, mat);
    w.rotation.x = -Math.PI / 2;
    w.position.y = -0.35;
    this.water = w;
    this.group.add(w);

    // a handful of lily pads bobbing in the shallows
    const padMat = voxelMaterial(0x4f9e4a);
    let seed = 99;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 10; i++) {
      const a = rnd() * Math.PI * 2;
      const r = ISLAND.shore + 1.5 + rnd() * 6;
      const lp = new THREE.Mesh(new THREE.CylinderGeometry(0.7 + rnd() * 0.4, 0.7, 0.12, 7), padMat);
      lp.position.set(Math.cos(a) * r, -0.28, Math.sin(a) * r);
      this.lilies.push(lp);
      this.group.add(lp);
    }
  }

  private buildDecor() {
    const trunk = voxelMaterial(VOX.bark);
    const trunkDark = voxelMaterial(VOX.barkDark);
    const rock = voxelMaterial(VOX.rock);
    const tuft = voxelMaterial(VOX.grassLight);
    const flowers = [VOX.flowerPink, VOX.flowerYellow, VOX.flowerWhite, VOX.flowerRed];
    let seed = 1337;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    const tooClose = (x: number, z: number, pad: number) =>
      CLEAR_PTS.some((p) => (p.x - x) ** 2 + (p.z - z) ** 2 < pad * pad);

    // autumn-mixed canopies (green / gold / amber / russet) like the reference —
    // each [main, lit-top, dark-underside] for shaded, sun-kissed crowns.
    const canopies: [number, number, number][] = [
      [VOX.leaf, VOX.leafLight, VOX.leafDark],
      [VOX.leaf, VOX.leafLight, VOX.leafDark],
      [0xe8a23c, 0xffc861, 0xb87a1f], // gold
      [0xd9762e, 0xf0a24a, 0xa9551c], // amber
      [0xc24a35, 0xe0734f, 0x923122], // russet
    ];
    const pines: [number, number][] = [[0x4f8a3a, 0x6fae4a], [0x3f7a4a, 0x5a9a5e]];

    const makeTree = (x: number, z: number) => {
      const tree = new THREE.Group();
      const conifer = rnd() < 0.3;
      const trunkMat = rnd() < 0.5 ? trunk : trunkDark;
      if (conifer) {
        // a stacked-tier pine: tapering green skirts up a slim trunk
        const [pMain, pTop] = pines[Math.floor(rnd() * pines.length)];
        const th = 1.2 + rnd() * 1.0;
        const tk = new THREE.Mesh(new THREE.BoxGeometry(0.4, th, 0.4), trunkMat);
        tk.position.y = th / 2;
        tree.add(tk);
        const tiers = 4 + Math.floor(rnd() * 2);
        for (let k = 0; k < tiers; k++) {
          const w = 2.3 - k * (1.8 / tiers);
          const tier = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, w), voxelMaterial(k === tiers - 1 ? pTop : pMain));
          tier.position.y = th + 0.2 + k * 0.62;
          tree.add(tier);
        }
      } else {
        // a leafy broadleaf: tapered trunk with root flares, an irregular bushy
        // crown (offset chunks, not a neat stack), a branch stub, + maybe blossoms
        const [cMain, cTop, cDark] = canopies[Math.floor(rnd() * canopies.length)];
        const main = voxelMaterial(cMain);
        const th = 2.2 + rnd() * 2.4;
        const tk = new THREE.Mesh(new THREE.BoxGeometry(0.65, th, 0.65), trunkMat);
        tk.position.y = th / 2;
        const tkTop = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.8, 0.5), trunkMat);
        tkTop.position.y = th + 0.2;
        tree.add(tk, tkTop);
        // root flares at the base
        for (let r = 0; r < 4; r++) {
          const a = (r / 4) * Math.PI * 2;
          const root = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.4, 0.3), trunkMat);
          root.position.set(Math.cos(a) * 0.4, 0.18, Math.sin(a) * 0.4);
          tree.add(root);
        }
        // a low branch stub
        if (rnd() < 0.6) {
          const br = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.24, 0.24), trunkMat);
          const ba = rnd() * Math.PI * 2;
          br.position.set(Math.cos(ba) * 0.5, th * 0.62, Math.sin(ba) * 0.5);
          br.rotation.y = ba;
          tree.add(br);
        }
        // bushy crown: a darker base, offset mid clumps, and a lit top knob
        const cBase = new THREE.Mesh(new THREE.BoxGeometry(2.6, 1.4, 2.6), voxelMaterial(cDark));
        cBase.position.y = th + 0.5;
        tree.add(cBase);
        for (let c = 0; c < 3; c++) {
          const s = 1.3 + rnd() * 0.9;
          const clump = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.85, s), main);
          clump.position.set((rnd() - 0.5) * 1.7, th + 1.2 + rnd() * 0.8, (rnd() - 0.5) * 1.7);
          tree.add(clump);
        }
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 1.0), voxelMaterial(cTop));
        top.position.y = th + 2.5;
        tree.add(top);
        // spring blossoms / berries dotted on the crown
        if (rnd() < 0.4) {
          const bcol = rnd() < 0.5 ? VOX.flowerPink : VOX.flowerWhite;
          for (let b = 0; b < 5; b++) {
            const bl = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), glowMaterial(bcol, 0.35));
            bl.position.set((rnd() - 0.5) * 2.4, th + 1.0 + rnd() * 1.6, (rnd() - 0.5) * 2.4);
            tree.add(bl);
          }
        }
      }
      tree.position.set(x, 0, z);
      tree.rotation.y = rnd() * Math.PI;
      this.group.add(tree);
    };

    // OUTER RING — big trees + rock clusters ringing the village, well clear of
    // the play area. Sparser than before (bigger gaps) so it frames, not crowds.
    for (let i = 0; i < 70; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 26 + rnd() * (ISLAND.shore - 28);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (tooClose(x, z, 4)) continue;
      if (rnd() < 0.8) {
        makeTree(x, z);
      } else {
        const cl = new THREE.Group();
        const cnt = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < cnt; k++) {
          const s = 0.6 + rnd() * 0.9;
          const rk = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.7, s), rock);
          rk.position.set((rnd() - 0.5) * 1.2, s * 0.35, (rnd() - 0.5) * 1.2);
          rk.rotation.y = rnd() * Math.PI;
          cl.add(rk);
        }
        cl.position.set(x, 0, z);
        this.group.add(cl);
      }
    }

    // INNER BAND — only LOW dressing (flowers, tufts, mushrooms, pebbles) in the
    // ring around the plaza + among the houses, skipping near any structure.
    for (let i = 0; i < 120; i++) {
      const a = rnd() * Math.PI * 2;
      const r = PLAZA_R + 1 + rnd() * 12; // 14 .. 26
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (tooClose(x, z, 4.2)) continue;
      const roll = rnd();
      if (roll < 0.45) {
        const patch = new THREE.Group();
        const col = flowers[Math.floor(rnd() * flowers.length)];
        for (let k = 0; k < 3; k++) {
          const stem = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.5, 0.08), voxelMaterial(VOX.flowerStem));
          stem.position.set((rnd() - 0.5) * 0.8, 0.25, (rnd() - 0.5) * 0.8);
          const head = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.24, 0.24), glowMaterial(col, 0.4));
          head.position.set(stem.position.x, 0.58, stem.position.z);
          patch.add(stem, head);
        }
        patch.position.set(x, 0, z);
        this.group.add(patch);
      } else if (roll < 0.7) {
        const t = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.5, 0.4), tuft);
        t.position.set(x, 0.2, z);
        t.scale.y = 0.6 + rnd();
        this.group.add(t);
      } else if (roll < 0.85) {
        const m = new THREE.Group();
        const stem = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.3, 0.16), voxelMaterial(VOX.mushroomStem));
        stem.position.y = 0.15;
        const cap = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.2, 0.34), voxelMaterial(VOX.mushroomCap));
        cap.position.y = 0.36;
        m.add(stem, cap);
        m.position.set(x, 0, z);
        this.group.add(m);
      } else {
        const s = 0.3 + rnd() * 0.3;
        const peb = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.6, s), voxelMaterial(VOX.pebble));
        peb.position.set(x, s * 0.3, z);
        this.group.add(peb);
      }
    }
  }

  /** Big layered rock outcrops near the shore — a craggy skyline that frames the
   *  village like the cliffs in the reference (placed behind the tree band). */
  private buildBackdrop() {
    const tones = [VOX.rock, VOX.rockDark, VOX.stone, VOX.stoneDark, 0x8a8d86];
    let seed = 24680;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const tone = () => voxelMaterial(tones[Math.floor(rnd() * tones.length)]);

    // One craggy peak: a stepped, jittered stack of stone blocks with mossy
    // ledges, a shadowed back face, scree at the foot, and a snow/grass cap.
    const makePeak = (cx: number, cz: number, scale: number, snowy: boolean) => {
      const peak = new THREE.Group();
      const layers = 4 + Math.floor(rnd() * 3);
      let w = (4 + rnd() * 4) * scale;
      let y = 0;
      for (let k = 0; k < layers; k++) {
        const h = (1.4 + rnd() * 2.0) * scale;
        const dep = w * (0.7 + rnd() * 0.5);
        const blk = new THREE.Mesh(new THREE.BoxGeometry(w, h, dep), tone());
        blk.position.set((rnd() - 0.5) * 1.6 * scale, y + h / 2, (rnd() - 0.5) * 1.6 * scale);
        blk.rotation.y = rnd() * 0.5;
        peak.add(blk);
        // a darker shadow slab tucked on the back/side for craggy depth
        if (rnd() < 0.7) {
          const sh = new THREE.Mesh(new THREE.BoxGeometry(w * 0.6, h * 0.8, dep * 0.5), voxelMaterial(VOX.rockDark));
          sh.position.set(blk.position.x - w * 0.3, y + h * 0.4, blk.position.z - dep * 0.3);
          peak.add(sh);
        }
        // a mossy/grass ledge on lower steps
        if (k < layers - 1 && rnd() < 0.55) {
          const moss = new THREE.Mesh(new THREE.BoxGeometry(w * 0.7, 0.3 * scale, dep * 0.7), voxelMaterial(rnd() < 0.5 ? VOX.grass : VOX.grassDark));
          moss.position.set(blk.position.x + (rnd() - 0.5) * w * 0.3, y + h - 0.1, blk.position.z + (rnd() - 0.5) * dep * 0.3);
          peak.add(moss);
        }
        y += h * (0.66 + rnd() * 0.2);
        w *= 0.66 + rnd() * 0.13;
      }
      // stepped snow (or grass) cap — 2 decreasing blocks for a real summit
      const capCol = snowy ? 0xeef2f6 : VOX.grass;
      for (let c = 0; c < 2; c++) {
        const cw = (w + 0.6) * (1 - c * 0.4);
        const cap = new THREE.Mesh(new THREE.BoxGeometry(cw, 0.6 * scale, cw), voxelMaterial(c === 0 ? capCol : (snowy ? 0xffffff : VOX.grassLight)));
        cap.position.y = y + 0.2 + c * 0.5 * scale;
        peak.add(cap);
      }
      // scree boulders scattered at the foot
      for (let b = 0; b < 3 + Math.floor(rnd() * 3); b++) {
        const s = (0.6 + rnd() * 1.1) * scale;
        const rk = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.7, s), tone());
        const ba = rnd() * Math.PI * 2;
        rk.position.set(Math.cos(ba) * (w + 2) * scale * 0.6, s * 0.35, Math.sin(ba) * (w + 2) * scale * 0.6);
        rk.rotation.y = rnd() * Math.PI;
        peak.add(rk);
      }
      peak.position.set(cx, 0, cz);
      return peak;
    };

    const count = 9;
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2 + (rnd() - 0.5) * 0.4;
      const r = ISLAND.shore - 3 - rnd() * 4;
      const cx = Math.cos(a) * r;
      const cz = Math.sin(a) * r;
      // a main peak flanked by a smaller sister peak → a craggy multi-summit massif
      const big = rnd() < 0.5;
      const main = makePeak(cx, cz, big ? 1.25 : 1.0, big);
      this.group.add(main);
      if (rnd() < 0.6) {
        const off = 4 + rnd() * 3;
        const sa = a + (rnd() - 0.5) * 0.6;
        this.group.add(makePeak(cx + Math.cos(sa) * off, cz + Math.sin(sa) * off, 0.6, false));
      }
    }
  }

  private buildPlaza() {
    // A hand-laid stone town square: irregular multi-tone flagstones with tiny
    // height jitter (so it reads as real masonry, not a flat disc), set slightly
    // below the grass like inset paving — the cozy Hypixel courtyard.
    const tones = [VOX.cobble, VOX.cobbleDark, VOX.stone, VOX.stoneDark, 0x9bae84];
    const wts = [0.3, 0.26, 0.22, 0.14, 0.08]; // mossy (last) is rare
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const pickTone = () => {
      let r = rnd();
      for (let i = 0; i < tones.length; i++) { r -= wts[i]; if (r < 0) return tones[i]; }
      return tones[0];
    };
    const R = PLAZA_R;
    const step = 1.5;
    const n = Math.ceil(R / step);
    for (let ix = -n; ix <= n; ix++) {
      for (let iz = -n; iz <= n; iz++) {
        const x = ix * step + (rnd() - 0.5) * 0.12;
        const z = iz * step + (rnd() - 0.5) * 0.12;
        if (Math.hypot(x, z) > R) continue;
        const h = 0.38 + rnd() * 0.08;
        const tile = new THREE.Mesh(new THREE.BoxGeometry(step * 0.96, h, step * 0.96), voxelMaterial(pickTone()));
        tile.position.set(x, h / 2 - 0.32, z);
        tile.rotation.y = (rnd() - 0.5) * 0.05;
        tile.userData.noCast = true; // paving receives shadow, doesn't cast
        this.group.add(tile);
      }
    }
    // a low stepped kerb ringing the square
    const kerb = new THREE.Mesh(new THREE.TorusGeometry(R + 0.15, 0.18, 5, 44), voxelMaterial(VOX.stoneDark));
    kerb.rotation.x = Math.PI / 2;
    kerb.position.y = 0.16;
    this.group.add(kerb);
  }

  /** Wide cobble spoke paths from the plaza out to each portal gate. */
  private buildPaths() {
    const path = voxelMaterial(VOX.path);
    const pathDark = voxelMaterial(VOX.dirtDark);
    for (const g of GATES) {
      const dir = g.pos.clone().normalize();
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);
      const start = PLAZA_R - 1;
      const end = g.pos.length() - 1.6;
      for (let r = start; r <= end; r += 0.95) {
        for (const off of [-0.85, 0.85]) {
          const c = dir.clone().multiplyScalar(r).add(perp.clone().multiplyScalar(off));
          const tile = new THREE.Mesh(new THREE.BoxGeometry(1.7, 0.2, 1.7), (Math.round(r) + (off > 0 ? 1 : 0)) % 2 ? path : pathDark);
          tile.position.set(c.x, 0.0, c.z);
          tile.rotation.y = Math.atan2(dir.x, dir.z);
          tile.userData.noCast = true;
          this.group.add(tile);
        }
      }
    }
  }

  /**
   * The centerpiece: a grand three-tier fountain with cascading glowing basins,
   * arcing water jets, and a slowly-rotating crystal spire crowning the top.
   */
  private buildFountain() {
    const stone = voxelMaterial(VOX.stone);
    const stoneDark = voxelMaterial(VOX.stoneDark);

    // a wide base pool with a low carved rim, then stacked basins narrowing up
    const rim = new THREE.Mesh(new THREE.TorusGeometry(3.9, 0.28, 6, 32), stoneDark);
    rim.rotation.x = Math.PI / 2;
    rim.position.y = 0.55;
    this.group.add(rim);
    // little kerb posts around the pool
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 0.7, 0.4), stone);
      post.position.set(Math.cos(a) * 3.9, 0.35, Math.sin(a) * 3.9);
      this.group.add(post);
    }
    const tiers = [
      { r: 3.7, y: 0.35, h: 0.6 },
      { r: 2.4, y: 1.1, h: 0.7 },
      { r: 1.55, y: 1.9, h: 0.6 },
      { r: 0.95, y: 2.6, h: 0.5 },
    ];
    tiers.forEach((tr, i) => {
      const basin = new THREE.Mesh(new THREE.CylinderGeometry(tr.r, tr.r + 0.22, tr.h, 18), i % 2 ? stoneDark : stone);
      basin.position.y = tr.y;
      this.group.add(basin);
      const water = new THREE.Mesh(new THREE.CylinderGeometry(tr.r - 0.2, tr.r - 0.2, 0.12, 18), this.fountainWaterMat());
      water.position.y = tr.y + tr.h / 2 + 0.02;
      this.fountainDiscs.push(water);
      this.group.add(water);
    });

    // crystal spire on top — a faceted glowing octahedron
    const spire = new THREE.Mesh(new THREE.OctahedronGeometry(0.7, 0), glowMaterial(0x9fe8ff, 1.2));
    (spire.geometry as THREE.BufferGeometry).scale(1, 1.7, 1);
    this.fountainSpireBaseY = 3.7;
    spire.position.y = this.fountainSpireBaseY;
    this.fountainSpire = spire;
    this.group.add(spire);

    // arcing water jets around the top basin (translucent rising shafts)
    const jetMat = () =>
      new THREE.MeshStandardMaterial({
        color: VOX.water, emissive: VOX.water, emissiveIntensity: 0.8,
        transparent: true, opacity: 0.5, depthWrite: false, toneMapped: false,
      });
    for (let i = 0; i < 8; i++) {
      const a = (i / 8) * Math.PI * 2;
      const jet = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.8, 0.14), jetMat());
      jet.position.set(Math.cos(a) * 1.7, 2.2, Math.sin(a) * 1.7);
      jet.userData.baseY = 2.2;
      this.fountainJets.push(jet);
      this.group.add(jet);
    }
  }
  private fountainSpireBaseY = 3.7;

  private fountainWaterMat() {
    return new THREE.MeshStandardMaterial({
      color: 0x6fd0ff, emissive: 0x3f9fe0, emissiveIntensity: 0.7,
      roughness: 0.3, transparent: true, opacity: 0.92, toneMapped: false,
    });
  }

  /** Build the utility pads (join + shop) just outside the plaza. */
  private buildZones() {
    for (const p of PADS) this.addPad(p.id, p.id, p.pos.clone(), p.color, p.label);
  }

  private addPad(id: string, kind: IslandZone["kind"], pos: THREE.Vector3, color: number, label: string) {
    const pad = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.2, 24), glowMaterial(color, 0.9));
    ring.position.y = 0.12;
    const inner = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.24, 24), glowMaterial(color, 0.45));
    inner.position.y = 0.13;
    const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.4, 0.5), glowMaterial(color, 1.0));
    beacon.position.y = 1.4;
    // a small floating icon-cube crowning the beacon
    const cap = new THREE.Mesh(new THREE.OctahedronGeometry(0.32, 0), glowMaterial(color, 1.2));
    cap.position.y = 2.9;
    this.beacons.push(beacon, cap);
    pad.add(ring, inner, beacon, cap);
    pad.position.copy(pos);
    this.group.add(pad);
    this.pads.push({ id, group: pad, ring, pos: pos.clone(), lit: 0 });
    this.zones.push({ id, kind, pos: pos.clone(), radius: 2.2, label });
  }

  /**
   * The three co-op ROOMS — Solo / Duo / Squad — open-top stone enclosures you
   * walk into (the iso camera sees over the walls). Each has a glowing tier-
   * coloured floor rune, a doorway facing the plaza flanked by torches + banners,
   * battlements, a sign plaque, and bobbing party-size figures inside. Standing
   * inside pools players for the gather (count shown on the HUD); walk out to
   * cancel. Bigger + grander per tier so the party size reads at a glance.
   */
  private buildModes() {
    for (const m of GATES) {
      const g = new THREE.Group();
      const interior = 3.2 + m.grand * 1.1; // floor span (solo→squad)
      const half = interior / 2;
      const h = 2.2 + m.grand * 0.35; // wall height
      const wt = 0.4; // wall thickness
      const doorGap = 1.9;
      const stone = voxelMaterial(VOX.stone);
      const stoneDark = voxelMaterial(VOX.stoneDark);
      const trim = glowMaterial(m.color, 0.5);
      const outer = interior + 0.8;

      // ---- floor: tinted slab + a glowing rune you stand on ----
      const slab = new THREE.Mesh(new THREE.BoxGeometry(outer, 0.2, outer), stoneDark);
      slab.position.y = 0.0;
      const floor = new THREE.Mesh(new THREE.CylinderGeometry(half + 0.1, half + 0.1, 0.12, 24), glowMaterial(m.color, 0.7));
      floor.position.y = 0.12;
      const rune = new THREE.Mesh(new THREE.TorusGeometry(half - 0.3, 0.08, 6, 28), glowMaterial(m.color, 0.9));
      rune.rotation.x = Math.PI / 2;
      rune.position.y = 0.2;
      g.add(slab, floor, rune);

      // ---- walls (open top): back + sides solid, front split for a doorway ----
      const wallWithTrim = (w: number, d: number, x: number, z: number) => {
        const wall = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), stone);
        wall.position.set(x, h / 2 + 0.1, z);
        const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.05, 0.18, d + 0.05), trim);
        cap.position.set(x, h + 0.1, z);
        g.add(wall, cap);
      };
      wallWithTrim(outer, wt, 0, -half - wt / 2); // back (-z)
      wallWithTrim(wt, outer, -half - wt / 2, 0); // left
      wallWithTrim(wt, outer, half + wt / 2, 0); // right
      // front (+z): two segments leaving a central doorway
      const segW = (outer - doorGap) / 2;
      for (const sx of [-1, 1]) {
        wallWithTrim(segW, wt, sx * (doorGap / 2 + segW / 2), half + wt / 2);
      }
      // doorway header + a glowing sign plaque over it
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(doorGap + 0.5, 0.4, wt + 0.1), stoneDark);
      lintel.position.set(0, h - 0.1, half + wt / 2);
      const plaque = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.7, 0.12), glowMaterial(m.color, 1.0));
      plaque.position.set(0, h + 0.35, half + wt / 2 + 0.06);
      g.add(lintel, plaque);
      // corner posts + battlement merlons along the back wall
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
        const post = new THREE.Mesh(new THREE.BoxGeometry(wt + 0.2, h + 0.3, wt + 0.2), stoneDark);
        post.position.set(sx * (half + wt / 2), (h + 0.3) / 2 + 0.1, sz * (half + wt / 2));
        g.add(post);
      }
      const merlonN = 3 + m.grand;
      for (let i = 0; i < merlonN; i++) {
        const mer = new THREE.Mesh(new THREE.BoxGeometry(0.45, 0.45, wt + 0.1), stone);
        mer.position.set(-half + 0.4 + (i / (merlonN - 1)) * (outer - 0.8), h + 0.35, -half - wt / 2);
        g.add(mer);
      }

      // ---- torches flanking the doorway + banners on the front wall ----
      for (const sx of [-1, 1]) {
        const { group: tg, flame } = this.makeTorch(0xffa53a);
        tg.position.set(sx * (doorGap / 2 + 0.4), 0.1, half + wt / 2 + 0.2);
        g.add(tg);
        this.flames.push(flame);
        const banner = this.makeBanner(m.color, h);
        banner.group.position.set(sx * (half - 0.3), h - 0.2, half + wt / 2 + 0.08);
        g.add(banner.group);
        this.banners.push(banner.rec);
      }
      // a warm lantern on each front corner post
      for (const sx of [-1, 1]) {
        const lan = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.34, 0.26), glowMaterial(VOX.lantern, 1.2));
        lan.position.set(sx * (half + wt / 2), h + 0.1, half + wt / 2);
        g.add(lan);
        this.beacons.push(lan);
      }

      // ---- bobbing party-size figures standing on the floor inside ----
      const figures: THREE.Object3D[] = [];
      for (let i = 0; i < m.players; i++) {
        const a = m.players === 1 ? 0 : (i / m.players) * Math.PI * 2;
        const rr = m.players === 1 ? 0 : half * 0.42;
        const fig = new THREE.Group();
        const body = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.55, 0.34), glowMaterial(m.color, 1.0));
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.3, 0.3), glowMaterial(0xfff2d6, 0.6));
        head.position.y = 0.42;
        fig.add(body, head);
        fig.position.set(Math.cos(a) * rr, 0.5, Math.sin(a) * rr - half * 0.2);
        figures.push(fig);
        g.add(fig);
      }

      g.position.copy(m.pos);
      g.rotation.y = Math.atan2(-m.pos.x, -m.pos.z); // doorway (+z) faces the plaza
      this.group.add(g);
      this.rooms.push({ group: g, floor, rune, figures, pos: m.pos.clone(), color: m.color, lit: 0 });
      this.zones.push({ id: m.id, kind: "mode", pos: m.pos.clone(), radius: half + 0.6, label: m.label, modePlayers: m.players });
    }
  }

  /** A flickering torch: post + bowl + glowing flame. Returns the flame record. */
  private makeTorch(flameColor: number): { group: THREE.Group; flame: Flame } {
    const group = new THREE.Group();
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.22, 1.8, 0.22), voxelMaterial(VOX.bark));
    post.position.y = 0.9;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.28, 0.18, 0.3, 8), voxelMaterial(VOX.steelDark));
    bowl.position.y = 1.85;
    const flameMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.26, 0), glowMaterial(flameColor, 1.5));
    flameMesh.position.y = 2.15;
    (flameMesh.geometry as THREE.BufferGeometry).scale(1, 1.5, 1);
    group.add(post, bowl, flameMesh);
    return { group, flame: { mesh: flameMesh, phase: Math.random() * 6.28, base: 1 } };
  }

  /** A hanging cloth banner that ripples; returns the group + animation record. */
  private makeBanner(color: number, height: number): { group: THREE.Group; rec: Banner } {
    const group = new THREE.Group();
    const pole = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.5, 0.1), voxelMaterial(VOX.steelDark));
    pole.position.y = 0.2;
    group.add(pole);
    const segs: THREE.Mesh[] = [];
    const segN = 4;
    const clothMat = glowMaterial(color, 0.5);
    for (let i = 0; i < segN; i++) {
      const seg = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.42, 0.06), clothMat);
      seg.position.y = -0.2 - i * 0.42;
      group.add(seg);
      segs.push(seg);
    }
    // accent emblem in the middle
    const emblem = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.08), glowMaterial(0xfff2d6, 0.8));
    emblem.position.set(0, -0.62, 0.04);
    group.add(emblem);
    void height;
    return { group, rec: { segs, phase: Math.random() * 6.28 } };
  }

  /**
   * The five egg shrines ringing the fountain. Each is a tiered pedestal topped
   * by a faceted, glowing gem-egg that bobs and wobbles inside a breathing aura,
   * crowned by a rising light shaft and orbited by sparkles. Tiers are visually
   * graded — pricier eggs glow brighter and carry more sparkles — so value reads
   * at a glance. Pure visuals; hatching is handled in main via the gacha module.
   */
  private buildEggs(eggDefs = DEFAULT_EGG_VISUALS) {
    const ringR = EGG_R;
    eggDefs.forEach((e, i) => {
      const a = (i / eggDefs.length) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * ringR;
      const z = Math.sin(a) * ringR;
      const pos = new THREE.Vector3(x, 0, z);
      const g = new THREE.Group();

      // --- tiered pedestal (chunky voxel stone with a tier-colored gem inset) ---
      const base = new THREE.Mesh(new THREE.CylinderGeometry(0.8, 0.95, 0.5, 8), voxelMaterial(VOX.stone));
      base.position.y = 0.25;
      const mid = new THREE.Mesh(new THREE.CylinderGeometry(0.58, 0.72, 0.7, 8), voxelMaterial(VOX.stoneDark));
      mid.position.y = 0.85;
      const top = new THREE.Mesh(new THREE.CylinderGeometry(0.78, 0.64, 0.26, 8), voxelMaterial(VOX.stone));
      top.position.y = 1.33;
      g.add(base, mid, top);
      // gem insets on the pedestal (front + back) so it glows from any angle
      for (const gz of [0.62, -0.62]) {
        const gem = new THREE.Mesh(new THREE.OctahedronGeometry(0.2, 0), glowMaterial(e.color, 1.2));
        gem.position.set(0, 0.85, gz);
        g.add(gem);
      }
      // glowing disc on top the egg floats above
      const ringGlow = new THREE.Mesh(new THREE.CylinderGeometry(0.66, 0.66, 0.09, 16), glowMaterial(e.color, 0.9));
      ringGlow.position.y = 1.48;
      g.add(ringGlow);

      // --- the egg: a big faceted, gem-like ovoid (flat-shaded catches light) ---
      const eggGeo = new THREE.IcosahedronGeometry(0.66, 1);
      eggGeo.scale(1, 1.34, 1);
      const egg = new THREE.Mesh(eggGeo, glowMaterial(e.color, 1.3));
      egg.position.y = 2.05;
      // speckle pattern: bright accent cubes banded around the shell
      const speckN = 6;
      for (let s = 0; s < speckN; s++) {
        const sa = (s / speckN) * Math.PI * 2;
        const sp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, 0.12), glowMaterial(0xfff6e0, 1.0));
        sp.position.set(Math.cos(sa) * 0.48, 0.06 + (s % 2) * 0.3, Math.sin(sa) * 0.48);
        egg.add(sp);
      }
      g.add(egg);

      // --- breathing aura shell ---
      const aura = new THREE.Mesh(new THREE.IcosahedronGeometry(1.0, 1), auraMaterial(e.color, 0.6));
      (aura.geometry as THREE.BufferGeometry).scale(1, 1.32, 1);
      aura.position.y = 2.05;
      g.add(aura);

      // --- rising light shaft ---
      const beam = new THREE.Mesh(
        // narrow at the egg, flaring upward — a shaft of rising magic
        new THREE.CylinderGeometry(0.55, 0.16, 2.8, 8, 1, true),
        new THREE.MeshStandardMaterial({
          color: e.color, emissive: e.color, emissiveIntensity: 1.0,
          transparent: true, opacity: 0.12, depthWrite: false,
          side: THREE.DoubleSide, toneMapped: false,
        }),
      );
      beam.position.y = 3.3;
      g.add(beam);

      // --- orbiting sparkles (more on richer tiers) ---
      const orbit = new THREE.Group();
      const sparkN = 3 + i; // common 3 → mythic 7
      for (let s = 0; s < sparkN; s++) {
        const sa = (s / sparkN) * Math.PI * 2;
        const rr = 0.92;
        const spark = new THREE.Mesh(new THREE.OctahedronGeometry(0.1, 0), glowMaterial(0xffffff, 1.3));
        spark.position.set(Math.cos(sa) * rr, (s % 2 ? 0.2 : -0.15), Math.sin(sa) * rr);
        orbit.add(spark);
      }
      orbit.position.y = 2.05;
      g.add(orbit);

      g.position.copy(pos);
      this.group.add(g);
      this.eggs.push({ id: e.id, group: g, egg, aura, orbit, beam, ringGlow, pos: pos.clone(), phase: i * 1.3, color: e.color, lit: 0 });
      this.zones.push({ id: e.id, kind: "egg", pos: pos.clone(), radius: 1.9, label: e.label, eggId: e.id });
    });
  }

  /**
   * The Pet Sanctuary — a little hexagonal pavilion where you walk up to equip
   * your squad (opens the Pets shop tab) and show them off. A stone podium under
   * six timber posts holding a canopy, crowned by a spinning glowing orb with
   * hearts orbiting it. Your equipped pets float around you in the hub already,
   * so this is the "manage + flex" spot.
   */
  private buildSanctuary() {
    const g = new THREE.Group();
    const stone = voxelMaterial(VOX.stone);
    const wood = voxelMaterial(VOX.bark);
    // raised stone podium + a step ring
    const podium = new THREE.Mesh(new THREE.CylinderGeometry(2.3, 2.5, 0.45, 6), stone);
    podium.position.y = 0.22;
    const stepRing = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.9, 0.22, 6), voxelMaterial(VOX.stoneDark));
    stepRing.position.y = 0.11;
    const floor = new THREE.Mesh(new THREE.CylinderGeometry(2.0, 2.0, 0.08, 6), glowMaterial(0xff9ec7, 0.5));
    floor.position.y = 0.46;
    g.add(stepRing, podium, floor);
    // six posts + a canopy roof + finial
    for (let i = 0; i < 6; i++) {
      const a = (i / 6) * Math.PI * 2;
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.26, 3.0, 0.26), wood);
      post.position.set(Math.cos(a) * 2.0, 1.95, Math.sin(a) * 2.0);
      g.add(post);
    }
    const roof = new THREE.Mesh(new THREE.ConeGeometry(2.9, 1.4, 6), voxelMaterial(VOX.roofPurple));
    roof.position.y = 4.1;
    roof.rotation.y = Math.PI / 6;
    const roofTrim = new THREE.Mesh(new THREE.CylinderGeometry(2.9, 2.9, 0.2, 6), voxelMaterial(VOX.woodTrim));
    roofTrim.position.y = 3.5;
    g.add(roof, roofTrim);
    // central pedestal + spinning glowing orb (the flex centerpiece)
    const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.4, 0.5, 1.0, 8), stone);
    ped.position.y = 0.96;
    g.add(ped);
    const orb = new THREE.Mesh(new THREE.IcosahedronGeometry(0.5, 1), glowMaterial(0xff7ab0, 1.2));
    orb.position.y = 2.0;
    this.sanctuaryOrb = orb;
    g.add(orb);
    // little hearts orbiting the orb
    const hearts = new THREE.Group();
    for (let i = 0; i < 5; i++) {
      const a = (i / 5) * Math.PI * 2;
      const heart = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.2, 0.2), glowMaterial(0xff9ec7, 1.2));
      heart.position.set(Math.cos(a) * 0.95, (i % 2 ? 0.15 : -0.1), Math.sin(a) * 0.95);
      hearts.add(heart);
    }
    hearts.position.y = 2.0;
    this.sanctuaryHearts = hearts;
    g.add(hearts);

    g.position.copy(SANCTUARY);
    g.rotation.y = Math.atan2(-SANCTUARY.x, -SANCTUARY.z); // face the plaza
    this.group.add(g);
    this.zones.push({ id: "pets", kind: "pets", pos: SANCTUARY.clone(), radius: 2.5, label: "Pet Sanctuary — equip & flex your pets" });
  }

  /** A giant leaderboard billboard floating in the sky behind the village. It's
   *  fog-immune (so the warm haze doesn't wash it out) and glows; the face is a
   *  canvas sprite redrawn by main via setLeaderboard(). */
  private buildLeaderboard() {
    const noFog = (m: THREE.MeshStandardMaterial) => { m.fog = false; return m; };
    const g = new THREE.Group();
    const W = 13, H = 8;
    // backing panel + dark inset + a glowing frame, all immune to the warm fog
    const back = new THREE.Mesh(new THREE.BoxGeometry(W, H, 0.5), noFog(voxelMaterial(VOX.woodTrim)));
    const inset = new THREE.Mesh(new THREE.BoxGeometry(W - 1.0, H - 1.0, 0.6),
      noFog(new THREE.MeshStandardMaterial({ color: 0x241a12, roughness: 1 })));
    inset.position.z = 0.06;
    g.add(back, inset);
    for (const [w, h, x, y] of [[W + 0.6, 0.5, 0, H / 2], [W + 0.6, 0.5, 0, -H / 2], [0.5, H + 0.6, -W / 2, 0], [0.5, H + 0.6, W / 2, 0]] as const) {
      const bar = new THREE.Mesh(new THREE.BoxGeometry(w, h, 0.7), noFog(glowMaterial(VOX.lantern, 1.1)));
      bar.position.set(x, y, 0.1);
      g.add(bar);
    }
    // a couple of glowing finials on top
    for (const fx of [-W / 2, W / 2]) {
      const fin = new THREE.Mesh(new THREE.OctahedronGeometry(0.6, 0), noFog(glowMaterial(0xffd24a, 1.3)));
      fin.position.set(fx, H / 2 + 0.7, 0.1);
      g.add(fin);
    }
    // canvas-sprite face (hi-res for big crisp text; fog disabled)
    this.lbCanvas = document.createElement("canvas");
    this.lbCanvas.width = 512;
    this.lbCanvas.height = 320;
    this.lbTex = new THREE.CanvasTexture(this.lbCanvas);
    this.lbTex.colorSpace = THREE.SRGBColorSpace;
    this.lbTex.generateMipmaps = false;
    this.lbTex.minFilter = THREE.LinearFilter;
    const face = new THREE.Sprite(new THREE.SpriteMaterial({ map: this.lbTex, transparent: true, depthTest: true, depthWrite: false, toneMapped: false, fog: false }));
    face.scale.set(W - 1.2, H - 1.2, 1);
    face.position.set(0, 0, 0.4);
    g.add(face);
    this.setLeaderboard([]);
    // float it high in the sky at the back of the map, facing the plaza (+z)
    g.position.set(0, 15, -32);
    this.group.add(g);
  }

  /** Redraw the leaderboard face with the current top survivors. */
  setLeaderboard(entries: { name: string; best: number }[]) {
    if (!this.lbCanvas || !this.lbTex) return;
    const W = this.lbCanvas.width, H = this.lbCanvas.height;
    const g = this.lbCanvas.getContext("2d")!;
    g.clearRect(0, 0, W, H);
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.font = "bold 44px system-ui, sans-serif";
    g.fillStyle = "#ffd24a";
    g.fillText("🏆 TOP SURVIVORS", W / 2, 38);
    g.font = "bold 32px system-ui, sans-serif";
    const top = entries.filter((e) => e.best > 0).sort((a, b) => b.best - a.best).slice(0, 5);
    if (!top.length) {
      g.fillStyle = "#e8dcc8";
      g.fillText("No runs yet — go make a mess!", W / 2, H / 2 + 10);
    } else {
      top.forEach((e, i) => {
        const y = 100 + i * 44;
        g.fillStyle = ["#ffd24a", "#cfe0ff", "#e0b070", "#ffffff", "#ffffff"][i] ?? "#fff";
        const nm = e.name.length > 14 ? e.name.slice(0, 13) + "…" : e.name;
        g.textAlign = "left";
        g.fillText(`${i + 1}. ${nm}`, 30, y);
        g.textAlign = "right";
        g.fillText(`R${e.best}`, W - 30, y);
      });
    }
    this.lbTex.needsUpdate = true;
  }

  /**
   * The cozy village — timber-framed cottages framing the square (the Shop & the
   * Inn are real buildings you walk up to; the rest dress the town), plus a pair
   * of market stalls flanking the entry path. This is what turns the hub from an
   * open field into a Hypixel-style courtyard.
   */
  private buildHouses() {
    for (const c of HOUSES) {
      const house = this.makeCottage(c.wall, c.roof, c.trim, c.big > 0, c.story > 0);
      house.position.set(c.x, 0, c.z);
      house.rotation.y = Math.atan2(-c.x, -c.z); // door (built on +z) faces the square
      this.group.add(house);
    }
    for (const s of STALLS) {
      const stall = this.makeStall(s.color);
      stall.position.set(s.x, 0, s.z);
      stall.rotation.y = Math.atan2(-s.x, -s.z);
      this.group.add(stall);
    }
  }

  /** A detailed timber-framed cottage: stone footing + porch step, plaster walls
   *  with Tudor framing, framed windows with shutters & flower boxes, a doorway
   *  with awning, a stepped gable roof with eaves, an optional second storey +
   *  dormer, a smoking chimney, and (for big plots) a hanging shop sign. */
  private makeCottage(wallColor: number, roofColor: number, trimColor: number, big: boolean, story: boolean): THREE.Group {
    const h = new THREE.Group();
    const w = big ? 4.6 : 3.6;
    const d = big ? 5.4 : 4.4;
    const wallH = 2.6;
    const wallTop = 0.2 + wallH;
    const trim = voxelMaterial(trimColor);
    const wallMat = voxelMaterial(wallColor);
    const roofMat = voxelMaterial(roofColor);
    const roofMat2 = voxelMaterial(darken(roofColor, 0.82));
    const winMat = glowMaterial(VOX.windowGlow, 0.95);
    const wood = voxelMaterial(VOX.woodTrim);
    const front = d / 2;

    // stone footing + a front porch step
    const foundation = new THREE.Mesh(new THREE.BoxGeometry(w + 0.7, 0.5, d + 0.7), voxelMaterial(VOX.foundation));
    foundation.position.y = 0.05;
    const step = new THREE.Mesh(new THREE.BoxGeometry(1.8, 0.26, 0.8), voxelMaterial(VOX.stone));
    step.position.set(0, 0.18, front + 0.45);
    h.add(foundation, step);

    const walls = new THREE.Mesh(new THREE.BoxGeometry(w, wallH, d), wallMat);
    walls.position.y = 0.2 + wallH / 2;
    h.add(walls);
    // a stone base course wrapping the lower walls (classic cottage masonry)
    const baseCourse = new THREE.Mesh(new THREE.BoxGeometry(w + 0.14, 0.7, d + 0.14), voxelMaterial(VOX.foundation));
    baseCourse.position.y = 0.2 + 0.35;
    h.add(baseCourse);

    // Tudor framing: corner posts + a mid + top horizontal band + two front studs
    for (const sx of [-1, 1]) for (const sz of [-1, 1]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.3, wallH, 0.3), trim);
      post.position.set((sx * w) / 2, 0.2 + wallH / 2, (sz * d) / 2);
      h.add(post);
    }
    for (const by of [wallTop - 0.05, 0.2 + wallH * 0.55]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(w + 0.08, 0.2, d + 0.08), trim);
      band.position.y = by;
      h.add(band);
    }
    for (const sx of [-1, 1]) {
      const stud = new THREE.Mesh(new THREE.BoxGeometry(0.18, wallH, 0.12), trim);
      stud.position.set(sx * (w / 2 - 0.95), 0.2 + wallH / 2, front + 0.01);
      h.add(stud);
      // diagonal timber brace on the upper front gable section (Tudor look)
      const brace = new THREE.Mesh(new THREE.BoxGeometry(0.15, 1.5, 0.1), trim);
      brace.position.set(sx * (w / 2 - 0.5), 0.2 + wallH * 0.78, front + 0.01);
      brace.rotation.z = sx * 0.6;
      h.add(brace);
      // eave bracket under the roof overhang
      const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.46, 0.5), trim);
      bracket.position.set(sx * (w / 2 - 0.1), wallTop + 0.05, front - 0.1);
      bracket.rotation.x = 0.45;
      h.add(bracket);
    }

    // a framed window with optional shutters + a flower box (faces +z)
    const frontWindow = (x: number, y: number, withBox: boolean) => {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.94, 1.06, 0.1), trim);
      frame.position.set(x, y, front + 0.02);
      const pane = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.82, 0.12), winMat);
      pane.position.set(x, y, front + 0.06);
      h.add(frame, pane);
      // glazing-bar mullions (a cross over the pane)
      const mullV = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.82, 0.14), trim);
      mullV.position.set(x, y, front + 0.08);
      const mullH = new THREE.Mesh(new THREE.BoxGeometry(0.68, 0.08, 0.14), trim);
      mullH.position.set(x, y, front + 0.08);
      h.add(mullV, mullH);
      for (const sx of [-1, 1]) {
        const shut = new THREE.Mesh(new THREE.BoxGeometry(0.2, 0.96, 0.06), wood);
        shut.position.set(x + sx * 0.58, y, front + 0.05);
        h.add(shut);
      }
      if (withBox) {
        const box = new THREE.Mesh(new THREE.BoxGeometry(0.86, 0.22, 0.26), wood);
        box.position.set(x, y - 0.62, front + 0.14);
        h.add(box);
        const cols = [VOX.flowerPink, VOX.flowerYellow, VOX.flowerRed, VOX.flowerWhite];
        for (let f = 0; f < 3; f++) {
          const fl = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.18, 0.16), glowMaterial(cols[(f + x) & 3] ?? VOX.flowerPink, 0.4));
          fl.position.set(x - 0.26 + f * 0.26, y - 0.46, front + 0.16);
          h.add(fl);
        }
      }
    };
    frontWindow(-w / 2 + 0.85, 1.55, true);
    frontWindow(w / 2 - 0.85, 1.55, true);
    // simple side windows
    for (const sx of [-1, 1]) for (const sz of [-0.8, 0.9]) {
      const frame = new THREE.Mesh(new THREE.BoxGeometry(0.1, 1.0, 0.92), trim);
      frame.position.set((sx * w) / 2 + sx * 0.02, 1.55, sz);
      const pane = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.76, 0.66), winMat);
      pane.position.set((sx * w) / 2 + sx * 0.05, 1.55, sz);
      h.add(frame, pane);
    }

    // doorway: framed door + a little pitched awning + a wall lantern
    const door = new THREE.Mesh(new THREE.BoxGeometry(1.0, 1.7, 0.14), voxelMaterial(VOX.doorWood));
    door.position.set(0, 0.2 + 0.85, front + 0.05);
    const doorFrame = new THREE.Mesh(new THREE.BoxGeometry(1.3, 2.0, 0.1), trim);
    doorFrame.position.set(0, 0.2 + 1.0, front + 0.02);
    const knob = new THREE.Mesh(new THREE.BoxGeometry(0.1, 0.1, 0.1), glowMaterial(VOX.lantern, 0.6));
    knob.position.set(0.35, 0.95, front + 0.12);
    h.add(doorFrame, door, knob);
    for (let k = 0; k < 2; k++) {
      const awn = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.12, 0.4), roofMat);
      awn.position.set(0, 0.2 + 2.05 + k * 0.16, front + 0.2 + k * 0.18);
      awn.rotation.x = -0.5;
      h.add(awn);
    }
    const lamp = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.32, 0.22), glowMaterial(VOX.lantern, 1.2));
    lamp.position.set(w / 2 - 0.5, 2.1, front + 0.06);
    h.add(lamp);
    this.beacons.push(lamp);

    // optional second storey (set back a touch) with its own framed windows
    let roofBase = wallTop;
    if (story) {
      const sH = 1.8;
      const upper = new THREE.Mesh(new THREE.BoxGeometry(w - 0.4, sH, d - 0.4), wallMat);
      upper.position.y = wallTop + sH / 2;
      h.add(upper);
      const uband = new THREE.Mesh(new THREE.BoxGeometry(w - 0.32, 0.18, d - 0.32), trim);
      uband.position.y = wallTop + sH - 0.04;
      h.add(uband);
      for (const sx of [-1, 1]) {
        const frame = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.9, 0.1), trim);
        frame.position.set(sx * (w / 2 - 1.0), wallTop + sH / 2, d / 2 - 0.2 + 0.02);
        const pane = new THREE.Mesh(new THREE.BoxGeometry(0.56, 0.66, 0.12), winMat);
        pane.position.set(sx * (w / 2 - 1.0), wallTop + sH / 2, d / 2 - 0.2 + 0.05);
        h.add(frame, pane);
      }
      roofBase = wallTop + sH;
    }

    // stepped gable roof with an eaves overhang (narrows in x → street-facing gable)
    const L = 5, layerH = 0.36, inset = 0.4;
    const roofW = (story ? w - 0.4 : w) + 1.1;
    const roofD = (story ? d - 0.4 : d) + 1.0;
    for (let k = 0; k < L; k++) {
      const lw = Math.max(0.5, roofW - k * 2 * inset);
      const layer = new THREE.Mesh(new THREE.BoxGeometry(lw, layerH, roofD), k % 2 ? roofMat2 : roofMat);
      layer.position.y = roofBase + 0.1 + k * layerH + layerH / 2;
      h.add(layer);
    }
    const ridgeY = roofBase + 0.1 + L * layerH + 0.1;
    const ridge = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.32, roofD + 0.1), trim);
    ridge.position.y = ridgeY;
    h.add(ridge);
    // a roof dormer on storied houses
    if (story) {
      const dormer = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.7, 0.6), wallMat);
      dormer.position.set(0, roofBase + 0.5, roofD / 2 - 0.5);
      const dWin = new THREE.Mesh(new THREE.BoxGeometry(0.5, 0.4, 0.1), winMat);
      dWin.position.set(0, roofBase + 0.55, roofD / 2 - 0.2);
      h.add(dormer, dWin);
    }

    // chimney (with a cap) + rising smoke
    const chimney = new THREE.Mesh(new THREE.BoxGeometry(0.55, 1.9, 0.55), voxelMaterial(VOX.stoneDark));
    chimney.position.set(w / 2 - 0.6, roofBase + 0.7, -d / 2 + 0.7);
    const chimCap = new THREE.Mesh(new THREE.BoxGeometry(0.75, 0.22, 0.75), voxelMaterial(VOX.stone));
    chimCap.position.set(chimney.position.x, roofBase + 1.6, chimney.position.z);
    h.add(chimney, chimCap);
    const smokeMat = () => new THREE.MeshStandardMaterial({ color: VOX.smoke, transparent: true, opacity: 0.5, depthWrite: false });
    const smokeBaseY = roofBase + 1.7;
    for (let s = 0; s < 3; s++) {
      const puff = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.34), smokeMat());
      puff.position.set(chimney.position.x, smokeBaseY + s * 0.6, chimney.position.z);
      h.add(puff);
      this.smokes.push({ mesh: puff, baseY: smokeBaseY, phase: Math.random() * 6.28, speed: 0.4, span: 2.2 });
    }

    // a weathervane on the ridge of storied houses
    if (story) {
      const vpost = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.8, 0.08), trim);
      vpost.position.set(0, ridgeY + 0.5, roofD / 2 - 0.8);
      const arrow = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.1, 0.08), glowMaterial(VOX.lantern, 0.7));
      arrow.position.set(0, ridgeY + 0.85, roofD / 2 - 0.8);
      const cross = new THREE.Mesh(new THREE.BoxGeometry(0.08, 0.1, 0.5), trim);
      cross.position.set(0, ridgeY + 0.7, roofD / 2 - 0.8);
      h.add(vpost, arrow, cross);
    }

    // a hanging shop sign on a bracket (big plots only)
    if (big) {
      const bracket = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.12, 0.12), trim);
      bracket.position.set(-w / 2 + 0.35, 2.3, front + 0.3);
      const sign = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.7, 0.1), wood);
      sign.position.set(-w / 2 + 0.7, 1.95, front + 0.3);
      const icon = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.12), glowMaterial(VOX.lantern, 0.9));
      icon.position.set(-w / 2 + 0.7, 1.95, front + 0.37);
      h.add(bracket, sign, icon);
    }

    // ---- cottage yard dressing: a wood pile, barrels, a crate, and a bench ----
    const logMat = voxelMaterial(VOX.bark);
    // stacked wood pile beside the left wall
    for (let row = 0; row < 2; row++) for (let c = 0; c < 3; c++) {
      const log = new THREE.Mesh(new THREE.CylinderGeometry(0.16, 0.16, 1.1, 6), logMat);
      log.rotation.z = Math.PI / 2;
      log.position.set(-w / 2 - 0.9, 0.36 + row * 0.34, -d / 2 + 0.9 + c * 0.36 - (row * 0.18));
      h.add(log);
    }
    // a couple of barrels by the back-left corner
    for (let b = 0; b < 2; b++) {
      const barrel = new THREE.Mesh(new THREE.CylinderGeometry(0.32, 0.36, 0.8, 8), voxelMaterial(VOX.barrel));
      barrel.position.set(-w / 2 - 0.7, 0.4, -d / 2 - 0.3 - b * 0.8);
      const hoop = new THREE.Mesh(new THREE.CylinderGeometry(0.37, 0.37, 0.1, 8), voxelMaterial(VOX.steelDark));
      hoop.position.set(barrel.position.x, 0.55, barrel.position.z);
      h.add(barrel, hoop);
    }
    // a crate by the door step
    const crate = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), voxelMaterial(VOX.crate));
    crate.position.set(w / 2 - 0.4, 0.3, front + 0.7);
    h.add(crate);
    // a little bench against the front wall
    const benchSeat = new THREE.Mesh(new THREE.BoxGeometry(1.4, 0.12, 0.4), wood);
    benchSeat.position.set(-w / 4, 0.5, front + 0.55);
    h.add(benchSeat);
    for (const bx of [-w / 4 - 0.55, -w / 4 + 0.55]) {
      const leg = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.32), wood);
      leg.position.set(bx, 0.25, front + 0.55);
      h.add(leg);
    }
    // big plots get a fenced garden patch with crops on the right
    if (big) {
      for (let p = 0; p < 4; p++) {
        const fp = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.5, 0.12), voxelMaterial(VOX.fence));
        fp.position.set(w / 2 + 0.6 + (p % 2) * 1.1, 0.25, -d / 2 + 0.6 + Math.floor(p / 2) * 1.1);
        h.add(fp);
      }
      const soil = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.18, 1.3), voxelMaterial(VOX.tilled));
      soil.position.set(w / 2 + 1.15, 0.18, -d / 2 + 1.15);
      h.add(soil);
      for (let cr = 0; cr < 4; cr++) {
        const crop = new THREE.Mesh(new THREE.BoxGeometry(0.18, 0.4, 0.18), voxelMaterial(VOX.crop));
        crop.position.set(w / 2 + 0.8 + (cr % 2) * 0.7, 0.45, -d / 2 + 0.8 + Math.floor(cr / 2) * 0.7);
        h.add(crop);
      }
    }
    return h;
  }

  /** A little market stall: counter, posts, a striped awning, and glowing wares. */
  private makeStall(awningColor: number): THREE.Group {
    const s = new THREE.Group();
    const counter = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.9, 0.8), voxelMaterial(VOX.crate));
    counter.position.y = 0.45;
    s.add(counter);
    for (const px of [-0.9, 0.9]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.14, 1.7, 0.14), voxelMaterial(VOX.bark));
      post.position.set(px, 0.85, -0.3);
      s.add(post);
    }
    // striped awning (two-tone) tilted forward over the counter
    for (let i = 0; i < 4; i++) {
      const stripe = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.1, 0.42), voxelMaterial(i % 2 ? awningColor : VOX.rvBody));
      stripe.position.set(0, 1.7 - i * 0.12, 0.1 + i * 0.34);
      stripe.rotation.x = -0.5;
      s.add(stripe);
    }
    // a back board with hanging wares under the awning
    const board = new THREE.Mesh(new THREE.BoxGeometry(2.0, 0.9, 0.1), voxelMaterial(VOX.woodTrim));
    board.position.set(0, 1.4, -0.34);
    s.add(board);
    const wareCols = [0xffd24a, 0x6ad7ff, 0xff6f7a, 0x7be08a];
    for (let i = 0; i < 4; i++) {
      const ware = new THREE.Mesh(new THREE.BoxGeometry(0.22, 0.3, 0.12), glowMaterial(wareCols[i], 0.6));
      ware.position.set(-0.75 + i * 0.5, 1.45, -0.28);
      s.add(ware);
    }
    // crates + a barrel stacked beside the stall
    const sideCrate = new THREE.Mesh(new THREE.BoxGeometry(0.6, 0.6, 0.6), voxelMaterial(VOX.crate));
    sideCrate.position.set(-1.3, 0.3, 0.3);
    const sideBarrel = new THREE.Mesh(new THREE.CylinderGeometry(0.3, 0.34, 0.74, 8), voxelMaterial(VOX.barrel));
    sideBarrel.position.set(1.3, 0.37, 0.3);
    s.add(sideCrate, sideBarrel);
    // a couple of glowing goods on the counter
    for (const gx of [-0.5, 0.4]) {
      const good = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), glowMaterial(gx < 0 ? 0xffd24a : 0x6ad7ff, 0.6));
      good.position.set(gx, 1.05, 0.15);
      s.add(good);
    }
    return s;
  }

  /** Warm lanterns lining the paths + the square, and braziers at the corners —
   *  the glow (with bloom) that gives the courtyard its cozy Hypixel mood. */
  private buildLighting() {
    // lantern posts flanking each spoke path out to the gates
    for (const g of GATES) {
      const dir = g.pos.clone().normalize();
      const perp = new THREE.Vector3(-dir.z, 0, dir.x);
      for (let r = PLAZA_R - 1; r <= g.pos.length() - 2.2; r += 3.0) {
        for (const side of [-1, 1]) {
          const p = dir.clone().multiplyScalar(r).add(perp.clone().multiplyScalar(side * 2.0));
          const lan = this.makeLantern();
          lan.position.set(p.x, 0, p.z);
          this.group.add(lan);
        }
      }
    }
    // a ring of lanterns just inside the kerb
    for (let i = 0; i < 12; i++) {
      const a = (i / 12) * Math.PI * 2 + 0.26;
      const lan = this.makeLantern();
      lan.position.set(Math.cos(a) * (PLAZA_R - 1), 0, Math.sin(a) * (PLAZA_R - 1));
      this.group.add(lan);
    }
    // braziers framing the fountain
    for (let i = 0; i < 4; i++) {
      const a = (i / 4) * Math.PI * 2 + Math.PI / 4;
      const { group, flame } = this.makeBrazier();
      group.position.set(Math.cos(a) * 4.4, 0, Math.sin(a) * 4.4);
      this.group.add(group);
      this.flames.push(flame);
    }
  }

  /** A wooden lantern post with a warm glowing head (pulses via the beacon loop). */
  private makeLantern(): THREE.Group {
    const g = new THREE.Group();
    const post = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.7, 0.16), voxelMaterial(VOX.bark));
    post.position.y = 0.85;
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.5), voxelMaterial(VOX.barkDark));
    arm.position.set(0, 1.7, 0.18);
    const cap = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.16, 0.34), voxelMaterial(VOX.steelDark));
    cap.position.set(0, 1.85, 0.32);
    const glow = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.34, 0.24), glowMaterial(VOX.lantern, 1.2));
    glow.position.set(0, 1.55, 0.32);
    g.add(post, arm, cap, glow);
    this.beacons.push(glow);
    return g;
  }

  /** A stone brazier with a flickering flame (registered to the flame loop). */
  private makeBrazier(): { group: THREE.Group; flame: Flame } {
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.3, 0.9, 8), voxelMaterial(VOX.stone));
    base.position.y = 0.45;
    const bowl = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.28, 0.32, 10), voxelMaterial(VOX.stoneDark));
    bowl.position.y = 1.0;
    const embers = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.34, 0.12, 8), glowMaterial(VOX.ember, 1.4));
    embers.position.y = 1.16;
    const flameMesh = new THREE.Mesh(new THREE.IcosahedronGeometry(0.3, 0), glowMaterial(VOX.emberHot, 1.6));
    flameMesh.position.y = 1.45;
    (flameMesh.geometry as THREE.BufferGeometry).scale(1, 1.5, 1);
    g.add(base, bowl, embers, flameMesh);
    return { group: g, flame: { mesh: flameMesh, phase: Math.random() * 6.28, base: 1 } };
  }

  /**
   * A friendly static greeter NPC near spawn with a welcome speech bubble + name
   * label, plus a floating arrow over the Duo gate pointing players at the action.
   */
  private buildGreeter() {
    const npc = new VoxelChar({ body: 0x6e4a9e, head: COLORS.playerAccent, eye: 0x222222, hat: 0xffd24a, gun: false });
    npc.root.position.set(3.2, 0, PLAZA_R - 2);
    npc.root.rotation.y = Math.PI;
    npc.play("idle");
    npc.emote("wave");
    this.greeter = npc;
    const label = makeLabel("Guide");
    npc.root.add(label);
    const bubble = makeBubble("Hatch pets at the egg shrines, then step into a SOLO / DUO / SQUAD room to fight together! Press T to wave 👋");
    bubble.scale.set(5.4, 1.4, 1);
    bubble.position.set(0, 3.1, 0);
    npc.root.add(bubble);
    this.group.add(npc.root);

    // a little wooden signpost beside the greeter
    const signPost = new THREE.Mesh(new THREE.BoxGeometry(0.16, 1.4, 0.16), voxelMaterial(VOX.bark));
    signPost.position.set(4.6, 0.7, PLAZA_R - 2);
    const signBoard = new THREE.Mesh(new THREE.BoxGeometry(1.2, 0.6, 0.1), voxelMaterial(VOX.woodTrim));
    signBoard.position.set(4.6, 1.4, PLAZA_R - 2);
    this.group.add(signPost, signBoard);

    const cone = new THREE.ConeGeometry(0.5, 1.0, 4);
    cone.rotateX(Math.PI);
    this.arrow = new THREE.Mesh(cone, glowMaterial(0x6ad7ff, 1.2));
    this.arrow.position.copy(GATES[1].pos).setY(3.8); // hover over the Duo gate
    this.group.add(this.arrow);
  }

  /** Ambient life: drifting glow motes over the plaza + slow clouds overhead. */
  private buildAtmosphere() {
    // floating sparkle motes rising over the plaza
    let seed = 555;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 40; i++) {
      const a = rnd() * Math.PI * 2;
      const r = rnd() * (PLAZA_R + 2);
      const mote = new THREE.Mesh(
        new THREE.OctahedronGeometry(0.07, 0),
        new THREE.MeshStandardMaterial({
          color: 0xfff0b8, emissive: 0xffe08a, emissiveIntensity: 1.2,
          transparent: true, opacity: 0.6, depthWrite: false, toneMapped: false,
        }),
      );
      const baseY = 0.4 + rnd() * 1.5;
      mote.position.set(Math.cos(a) * r, baseY + rnd() * 2, Math.sin(a) * r);
      this.motes.push({ mesh: mote, baseY, phase: rnd() * 6.28, speed: 0.3 + rnd() * 0.5, span: 3 + rnd() * 2 });
      this.group.add(mote);
    }
    // chunky drifting clouds, kept high overhead + soft so they don't crowd the
    // structures (the earlier pass had them low enough to drift over the gates).
    const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, roughness: 1, transparent: true, opacity: 0.7 });
    for (let i = 0; i < 5; i++) {
      const cloud = new THREE.Group();
      const n = 3 + Math.floor(rnd() * 3);
      for (let k = 0; k < n; k++) {
        const w = 1.8 + rnd() * 2.2;
        const blk = new THREE.Mesh(new THREE.BoxGeometry(w, 1.0, 1.6), cloudMat);
        blk.position.set((rnd() - 0.5) * 4, (rnd() - 0.5) * 0.6, (rnd() - 0.5) * 2);
        cloud.add(blk);
      }
      const reset = 48;
      cloud.position.set(-reset + rnd() * reset * 2, 20 + rnd() * 5, -22 + rnd() * 44);
      this.clouds.push({ mesh: cloud as unknown as THREE.Mesh, speed: 0.4 + rnd() * 0.5, reset });
      this.group.add(cloud);
    }
  }
}

/** Multiply an 0xRRGGBB color toward black (f in 0..1). */
function darken(color: number, f: number): number {
  const r = Math.floor(((color >> 16) & 0xff) * f);
  const g = Math.floor(((color >> 8) & 0xff) * f);
  const b = Math.floor((color & 0xff) * f);
  return (r << 16) | (g << 8) | b;
}

/** Default visual set for the 5 egg shrines (id + tier color + walk-up label). */
const DEFAULT_EGG_VISUALS: { id: string; color: number; label: string }[] = [
  { id: "egg_common", color: 0x8fcf5a, label: "Mossy Egg" },
  { id: "egg_uncommon", color: 0x6ad7ff, label: "River Egg" },
  { id: "egg_rare", color: 0x5aa9ff, label: "Storm Egg" },
  { id: "egg_epic", color: 0xc792ea, label: "Astral Egg" },
  { id: "egg_legendary", color: 0xffb84a, label: "Mythic Egg" },
];

/** Re-exported so main can tint prompts consistently with the hub. */
export const ISLAND_COLORS = COLORS;
