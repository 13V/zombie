import * as THREE from "three";

/**
 * Pooled expanding shockwave rings for explosions (detonate-on-kill, explosive
 * rounds, bombers, nukes). A flat ring on the ground that scales up and fades.
 * Hard-capped + pooled so chaotic chains can't spawn unbounded meshes.
 */
const MAX_LIVE = 40;

interface Ring {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  radius: number;
}

export class Explosions {
  private pool: Ring[] = [];
  private active: Ring[] = [];
  // Unit ring (inner 0.6, outer 1.0) scaled per-explosion; shared geometry.
  private geo = new THREE.RingGeometry(0.6, 1.0, 24);

  constructor(private scene: THREE.Scene) {}

  /** Spawn a shockwave at (pos) expanding to ~`radius`, tinted `color`. */
  burst(pos: THREE.Vector3, radius: number, color: number) {
    if (this.active.length >= MAX_LIVE) {
      const old = this.active.shift();
      if (old) this.retire(old);
    }
    let r = this.pool.pop();
    if (!r) {
      const mat = new THREE.MeshBasicMaterial({
        color,
        transparent: true,
        opacity: 0.9,
        depthWrite: false,
        depthTest: false,
        side: THREE.DoubleSide,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      const mesh = new THREE.Mesh(this.geo, mat);
      mesh.rotation.x = -Math.PI / 2; // lie flat on the ground
      r = { mesh, life: 0, maxLife: 0, radius: 1 };
    }
    (r.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    (r.mesh.material as THREE.MeshBasicMaterial).opacity = 0.9;
    r.mesh.position.set(pos.x, 0.12, pos.z);
    r.mesh.scale.setScalar(0.3);
    r.radius = radius;
    r.life = r.maxLife = 0.35;
    r.mesh.visible = true;
    this.scene.add(r.mesh);
    this.active.push(r);
  }

  update(dt: number) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const r = this.active[i];
      r.life -= dt;
      const k = 1 - r.life / r.maxLife; // 0..1
      r.mesh.scale.setScalar(0.3 + k * r.radius);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = Math.max(0, 0.9 * (1 - k));
      if (r.life <= 0) {
        this.retire(r);
        this.active.splice(i, 1);
      }
    }
  }

  private retire(r: Ring) {
    r.mesh.visible = false;
    this.scene.remove(r.mesh);
    this.pool.push(r);
  }

  clear() {
    for (const r of this.active) this.retire(r);
    this.active.length = 0;
  }
}
