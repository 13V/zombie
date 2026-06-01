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
  private portalRings: THREE.Mesh[] = [];
  private coreGem?: THREE.Mesh; // the base crystal core (pulses / flashes)
  private coreBaseEmissive = 1.2;
  private flashTimer = 0; // seconds of damage-flash remaining

  constructor(scene: THREE.Scene) {
    this.buildBackdrop();
    this.buildGround();
    this.buildLane();
    this.buildPads();
    this.buildSpawn();
    this.buildBase();
    this.applyShadows();
    scene.add(this.group);
    this.group.visible = false; // shown only while in the Tower-Defense mode
  }

  setVisible(on: boolean) {
    this.group.visible = on;
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
        color: VOX.water,
        emissive: VOX.water,
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

    // chunky stone underbelly (two tapering tiers — the floating-diorama look)
    const belly = new THREE.Mesh(new THREE.BoxGeometry(span, 2.4, span), voxelMaterial(VOX.stone));
    belly.position.y = GROUND_TOP - 1.2;
    this.group.add(belly);
    const root = new THREE.Mesh(new THREE.BoxGeometry(span - 6, 2.6, span - 6), voxelMaterial(VOX.stoneDark));
    root.position.y = GROUND_TOP - 3.4;
    this.group.add(root);

    // grass cap — alternating tones via two InstancedMeshes (cheap & crisp)
    const tileH = 0.5;
    const tileGeo = new THREE.BoxGeometry(TILE * 0.98, tileH, TILE * 0.98);
    const n = Math.floor(ARENA_HALF / TILE);

    // gather instance transforms, splitting into light/dark checker buckets and
    // skipping tiles the lane will cover.
    const light: THREE.Vector3[] = [];
    const dark: THREE.Vector3[] = [];
    for (let ix = -n; ix <= n; ix++) {
      for (let iz = -n; iz <= n; iz++) {
        const x = ix * TILE;
        const z = iz * TILE;
        if (Math.abs(x) > ARENA_HALF - 0.2 || Math.abs(z) > ARENA_HALF - 0.2) continue;
        if (this.nearLane(x, z, LANE_W + 0.5)) continue; // leave a gap for the road
        const pos = new THREE.Vector3(x, GROUND_TOP - tileH / 2, z);
        if ((ix + iz) % 2 === 0) light.push(pos);
        else dark.push(pos);
      }
    }

    const m = new THREE.Matrix4();
    const buildField = (positions: THREE.Vector3[], color: number) => {
      const inst = new THREE.InstancedMesh(tileGeo, voxelMaterial(color), positions.length);
      positions.forEach((p, i) => {
        m.makeTranslation(p.x, p.y, p.z);
        inst.setMatrixAt(i, m);
      });
      inst.instanceMatrix.needsUpdate = true;
      inst.userData.noCast = true; // big field receives shadow, stays out of shadow map
      this.group.add(inst);
    };
    buildField(light, VOX.grass);
    buildField(dark, VOX.grassDark);
  }

  /**
   * The LANE — a continuous ribbon of darker dirt/path tiles following each
   * TD_PATH segment. Every segment in TD_PATH is axis-aligned, so each becomes
   * a single flat box covering its length × (2·LANE_W) footprint; the joints
   * overlap at the corners and read as a seamless road. The road surface sits
   * a hair below grass so it reads as inset.
   */
  private buildLane() {
    const roadMat = voxelMaterial(VOX.path);
    const edgeMat = voxelMaterial(VOX.dirtDark);
    const roadH = 0.42;
    const roadY = GROUND_TOP - roadH / 2 + 0.04; // top just below grass top

    for (let i = 1; i < TD_PATH.length; i++) {
      const a = TD_PATH[i - 1];
      const b = TD_PATH[i];
      // clamp the spawn end to the arena edge so the road doesn't shoot far into
      // the void (TD_SPAWN sits off the west edge at x = -30).
      const ax = clamp(a.x, -ARENA_HALF, ARENA_HALF);
      const az = clamp(a.z, -ARENA_HALF, ARENA_HALF);
      const bx = clamp(b.x, -ARENA_HALF, ARENA_HALF);
      const bz = clamp(b.z, -ARENA_HALF, ARENA_HALF);

      const minX = Math.min(ax, bx);
      const maxX = Math.max(ax, bx);
      const minZ = Math.min(az, bz);
      const maxZ = Math.max(az, bz);
      const w = maxX - minX + LANE_W * 2; // pad the half-width on both ends
      const d = maxZ - minZ + LANE_W * 2;
      const cx = (minX + maxX) / 2;
      const cz = (minZ + maxZ) / 2;

      // a thin dark "edge" mat slightly larger underneath, then the road slab
      const edge = new THREE.Mesh(new THREE.BoxGeometry(w + 0.8, roadH * 0.6, d + 0.8), edgeMat);
      edge.position.set(cx, GROUND_TOP - roadH * 0.7, cz);
      edge.userData.noCast = true;
      this.group.add(edge);

      const slab = new THREE.Mesh(new THREE.BoxGeometry(w, roadH, d), roadMat);
      slab.position.set(cx, roadY, cz);
      slab.userData.noCast = true;
      this.group.add(slab);
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

    // generic emissive pulses (pad rims, portal rings, base dais ring)
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
