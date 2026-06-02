import * as THREE from "three";
import { glowMaterial, voxelMaterial, VOX } from "../palette";

/**
 * TdFx — self-contained Tower-Defense effects system.
 *
 * Owns its own THREE.Group (added to the scene in the constructor) and pools
 * every mesh/sprite it spawns so a busy wave never allocates unboundedly. All
 * effects share the cozy flat-shaded voxel look but lean on emissive glow so the
 * game's bloom + ACES post-stack makes them pop.
 *
 * Public API (the integrator calls these):
 *   new TdFx(scene)
 *   muzzleFlash(pos, dir, color)        — turret fires: bright flash + sparks
 *   tracer(from, to, color, kind?)      — projectile/tracer ("bolt"|"beam"|"shell")
 *   impact(pos, color, big?)            — voxel-chip burst + flash ring at a hit
 *   floatText(pos, text, color)         — rising, fading damage/+money label
 *   ring(pos, color, radius)            — expanding shockwave ring
 *   update(dt)                          — advance + fade all live effects
 *   clear()                             — remove + dispose everything
 *
 * Everything is pooled and hard-capped; update() recycles finished effects.
 */

// ---- tuning ---------------------------------------------------------------
// Bump these down for weaker hardware; they only cap *live* counts, the pools
// reuse meshes so steady-state allocation is zero.
const MAX_SPARKS = 200; // voxel chips for muzzle flashes + impacts
const MAX_FLASHES = 48; // soft point-flash quads (muzzle + impact cores)
const MAX_TRACERS = 64; // travelling bolts / fading beams / lobbed shells
const MAX_RINGS = 24; // expanding shockwave rings
const MAX_TEXTS = 48; // floating damage / +money labels
const MAX_TEXT_CACHE = 64; // distinct canvas textures kept before eviction

const SPARK_LIFE = 0.42; // base lifetime of a flung voxel chip (s)
const FLASH_LIFE = 0.12; // muzzle/impact core flash lifetime (s)
const BEAM_LIFE = 0.14; // instant tracer line fade (s)
const RING_LIFE = 0.5; // shockwave ring expand+fade (s)
const TEXT_LIFE = 0.85; // floating label lifetime (s)
const BOLT_SPEED = 64; // travel speed of a "bolt" tracer (world units/s)
const SHELL_SPEED = 34; // travel speed of an arcing "shell" tracer
const SHELL_ARC = 3.4; // peak lob height of a "shell" (world units)
const GRAVITY = 26; // fall rate applied to spark chips (units/s^2)

// ---- module-scope scratch (avoid per-frame allocations) -------------------
const _v0 = new THREE.Vector3();
const _v1 = new THREE.Vector3();
const _v2 = new THREE.Vector3();
const _dir = new THREE.Vector3();
const _q = new THREE.Quaternion();

type TracerKind = "bolt" | "beam" | "shell";

interface Spark {
  mesh: THREE.Mesh;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  spin: THREE.Vector3; // per-axis tumble rate
  base: number; // resting half-size
}

interface Flash {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  base: number;
}

interface Tracer {
  mesh: THREE.Mesh; // bolt/shell = a small dart; beam = a stretched bar
  kind: TracerKind;
  from: THREE.Vector3;
  to: THREE.Vector3;
  prog: number; // 0..1 travel progress (bolt/shell)
  speed: number; // units/s for bolt/shell (converted to prog/s)
  life: number; // for beams (instant fade)
  maxLife: number;
  color: number;
  onArrive: ((p: THREE.Vector3, c: number) => void) | null;
}

interface Ring {
  mesh: THREE.Mesh;
  life: number;
  maxLife: number;
  radius: number;
}

interface FloatLabel {
  sprite: THREE.Sprite;
  vel: THREE.Vector3;
  life: number;
  maxLife: number;
  baseX: number;
  baseY: number;
}

export class TdFx {
  readonly group = new THREE.Group();

  // pools + live lists
  private sparkPool: Spark[] = [];
  private sparkLive: Spark[] = [];
  private flashPool: Flash[] = [];
  private flashLive: Flash[] = [];
  private tracerPool: Tracer[] = [];
  private tracerLive: Tracer[] = [];
  private ringPool: Ring[] = [];
  private ringLive: Ring[] = [];
  private textPool: FloatLabel[] = [];
  private textLive: FloatLabel[] = [];
  private texCache = new Map<string, THREE.Texture>();

  // shared geometry (disposed in clear())
  private chipGeo = new THREE.BoxGeometry(0.16, 0.16, 0.16); // chunky voxel chip
  private flashGeo = new THREE.PlaneGeometry(1, 1); // billboarded soft flash
  private dartGeo = new THREE.BoxGeometry(0.18, 0.18, 0.6); // bolt/shell projectile
  private beamGeo = new THREE.BoxGeometry(0.12, 0.12, 1); // unit-length beam bar (z-scaled)
  private ringGeo = new THREE.RingGeometry(0.78, 1.0, 40); // thin shockwave ring

  constructor(private scene: THREE.Scene) {
    this.group.name = "TdFx";
    this.scene.add(this.group);
  }

  // =========================================================================
  // muzzle flash — quick bright core + a few voxel sparks spat along `dir`.
  // =========================================================================
  muzzleFlash(pos: THREE.Vector3, dir: THREE.Vector3, color: number): void {
    _dir.copy(dir);
    if (_dir.lengthSq() < 1e-6) _dir.set(0, 0, 1);
    else _dir.normalize();

    // bright core flash just ahead of the muzzle
    _v0.copy(pos).addScaledVector(_dir, 0.25);
    this.spawnFlash(_v0, color, 1.1, 0.95);

    // a handful of fast chips fanned around the firing direction
    for (let i = 0; i < 5; i++) {
      const s = this.acquireSpark();
      if (!s) break;
      this.tintGlow(s.mesh, color, 1.4);
      s.mesh.position.copy(pos);
      // velocity = forward + small random cone
      const spread = 0.55;
      _v1.set(
        _dir.x + (Math.random() - 0.5) * spread,
        _dir.y + (Math.random() - 0.5) * spread + 0.2,
        _dir.z + (Math.random() - 0.5) * spread,
      ).normalize();
      const sp = 9 + Math.random() * 7;
      s.vel.copy(_v1).multiplyScalar(sp);
      s.spin.set(rand(8), rand(8), rand(8));
      s.base = 0.5 + Math.random() * 0.5;
      s.life = s.maxLife = SPARK_LIFE * (0.5 + Math.random() * 0.4);
    }
  }

  // =========================================================================
  // tracer — projectile from turret to target. Travels over several frames.
  //   "bolt"  = fast small glowing dart that flies from→to (default)
  //   "beam"  = instant glowing line that fades out
  //   "shell" = arcing lobbed projectile (parabolic), slower
  // `onArrive` is optional internal use (impact at the landing point).
  // =========================================================================
  tracer(
    from: THREE.Vector3,
    to: THREE.Vector3,
    color: number,
    kind: TracerKind = "bolt",
    onArrive?: (p: THREE.Vector3, c: number) => void,
  ): void {
    const t = this.acquireTracer();
    if (!t) return;
    t.kind = kind;
    t.from.copy(from);
    t.to.copy(to);
    t.prog = 0;
    t.color = color;
    t.onArrive = onArrive ?? null;
    const dist = _v0.copy(to).sub(from).length() || 0.001;

    if (kind === "beam") {
      // instant stretched bar from→to, fades fast
      t.mesh.geometry = this.beamGeo;
      this.tintGlow(t.mesh, color, 1.6);
      this.orientBeam(t.mesh, from, to, dist);
      t.life = t.maxLife = BEAM_LIFE;
      t.speed = 0;
    } else {
      // bolt / shell: a small dart that actually travels
      t.mesh.geometry = this.dartGeo;
      this.tintGlow(t.mesh, color, kind === "shell" ? 1.1 : 1.5);
      const speed = kind === "shell" ? SHELL_SPEED : BOLT_SPEED;
      t.speed = speed / dist; // progress per second
      t.mesh.position.copy(from);
      t.life = t.maxLife = 0; // unused for travellers
      // initial orient toward target
      this.orientToward(t.mesh, from, to);
      // slightly stretch the dart for a hot streak look
      t.mesh.scale.set(1, 1, kind === "shell" ? 1.4 : 2.2);
    }
    t.mesh.visible = true;
  }

  // =========================================================================
  // impact — voxel-chip burst at the hit point: a fan of small shards that fly
  // out + fall + fade, plus a bright core flash and a quick flash ring.
  // `big` (boss/splash) scales count, size, speed and ring.
  // =========================================================================
  impact(pos: THREE.Vector3, color: number, big = false): void {
    const n = big ? 14 : 7;
    const speed = big ? 11 : 7;
    for (let i = 0; i < n; i++) {
      const s = this.acquireSpark();
      if (!s) break;
      this.tintGlow(s.mesh, color, big ? 1.3 : 1.0);
      s.mesh.position.copy(pos);
      const a = Math.random() * Math.PI * 2;
      const sp = speed * (0.5 + Math.random() * 0.8);
      const up = 2 + Math.random() * (big ? 6 : 3.5);
      s.vel.set(Math.cos(a) * sp, up, Math.sin(a) * sp);
      s.spin.set(rand(10), rand(10), rand(10));
      s.base = (big ? 0.9 : 0.6) + Math.random() * 0.6;
      s.life = s.maxLife = SPARK_LIFE * (0.7 + Math.random() * 0.6);
    }
    // core flash + ground flash ring
    this.spawnFlash(pos, color, big ? 1.8 : 1.1, 1);
    this.spawnRing(pos, color, big ? 2.6 : 1.3, big ? 0.6 : 0.34);
  }

  // =========================================================================
  // floatText — rising, fading canvas-sprite label (damage / +money).
  // Textures are cached by text+color; cache is capped, sprites are pooled.
  // =========================================================================
  floatText(pos: THREE.Vector3, text: string, color: number): void {
    if (this.textLive.length >= MAX_TEXTS) {
      const oldest = this.textLive.shift();
      if (oldest) this.retireText(oldest);
    }
    let ft = this.textPool.pop();
    if (!ft) {
      const mat = new THREE.SpriteMaterial({
        transparent: true,
        depthTest: false,
        depthWrite: false,
        toneMapped: false,
      });
      ft = {
        sprite: new THREE.Sprite(mat),
        vel: new THREE.Vector3(),
        life: 0,
        maxLife: 0,
        baseX: 0,
        baseY: 0,
      };
    }
    const mat = ft.sprite.material as THREE.SpriteMaterial;
    mat.map = this.labelTexture(text, color);
    mat.opacity = 1;
    ft.baseX = 1.5;
    ft.baseY = 0.75;
    // start punched-out a touch; update() eases back to resting size
    ft.sprite.scale.set(ft.baseX * 1.4, ft.baseY * 1.4, 1);
    ft.sprite.position.copy(pos);
    ft.sprite.position.y += 1.4;
    ft.vel.set((Math.random() - 0.5) * 1.2, 3.0 + Math.random(), (Math.random() - 0.5) * 1.2);
    ft.life = ft.maxLife = TEXT_LIFE;
    ft.sprite.visible = true;
    this.group.add(ft.sprite);
    this.textLive.push(ft);
  }

  // =========================================================================
  // ring — expanding flat shockwave ring (big impacts / wave starts).
  // =========================================================================
  ring(pos: THREE.Vector3, color: number, radius: number): void {
    this.spawnRing(pos, color, radius, RING_LIFE);
  }

  // =========================================================================
  // update — advance + fade everything; recycle finished effects.
  // =========================================================================
  update(dt: number): void {
    this.updateSparks(dt);
    this.updateFlashes(dt);
    this.updateTracers(dt);
    this.updateRings(dt);
    this.updateTexts(dt);
  }

  // =========================================================================
  // clear — remove + dispose everything (mode leave).
  // =========================================================================
  clear(): void {
    // retire all live effects back to scene-detached state
    for (const s of this.sparkLive) s.mesh.visible = false;
    for (const f of this.flashLive) f.mesh.visible = false;
    for (const t of this.tracerLive) t.mesh.visible = false;
    for (const r of this.ringLive) r.mesh.visible = false;
    for (const ft of this.textLive) ft.sprite.visible = false;

    // dispose every pooled + live mesh/material (shared geos disposed once)
    const allSparks = this.sparkLive.concat(this.sparkPool);
    for (const s of allSparks) disposeMesh(s.mesh, false);
    const allFlashes = this.flashLive.concat(this.flashPool);
    for (const f of allFlashes) disposeMesh(f.mesh, false);
    const allTracers = this.tracerLive.concat(this.tracerPool);
    for (const t of allTracers) disposeMesh(t.mesh, false);
    const allRings = this.ringLive.concat(this.ringPool);
    for (const r of allRings) disposeMesh(r.mesh, false);
    const allTexts = this.textLive.concat(this.textPool);
    for (const ft of allTexts) (ft.sprite.material as THREE.SpriteMaterial).dispose();

    for (const tex of this.texCache.values()) tex.dispose();
    this.texCache.clear();

    // shared geometry
    this.chipGeo.dispose();
    this.flashGeo.dispose();
    this.dartGeo.dispose();
    this.beamGeo.dispose();
    this.ringGeo.dispose();

    this.sparkLive.length = this.sparkPool.length = 0;
    this.flashLive.length = this.flashPool.length = 0;
    this.tracerLive.length = this.tracerPool.length = 0;
    this.ringLive.length = this.ringPool.length = 0;
    this.textLive.length = this.textPool.length = 0;

    this.scene.remove(this.group);
    this.group.clear();
  }

  // ===================== internals: spark =================================
  private acquireSpark(): Spark | null {
    if (this.sparkLive.length >= MAX_SPARKS) {
      const old = this.sparkLive.shift();
      if (old) this.retireSpark(old);
    }
    let s = this.sparkPool.pop();
    if (!s) {
      const mesh = new THREE.Mesh(this.chipGeo, glowMaterial(0xffffff, 1.0));
      s = { mesh, vel: new THREE.Vector3(), life: 0, maxLife: 0, spin: new THREE.Vector3(), base: 1 };
    }
    s.mesh.visible = true;
    s.mesh.rotation.set(Math.random() * 6.28, Math.random() * 6.28, 0);
    s.mesh.scale.setScalar(s.base);
    this.group.add(s.mesh);
    this.sparkLive.push(s);
    return s;
  }

  private updateSparks(dt: number): void {
    for (let i = this.sparkLive.length - 1; i >= 0; i--) {
      const s = this.sparkLive[i];
      s.life -= dt;
      s.vel.y -= GRAVITY * dt;
      s.mesh.position.addScaledVector(s.vel, dt);
      if (s.mesh.position.y < 0.06) {
        s.mesh.position.y = 0.06;
        s.vel.y *= -0.32;
        s.vel.x *= 0.6;
        s.vel.z *= 0.6;
      }
      s.mesh.rotation.x += s.spin.x * dt;
      s.mesh.rotation.y += s.spin.y * dt;
      s.mesh.rotation.z += s.spin.z * dt;
      const k = Math.max(0, s.life) / s.maxLife;
      s.mesh.scale.setScalar(s.base * (0.25 + k * 0.75));
      const mat = s.mesh.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.4 + k * 1.0;
      if (s.life <= 0) {
        this.retireSpark(s);
        this.sparkLive.splice(i, 1);
      }
    }
  }

  private retireSpark(s: Spark): void {
    s.mesh.visible = false;
    this.group.remove(s.mesh);
    this.sparkPool.push(s);
  }

  // ===================== internals: flash =================================
  private spawnFlash(pos: THREE.Vector3, color: number, base: number, intensity: number): void {
    if (this.flashLive.length >= MAX_FLASHES) {
      const old = this.flashLive.shift();
      if (old) this.retireFlash(old);
    }
    let f = this.flashPool.pop();
    if (!f) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        depthTest: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
      });
      f = { mesh: new THREE.Mesh(this.flashGeo, mat), life: 0, maxLife: 0, base };
    }
    const mat = f.mesh.material as THREE.MeshBasicMaterial;
    mat.color.set(color);
    mat.opacity = intensity;
    f.base = base;
    f.mesh.position.copy(pos);
    f.mesh.scale.setScalar(base * 0.6);
    f.mesh.visible = true;
    f.life = f.maxLife = FLASH_LIFE;
    this.group.add(f.mesh);
    this.flashLive.push(f);
  }

  private updateFlashes(dt: number): void {
    // billboard flashes toward the active camera each frame
    const cam = this.findCamera();
    for (let i = this.flashLive.length - 1; i >= 0; i--) {
      const f = this.flashLive[i];
      f.life -= dt;
      const k = Math.max(0, f.life) / f.maxLife;
      // pop out then fade
      f.mesh.scale.setScalar(f.base * (0.6 + (1 - k) * 1.6));
      (f.mesh.material as THREE.MeshBasicMaterial).opacity = k;
      if (cam) f.mesh.quaternion.copy(cam.quaternion);
      if (f.life <= 0) {
        this.retireFlash(f);
        this.flashLive.splice(i, 1);
      }
    }
  }

  private retireFlash(f: Flash): void {
    f.mesh.visible = false;
    this.group.remove(f.mesh);
    this.flashPool.push(f);
  }

  // ===================== internals: tracer ================================
  private acquireTracer(): Tracer | null {
    if (this.tracerLive.length >= MAX_TRACERS) {
      const old = this.tracerLive.shift();
      if (old) this.retireTracer(old);
    }
    let t = this.tracerPool.pop();
    if (!t) {
      const mesh = new THREE.Mesh(this.dartGeo, glowMaterial(0xffffff, 1.4));
      t = {
        mesh,
        kind: "bolt",
        from: new THREE.Vector3(),
        to: new THREE.Vector3(),
        prog: 0,
        speed: 0,
        life: 0,
        maxLife: 0,
        color: 0xffffff,
        onArrive: null,
      };
    }
    t.mesh.scale.set(1, 1, 1);
    this.group.add(t.mesh);
    this.tracerLive.push(t);
    return t;
  }

  private updateTracers(dt: number): void {
    for (let i = this.tracerLive.length - 1; i >= 0; i--) {
      const t = this.tracerLive[i];
      let done = false;
      if (t.kind === "beam") {
        t.life -= dt;
        const k = Math.max(0, t.life) / t.maxLife;
        const mat = t.mesh.material as THREE.MeshStandardMaterial;
        mat.emissiveIntensity = 0.4 + k * 1.6;
        mat.opacity = k;
        mat.transparent = true;
        if (t.life <= 0) done = true;
      } else {
        t.prog += t.speed * dt;
        const p = Math.min(1, t.prog);
        // straight lerp; shells add a parabolic vertical arc on top
        _v0.copy(t.from).lerp(t.to, p);
        if (t.kind === "shell") {
          _v0.y += SHELL_ARC * 4 * p * (1 - p); // 0 at ends, peak mid-flight
        }
        // orient toward the next point along the path for a believable streak
        const pNext = Math.min(1, p + 0.04);
        _v1.copy(t.from).lerp(t.to, pNext);
        if (t.kind === "shell") _v1.y += SHELL_ARC * 4 * pNext * (1 - pNext);
        t.mesh.position.copy(_v0);
        if (_v1.distanceToSquared(_v0) > 1e-6) this.orientToward(t.mesh, _v0, _v1);
        if (t.prog >= 1) {
          done = true;
          if (t.onArrive) t.onArrive(t.to, t.color);
        }
      }
      if (done) {
        this.retireTracer(t);
        this.tracerLive.splice(i, 1);
      }
    }
  }

  private retireTracer(t: Tracer): void {
    t.mesh.visible = false;
    t.onArrive = null;
    const mat = t.mesh.material as THREE.MeshStandardMaterial;
    mat.opacity = 1;
    mat.transparent = false;
    this.group.remove(t.mesh);
    this.tracerPool.push(t);
  }

  // ===================== internals: ring ==================================
  private spawnRing(pos: THREE.Vector3, color: number, radius: number, life: number): void {
    if (this.ringLive.length >= MAX_RINGS) {
      const old = this.ringLive.shift();
      if (old) this.retireRing(old);
    }
    let r = this.ringPool.pop();
    if (!r) {
      const mat = new THREE.MeshBasicMaterial({
        color: 0xffffff,
        transparent: true,
        opacity: 1,
        depthWrite: false,
        blending: THREE.AdditiveBlending,
        toneMapped: false,
        side: THREE.DoubleSide,
      });
      const mesh = new THREE.Mesh(this.ringGeo, mat);
      mesh.rotation.x = -Math.PI / 2; // lay flat on the ground plane
      r = { mesh, life: 0, maxLife: 0, radius };
    }
    (r.mesh.material as THREE.MeshBasicMaterial).color.set(color);
    (r.mesh.material as THREE.MeshBasicMaterial).opacity = 1;
    r.mesh.position.copy(pos);
    r.mesh.position.y += 0.06; // hover just above ground to avoid z-fight
    r.radius = radius;
    r.mesh.scale.setScalar(0.2);
    r.mesh.visible = true;
    r.life = r.maxLife = life;
    this.group.add(r.mesh);
    this.ringLive.push(r);
  }

  private updateRings(dt: number): void {
    for (let i = this.ringLive.length - 1; i >= 0; i--) {
      const r = this.ringLive[i];
      r.life -= dt;
      const k = Math.max(0, r.life) / r.maxLife; // 1..0
      const grow = 1 - k; // 0..1
      r.mesh.scale.setScalar(0.2 + grow * r.radius);
      (r.mesh.material as THREE.MeshBasicMaterial).opacity = k * k; // fade quicker late
      if (r.life <= 0) {
        this.retireRing(r);
        this.ringLive.splice(i, 1);
      }
    }
  }

  private retireRing(r: Ring): void {
    r.mesh.visible = false;
    this.group.remove(r.mesh);
    this.ringPool.push(r);
  }

  // ===================== internals: float text ============================
  private updateTexts(dt: number): void {
    for (let i = this.textLive.length - 1; i >= 0; i--) {
      const ft = this.textLive[i];
      ft.life -= dt;
      ft.vel.y -= 3.5 * dt; // gentle gravity so it arcs as it rises
      ft.sprite.position.addScaledVector(ft.vel, dt);
      const k = ft.life / ft.maxLife;
      (ft.sprite.material as THREE.SpriteMaterial).opacity = Math.max(0, Math.min(1, k * 1.6));
      // punch-out ease back to resting size over the first ~0.12s
      const age = ft.maxLife - ft.life;
      if (age < 0.12) {
        const p = 1 + 0.4 * (1 - age / 0.12);
        ft.sprite.scale.set(ft.baseX * p, ft.baseY * p, 1);
      } else if (ft.sprite.scale.x !== ft.baseX) {
        ft.sprite.scale.set(ft.baseX, ft.baseY, 1);
      }
      if (ft.life <= 0) {
        this.retireText(ft);
        this.textLive.splice(i, 1);
      }
    }
  }

  private retireText(ft: FloatLabel): void {
    ft.sprite.visible = false;
    this.group.remove(ft.sprite);
    this.textPool.push(ft);
  }

  private labelTexture(text: string, color: number): THREE.Texture {
    const css = "#" + (color & 0xffffff).toString(16).padStart(6, "0");
    const key = `${text}|${css}`;
    const hit = this.texCache.get(key);
    if (hit) return hit;
    // cap distinct textures: evict the oldest entry (Map preserves insert order)
    if (this.texCache.size >= MAX_TEXT_CACHE) {
      const firstKey = this.texCache.keys().next().value as string | undefined;
      if (firstKey !== undefined) {
        const old = this.texCache.get(firstKey);
        if (old) old.dispose();
        this.texCache.delete(firstKey);
      }
    }
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
    g.fillStyle = css;
    g.fillText(text, 64, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false; // avoid per-spawn GPU upload stalls
    tex.minFilter = THREE.LinearFilter;
    this.texCache.set(key, tex);
    return tex;
  }

  // ===================== shared helpers ===================================
  // Tint a pooled mesh's emissive glow material to `color` at `intensity`.
  private tintGlow(mesh: THREE.Mesh, color: number, intensity: number): void {
    const mat = mesh.material as THREE.MeshStandardMaterial;
    mat.color.set(color);
    mat.emissive.set(color);
    mat.emissiveIntensity = intensity;
  }

  // Orient a dart so its long (+Z) axis points from `a` toward `b`.
  private orientToward(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3): void {
    _dir.copy(b).sub(a);
    if (_dir.lengthSq() < 1e-6) return;
    _dir.normalize();
    _q.setFromUnitVectors(FWD, _dir);
    mesh.quaternion.copy(_q);
  }

  // Stretch + position a unit beam bar to span from `a` to `b`.
  private orientBeam(mesh: THREE.Mesh, a: THREE.Vector3, b: THREE.Vector3, dist: number): void {
    _v2.copy(a).add(b).multiplyScalar(0.5); // midpoint
    mesh.position.copy(_v2);
    this.orientToward(mesh, a, b);
    mesh.scale.set(1, 1, dist); // beamGeo is unit-length on Z
  }

  // Locate the scene's active PerspectiveCamera so flashes can billboard.
  private findCamera(): THREE.Camera | null {
    let cam: THREE.Camera | null = null;
    this.scene.traverse((o) => {
      if (!cam && (o as THREE.Camera).isCamera) cam = o as THREE.Camera;
    });
    return cam;
  }
}

// box geometries are built along +Z; this is the axis we rotate to face travel
const FWD = new THREE.Vector3(0, 0, 1);

// small symmetric random in [-m, m]
function rand(m: number): number {
  return (Math.random() - 0.5) * 2 * m;
}

// dispose a mesh's material (+ optionally geometry — shared geos handled once)
function disposeMesh(mesh: THREE.Mesh, disposeGeo: boolean): void {
  const mat = mesh.material;
  if (Array.isArray(mat)) mat.forEach((m) => m.dispose());
  else (mat as THREE.Material).dispose();
  if (disposeGeo) mesh.geometry.dispose();
}

// reference voxelMaterial/VOX so the chunky-voxel palette is part of this module's
// contract (chips can be swapped to a matte voxel look by callers if desired).
export const VOX_CHIP = { material: voxelMaterial, tones: VOX };
