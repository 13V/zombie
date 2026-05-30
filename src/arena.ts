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
   * The camper van as a genuinely high-density voxel model. The trick that makes
   * dense voxels look *premium* instead of a quilt: voxels are placed on a fine
   * grid but scaled to slightly **overlap** (so surfaces read solid — no
   * see-through gaps), with small even bevels; ambient occlusion then settles
   * into the grooves. Baked into instanced batches (a few draw calls).
   */
  private buildRV() {
    const solid = new VoxelBatch();
    const glow = new VoxelBatch();
    const geo = new RoundedBoxGeometry(1, 1, 1, 2, 0.06);
    const s = 0.34;        // grid spacing — fine enough to read as detailed
    const v = s * 1.16;    // voxel size > spacing => overlap => no holes
    const eps = s * 0.25;

    const region = (
      x0: number, x1: number, y0: number, y1: number, z0: number, z1: number,
      colorFn: (x: number, y: number, z: number) => number | null, shell = true,
    ) => {
      for (let x = x0 + s / 2; x < x1 - eps; x += s)
        for (let y = y0 + s / 2; y < y1 - eps; y += s)
          for (let z = z0 + s / 2; z < z1 - eps; z += s) {
            if (shell && x > x0 + s && x < x1 - s && y > y0 + s && y < y1 - s && z > z0 + s && z < z1 - s) continue;
            const col = colorFn(x, y, z);
            if (col !== null) solid.add(x, y, z, col, v, v, v);
          }
    };
    const fill = (x0: number, x1: number, y0: number, y1: number, z0: number, z1: number, color: number) =>
      region(x0, x1, y0, y1, z0, z1, () => color, false);
    const win = (x0: number, x1: number, y0: number, y1: number, z: number, color: number) => {
      for (let x = x0 + s / 2; x < x1 - eps; x += s)
        for (let y = y0 + s / 2; y < y1 - eps; y += s) glow.add(x, y, z, color, v, v, s * 0.7);
    };
    // body: white shell with a blue stripe band wrapping the walls
    const body = (_x: number, y: number) => (y > 1.5 && y < 1.95 ? VOX.rvStripe : VOX.rvBody);

    // shells: rear living box, lower cab, cab-over bunk
    region(-1.7, 3.3, 1.2, 3.3, -1.4, 1.4, body);
    region(-3.85, -1.7, 1.0, 2.45, -1.3, 1.3, body);
    region(-3.85, -1.7, 2.45, 3.3, -1.4, 1.4, () => VOX.rvBody);
    // chassis skirt + lighter two-tone roof caps
    fill(-3.7, 3.5, 0.82, 1.18, -1.25, 1.25, VOX.rvTrim);
    fill(-1.7, 3.3, 3.3, 3.6, -1.45, 1.45, VOX.rvBodyShade);
    fill(-3.85, -1.7, 3.3, 3.6, -1.42, 1.42, VOX.rvBodyShade);
    // windows (gentle glow = glass), door, windshield
    win(-0.65, 0.65, 2.2, 2.95, 1.42, VOX.rvWindow);
    win(1.35, 2.65, 2.2, 2.95, 1.42, VOX.rvWindow);
    win(-3.5, -2.1, 1.55, 2.25, 1.32, VOX.rvWindow);   // cab side glass
    for (let z = -1.0; z <= 1.0; z += s) glow.add(-3.88, 1.95, z, VOX.rvWindow, 0.12, 0.7, v);
    fill(-1.5, -0.7, 1.2, 2.45, 1.38, 1.5, VOX.rvDoor);
    win(-1.4, -0.8, 2.45, 2.85, 1.5, VOX.rvWindow);    // door porthole
    // wheels: fat tire blocks, steel hubs, dark arches
    for (const wx of [-2.4, 2.6]) for (const wz of [-1.12, 1.12]) {
      fill(wx - 0.5, wx + 0.5, 0.2, 1.0, wz - 0.36, wz + 0.36, VOX.tire);
      solid.add(wx, 0.55, wz, VOX.rim, 0.42, 0.42, 0.8);
      fill(wx - 0.66, wx + 0.66, 1.0, 1.22, wz - 0.42, wz + 0.42, VOX.rvTrim);
    }
    // bumpers, grille, head/taillights
    fill(-4.05, -3.8, 1.05, 1.45, -1.2, 1.2, VOX.rvTrim);
    fill(3.35, 3.6, 1.05, 1.45, -1.2, 1.2, VOX.rvTrim);
    fill(-3.9, -3.78, 1.2, 1.55, -0.7, 0.7, VOX.steelDark);
    for (const hz of [-0.85, 0.85]) glow.add(-3.9, 1.45, hz, VOX.windowGlow, 0.14, 0.32, 0.36);
    for (const tz of [-1.05, 1.05]) glow.add(3.42, 1.7, tz, VOX.toolbox, 0.14, 0.36, 0.36);
    // wing mirrors
    for (const mz of [-1.5, 1.5]) {
      solid.add(-3.45, 2.05, mz, VOX.steelDark, 0.34, 0.12, 0.12);
      solid.add(-3.62, 1.95, mz, VOX.steelDark, 0.16, 0.34, 0.18);
    }
    // back ladder, roof rails, AC unit, deck chair
    for (const lz of [-0.7, 0.7]) for (let y = 1.4; y < 3.25; y += s) solid.add(3.45, y, lz, VOX.steelDark, 0.14, v, 0.14);
    for (let r = 0; r < 4; r++) solid.add(3.45, 1.65 + r * 0.45, 0, VOX.steelDark, 0.14, 0.12, 1.4);
    for (const rz of [-1.08, 1.08]) for (let x = -1.5; x < 3.2; x += s) solid.add(x, 3.6, rz, VOX.steelDark, v, 0.12, 0.14);
    fill(-0.9, 0.1, 3.6, 3.95, -0.25, 0.75, VOX.rvTrim);
    fill(1.2, 2.0, 3.6, 3.72, -0.7, 0.1, VOX.woodTrim);
    fill(1.9, 2.05, 3.72, 4.25, -0.7, 0.1, VOX.woodTrim);

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
  /**
   * A shell of overlapping fine voxels (scale > spacing so it reads solid, not
   * a quilt) — the same premium-voxel technique as the RV, for detailed props.
   */
  private denseShell(
    b: VoxelBatch, cx: number, cy: number, cz: number, w: number, h: number, d: number, step: number,
    colorFn: (vx: number, vy: number, vz: number) => number | null,
  ) {
    const v = step * 1.18;
    const eps = step * 0.25;
    for (let x = -w / 2 + step / 2; x < w / 2 - eps; x += step)
      for (let y = -h / 2 + step / 2; y < h / 2 - eps; y += step)
        for (let z = -d / 2 + step / 2; z < d / 2 - eps; z += step) {
          if (Math.abs(x) < w / 2 - step && Math.abs(y) < h / 2 - step && Math.abs(z) < d / 2 - step) continue;
          const col = colorFn(x, y, z);
          if (col !== null) b.add(cx + x, cy + y, cz + z, col, v, v, v);
        }
  }

  /** A planked wooden crate built from fine voxels (slats + dark frame). */
  private crateBody(props: VoxelBatch, x: number, y: number, z: number, s: number) {
    const step = s * 0.26; // ~4 voxels per edge
    this.denseShell(props, x, y, z, s, s, s, step, (vx, vy, vz) => {
      const frame =
        Math.abs(vy) > s / 2 - step * 1.2 || Math.abs(vx) > s / 2 - step * 1.2 || Math.abs(vz) > s / 2 - step * 1.2;
      if (frame) return VOX.crateDark; // plank frame around the edges
      return Math.round(vx / step) % 2 === 0 ? VOX.crate : VOX.crateDark; // vertical slats
    });
  }

  /** A barrel built from fine voxels with three steel hoop bands + a lid. */
  private propBarrel(props: VoxelBatch, x: number, z: number, color: number) {
    const w = 0.8, h = 1.2, step = w * 0.27; // ~3 voxels across, ~4 tall
    this.denseShell(props, x, 0.6, z, w, h, w, step, (_vx, vy, _vz) => {
      // hoops at local heights ≈ +0.35, 0, -0.35
      if (Math.abs(vy - 0.35) < step * 0.65 || Math.abs(vy) < step * 0.55 || Math.abs(vy + 0.35) < step * 0.65)
        return VOX.steelDark;
      return color;
    });
    props.add(x, 1.22, z, VOX.steel, 0.52, 0.12, 0.52); // lid
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
    while (placed.length < 9 && attempts++ < 300) {
      const i = Math.floor((Math.random() * 2 - 1) * (this.half - 3));
      const j = Math.floor((Math.random() * 2 - 1) * (this.half - 3));
      if (!this.inArena(i, j)) continue;
      if (Math.max(Math.abs(i), Math.abs(j)) <= this.plaza + 1) continue; // keep plaza clear
      if (Math.abs(i) <= 1 || Math.abs(j) <= 1) continue; // keep paths clear
      if (this.insideObstacle(i, j, 2)) continue;
      // wider spacing so trees feel placed, not cluttered
      if (placed.some(([pi, pj]) => Math.abs(pi - i) < 5 && Math.abs(pj - j) < 5)) continue;
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

  // ---- per-frame ----
  update(dt: number) {
    this.t += dt;
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
