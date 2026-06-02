import * as THREE from "three";
import { voxelMaterial, glowMaterial, VOX } from "../palette";
import { TD_PATH, TD_PADS, TD_GOAL, TD_SPAWN, type Vec2 } from "./tdpath";

/**
 * The Tower-Defense MAP — a flat square voxel battlefield (~70×70) floating over
 * a soft void, in the same chunky toy-diorama style as the rest of the game.
 *
 * It draws the static world only + gentle ambient animation:
 *   • a checkerboarded grass tile field (top surface at y = 0, the gameplay plane)
 *   • a darker dirt/stone LANE ribbon following TD_PATH waypoint-to-waypoint, so
 *     the road you see is exactly the lane creeps walk
 *   • a glowing SPAWN portal/arch at TD_SPAWN (off the west edge)
 *   • a chunky crystal-core BASE at TD_GOAL you defend (emissive, flashable)
 *   • a low stone BUILD PAD with a glowing rim at every TD_PADS position
 *
 * The integrator reads TD_PADS / TD_GOAL / TD_SPAWN directly for gameplay; this
 * class owns the visuals. Pulsing/animation is purely cosmetic. `flashBase()`
 * lets gameplay flash the core when the base takes damage.
 */

// ---- layout constants -----------------------------------------------------
const ARENA_HALF = 35; // half-extent of the square battlefield footprint (~70×70)
const GROUND_TOP = 0; // top surface of the ground — the gameplay plane (y = 0)
const TILE = 2; // voxel tile pitch

// The lane is built from boxes covering the union of TD_PATH segments. We keep
// the visible road ~3 units to either side of the centre-line of the polyline.
const LANE_W = 3; // half-width of the walkable road (so road ≈ 6 wide)

// Soft, low-contrast pastel turf + dusky water — a calm lofi palette instead of
// the bright midday lime (the warm dusk mood lighting does the rest).
const TD_GRASS = 0x8fc174;
const TD_GRASS_DARK = 0x80b266;
const TD_GRASS_LIGHT = 0xaedc92;
const TD_WATER = 0x9db9d2;

interface PulseGlow {
  mesh: THREE.Mesh;
  base: number; // rest emissive intensity
  amp: number; // pulse amplitude
  phase: number;
}

export class TdMap {
  readonly group = new THREE.Group();
  /** The build-pad plinth markers, parallel to TD_PADS (handy for highlighting). */
  readonly padMarkers: THREE.Object3D[] = [];
  /** The defendable base group (positioned at TD_GOAL). */
  readonly base = new THREE.Group();

  private t = 0;
  private pulses: PulseGlow[] = [];
  private clouds: { group: THREE.Group; speed: number; x0: number }[] = [];
  private portalRings: THREE.Mesh[] = [];
  private coreGem?: THREE.Mesh; // the base crystal core (pulses / flashes)
  private coreBaseEmissive = 1.2;
  private flashTimer = 0; // seconds of damage-flash remaining

  // ---- calm dusk "lofi" mood (TD-only; snapshots + restores the scene) ----
  private scene: THREE.Scene;
  private moodSaved = false;
  private savedFog: THREE.Scene["fog"] = null;
  private savedBg: THREE.Color | THREE.Texture | null = null;
  private savedEnv = 0.5;
  private lightOrig = new Map<THREE.Light, { intensity: number; color: number }>();

  constructor(scene: THREE.Scene) {
    this.scene = scene;
    this.buildBackdrop();
    this.buildGround();
    this.buildLane();
    this.buildDecor();
    this.buildPads();
    this.buildSpawn();
    this.buildBase();
    this.buildAtmosphere();
    this.buildMoodLights();
    this.applyShadows();
    scene.add(this.group);
    this.group.visible = false; // shown only while in the Tower-Defense mode
  }

  setVisible(on: boolean) {
    this.group.visible = on;
    if (on) this.enterMood();
    else this.exitMood();
  }

  /** Soft mood lights under the group (only active while TD is visible): a low
   *  peach key + a cool lavender fill — warm/cool dusk balance for a chill vibe. */
  private buildMoodLights() {
    const hemi = new THREE.HemisphereLight(0xffd6c0, 0x6a5a72, 0.4); // peach sky / dusky ground
    const sun = new THREE.DirectionalLight(0xffb98a, 0.6); // low amber sunset key
    sun.position.set(-24, 14, 18);
    const cool = new THREE.DirectionalLight(0xb9a6e6, 0.3); // soft lavender counter-fill
    cool.position.set(18, 9, -16);
    this.group.add(hemi, sun, cool);
  }

  private enterMood() {
    if (!this.moodSaved) {
      this.savedFog = this.scene.fog;
      this.savedBg = this.scene.background as THREE.Color | THREE.Texture | null;
      this.savedEnv = this.scene.environmentIntensity ?? 0.5;
      for (const c of this.scene.children) {
        const l = c as THREE.Light;
        if (l.isLight) this.lightOrig.set(l, { intensity: l.intensity, color: l.color.getHex() });
      }
      this.moodSaved = true;
    }
    // soft hazy dusk: a muted lavender-peach sky + gentle haze hugging the field,
    // dimmed IBL so the warm key + bloom carry the calm lofi mood.
    this.scene.fog = new THREE.Fog(0xd9c3c9, 34, 96);
    this.scene.background = new THREE.Color(0xe6cfca);
    this.scene.environmentIntensity = 0.3;
    for (const [l, o] of this.lightOrig) {
      const isKey = o.intensity > 1;
      l.intensity = o.intensity * (isKey ? 0.4 : 0.55);
      l.color.setHex(isKey ? 0xffc69a : 0xe3cdbf);
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

  /** Flash the base core (call when the base takes damage). */
  flashBase(seconds = 0.4) {
    this.flashTimer = Math.max(this.flashTimer, seconds);
  }

  // ========================================================================
  //  WORLD BUILDING
  // ========================================================================

  /** A dark void plate + a glassy water sheet far below, so the battlefield
   *  reads as a floating diorama (mirrors bwmap's backdrop). */
  private buildBackdrop() {
    const voidPlate = new THREE.Mesh(
      new THREE.BoxGeometry(ARENA_HALF * 2 + 30, 1, ARENA_HALF * 2 + 30),
      voxelMaterial(0x222634),
    );
    voidPlate.position.y = -12;
    voidPlate.userData.noCast = true;
    this.group.add(voidPlate);

    const water = new THREE.Mesh(
      new THREE.BoxGeometry(ARENA_HALF * 2 + 24, 0.4, ARENA_HALF * 2 + 24),
      new THREE.MeshStandardMaterial({
        color: TD_WATER,
        emissive: TD_WATER,
        emissiveIntensity: 0.18,
        transparent: true,
        opacity: 0.78,
        roughness: 0.3,
        metalness: 0.0,
      }),
    );
    water.position.y = -9.5;
    water.userData.noCast = true;
    this.group.add(water);
  }

  /**
   * The flat battlefield: a chunky stone underbelly + a checkerboarded grass
   * cap whose tile TOPS sit at y = 0. Lane tiles are skipped here and drawn
   * separately so the road reads as inset/darker. Built with a handful of
   * shared geometries + two InstancedMeshes for the (light/dark) grass tiles so
   * the field stays cheap (no thousands of separate meshes).
   */
  private buildGround() {
    const span = ARENA_HALF * 2;

    // chunky stone underbelly (two tapering tiers — the floating-diorama look).
    // Its TOP sits just below the grass tile bottoms (y -0.5) so it never shares
    // a plane with the grass/road tops (that coplanar overlap was z-fighting).
    const belly = new THREE.Mesh(new THREE.BoxGeometry(span, 2.4, span), voxelMaterial(VOX.stone));
    belly.position.y = GROUND_TOP - 1.7;
    this.group.add(belly);
    const root = new THREE.Mesh(new THREE.BoxGeometry(span - 6, 2.6, span - 6), voxelMaterial(VOX.stoneDark));
    root.position.y = GROUND_TOP - 3.9;
    this.group.add(root);

    // grass cap — alternating tones + occasional sun-kissed highlight via three
    // InstancedMeshes (cheap & crisp), matching the island's lawn.
    const tileH = 0.5;
    const tileGeo = new THREE.BoxGeometry(TILE * 0.98, tileH, TILE * 0.98);
    const n = Math.floor(ARENA_HALF / TILE);

    let seed = 4711;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const light: THREE.Vector3[] = [];
    const dark: THREE.Vector3[] = [];
    const lit: THREE.Vector3[] = [];
    for (let ix = -n; ix <= n; ix++) {
      for (let iz = -n; iz <= n; iz++) {
        const x = ix * TILE;
        const z = iz * TILE;
        if (Math.abs(x) > ARENA_HALF - 0.2 || Math.abs(z) > ARENA_HALF - 0.2) continue;
        if (this.nearLane(x, z, LANE_W + 0.5)) continue; // leave a gap for the road
        const pos = new THREE.Vector3(x, GROUND_TOP - tileH / 2, z);
        if (rnd() < 0.1) lit.push(pos);
        else if ((ix + iz) % 2 === 0) light.push(pos);
        else dark.push(pos);
      }
    }

    const m = new THREE.Matrix4();
    const buildField = (positions: THREE.Vector3[], color: number) => {
      if (positions.length === 0) return;
      const inst = new THREE.InstancedMesh(tileGeo, voxelMaterial(color), positions.length);
      positions.forEach((p, i) => {
        m.makeTranslation(p.x, p.y, p.z);
        inst.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.userData.noCast = true; // big field receives shadow, stays out of shadow map
      this.group.add(inst);
    };
    buildField(light, TD_GRASS);
    buildField(dark, TD_GRASS_DARK);
    buildField(lit, TD_GRASS_LIGHT);
  }

  /**
   * The LANE — a sunken cobble road following TD_PATH. Built as NON-overlapping
   * grid tiles (two cobble tones, checkered) covering every grid cell within
   * LANE_W of the path, sitting a hair below the grass so it reads as an inset
   * road. Grid tiles never overlap, so there is no coplanar z-fighting (the old
   * per-segment slabs overlapped at every corner and flickered).
   */
  private buildLane() {
    const tileH = 0.5;
    const geo = new THREE.BoxGeometry(TILE * 0.98, tileH, TILE * 0.98);
    const n = Math.floor(ARENA_HALF / TILE);
    const top = GROUND_TOP - 0.06; // just below the grass surface
    const a: THREE.Vector3[] = [];
    const b: THREE.Vector3[] = [];
    for (let ix = -n; ix <= n; ix++) {
      for (let iz = -n; iz <= n; iz++) {
        const x = ix * TILE;
        const z = iz * TILE;
        if (Math.abs(x) > ARENA_HALF - 0.2 || Math.abs(z) > ARENA_HALF - 0.2) continue;
        if (!this.nearLane(x, z, LANE_W)) continue;
        const pos = new THREE.Vector3(x, top - tileH / 2, z);
        ((ix + iz) % 2 === 0 ? a : b).push(pos);
      }
    }
    const m = new THREE.Matrix4();
    const lay = (positions: THREE.Vector3[], color: number) => {
      if (!positions.length) return;
      const inst = new THREE.InstancedMesh(geo, voxelMaterial(color), positions.length);
      positions.forEach((p, i) => { m.makeTranslation(p.x, p.y, p.z); inst.setMatrixAt(i, m); });
      inst.instanceMatrix.needsUpdate = true;
      inst.userData.noCast = true;
      this.group.add(inst);
    };
    lay(a, VOX.cobble);
    lay(b, VOX.cobbleDark);
  }

  /** Lush diorama dressing on the grass (away from lane/pads/base/spawn): layered
   *  broadleaf + pine trees with the odd cherry blossom, rock clusters, and a
   *  carpet of low grass tufts + wildflowers — the same density as the arena. */
  private buildDecor() {
    let seed = 90125;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    const trunkMat = voxelMaterial(0x7a5230);
    const trunkDark = voxelMaterial(0x5f3f25);
    const broad: [number, number][] = [[0x6ab04a, 0x8ed16a], [0x4f8a3a, 0x6fae4a], [0xd99a3a, 0xf0bd5e], [0xc24a35, 0xe0734f]];
    const pine: [number, number][] = [[0x3f7a4a, 0x5a9a5e], [0x4f8a3a, 0x6fae4a]];
    const rockMat = voxelMaterial(VOX.stone);
    const rockMatD = voxelMaterial(VOX.stoneDark);

    const blocked = (x: number, z: number, pad = 0): boolean => {
      if (this.nearLane(x, z, LANE_W + 1.8 + pad)) return true;
      for (const p of TD_PADS) if ((p.x - x) ** 2 + (p.z - z) ** 2 < (3.0 + pad) ** 2) return true;
      if ((TD_GOAL.x - x) ** 2 + (TD_GOAL.z - z) ** 2 < (7 + pad) ** 2) return true;
      if ((TD_SPAWN.x - x) ** 2 + (TD_SPAWN.z - z) ** 2 < (7 + pad) ** 2) return true;
      return false;
    };

    // ---- trees + rocks (taller dressing) ----
    let placed = 0, tries = 0;
    while (placed < 78 && tries++ < 900) {
      const x = (rnd() * 2 - 1) * (ARENA_HALF - 3);
      const z = (rnd() * 2 - 1) * (ARENA_HALF - 3);
      if (blocked(x, z, 1.5)) continue;
      placed++;
      const g = new THREE.Group();
      const roll = rnd();
      if (roll < 0.5) {
        // broadleaf: tapered trunk + a bushy multi-box crown, sometimes blossom
        const th = 1.2 + rnd() * 1.2;
        const tk = new THREE.Mesh(new THREE.BoxGeometry(0.5, th, 0.5), rnd() < 0.5 ? trunkMat : trunkDark);
        tk.position.y = th / 2; g.add(tk);
        const blossom = rnd() < 0.16;
        const [cMain, cTop] = blossom ? [0xff9ec7, 0xffc2dd] : broad[Math.floor(rnd() * broad.length)];
        const crowns = 3 + Math.floor(rnd() * 2);
        for (let k = 0; k < crowns; k++) {
          const w = 2.4 - k * 0.55;
          const c = new THREE.Mesh(new THREE.BoxGeometry(w, w * 0.7, w), voxelMaterial(k === crowns - 1 ? cTop : cMain));
          c.position.set((rnd() - 0.5) * 0.7, th + 0.3 + k * 0.62, (rnd() - 0.5) * 0.7);
          g.add(c);
        }
      } else if (roll < 0.78) {
        // pine: slim trunk + tapering tiers
        const [pMain, pTop] = pine[Math.floor(rnd() * pine.length)];
        const th = 1.0 + rnd() * 0.9;
        const tk = new THREE.Mesh(new THREE.BoxGeometry(0.4, th, 0.4), trunkDark);
        tk.position.y = th / 2; g.add(tk);
        const tiers = 4 + Math.floor(rnd() * 2);
        for (let k = 0; k < tiers; k++) {
          const w = 2.3 - k * (1.8 / tiers);
          const t = new THREE.Mesh(new THREE.BoxGeometry(w, 0.7, w), voxelMaterial(k === tiers - 1 ? pTop : pMain));
          t.position.y = th + 0.2 + k * 0.6; g.add(t);
        }
      } else {
        // rock cluster
        const cnt = 1 + Math.floor(rnd() * 3);
        for (let k = 0; k < cnt; k++) {
          const s = 0.7 + rnd() * 1.1;
          const rk = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.8, s), rnd() < 0.5 ? rockMat : rockMatD);
          rk.position.set((rnd() - 0.5) * 1.5, s * 0.4, (rnd() - 0.5) * 1.5);
          rk.rotation.y = rnd() * Math.PI; g.add(rk);
        }
      }
      g.position.set(x, 0, z);
      g.scale.setScalar(0.85 + rnd() * 0.6);
      this.group.add(g);
    }

    // ---- low ground cover: grass tufts + wildflowers (carpet, breaks the checker) ----
    const tuftMat = voxelMaterial(TD_GRASS_LIGHT);
    const flowerCols = [0xff6f91, 0xffd24a, 0xfff4e0, 0xff5a4a, 0x9b6fff];
    let f = 0, ftries = 0;
    while (f < 150 && ftries++ < 1400) {
      const x = (rnd() * 2 - 1) * (ARENA_HALF - 2);
      const z = (rnd() * 2 - 1) * (ARENA_HALF - 2);
      if (blocked(x, z, -0.5)) continue;
      f++;
      if (rnd() < 0.55) {
        const tuft = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.45, 0.3), tuftMat);
        tuft.position.set(x, 0.22, z);
        tuft.userData.noCast = true;
        this.group.add(tuft);
      } else {
        const stem = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.4, 0.12), tuftMat);
        stem.position.set(x, 0.2, z);
        const head = new THREE.Mesh(new THREE.BoxGeometry(0.28, 0.28, 0.28), glowMaterial(flowerCols[Math.floor(rnd() * flowerCols.length)], 0.35));
        head.position.set(x, 0.5, z);
        head.userData.noCast = true; stem.userData.noCast = true;
        this.group.add(stem, head);
      }
    }
  }

  /** Atmosphere: drifting clouds overhead + warm brazier light-pools flanking the
   *  base and spawn, for the cozy golden-hour depth the arena has. */
  private buildAtmosphere() {
    let seed = 31337;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);

    // soft voxel clouds drifting across, high above the field
    const cloudMat = new THREE.MeshStandardMaterial({ color: 0xffffff, emissive: 0xfff2e0, emissiveIntensity: 0.25, roughness: 1, transparent: true, opacity: 0.92 });
    for (let i = 0; i < 7; i++) {
      const cloud = new THREE.Group();
      const puffs = 3 + Math.floor(rnd() * 4);
      for (let k = 0; k < puffs; k++) {
        const w = 2 + rnd() * 3;
        const puff = new THREE.Mesh(new THREE.BoxGeometry(w, w * 0.6, w * 0.8), cloudMat);
        puff.position.set((rnd() - 0.5) * 7, (rnd() - 0.5) * 1.2, (rnd() - 0.5) * 4);
        puff.userData.noCast = true;
        cloud.add(puff);
      }
      cloud.position.set((rnd() * 2 - 1) * ARENA_HALF, 16 + rnd() * 6, (rnd() * 2 - 1) * ARENA_HALF);
      this.group.add(cloud);
      this.clouds.push({ group: cloud, speed: 0.6 + rnd() * 0.9, x0: cloud.position.x });
    }

    // warm braziers (point light + ember) at the base + spawn + a couple mid-field
    const spots: Vec2[] = [
      { x: TD_GOAL.x - 4.5, z: TD_GOAL.z }, { x: TD_GOAL.x + 4.5, z: TD_GOAL.z },
      { x: clamp(TD_SPAWN.x, -ARENA_HALF + 2, ARENA_HALF - 2), z: TD_SPAWN.z - 4 },
    ];
    for (const s of spots) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.4, 1.6, 0.4), voxelMaterial(VOX.stoneDark));
      post.position.set(s.x, 0.8, s.z);
      const bowl = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.4, 0.9), voxelMaterial(VOX.cobble));
      bowl.position.set(s.x, 1.7, s.z);
      const ember = new THREE.Mesh(new THREE.BoxGeometry(0.7, 0.5, 0.7), glowMaterial(VOX.emberHot, 1.4));
      ember.position.set(s.x, 2.0, s.z);
      ember.userData.noCast = true;
      this.group.add(post, bowl, ember);
      this.pulses.push({ mesh: ember, base: 1.1, amp: 0.7, phase: s.x * 0.3 });
      const light = new THREE.PointLight(0xff8a3a, 3.2, 11, 2);
      light.position.set(s.x, 2.4, s.z);
      this.group.add(light);
    }
  }

  /** A raised stone build-pad plinth with a glowing rim at every TD_PADS spot. */
  private buildPads() {
    TD_PADS.forEach((p, i) => {
      const pad = new THREE.Group();

      // low stone plinth (~2 units across), two stacked tiers
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 0.5, 6), voxelMaterial(VOX.cobble));
      base.position.y = GROUND_TOP + 0.25;
      pad.add(base);
      const top = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.4, 0.35, 6), voxelMaterial(VOX.cobbleDark));
      top.position.y = GROUND_TOP + 0.62;
      pad.add(top);

      // gentle glowing rim ring (breathes) so the buildable spot reads clearly
      const rim = new THREE.Mesh(new THREE.TorusGeometry(1.5, 0.12, 6, 18), glowMaterial(VOX.emberHot, 0.7));
      rim.rotation.x = Math.PI / 2;
      rim.position.y = GROUND_TOP + 0.5;
      rim.userData.noCast = true;
      pad.add(rim);
      this.pulses.push({ mesh: rim, base: 0.5, amp: 0.5, phase: i * 0.7 });

      pad.position.set(p.x, 0, p.z);
      this.group.add(pad);
      this.padMarkers.push(pad);
    });
  }

  /** A glowing spawn arch/portal at TD_SPAWN (off the west edge) where creeps
   *  emerge — two stone pillars, a lintel, and a shimmering portal pane. */
  private buildSpawn() {
    const portal = new THREE.Group();
    const pillarMat = voxelMaterial(VOX.stoneDark);
    const half = LANE_W + 0.6; // pillars flank the lane mouth

    for (const sx of [-1, 1]) {
      const pillar = new THREE.Mesh(new THREE.BoxGeometry(0.9, 5.2, 1.4), pillarMat);
      pillar.position.set(0, GROUND_TOP + 2.6, sx * half);
      portal.add(pillar);
    }
    // lintel across the top
    const lintel = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, half * 2 + 1.4), voxelMaterial(VOX.stone));
    lintel.position.set(0, GROUND_TOP + 5.0, 0);
    portal.add(lintel);

    // shimmering portal pane (glow, caught by bloom) inside the arch
    const pane = new THREE.Mesh(
      new THREE.PlaneGeometry(half * 2, 4.6),
      new THREE.MeshStandardMaterial({
        color: 0x9b6fff,
        emissive: 0x9b6fff,
        emissiveIntensity: 1.1,
        transparent: true,
        opacity: 0.6,
        side: THREE.DoubleSide,
        roughness: 0.4,
        metalness: 0.0,
      }),
    );
    pane.rotation.y = Math.PI / 2;
    pane.position.set(0, GROUND_TOP + 2.5, 0);
    pane.userData.noCast = true;
    portal.add(pane);
    this.portalRings.push(pane);

    // a couple of glowing rim accents (breathe)
    for (let k = 0; k < 2; k++) {
      const ring = new THREE.Mesh(new THREE.TorusGeometry(1.8 + k * 0.5, 0.1, 6, 20), glowMaterial(0xc7a6ff, 0.9));
      ring.rotation.y = Math.PI / 2;
      ring.position.set(0, GROUND_TOP + 2.5, 0);
      ring.userData.noCast = true;
      portal.add(ring);
      this.pulses.push({ mesh: ring, base: 0.7, amp: 0.6, phase: k * 1.1 });
    }

    // sit the arch at the spawn point (clamped to the arena edge for the visual)
    portal.position.set(clamp(TD_SPAWN.x, -ARENA_HALF + 1, ARENA_HALF - 1), 0, TD_SPAWN.z);
    this.group.add(portal);
  }

  /** The BASE you defend at TD_GOAL — a chunky stone keep crowned by an emissive
   *  crystal core (pulses gently; `flashBase()` makes it flare when damaged). */
  private buildBase() {
    // stepped stone keep
    const plinth = new THREE.Mesh(new THREE.BoxGeometry(6, 1.0, 6), voxelMaterial(VOX.cobble));
    plinth.position.y = GROUND_TOP + 0.5;
    this.base.add(plinth);
    const keep = new THREE.Mesh(new THREE.BoxGeometry(4.4, 2.6, 4.4), voxelMaterial(VOX.stone));
    keep.position.y = GROUND_TOP + 2.3;
    this.base.add(keep);
    const battle = new THREE.Mesh(new THREE.BoxGeometry(5.0, 0.6, 5.0), voxelMaterial(VOX.stoneDark));
    battle.position.y = GROUND_TOP + 3.9;
    this.base.add(battle);

    // four corner merlons for a little castle silhouette
    for (const mx of [-1, 1]) {
      for (const mz of [-1, 1]) {
        const merlon = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 0.9), voxelMaterial(VOX.cobbleDark));
        merlon.position.set(mx * 2.1, GROUND_TOP + 4.45, mz * 2.1);
        this.base.add(merlon);
      }
    }

    // the defended CRYSTAL CORE — a faceted glowing gem floating above the keep
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(1.1, 0), glowMaterial(0x6ad7ff, this.coreBaseEmissive));
    (core.geometry as THREE.BufferGeometry).scale(1, 1.5, 1);
    core.position.y = GROUND_TOP + 5.6;
    this.base.add(core);
    this.coreGem = core;

    // a glowing dais ring around the keep base so the goal reads clearly
    const ring = new THREE.Mesh(new THREE.TorusGeometry(3.4, 0.18, 6, 24), glowMaterial(0x6ad7ff, 0.7));
    ring.rotation.x = Math.PI / 2;
    ring.position.y = GROUND_TOP + 0.6;
    ring.userData.noCast = true;
    this.base.add(ring);
    this.pulses.push({ mesh: ring, base: 0.6, amp: 0.5, phase: 0.3 });

    this.base.position.set(TD_GOAL.x, 0, TD_GOAL.z);
    this.group.add(this.base);
  }

  // ========================================================================
  //  HELPERS
  // ========================================================================

  /** True if (x,z) lies within `pad` units of any TD_PATH segment (used to
   *  carve the road gap out of the grass field). */
  private nearLane(x: number, z: number, pad: number): boolean {
    for (let i = 1; i < TD_PATH.length; i++) {
      if (distToSeg(x, z, TD_PATH[i - 1], TD_PATH[i]) <= pad) return true;
    }
    return false;
  }

  /** Opaque structures cast + receive contact shadows; glow/transparent bits
   *  and the big tile field (tagged noCast) only receive. */
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

  // ========================================================================
  //  ANIMATION — gentle ambient life only
  // ========================================================================

  update(dt: number) {
    if (!this.group.visible) return;
    this.t += dt;
    const t = this.t;

    // spawn-portal shimmer: the pane breathes its emissive + opacity
    for (const pane of this.portalRings) {
      const mat = pane.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.9 + (Math.sin(t * 2.0) + 1) * 0.4;
      mat.opacity = 0.5 + (Math.sin(t * 1.4) + 1) * 0.12;
    }

    // base core: slow spin + bob + gentle pulse, with a damage-flash override
    if (this.coreGem) {
      this.coreGem.rotation.y += dt * 1.1;
      this.coreGem.position.y = GROUND_TOP + 5.6 + Math.sin(t * 1.5) * 0.16;
      const mat = this.coreGem.material as THREE.MeshStandardMaterial;
      if (this.flashTimer > 0) {
        this.flashTimer = Math.max(0, this.flashTimer - dt);
        // flare bright + tint toward red while flashing
        mat.emissiveIntensity = 3.2;
        mat.emissive.setHex(0xff5a4a);
      } else {
        mat.emissive.setHex(0x6ad7ff);
        mat.emissiveIntensity = this.coreBaseEmissive + (Math.sin(t * 2.0) + 1) * 0.35;
      }
    }

    // clouds drift slowly across and wrap around
    for (const c of this.clouds) {
      c.group.position.x += c.speed * dt;
      if (c.group.position.x > ARENA_HALF + 14) c.group.position.x = -ARENA_HALF - 14;
    }

    // generic emissive pulses (pad rims, portal rings, base dais ring, braziers)
    for (const p of this.pulses) {
      (p.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity =
        p.base + (Math.sin(t * 2.4 + p.phase) + 1) * 0.5 * p.amp;
    }
  }
}

// ---- pure geometry helpers -------------------------------------------------
function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

/** Distance from point (px,pz) to segment a→b in the XZ plane. */
function distToSeg(px: number, pz: number, a: Vec2, b: Vec2): number {
  const vx = b.x - a.x;
  const vz = b.z - a.z;
  const wx = px - a.x;
  const wz = pz - a.z;
  const len2 = vx * vx + vz * vz;
  let tt = len2 > 0 ? (wx * vx + wz * vz) / len2 : 0;
  tt = tt < 0 ? 0 : tt > 1 ? 1 : tt;
  const cx = a.x + tt * vx;
  const cz = a.z + tt * vz;
  return Math.hypot(px - cx, pz - cz);
}
