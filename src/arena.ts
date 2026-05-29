import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { WORLD } from "./config";
import { VOX, voxelMaterial } from "./palette";

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

  build(parent: THREE.Object3D, geo: THREE.BufferGeometry, cast: boolean, receive: boolean) {
    const dummy = new THREE.Object3D();
    for (const [color, arr] of this.buckets) {
      const mesh = new THREE.InstancedMesh(geo, voxelMaterial(color), arr.length);
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
 * A voxel floating island in a soft sky — the "Tiny World" look. Grass-topped
 * blocks over dirt + a tapering stone underside, with paths, a pond, a farm,
 * voxel trees, houses, fences and crops. Drifting blocky clouds fill the sky.
 */
export class Arena {
  readonly group = new THREE.Group();
  readonly half = WORLD.half;
  readonly obstacles: Obstacle[] = [];

  private geo = new RoundedBoxGeometry(1, 1, 1, 2, 0.08);
  private clouds: { group: THREE.Group; speed: number }[] = [];

  constructor(scene: THREE.Scene) {
    scene.fog = new THREE.Fog(WORLD.fogColor, WORLD.fogNear, WORLD.fogFar);

    this.buildSky(scene);
    this.buildLights(scene);

    const terrain = new VoxelBatch();
    const props = new VoxelBatch();
    this.generateIsland(terrain, props);
    this.buildHouses(props);
    this.buildTrees(props);
    terrain.build(this.group, this.geo, false, true);
    props.build(this.group, this.geo, true, true);

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
    // Env map (set in main.ts) supplies soft ambient; these stay gentle + warm.
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

  // ---- island generation ----
  private inIsland(i: number, j: number, shrink = 0): boolean {
    const H = this.half - shrink;
    if (Math.max(Math.abs(i), Math.abs(j)) > H) return false;
    const ci = Math.abs(i) - (H - 3);
    const cj = Math.abs(j) - (H - 3);
    if (ci > 0 && cj > 0 && ci + cj > 3) return false; // round the corners
    return true;
  }

  private inRect(i: number, j: number, x0: number, x1: number, z0: number, z1: number) {
    return i >= x0 && i <= x1 && j >= z0 && j <= z1;
  }

  private generateIsland(terrain: VoxelBatch, props: VoxelBatch) {
    const H = this.half;
    // feature regions (kept off the central spawn area)
    const pond = { x0: -H + 4, x1: -H + 9, z0: H - 9, z1: H - 4 };
    const farm = { x0: 4, x1: 10, z0: -10, z1: -4 };

    for (let i = -H; i <= H; i++) {
      for (let j = -H; j <= H; j++) {
        if (!this.inIsland(i, j)) continue;

        const isPond = this.inRect(i, j, pond.x0, pond.x1, pond.z0, pond.z1);
        const isFarm = this.inRect(i, j, farm.x0, farm.x1, farm.z0, farm.z1);
        const isPath = (Math.abs(i) <= 1 || Math.abs(j) <= 1) && !isPond && !isFarm;

        if (isPond) {
          terrain.add(i, -0.75, j, VOX.water, 1, 0.7, 1); // recessed water
        } else if (isFarm) {
          terrain.add(i, -0.5, j, VOX.tilled);
          if ((i + j) % 2 === 0) {
            const ripe = Math.random() < 0.3;
            props.add(i, 0.2, j, ripe ? VOX.cropRipe : VOX.crop, 0.3, 0.5, 0.3);
          }
        } else if (isPath) {
          terrain.add(i, -0.5, j, VOX.path);
        } else {
          const shade = (i * 7 + j * 13) % 5 === 0 ? VOX.grassDark : VOX.grass;
          terrain.add(i, -0.5, j, shade);
          // scattered grass tufts for texture
          if (Math.random() < 0.05 && Math.abs(i) + Math.abs(j) > 4) {
            props.add(i + (Math.random() - 0.5) * 0.4, 0.15, j + (Math.random() - 0.5) * 0.4, VOX.leaf, 0.35, 0.35, 0.35);
          }
        }
      }
    }

    this.buildUnderside(terrain);
    this.buildFences(props, farm);
  }

  private buildUnderside(terrain: VoxelBatch) {
    const H = this.half;
    for (let d = 1; d <= 9; d++) {
      const shrink = Math.max(0, d - 1);
      if (H - shrink < 3) break;
      const color = d === 1 ? VOX.dirt : d === 2 ? VOX.dirtDark : (d % 2 ? VOX.stone : VOX.stoneDark);
      for (let i = -H; i <= H; i++) {
        for (let j = -H; j <= H; j++) {
          if (this.inIsland(i, j, shrink)) terrain.add(i, -0.5 - d, j, color);
        }
      }
    }
    // a few ragged stalactite blocks dangling from the center underside
    for (let n = 0; n < 10; n++) {
      const i = Math.floor((Math.random() * 2 - 1) * (H - 6));
      const j = Math.floor((Math.random() * 2 - 1) * (H - 6));
      const depth = 9 + Math.floor(Math.random() * 3);
      terrain.add(i, -0.5 - depth, j, Math.random() < 0.5 ? VOX.stone : VOX.stoneDark);
    }
  }

  private buildFences(props: VoxelBatch, farm: { x0: number; x1: number; z0: number; z1: number }) {
    for (let i = farm.x0 - 1; i <= farm.x1 + 1; i++) {
      props.add(i, 0.4, farm.z0 - 1, VOX.fence, 0.25, 1.0, 0.25);
      props.add(i, 0.4, farm.z1 + 1, VOX.fence, 0.25, 1.0, 0.25);
    }
    for (let j = farm.z0 - 1; j <= farm.z1 + 1; j++) {
      props.add(farm.x0 - 1, 0.4, j, VOX.fence, 0.25, 1.0, 0.25);
      props.add(farm.x1 + 1, 0.4, j, VOX.fence, 0.25, 1.0, 0.25);
    }
  }

  // ---- structures ----
  private buildHouses(props: VoxelBatch) {
    this.buildHouse(props, -9, -8, VOX.roofBlue);
    this.buildHouse(props, 7, 8, VOX.roofRed);
  }

  /** A 4×4 voxel cottage with walls, a door gap and a stepped colored roof. */
  private buildHouse(props: VoxelBatch, ox: number, oz: number, roof: number) {
    const w = 4;
    for (let y = 0; y < 3; y++) {
      for (let i = 0; i < w; i++) {
        for (let j = 0; j < w; j++) {
          const edge = i === 0 || i === w - 1 || j === 0 || j === w - 1;
          if (!edge) continue;
          if (y === 0 && i === 1 && j === 0) continue; // door gap
          props.add(ox + i, 0.5 + y, oz + j, VOX.houseWall);
        }
      }
    }
    // stepped roof
    for (let i = -1; i < w + 1; i++) for (let j = -1; j < w + 1; j++) props.add(ox + i, 3.5, oz + j, roof);
    for (let i = 0; i < w; i++) for (let j = 0; j < w; j++) props.add(ox + i, 4.5, oz + j, roof);
    props.add(ox + 1.5, 5.5, oz + 1.5, roof, 1.4, 1, 1.4);

    this.obstacles.push({ minX: ox - 0.5, maxX: ox + w - 0.5, minZ: oz - 0.5, maxZ: oz + w - 0.5 });
  }

  private buildTrees(props: VoxelBatch) {
    const placed: [number, number][] = [];
    let attempts = 0;
    while (placed.length < 11 && attempts++ < 200) {
      const i = Math.floor((Math.random() * 2 - 1) * (this.half - 3));
      const j = Math.floor((Math.random() * 2 - 1) * (this.half - 3));
      if (!this.inIsland(i, j)) continue;
      if (Math.abs(i) < 3 && Math.abs(j) < 3) continue; // keep spawn clear
      if (this.insideObstacle(i, j, 2)) continue;
      if (placed.some(([pi, pj]) => Math.abs(pi - i) < 3 && Math.abs(pj - j) < 3)) continue;
      placed.push([i, j]);
      this.buildTree(props, i, j);
    }
  }

  private buildTree(props: VoxelBatch, ox: number, oz: number) {
    props.add(ox, 0.5, oz, VOX.trunk, 0.5, 1, 0.5);
    props.add(ox, 1.5, oz, VOX.trunk, 0.5, 1, 0.5);
    const pink = Math.random() < 0.25;
    const leaf = pink ? VOX.leafPink : VOX.leaf;
    const leafD = pink ? VOX.leafPink : VOX.leafDark;
    for (let i = -1; i <= 1; i++)
      for (let j = -1; j <= 1; j++) props.add(ox + i, 2.6, oz + j, (i + j) % 2 ? leafD : leaf);
    for (let i = 0; i <= 1; i++)
      for (let j = 0; j <= 1; j++) props.add(ox + i - 0.5, 3.6, oz + j - 0.5, leaf);
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
      g.position.set(
        (Math.random() - 0.5) * 160,
        -6 + Math.random() * 34,
        (Math.random() - 0.5) * 160,
      );
      scene.add(g);
      this.clouds.push({ group: g, speed: 1 + Math.random() * 1.6 });
    }
  }

  // ---- per-frame ----
  update(dt: number) {
    for (const c of this.clouds) {
      c.group.position.x += c.speed * dt;
      if (c.group.position.x > 90) c.group.position.x = -90;
    }
  }

  // ---- gameplay helpers ----
  clamp(pos: THREE.Vector3, radius: number) {
    const lim = this.half - 1 - radius;
    pos.x = Math.max(-lim, Math.min(lim, pos.x));
    pos.z = Math.max(-lim, Math.min(lim, pos.z));
  }

  /** Push a circle (radius r) out of any house footprint. */
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
