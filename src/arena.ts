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

/** Which wall of a building a cell faces. */
type Side = "xmin" | "xmax" | "zmin" | "zmax";

/** Layout for one cottage. */
interface HouseCfg {
  ox: number; // min-corner origin
  oz: number;
  w: number; // footprint width (x) / depth (z)
  d: number;
  stories: number; // 1 or 2
  wall: number; // wall color
  roof: number; // roof color
  chimney: boolean;
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
 * A flat voxel arena in a soft sky — a blend of Kintara (flat isometric tiled
 * ground, a central cobblestone fountain plaza) and Tiny World (thick beveled
 * voxels, blue sky, drifting clouds). The fountain is the defensive core to
 * circle while kiting the horde; blocky trees and peaked-roof houses give cover.
 */
export class Arena {
  readonly group = new THREE.Group();
  readonly half = WORLD.half;
  readonly obstacles: Obstacle[] = [];
  readonly plaza = 6; // half-extent of the central plaza

  private geo = new RoundedBoxGeometry(1, 1, 1, 2, 0.08);
  private clouds: { group: THREE.Group; speed: number }[] = [];
  private plume?: THREE.Mesh;
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
    this.buildHouses(props, glow);
    this.buildTrees(props);
    terrain.build(this.group, this.geo, false, true);
    props.build(this.group, this.geo, true, true);
    glow.build(this.group, this.geo, false, false, (c) => glowMaterial(c, 0.9));

    this.buildFountain();
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
        },
        vertexShader: `
          varying vec3 vPos;
          void main() { vPos = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
        `,
        fragmentShader: `
          uniform vec3 top; uniform vec3 bottom; varying vec3 vPos;
          void main() {
            float h = clamp(vPos.y / 300.0 * 0.5 + 0.5, 0.0, 1.0);
            gl_FragColor = vec4(mix(bottom, top, pow(h, 0.7)), 1.0);
          }
        `,
      }),
    );
    scene.add(sky);
  }

  private buildLights(scene: THREE.Scene) {
    scene.add(new THREE.HemisphereLight(0xcfe8ff, 0x6f7a4a, 0.55));
    const key = new THREE.DirectionalLight(0xfff2d4, 1.35);
    key.position.set(20, 34, 16);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const d = this.half + 8;
    const cam = key.shadow.camera;
    cam.left = -d; cam.right = d; cam.top = d; cam.bottom = -d;
    cam.near = 1; cam.far = 100;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.03;
    scene.add(key);
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
          terrain.add(i, -0.5, j, (i + j) % 2 === 0 ? VOX.cobble : VOX.cobbleDark);
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

  // ---- fountain (plaza centerpiece) ----
  private buildFountain() {
    const stone = new THREE.MeshStandardMaterial({ color: VOX.cobbleDark, roughness: 0.85 });
    const water = new THREE.MeshStandardMaterial({ color: VOX.water, roughness: 0.25, metalness: 0.0 });
    const spray = new THREE.MeshStandardMaterial({
      color: 0xeaf6ff, roughness: 0.2, transparent: true, opacity: 0.65, emissive: 0x9fd2f5, emissiveIntensity: 0.4,
    });

    const basin = new THREE.Mesh(new THREE.CylinderGeometry(3.2, 3.4, 0.8, 28), stone);
    basin.position.y = 0.4;
    basin.castShadow = true;
    basin.receiveShadow = true;
    this.group.add(basin);

    const pool = new THREE.Mesh(new THREE.CylinderGeometry(2.7, 2.7, 0.4, 28), water);
    pool.position.y = 0.65;
    this.group.add(pool);

    const post = new THREE.Mesh(new THREE.CylinderGeometry(0.35, 0.45, 1.4, 16), stone);
    post.position.y = 1.1;
    post.castShadow = true;
    this.group.add(post);

    const cap = new THREE.Mesh(new THREE.CylinderGeometry(0.7, 0.7, 0.2, 16), stone);
    cap.position.y = 1.85;
    this.group.add(cap);

    this.plume = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.4, 1.6, 12), spray);
    this.plume.position.y = 2.6;
    this.group.add(this.plume);

    // Block the fountain so players circle it (the kiting core).
    this.obstacles.push({ minX: -3.1, maxX: 3.1, minZ: -3.1, maxZ: 3.1 });
  }

  // ---- structures ----
  private buildHouses(props: VoxelBatch, glow: VoxelBatch) {
    // A deliberate ring of varied cottages around the plaza, each with its door
    // turned toward the centre. Mixed footprints, heights, wall + roof colors.
    const cfgs: HouseCfg[] = [
      { ox: -16, oz: -15, w: 4, d: 5, stories: 2, wall: VOX.houseWall, roof: VOX.roofBlue, chimney: true },
      { ox: 11, oz: -15, w: 5, d: 4, stories: 1, wall: VOX.plasterWarm, roof: VOX.roofRed, chimney: true },
      { ox: -15, oz: 11, w: 4, d: 4, stories: 1, wall: VOX.plasterSage, roof: VOX.roofPurple, chimney: false },
      { ox: 11, oz: 11, w: 4, d: 5, stories: 2, wall: VOX.brick, roof: VOX.roofDark, chimney: true },
      { ox: 15, oz: -2, w: 4, d: 4, stories: 1, wall: VOX.houseWall, roof: VOX.roofRed, chimney: false },
      { ox: -17, oz: -1, w: 3, d: 4, stories: 1, wall: VOX.plasterWarm, roof: VOX.roofBlue, chimney: true },
    ];
    for (const c of cfgs) this.buildHouse(props, glow, c);
  }

  /**
   * A chunky voxel cottage: stone foundation, plastered walls with glowing
   * windows + flower boxes, a framed door with a lantern, an overhanging hip
   * roof with a ridge cap, and an optional smoking chimney. The door faces the
   * plaza so it reads as the "front".
   */
  private buildHouse(props: VoxelBatch, glow: VoxelBatch, c: HouseCfg) {
    const { ox, oz, w, d, stories } = c;
    const H = stories * 3; // wall courses tall
    // which side faces the plaza centre → that's the front (door) wall
    const cx = ox + (w - 1) / 2;
    const cz = oz + (d - 1) / 2;
    const front: Side =
      Math.abs(cx) >= Math.abs(cz) ? (cx >= 0 ? "xmin" : "xmax") : cz >= 0 ? "zmin" : "zmax";

    // the door's index along its wall, and its grid cell
    const horiz = front === "xmin" || front === "xmax"; // wall runs along z
    const doorAlong = horiz ? Math.floor((d - 1) / 2) : Math.floor((w - 1) / 2);
    const doorI = front === "xmin" ? 0 : front === "xmax" ? w - 1 : doorAlong;
    const doorJ = front === "zmin" ? 0 : front === "zmax" ? d - 1 : doorAlong;

    for (let y = 0; y < H; y++) {
      for (let i = 0; i < w; i++) {
        for (let j = 0; j < d; j++) {
          if (i !== 0 && i !== w - 1 && j !== 0 && j !== d - 1) continue; // interior
          const side = this.cellSide(i, j, w, d); // null at corners

          // door opening: front wall, centre column, bottom two courses
          if (i === doorI && j === doorJ && y < 2) {
            props.add(ox + i, 0.5 + y, oz + j, VOX.doorWood, 0.82, 1, 0.82);
            continue;
          }
          // glowing windows: 2nd course of each storey, non-corner, every other
          // cell along the wall
          const onWindowRow = y % 3 === 1;
          const along = side === "xmin" || side === "xmax" ? j : i;
          if (side && onWindowRow && along % 2 === 1) {
            glow.add(ox + i, 0.5 + y, oz + j, VOX.windowGlow, 0.92, 0.92, 0.92);
            if (y === 1) this.addFlowerBox(props, ox + i, 0.5 + y - 0.5, oz + j, side); // sill box
            continue;
          }
          // foundation course is stone; everything above is the wall color
          props.add(ox + i, 0.5 + y, oz + j, y === 0 ? VOX.foundation : c.wall);
        }
      }
    }

    this.addDoorLantern(props, glow, ox + doorI, oz + doorJ, front);
    this.buildRoof(props, ox, oz, w, d, 0.5 + H - 0.5, c.roof);
    if (c.chimney) this.buildChimney(props, ox, oz, w, 0.5 + H);

    this.obstacles.push({ minX: ox - 0.5, maxX: ox + w - 0.5, minZ: oz - 0.5, maxZ: oz + d - 0.5 });
  }

  /** Which wall a non-corner perimeter cell sits on (null at corners). */
  private cellSide(i: number, j: number, w: number, d: number): Side | null {
    const onI = i === 0 || i === w - 1;
    const onJ = j === 0 || j === d - 1;
    if (onI && onJ) return null; // corner
    if (i === 0) return "xmin";
    if (i === w - 1) return "xmax";
    if (j === 0) return "zmin";
    return "zmax";
  }

  /** Outward offset for a wall side (so sills/lanterns sit on the exterior). */
  private sideOut(side: Side, out: number): [number, number] {
    return [
      side === "xmin" ? -out : side === "xmax" ? out : 0,
      side === "zmin" ? -out : side === "zmax" ? out : 0,
    ];
  }

  private addFlowerBox(props: VoxelBatch, x: number, y: number, z: number, side: Side) {
    const [dx, dz] = this.sideOut(side, 0.5);
    props.add(x + dx, y, z + dz, VOX.woodTrim, 0.7, 0.3, 0.7);
    props.add(x + dx, y + 0.32, z + dz, VOX.leafPink, 0.5, 0.3, 0.5);
  }

  /** A warm lantern mounted on the wall just outside the door. */
  private addDoorLantern(props: VoxelBatch, glow: VoxelBatch, dx0: number, dz0: number, front: Side) {
    const [dx, dz] = this.sideOut(front, 0.6);
    props.add(dx0 + dx, 2.1, dz0 + dz, VOX.woodTrim, 0.16, 0.7, 0.16); // bracket
    glow.add(dx0 + dx, 1.75, dz0 + dz, VOX.lantern, 0.32, 0.42, 0.32); // flame
  }

  /** Stepped overhanging hip roof with a small ridge cap. */
  private buildRoof(props: VoxelBatch, ox: number, oz: number, w: number, d: number, top: number, roof: number) {
    // overhanging eave ring
    for (let i = -1; i <= w; i++) for (let j = -1; j <= d; j++) props.add(ox + i, top + 0.5, oz + j, roof);
    // step inward until the roof closes
    let inset = 0;
    let y = top + 1.3;
    while (true) {
      const x0 = inset, x1 = w - 1 - inset, z0 = inset, z1 = d - 1 - inset;
      if (x0 > x1 || z0 > z1) break;
      for (let i = x0; i <= x1; i++) for (let j = z0; j <= z1; j++) props.add(ox + i, y, oz + j, roof);
      inset++;
      y += 0.8;
    }
  }

  private buildChimney(props: VoxelBatch, ox: number, oz: number, w: number, top: number) {
    const cxv = ox + w - 1;
    const czv = oz + 1;
    for (let k = 0; k < 3; k++) props.add(cxv, top + 0.6 + k, czv, VOX.brick, 0.7, 1, 0.7);
    const capY = top + 0.6 + 3;
    props.add(cxv, capY, czv, VOX.stoneDark, 0.85, 0.4, 0.85);
    this.registerSmoke(cxv, capY + 0.4, czv);
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

  // ---- per-frame ----
  update(dt: number) {
    this.t += dt;
    for (const c of this.clouds) {
      c.group.position.x += c.speed * dt;
      if (c.group.position.x > 95) c.group.position.x = -95;
    }
    if (this.plume) {
      this.plume.scale.y = 1 + Math.sin(this.t * 3) * 0.12;
      this.plume.rotation.y = this.t;
    }
    // chimney smoke: each puff rises, drifts, swells + fades, then loops
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
