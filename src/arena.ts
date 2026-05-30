import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { WORLD } from "./config";
import { VOX, voxelMaterial, glowMaterial } from "./palette";

/** Axis-aligned box footprint that the player + zombies are pushed out of. */
interface Obstacle {
  minX: number;
  maxX: number;
  minZ: number;
  maxZ: number;
}

/** Accumulates voxel positions per color, then bakes one InstancedMesh per color. */
class VoxelBatch {
  private buckets = new Map<number, { x: number; y: number; z: number; sx: number; sy: number; sz: number }[]>();

  add(x: number, y: number, z: number, color: number, sx = 1, sy = 1, sz = 1) {
    let arr = this.buckets.get(color);
    if (!arr) this.buckets.set(color, (arr = []));
    arr.push({ x, y, z, sx, sy, sz });
  }

  build(
    parent: THREE.Object3D,
    geo: THREE.BufferGeometry,
    cast: boolean,
    receive: boolean,
    matFn: (color: number) => THREE.Material = voxelMaterial,
  ) {
    const dummy = new THREE.Object3D();
    for (const [color, arr] of this.buckets) {
      const mesh = new THREE.InstancedMesh(geo, matFn(color), arr.length);
      mesh.castShadow = cast;
      mesh.receiveShadow = receive;
      arr.forEach((p, i) => {
        dummy.position.set(p.x, p.y, p.z);
        dummy.scale.set(p.sx, p.sy, p.sz);
        dummy.updateMatrix();
        mesh.setMatrixAt(i, dummy.matrix);
      });
      mesh.instanceMatrix.needsUpdate = true;
      parent.add(mesh);
    }
  }
}

/**
 * A flat voxel arena in a soft sky — the bright "Tiny World" toy-diorama look:
 * thick beveled voxels, a grassy island with dirt paths, drifting clouds and
 * sunlit motes. The centerpiece is a chunky voxel **camper van** (the defensive
 * core to circle while kiting the horde), ringed by a wooden fence and dotted
 * with camp clutter — jerry cans, crates, barrels, sandbags and a campfire —
 * with blocky trees for cover.
 */
export class Arena {
  readonly group = new THREE.Group();
  readonly half = WORLD.half;
  readonly obstacles: Obstacle[] = [];
  readonly plaza = 6; // half-extent of the central clearing (camp pad)

  // Cheap, clean voxel edges — kept to 2 bevel segments so the thousands of
  // instanced voxels stay light (SMAA handles edge smoothing in post).
  private geo = new RoundedBoxGeometry(1, 1, 1, 2, 0.07);
  private clouds: { group: THREE.Group; speed: number }[] = [];
  // Campfire flames that flicker (emissive + scale), plus rising smoke puffs.
  private flames: { mesh: THREE.Mesh; baseY: number; phase: number }[] = [];
  private smoke: { mesh: THREE.Mesh; baseX: number; baseY: number; baseZ: number; phase: number; speed: number; rise: number }[] = [];
  // Soft drifting light motes (pollen / fireflies) that catch the bloom — the
  // single coziest atmospheric touch, gently bobbing through the warm air.
  private motes: { sprite: THREE.Sprite; baseX: number; baseY: number; baseZ: number; phase: number; bob: number; sway: number; speed: number }[] = [];
  private t = 0;

  constructor(scene: THREE.Scene) {
    scene.fog = new THREE.Fog(WORLD.fogColor, WORLD.fogNear, WORLD.fogFar);

    this.buildSky(scene);
    this.buildLights(scene);

    const terrain = new VoxelBatch();
    const props = new VoxelBatch();
    const glow = new VoxelBatch(); // emissive window/lantern panes (caught by bloom)
    this.generateGround(terrain, props);
    this.buildCamp(props, glow);
    this.buildTrees(props);
    terrain.build(this.group, this.geo, false, true);
    props.build(this.group, this.geo, true, true);
    glow.build(this.group, this.geo, false, false, (c) => glowMaterial(c, 0.9));

    this.buildRV();
    this.buildClouds(scene);
    this.buildMotes(scene);
    scene.add(this.group);
  }

  // ---- environment ----
  private buildSky(scene: THREE.Scene) {
    scene.background = new THREE.Color(VOX.skyBottom);
    const sky = new THREE.Mesh(
      new THREE.SphereGeometry(300, 24, 16),
      new THREE.ShaderMaterial({
        side: THREE.BackSide,
        depthWrite: false,
        uniforms: {
          top: { value: new THREE.Color(VOX.skyTop) },
          bottom: { value: new THREE.Color(VOX.skyBottom) },
          sun: { value: new THREE.Vector3(20, 34, 16).normalize() },
          sunColor: { value: new THREE.Color(0xfff3d2) },
        },
        vertexShader: `
          varying vec3 vPos;
          void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: `
          uniform vec3 top; uniform vec3 bottom; uniform vec3 sun; uniform vec3 sunColor;
          varying vec3 vPos;
          void main() {
            float h = clamp(vPos.y / 300.0 * 0.5 + 0.5, 0.0, 1.0);
            vec3 col = mix(bottom, top, pow(h, 0.7));
            // A soft warm sun halo bleeding into the sky for a dreamy, comforting glow.
            float s = max(dot(normalize(vPos), sun), 0.0);
            col = mix(col, sunColor, pow(s, 6.0) * 0.55);
            gl_FragColor = vec4(col, 1.0);
          }
        `,
      }),
    );
    scene.add(sky);
  }

  private buildLights(scene: THREE.Scene) {
    // Soft sky-dome fill — keeps shadows from crushing to black without washing
    // the scene out (the clean, cheerful daylight of the toy-diorama reference).
    scene.add(new THREE.HemisphereLight(0xdcefff, 0x8fa05a, 0.5));
    const key = new THREE.DirectionalLight(0xfff4dc, 1.55);
    key.position.set(20, 34, 16);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const d = this.half + 8;
    const cam = key.shadow.camera;
    cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d;
    cam.near = 1; cam.far = 100;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    // Soft contact-AO shadows — defined enough to read as crisp, not hard black.
    key.shadow.intensity = 0.9;
    scene.add(key);

    // A subtle cool fill from the opposite side just lifts shadowed faces.
    const fill = new THREE.DirectionalLight(0xcfe2ff, 0.18);
    fill.position.set(-18, 16, -14);
    scene.add(fill);
  }

  // ---- ground generation ----
  private inArena(i: number, j: number): boolean {
    const H = this.half;
    if (Math.max(Math.abs(i), Math.abs(j)) > H) return false;
    const ci = Math.abs(i) - (H - 3);
    const cj = Math.abs(j) - (H - 3);
    if (ci > 0 && cj > 0 && ci + cj > 3) return false; // round the corners
    return true;
  }

  private generateGround(terrain: VoxelBatch, props: VoxelBatch) {
    const H = this.half;
    const P = this.plaza;

    for (let i = -H; i <= H; i++) {
      for (let j = -H; j <= H; j++) {
        if (!this.inArena(i, j)) continue;

        const cheb = Math.max(Math.abs(i), Math.abs(j));
        const onPlaza = cheb <= P;
        const onPath = !onPlaza && (Math.abs(i) <= 1 || Math.abs(j) <= 1);

        if (onPlaza) {
          // calm gravel pad (mostly one tone, a few darker flecks) — no harsh
          // checkerboard under the van.
          terrain.add(i, -0.5, j, (i * 5 + j * 3) % 7 === 0 ? VOX.cobbleDark : VOX.cobble);
        } else if (onPath) {
          terrain.add(i, -0.5, j, VOX.path);
        } else {
          terrain.add(i, -0.5, j, (i * 7 + j * 13) % 5 === 0 ? VOX.grassDark : VOX.grass);
          if (Math.random() < 0.05) {
            props.add(i + (Math.random() - 0.5) * 0.4, 0.15, j + (Math.random() - 0.5) * 0.4, VOX.leaf, 0.35, 0.35, 0.35);
          }
        }
      }
    }

    // Flat slab underside (dirt over stone), with a slightly inset bottom rim.
    for (let d = 1; d <= 4; d++) {
      const color = d <= 2 ? (d === 1 ? VOX.dirt : VOX.dirtDark) : d === 3 ? VOX.stone : VOX.stoneDark;
      for (let i = -H; i <= H; i++) {
        for (let j = -H; j <= H; j++) {
          if (!this.inArena(i, j)) continue;
          if (d === 4 && Math.max(Math.abs(i), Math.abs(j)) >= H - 1) continue; // inset rim
          terrain.add(i, -0.5 - d, j, color);
        }
      }
    }
  }

  // ---- camper van (clearing centerpiece) ----
  /** A scaled, beveled emissive voxel box added to the scene (fire, signs). */
  private glowBox(w: number, h: number, d: number, x: number, y: number, z: number, color: number, intensity = 0.9) {
    const m = new THREE.Mesh(this.geo, glowMaterial(color, intensity));
    m.scale.set(w, h, d);
    m.position.set(x, y, z);
    this.group.add(m);
    return m;
  }

  /**
   * The camper van as clean, crisp panels (not a fine voxel grid — that just
   * quilts the surfaces with seams). Built from a modest set of solid boxes
   * baked into instanced batches (a few draw calls), with sharp edges that SMAA
   * smooths. Smooth white shell + blue stripe, glass-like windows, fat wheels.
   */
  private buildRV() {
    const solid = new VoxelBatch();
    const glow = new VoxelBatch();
    // Plain (un-beveled) boxes: large beveled boxes balloon their rounded edges
    // when scaled, which reads as soft/blobby. Sharp panels look crisp + clean.
    const geo = new THREE.BoxGeometry(1, 1, 1);
    const S = (x: number, y: number, z: number, color: number, sx: number, sy: number, sz: number) =>
      solid.add(x, y, z, color, sx, sy, sz);
    const G = (x: number, y: number, z: number, color: number, sx: number, sy: number, sz: number) =>
      glow.add(x, y, z, color, sx, sy, sz);

    // chassis + fat wheels with steel hubs + dark arches
    S(0.3, 1.0, 0, VOX.rvTrim, 6.8, 0.4, 2.7);
    for (const wx of [-2.4, 2.6]) for (const wz of [-1.1, 1.1]) {
      S(wx, 0.5, wz, VOX.tire, 1.0, 0.95, 0.72);
      S(wx, 0.5, wz, VOX.rim, 0.44, 0.44, 0.76);
      S(wx, 1.15, wz, VOX.rvTrim, 1.4, 0.55, 0.86);
    }
    // smooth shell: rear living box, lower cab, cab-over bunk
    S(0.8, 2.25, 0, VOX.rvBody, 5.0, 2.1, 2.8);
    S(-2.9, 1.7, 0, VOX.rvBody, 1.9, 1.5, 2.6);
    S(-2.9, 2.85, 0, VOX.rvBody, 1.9, 0.95, 2.7);
    // lighter roof cap (soft two-tone shading) + a subtle panel shade line
    S(0.8, 3.35, 0, VOX.rvBodyShade, 5.25, 0.28, 2.9);
    S(-2.9, 3.35, 0, VOX.rvBodyShade, 1.95, 0.28, 2.78);
    S(0.8, 2.74, 0, VOX.rvBodyShade, 5.0, 0.06, 2.83);
    // blue accent stripe wrapping body + cab
    S(0.8, 1.92, 0, VOX.rvStripe, 5.06, 0.4, 2.84);
    S(-2.9, 1.52, 0, VOX.rvStripe, 1.94, 0.4, 2.64);
    // glass-like windows (gentle glow so they read as glass, not lamps)
    G(0.0, 2.55, 1.43, VOX.rvWindow, 1.3, 0.72, 0.06);
    G(2.3, 2.55, 1.43, VOX.rvWindow, 1.3, 0.72, 0.06);
    G(-3.0, 1.95, 1.32, VOX.rvWindow, 1.35, 0.66, 0.06); // cab side
    G(-3.86, 1.98, 0, VOX.rvWindow, 0.06, 0.78, 2.0);    // windshield
    // crisp window frames
    for (const fx of [0.0, 2.3]) {
      S(fx, 2.93, 1.45, VOX.rvTrim, 1.5, 0.09, 0.08);
      S(fx, 2.17, 1.45, VOX.rvTrim, 1.5, 0.09, 0.08);
      S(fx, 2.55, 1.45, VOX.rvTrim, 0.08, 0.82, 0.08);
    }
    // door + porthole + step
    S(-1.0, 1.92, 1.43, VOX.rvDoor, 1.0, 1.66, 0.09);
    G(-1.0, 2.42, 1.49, VOX.rvWindow, 0.4, 0.4, 0.06);
    S(-1.0, 1.05, 1.6, VOX.steelDark, 0.9, 0.2, 0.4);
    // bumpers + grille + head/taillights
    S(-4.0, 1.2, 0, VOX.rvTrim, 0.5, 0.5, 2.6);
    S(3.5, 1.2, 0, VOX.rvTrim, 0.5, 0.5, 2.6);
    S(-3.9, 1.4, 0, VOX.steelDark, 0.14, 0.5, 1.5);
    for (const hz of [-0.85, 0.85]) G(-3.95, 1.45, hz, VOX.windowGlow, 0.12, 0.3, 0.34);
    for (const tz of [-1.05, 1.05]) G(3.45, 1.7, tz, VOX.toolbox, 0.12, 0.34, 0.34);
    // wing mirrors
    for (const mz of [-1.5, 1.5]) {
      S(-3.5, 2.05, mz, VOX.steelDark, 0.3, 0.1, 0.1);
      S(-3.66, 1.95, mz, VOX.steelDark, 0.12, 0.32, 0.16);
    }
    // back ladder, roof rails, AC unit, deck chair
    for (const lz of [-0.7, 0.7]) S(3.5, 2.4, lz, VOX.steelDark, 0.12, 1.8, 0.12);
    for (let r = 0; r < 4; r++) S(3.5, 1.7 + r * 0.45, 0, VOX.steelDark, 0.12, 0.1, 1.5);
    for (const rz of [-1.05, 1.05]) S(0.8, 3.54, rz, VOX.steelDark, 4.6, 0.1, 0.12);
    S(-0.4, 3.62, 0.3, VOX.rvTrim, 1.1, 0.36, 1.1);
    S(1.6, 3.56, -0.3, VOX.woodTrim, 0.9, 0.12, 0.9);
    S(2.05, 3.86, -0.3, VOX.woodTrim, 0.12, 0.7, 0.9);

    solid.build(this.group, geo, true, true);
    glow.build(this.group, geo, false, false, (col) => glowMaterial(col, 0.4));

    // central obstacle so the horde funnels around the van
    this.obstacles.push({ minX: -4.1, maxX: 3.8, minZ: -1.6, maxZ: 1.6 });
  }

  // ---- survival camp dressing ----
  private buildCamp(props: VoxelBatch, _glow: VoxelBatch) {
    this.buildFences(props);
    this.buildCovers(props);
    this.buildClutter(props);
    this.buildCampfire(props, 4.5, 4.5);
  }

  /** A wooden post-and-rail fence ringing the camp, with gates at the paths. */
  private buildFences(props: VoxelBatch) {
    const lim = this.half - 2;
    const post = (x: number, z: number) => props.add(x, 0.55, z, VOX.fence, 0.24, 1.15, 0.24);
    const railX = (x: number, z: number) => {
      props.add(x, 0.5, z, VOX.woodTrim, 2.0, 0.14, 0.14);
      props.add(x, 0.86, z, VOX.woodTrim, 2.0, 0.14, 0.14);
    };
    const railZ = (x: number, z: number) => {
      props.add(x, 0.5, z, VOX.woodTrim, 0.14, 0.14, 2.0);
      props.add(x, 0.86, z, VOX.woodTrim, 0.14, 0.14, 2.0);
    };
    for (let p = -lim; p <= lim; p += 2) {
      if (Math.abs(p) > 1) {
        // posts (leave the path crossings open as gates)
        if (this.inArena(p, -lim)) post(p, -lim);
        if (this.inArena(p, lim)) post(p, lim);
        if (this.inArena(-lim, p)) post(-lim, p);
        if (this.inArena(lim, p)) post(lim, p);
      }
      const mid = p + 1;
      if (p < lim && Math.abs(mid) > 1) {
        if (this.inArena(mid, -lim)) railX(mid, -lim);
        if (this.inArena(mid, lim)) railX(mid, lim);
        if (this.inArena(-lim, mid)) railZ(-lim, mid);
        if (this.inArena(lim, mid)) railZ(lim, mid);
      }
    }
  }

  /** Fixed cover clusters (crates / barrels / sandbags) that block the horde. */
  private buildCovers(props: VoxelBatch) {
    const spots: [number, number, "crates" | "barrels" | "sandbags"][] = [
      [-10, -9, "crates"], [10, -8, "barrels"], [-9, 10, "sandbags"], [10, 10, "crates"],
      [-13, 2, "barrels"], [13, 1, "sandbags"], [2, 13, "crates"], [1, -13, "barrels"],
    ];
    for (const [x, z, kind] of spots) {
      if (kind === "crates") {
        this.propCrate(props, x, z, true);
        this.propCrate(props, x + 1.1, z + 0.3, false);
        this.obstacles.push({ minX: x - 0.6, maxX: x + 1.7, minZ: z - 0.6, maxZ: z + 0.9 });
      } else if (kind === "barrels") {
        this.propBarrel(props, x, z, VOX.barrel);
        this.propBarrel(props, x + 0.9, z + 0.2, VOX.barrelRust);
        this.propBarrel(props, x + 0.4, z - 0.9, VOX.barrel);
        this.obstacles.push({ minX: x - 0.6, maxX: x + 1.5, minZ: z - 1.5, maxZ: z + 0.8 });
      } else {
        this.propSandbags(props, x, z);
        this.obstacles.push({ minX: x - 1.5, maxX: x + 1.5, minZ: z - 0.6, maxZ: z + 0.6 });
      }
      this.propRocks(props, x - 1.0, z + 1.0);
    }
  }

  /** Scatter light, decorative camp clutter across the grass (no collision). */
  private buildClutter(props: VoxelBatch) {
    const kinds = ["jerry", "propane", "toolbox", "tire", "rocks"] as const;
    let placed = 0;
    let attempts = 0;
    while (placed < 16 && attempts++ < 400) {
      const x = (Math.random() * 2 - 1) * (this.half - 3);
      const z = (Math.random() * 2 - 1) * (this.half - 3);
      if (!this.inArena(Math.round(x), Math.round(z))) continue;
      if (Math.max(Math.abs(x), Math.abs(z)) <= this.plaza + 1) continue; // keep the clearing open
      if (Math.abs(x) <= 1.2 || Math.abs(z) <= 1.2) continue; // keep paths clear
      if (this.insideObstacle(x, z, 1)) continue;
      const kind = kinds[Math.floor(Math.random() * kinds.length)];
      if (kind === "jerry") this.propJerryCan(props, x, z);
      else if (kind === "propane") this.propPropane(props, x, z);
      else if (kind === "toolbox") this.propToolbox(props, x, z);
      else if (kind === "tire") this.propTire(props, x, z);
      else this.propRocks(props, x, z);
      placed++;
    }
  }

  // ---- individual voxel props ----
  /** A crate with a darker plank frame + diagonal brace for a built look. */
  private propCrate(props: VoxelBatch, x: number, z: number, stacked: boolean) {
    this.crateBody(props, x, 0.5, z, 1.0);
    if (stacked) this.crateBody(props, x + 0.1, 1.45, z - 0.05, 0.9);
  }
  private crateBody(props: VoxelBatch, x: number, y: number, z: number, s: number) {
    props.add(x, y, z, VOX.crate, s, s, s);
    // plank frame on the camera-facing (+z) face
    const f = z + s * 0.5;
    props.add(x, y + s * 0.4, f, VOX.crateDark, s, s * 0.12, 0.06); // top rail
    props.add(x, y - s * 0.4, f, VOX.crateDark, s, s * 0.12, 0.06); // bottom rail
    props.add(x - s * 0.4, y, f, VOX.crateDark, s * 0.12, s, 0.06); // left stile
    props.add(x + s * 0.4, y, f, VOX.crateDark, s * 0.12, s, 0.06); // right stile
    props.add(x, y, f, VOX.crateDark, s * 0.12, s * 1.2, 0.05);     // centre brace
  }

  /** A barrel with vertical staves + two steel hoops. */
  private propBarrel(props: VoxelBatch, x: number, z: number, color: number) {
    props.add(x, 0.6, z, color, 0.75, 1.2, 0.75);
    // staves: slim ribs around the rim catch the light as fine detail
    for (let a = 0; a < 8; a++) {
      const an = (a / 8) * Math.PI * 2;
      props.add(x + Math.cos(an) * 0.36, 0.6, z + Math.sin(an) * 0.36, color === VOX.barrel ? VOX.barrelRust : VOX.barrel, 0.1, 1.16, 0.1);
    }
    props.add(x, 0.95, z, VOX.steelDark, 0.82, 0.14, 0.82); // top hoop
    props.add(x, 0.6, z, VOX.steelDark, 0.84, 0.12, 0.84);  // mid hoop
    props.add(x, 0.3, z, VOX.steelDark, 0.82, 0.14, 0.82);  // bottom hoop
    props.add(x, 1.22, z, VOX.steel, 0.5, 0.1, 0.5);        // lid
  }

  private propSandbags(props: VoxelBatch, x: number, z: number) {
    for (let k = -1; k <= 1; k++) {
      props.add(x + k * 0.9, 0.22, z, VOX.sandbag, 0.86, 0.42, 0.7);
      props.add(x + k * 0.9, 0.62, z, VOX.sandbagDark, 0.86, 0.42, 0.7);
    }
    props.add(x - 0.45, 1.0, z, VOX.sandbag, 0.86, 0.42, 0.7);
    props.add(x + 0.45, 1.0, z, VOX.sandbag, 0.86, 0.42, 0.7);
  }

  private propJerryCan(props: VoxelBatch, x: number, z: number) {
    props.add(x, 0.45, z, VOX.jerryCan, 0.55, 0.85, 0.42);
    props.add(x, 0.5, z + 0.21, VOX.jerryCanDark, 0.4, 0.55, 0.05); // recessed X panel
    props.add(x, 0.78, z + 0.22, VOX.jerryCanDark, 0.46, 0.08, 0.04); // top ridge
    props.add(x - 0.18, 0.95, z, VOX.jerryCanDark, 0.18, 0.18, 0.34); // handle
    props.add(x + 0.16, 0.95, z, VOX.steelDark, 0.16, 0.14, 0.16); // spout cap
  }

  private propPropane(props: VoxelBatch, x: number, z: number) {
    props.add(x, 0.55, z, VOX.propane, 0.5, 1.0, 0.5);
    props.add(x, 1.08, z, VOX.steel, 0.26, 0.16, 0.26); // valve
  }

  private propToolbox(props: VoxelBatch, x: number, z: number) {
    props.add(x, 0.3, z, VOX.toolbox, 0.9, 0.5, 0.55);
    props.add(x, 0.56, z, VOX.toolboxDark, 0.92, 0.1, 0.57); // lid lip
    props.add(x, 0.7, z, VOX.steel, 0.34, 0.1, 0.12); // handle
  }

  private propTire(props: VoxelBatch, x: number, z: number) {
    props.add(x, 0.2, z, VOX.tire, 0.85, 0.32, 0.85);
    props.add(x + 0.06, 0.5, z + 0.04, VOX.tire, 0.8, 0.3, 0.8);
    props.add(x + 0.06, 0.5, z + 0.04, VOX.steelDark, 0.3, 0.32, 0.3);
  }

  private propRocks(props: VoxelBatch, x: number, z: number) {
    props.add(x, 0.18, z, VOX.rock, 0.5, 0.38, 0.5);
    props.add(x + 0.4, 0.12, z + 0.25, VOX.rockDark, 0.32, 0.26, 0.32);
  }

  /** A stone-ringed campfire with charred logs, flickering flame + smoke. */
  private buildCampfire(props: VoxelBatch, x: number, z: number) {
    for (let a = 0; a < 8; a++) {
      const an = (a / 8) * Math.PI * 2;
      props.add(x + Math.cos(an) * 0.75, 0.18, z + Math.sin(an) * 0.75, a % 2 ? VOX.rock : VOX.rockDark, 0.4, 0.34, 0.4);
    }
    props.add(x, 0.32, z, VOX.doorWood, 1.0, 0.22, 0.26); // crossed logs
    props.add(x, 0.44, z, VOX.trunk, 0.26, 0.22, 1.0);
    for (let f = 0; f < 3; f++) {
      const m = this.glowBox(0.3, 0.5, 0.3, x + (f - 1) * 0.16, 0.75 + f * 0.12, z, f === 1 ? VOX.emberHot : VOX.ember, 1.3);
      this.flames.push({ mesh: m, baseY: 0.75 + f * 0.12, phase: f * 1.3 });
    }
    const light = new THREE.PointLight(0xff8a3a, 4, 9, 2);
    light.position.set(x, 1.3, z);
    this.group.add(light);
    this.registerSmoke(x, 1.5, z);
    this.obstacles.push({ minX: x - 0.9, maxX: x + 0.9, minZ: z - 0.9, maxZ: z + 0.9 });
  }

  private registerSmoke(x: number, y: number, z: number) {
    const mat = new THREE.MeshStandardMaterial({
      color: VOX.smoke, transparent: true, opacity: 0.5, roughness: 1, depthWrite: false,
    });
    for (let p = 0; p < 3; p++) {
      const m = new THREE.Mesh(this.geo, mat.clone());
      m.position.set(x, y, z);
      m.scale.setScalar(0.4);
      this.group.add(m);
      this.smoke.push({ mesh: m, baseX: x, baseY: y, baseZ: z, phase: p / 3, speed: 0.5 + Math.random() * 0.3, rise: 3 + Math.random() });
    }
  }

  private buildTrees(props: VoxelBatch) {
    const placed: [number, number][] = [];
    let attempts = 0;
    while (placed.length < 16 && attempts++ < 300) {
      const i = Math.floor((Math.random() * 2 - 1) * (this.half - 3));
      const j = Math.floor((Math.random() * 2 - 1) * (this.half - 3));
      if (!this.inArena(i, j)) continue;
      if (Math.max(Math.abs(i), Math.abs(j)) <= this.plaza + 1) continue; // keep plaza clear
      if (Math.abs(i) <= 1 || Math.abs(j) <= 1) continue; // keep paths clear
      if (this.insideObstacle(i, j, 2)) continue;
      if (placed.some(([pi, pj]) => Math.abs(pi - i) < 3 && Math.abs(pj - j) < 3)) continue;
      placed.push([i, j]);
      this.buildTree(props, i, j);
    }
  }

  /** Kintara-style tiered voxel tree: thin trunk + stacked green tiers. */
  private buildTree(props: VoxelBatch, ox: number, oz: number) {
    props.add(ox, 0.5, oz, VOX.trunk, 0.45, 1, 0.45);
    props.add(ox, 1.5, oz, VOX.trunk, 0.45, 1, 0.45);
    const pink = Math.random() < 0.2;
    const leaf = pink ? VOX.leafPink : VOX.leaf;
    const leafD = pink ? VOX.leafPink : VOX.leafDark;
    for (let i = -1; i <= 1; i++) for (let j = -1; j <= 1; j++) props.add(ox + i, 2.4, oz + j, (i + j) % 2 ? leafD : leaf);
    for (let i = 0; i <= 1; i++) for (let j = 0; j <= 1; j++) props.add(ox + i - 0.5, 3.2, oz + j - 0.5, leaf);
    props.add(ox, 3.9, oz, leaf, 0.8, 0.8, 0.8);
  }

  private insideObstacle(x: number, z: number, pad = 0): boolean {
    return this.obstacles.some(
      (o) => x > o.minX - pad && x < o.maxX + pad && z > o.minZ - pad && z < o.maxZ + pad,
    );
  }

  // ---- clouds ----
  private buildClouds(scene: THREE.Scene) {
    const mat = voxelMaterial(VOX.cloud);
    for (let n = 0; n < 16; n++) {
      const g = new THREE.Group();
      const puffs = 4 + Math.floor(Math.random() * 4);
      for (let p = 0; p < puffs; p++) {
        const s = 2 + Math.random() * 3;
        const m = new THREE.Mesh(this.geo, mat);
        m.position.set((Math.random() - 0.5) * 8, (Math.random() - 0.5) * 2, (Math.random() - 0.5) * 6);
        m.scale.set(s, s * 0.7, s);
        g.add(m);
      }
      // Keep clouds well above the camera (y≈24) so they stay a sky backdrop and
      // never drift between the lens and the player on the ground.
      g.position.set((Math.random() - 0.5) * 170, 44 + Math.random() * 24, (Math.random() - 0.5) * 170);
      scene.add(g);
      this.clouds.push({ group: g, speed: 1 + Math.random() * 1.6 });
    }
  }

  // ---- floating light motes (pollen / fireflies) ----
  /** A soft round falloff sprite texture, generated once for all motes. */
  private static moteTexture?: THREE.Texture;
  private moteSprite(): THREE.Texture {
    if (Arena.moteTexture) return Arena.moteTexture;
    const s = 64;
    const cv = document.createElement("canvas");
    cv.width = cv.height = s;
    const ctx = cv.getContext("2d")!;
    const g = ctx.createRadialGradient(s / 2, s / 2, 0, s / 2, s / 2, s / 2);
    g.addColorStop(0, "rgba(255,255,255,1)");
    g.addColorStop(0.35, "rgba(255,248,224,0.7)");
    g.addColorStop(1, "rgba(255,244,210,0)");
    ctx.fillStyle = g;
    ctx.fillRect(0, 0, s, s);
    const tex = new THREE.CanvasTexture(cv);
    tex.colorSpace = THREE.SRGBColorSpace;
    Arena.moteTexture = tex;
    return tex;
  }

  /**
   * Slow, soft motes of light drifting through the air — sunlit pollen that
   * bobs and sways. Picked up by the bloom pass, this is the coziest, most
   * comforting atmospheric layer in the scene.
   */
  private buildMotes(scene: THREE.Scene) {
    const tex = this.moteSprite();
    const R = this.half - 2;
    for (let n = 0; n < 22; n++) {
      const mat = new THREE.SpriteMaterial({
        map: tex,
        color: Math.random() < 0.25 ? 0xfff0c0 : 0xffffff,
        transparent: true,
        opacity: 0.25 + Math.random() * 0.4,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        fog: true,
      });
      const sprite = new THREE.Sprite(mat);
      const x = (Math.random() * 2 - 1) * R;
      const z = (Math.random() * 2 - 1) * R;
      const y = 1.2 + Math.random() * 7;
      const sc = 0.12 + Math.random() * 0.22;
      sprite.position.set(x, y, z);
      sprite.scale.setScalar(sc);
      scene.add(sprite);
      this.motes.push({
        sprite,
        baseX: x, baseY: y, baseZ: z,
        phase: Math.random() * Math.PI * 2,
        bob: 0.4 + Math.random() * 0.8,
        sway: 0.5 + Math.random() * 1.2,
        speed: 0.25 + Math.random() * 0.4,
      });
    }
  }

  // ---- per-frame ----
  update(dt: number) {
    this.t += dt;
    for (const m of this.motes) {
      const p = this.t * m.speed + m.phase;
      m.sprite.position.set(
        m.baseX + Math.sin(p) * m.sway,
        m.baseY + Math.sin(p * 1.3) * m.bob,
        m.baseZ + Math.cos(p * 0.8) * m.sway,
      );
      // a gentle twinkle so they shimmer rather than sit static
      (m.sprite.material as THREE.SpriteMaterial).opacity =
        0.3 + 0.25 * (0.5 + 0.5 * Math.sin(p * 2.1));
    }
    for (const c of this.clouds) {
      c.group.position.x += c.speed * dt;
      if (c.group.position.x > 95) c.group.position.x = -95;
    }
    // campfire flames: flicker their height + glow so the fire dances
    for (const f of this.flames) {
      const flick = 0.5 + 0.5 * Math.sin(this.t * 12 + f.phase) * Math.sin(this.t * 7 + f.phase * 2);
      f.mesh.scale.set(0.28 + flick * 0.1, 0.45 + flick * 0.35, 0.28 + flick * 0.1);
      f.mesh.position.y = f.baseY + flick * 0.12;
      (f.mesh.material as THREE.MeshStandardMaterial).emissiveIntensity = 1.1 + flick * 0.8;
    }
    // campfire smoke: each puff rises, drifts, swells + fades, then loops
    for (const s of this.smoke) {
      const k = (this.t * s.speed + s.phase) % 1; // 0→1 life cycle
      s.mesh.position.set(
        s.baseX + Math.sin(this.t * 0.8 + s.phase * 6) * k * 0.8,
        s.baseY + k * s.rise,
        s.baseZ + Math.cos(this.t * 0.6 + s.phase * 6) * k * 0.4,
      );
      s.mesh.scale.setScalar(0.3 + k * 0.9);
      (s.mesh.material as THREE.MeshStandardMaterial).opacity = 0.5 * (1 - k);
    }
  }

  // ---- gameplay helpers ----
  clamp(pos: THREE.Vector3, radius: number) {
    const lim = this.half - 1 - radius;
    pos.x = Math.max(-lim, Math.min(lim, pos.x));
    pos.z = Math.max(-lim, Math.min(lim, pos.z));
  }

  /** Push a circle (radius r) out of any obstacle footprint. */
  resolveObstacles(pos: THREE.Vector3, r: number) {
    for (const o of this.obstacles) {
      const minX = o.minX - r, maxX = o.maxX + r, minZ = o.minZ - r, maxZ = o.maxZ + r;
      if (pos.x > minX && pos.x < maxX && pos.z > minZ && pos.z < maxZ) {
        const dl = pos.x - minX, dr = maxX - pos.x, du = pos.z - minZ, dd = maxZ - pos.z;
        const m = Math.min(dl, dr, du, dd);
        if (m === dl) pos.x = minX;
        else if (m === dr) pos.x = maxX;
        else if (m === du) pos.z = minZ;
        else pos.z = maxZ;
      }
    }
  }

  randomEdgePoint(out: THREE.Vector3): THREE.Vector3 {
    const lim = this.half - 1.5;
    const t = Math.random() * 2 - 1;
    switch (Math.floor(Math.random() * 4)) {
      case 0: out.set(t * lim, 0, -lim); break;
      case 1: out.set(t * lim, 0, lim); break;
      case 2: out.set(-lim, 0, t * lim); break;
      default: out.set(lim, 0, t * lim); break;
    }
    return out;
  }
}
