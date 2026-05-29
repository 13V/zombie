import * as THREE from "three";
import { WORLD } from "./config";
import { COLORS, toyMaterial } from "./palette";

/**
 * The miniature diorama world: a rounded grassy/sandy plate, low perimeter
 * walls, scattered toy props, and warm soft lighting with gentle fog.
 */
export class Arena {
  readonly group = new THREE.Group();
  readonly half = WORLD.half;

  constructor(scene: THREE.Scene) {
    scene.fog = new THREE.Fog(WORLD.fogColor, WORLD.fogNear, WORLD.fogFar);
    scene.background = new THREE.Color(WORLD.fogColor);

    this.buildLights(scene);
    this.buildGround();
    this.buildWalls();
    this.buildProps();

    scene.add(this.group);
  }

  private buildLights(scene: THREE.Scene) {
    // Env map (set in main.ts) supplies soft ambient, so these stay gentle.
    const hemi = new THREE.HemisphereLight(0xfff3d6, 0x6b5a3e, 0.45);
    scene.add(hemi);

    const key = new THREE.DirectionalLight(0xfff0c8, 1.25);
    key.position.set(18, 32, 14);
    key.castShadow = true;
    key.shadow.mapSize.set(2048, 2048);
    const d = this.half + 6;
    const cam = key.shadow.camera;
    cam.left = -d;
    cam.right = d;
    cam.top = d;
    cam.bottom = -d;
    cam.near = 1;
    cam.far = 90;
    key.shadow.bias = -0.0004;
    key.shadow.normalBias = 0.02;
    scene.add(key);

    const fill = new THREE.DirectionalLight(0x9fb6ff, 0.35);
    fill.position.set(-16, 12, -10);
    scene.add(fill);
  }

  private buildGround() {
    const size = this.half * 2;
    // Slightly raised plate so it reads as a diorama sitting on a table.
    const plate = new THREE.Mesh(
      new THREE.BoxGeometry(size + 3, 2, size + 3),
      toyMaterial(0x8a6f4a),
    );
    plate.position.y = -1;
    plate.receiveShadow = true;
    this.group.add(plate);

    const ground = new THREE.Mesh(
      new THREE.BoxGeometry(size, 0.4, size),
      toyMaterial(WORLD.groundColor),
    );
    ground.position.y = 0.0;
    ground.receiveShadow = true;
    this.group.add(ground);

    // A few flat color patches for visual texture (moss/paths), no gameplay role.
    const patchMat = toyMaterial(0xc3b787);
    for (let i = 0; i < 6; i++) {
      const w = 4 + Math.random() * 7;
      const h = 4 + Math.random() * 7;
      const patch = new THREE.Mesh(new THREE.BoxGeometry(w, 0.42, h), patchMat);
      patch.position.set(
        (Math.random() * 2 - 1) * (this.half - 5),
        0.01,
        (Math.random() * 2 - 1) * (this.half - 5),
      );
      patch.receiveShadow = true;
      this.group.add(patch);
    }
  }

  private buildWalls() {
    const size = this.half * 2;
    const t = 1.2; // wall thickness
    const hgt = 2.2;
    const mat = toyMaterial(COLORS.wall);
    const topMat = toyMaterial(COLORS.wallTop);

    const make = (w: number, d: number, x: number, z: number) => {
      const wall = new THREE.Mesh(new THREE.BoxGeometry(w, hgt, d), mat);
      wall.position.set(x, hgt / 2, z);
      wall.castShadow = true;
      wall.receiveShadow = true;
      this.group.add(wall);
      // little cap on top for a friendly storybook silhouette
      const cap = new THREE.Mesh(new THREE.BoxGeometry(w + 0.3, 0.3, d + 0.3), topMat);
      cap.position.set(x, hgt + 0.15, z);
      cap.castShadow = true;
      this.group.add(cap);
    };

    const e = this.half;
    make(size + t * 2, t, 0, -e); // north
    make(size + t * 2, t, 0, e); // south
    make(t, size, -e, 0); // west
    make(t, size, e, 0); // east
  }

  private buildProps() {
    // Decorative chunky tombstones + stumps. Purely cosmetic in the prototype.
    const stone = toyMaterial(0xb9b2a4);
    const wood = toyMaterial(COLORS.prop);
    for (let i = 0; i < 14; i++) {
      const isStone = Math.random() < 0.6;
      const x = (Math.random() * 2 - 1) * (this.half - 4);
      const z = (Math.random() * 2 - 1) * (this.half - 4);
      // Keep the center clear-ish for the player spawn.
      if (Math.abs(x) < 4 && Math.abs(z) < 4) continue;

      let mesh: THREE.Mesh;
      if (isStone) {
        mesh = new THREE.Mesh(new THREE.BoxGeometry(1.1, 1.6, 0.4), stone);
        mesh.position.set(x, 0.8, z);
        mesh.rotation.y = Math.random() * Math.PI;
        mesh.rotation.z = (Math.random() - 0.5) * 0.18;
      } else {
        mesh = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.8, 8), wood);
        mesh.position.set(x, 0.4, z);
      }
      mesh.castShadow = true;
      mesh.receiveShadow = true;
      this.group.add(mesh);
    }
  }

  /** Clamp a position to stay inside the walls (with a margin for the radius). */
  clamp(pos: THREE.Vector3, radius: number) {
    const lim = this.half - 1 - radius;
    pos.x = Math.max(-lim, Math.min(lim, pos.x));
    pos.z = Math.max(-lim, Math.min(lim, pos.z));
  }

  /** A random point just inside a wall, where zombies enter the arena. */
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
