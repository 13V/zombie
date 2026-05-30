import * as THREE from "three";

/**
 * Pooled floating combat text (damage numbers, "+points", crit pops). Each is a
 * canvas-textured sprite that rises and fades, then returns to the pool. Capped
 * so late-wave crowds can't spawn thousands and tank the framerate.
 */
const MAX_NUMBERS = 60;

interface FloatText {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
}

export class FloatingText {
  private pool: FloatText[] = [];
  private active: FloatText[] = [];
  // One reusable canvas/texture per distinct color avoids per-spawn texture churn.
  private cache = new Map<string, THREE.Texture>();

  constructor(private scene: THREE.Scene) {}

  private texture(text: string, color: string): THREE.Texture {
    const key = `${text}|${color}`;
    const hit = this.cache.get(key);
    if (hit) return hit;
    const c = document.createElement("canvas");
    c.width = 128;
    c.height = 64;
    const g = c.getContext("2d")!;
    g.font = "bold 40px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 6;
    g.strokeStyle = "rgba(0,0,0,0.85)";
    g.strokeText(text, 64, 32);
    g.fillStyle = color;
    g.fillText(text, 64, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    this.cache.set(key, tex);
    return tex;
  }

  /** Spawn rising text at a world position. */
  spawn(pos: THREE.Vector3, text: string, color: string, scale = 1, crit = false) {
    if (this.active.length >= MAX_NUMBERS) {
      // recycle the oldest rather than exceed the cap
      const oldest = this.active.shift();
      if (oldest) this.retire(oldest);
    }
    let ft = this.pool.pop();
    if (!ft) {
      const mat = new THREE.SpriteMaterial({ transparent: true, depthTest: false });
      const sprite = new THREE.Sprite(mat);
      ft = { sprite, vel: new THREE.Vector3(), life: 0, maxLife: 0 };
    }
    const mat = ft.sprite.material as THREE.SpriteMaterial;
    mat.map = this.texture(text, color);
    mat.opacity = 1;
    const s = (crit ? 1.5 : 1) * scale;
    ft.sprite.scale.set(1.4 * s, 0.7 * s, 1);
    ft.sprite.position.copy(pos);
    ft.sprite.position.y += 1.6;
    ft.vel.set((Math.random() - 0.5) * 1.2, 3.2 + Math.random(), (Math.random() - 0.5) * 1.2);
    ft.life = ft.maxLife = crit ? 1.0 : 0.75;
    ft.sprite.visible = true;
    this.scene.add(ft.sprite);
    this.active.push(ft);
  }

  private retire(ft: FloatText) {
    ft.sprite.visible = false;
    this.scene.remove(ft.sprite);
    this.pool.push(ft);
  }

  update(dt: number) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const ft = this.active[i];
      ft.life -= dt;
      ft.vel.y -= 4 * dt; // gentle gravity
      ft.sprite.position.addScaledVector(ft.vel, dt);
      const k = ft.life / ft.maxLife;
      (ft.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, Math.min(1, k * 1.5));
      if (ft.life <= 0) {
        this.retire(ft);
        this.active.splice(i, 1);
      }
    }
  }

  clear() {
    for (const ft of this.active) this.retire(ft);
    this.active.length = 0;
  }
}
