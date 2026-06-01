import * as THREE from "three";
import { voxelMaterial, glowMaterial } from "../palette";
import { TdMap } from "./tdmap";
import { TdEnemies } from "./tdenemy";
import { TD_PADS } from "./tdpath";
import { TD_TOWERS, towerStats, tdUpgradeCost, tdSellValue, pickTarget, type TdTowerId, type TdTargetable } from "./tdtowers";
import { buildWave, spawnInterval, TD_START_GOLD, TD_START_LIVES, TD_TOTAL_WAVES, TD_WAVE_CLEAR_BONUS } from "./tdwaves";

/** A built turret occupying one pad. */
interface Tower {
  pad: number; id: TdTowerId; tier: number;
  pos: THREE.Vector3; cooldown: number;
  group: THREE.Group; barrel: THREE.Group;
}
/** A fading shot tracer. */
interface Tracer { mesh: THREE.Mesh; life: number }

const BUILD_REACH = 4;        // how close the engineer must stand to a pad
const NEXT_WAVE_DELAY = 8;    // auto-start the next wave after this many seconds
const TRACER_LIFE = 0.12;
const _a = new THREE.Vector3();

/**
 * Tower-Defense controller. Owns the map, the creeps, the placed towers, the
 * gold/lives economy, and the wave state machine. main drives it:
 * enter() / tick() / build()/upgrade()/sell() / leave(), keeping the player
 * (the "engineer" you walk between pads), camera and input.
 */
export class TdMode {
  private map: TdMap;
  private creeps: TdEnemies;
  private towers = new Map<number, Tower>(); // keyed by pad index
  private fx = new THREE.Group();
  private tracers: Tracer[] = [];

  gold = TD_START_GOLD;
  lives = TD_START_LIVES;
  wave = 0;
  private spawnQueue: ReturnType<typeof buildWave> = [];
  private spawnTimer = 0;
  private betweenWaves = true;
  private nextWaveIn = NEXT_WAVE_DELAY;
  private active = false;
  private hud?: HTMLElement;

  result: { over: boolean; win: boolean } = { over: false, win: false };

  constructor(scene: THREE.Scene) {
    this.map = new TdMap(scene);
    this.creeps = new TdEnemies(scene);
    scene.add(this.fx);
  }

  spawn(): THREE.Vector3 { return new THREE.Vector3(0, 0, 0); } // engineer starts mid-field
  clamp(pos: THREE.Vector3) {
    pos.x = Math.max(-34, Math.min(34, pos.x));
    pos.z = Math.max(-26, Math.min(30, pos.z));
    pos.y = 0;
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.result = { over: false, win: false };
    this.map.setVisible(true);
    this.gold = TD_START_GOLD;
    this.lives = TD_START_LIVES;
    this.wave = 0;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.betweenWaves = true;
    this.nextWaveIn = NEXT_WAVE_DELAY;
    this.buildHud();
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.map.setVisible(false);
    this.creeps.clear();
    for (const t of this.towers.values()) this.fx.remove(t.group), this.disposeGroup(t.group);
    this.towers.clear();
    for (const tr of this.tracers) { this.fx.remove(tr.mesh); tr.mesh.geometry.dispose(); (tr.mesh.material as THREE.Material).dispose(); }
    this.tracers.length = 0;
    this.hud?.remove();
    this.hud = undefined;
  }

  // ── pads / building ─────────────────────────────────────────────────────
  /** Nearest pad index within build reach of `pos`, or -1. */
  nearestPad(pos: THREE.Vector3): number {
    let best = -1, bestD = BUILD_REACH * BUILD_REACH;
    for (let i = 0; i < TD_PADS.length; i++) {
      const dx = TD_PADS[i].x - pos.x, dz = TD_PADS[i].z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < bestD) { bestD = d; best = i; }
    }
    return best;
  }
  padOccupied(i: number): boolean { return this.towers.has(i); }
  towerAt(i: number): { id: TdTowerId; tier: number } | null {
    const t = this.towers.get(i);
    return t ? { id: t.id, tier: t.tier } : null;
  }

  build(pad: number, id: TdTowerId): boolean {
    if (this.towers.has(pad) || this.result.over) return false;
    const cost = TD_TOWERS[id].cost;
    if (this.gold < cost) return false;
    this.gold -= cost;
    const p = TD_PADS[pad];
    const pos = new THREE.Vector3(p.x, 0, p.z);
    const group = this.makeTurret(id, 1);
    group.position.copy(pos).setY(0.6);
    this.fx.add(group);
    const barrel = group.getObjectByName("barrel") as THREE.Group;
    this.towers.set(pad, { pad, id, tier: 1, pos, cooldown: 0, group, barrel });
    this.refreshHud();
    return true;
  }
  upgrade(pad: number): boolean {
    const t = this.towers.get(pad);
    if (!t || this.result.over) return false;
    const cost = tdUpgradeCost(t.id, t.tier);
    if (cost == null || this.gold < cost) return false;
    this.gold -= cost;
    t.tier++;
    // visibly bulk the turret up a notch
    const s = 1 + (t.tier - 1) * 0.14;
    t.group.scale.setScalar(s);
    this.refreshHud();
    return true;
  }
  sell(pad: number): boolean {
    const t = this.towers.get(pad);
    if (!t) return false;
    this.gold += tdSellValue(t.id, t.tier);
    this.fx.remove(t.group);
    this.disposeGroup(t.group);
    this.towers.delete(pad);
    this.refreshHud();
    return true;
  }

  // ── waves ───────────────────────────────────────────────────────────────
  get isBetweenWaves(): boolean { return this.betweenWaves; }
  /** Start the next wave early (player pressed the call key). */
  startNextWave() {
    if (!this.betweenWaves || this.result.over) return;
    this.wave++;
    this.spawnQueue = buildWave(this.wave);
    this.spawnTimer = 0;
    this.betweenWaves = false;
    this.refreshHud();
  }

  tick(dt: number, _playerPos?: THREE.Vector3) {
    if (!this.active || this.result.over) return;
    this.map.update(dt);

    // wave pacing
    if (this.betweenWaves) {
      this.nextWaveIn -= dt;
      if (this.nextWaveIn <= 0) this.startNextWave();
    } else {
      this.spawnTimer -= dt;
      if (this.spawnTimer <= 0 && this.spawnQueue.length) {
        this.creeps.spawn(this.spawnQueue.shift()!);
        this.spawnTimer = spawnInterval(this.wave);
      }
    }

    // advance creeps; bank kills, dock lives on leaks
    const res = this.creeps.update(dt);
    if (res.leaked > 0) {
      this.lives -= res.leaked;
      this.map.flashBase(0.4);
      if (this.lives <= 0) { this.lives = 0; this.result = { over: true, win: false }; }
    }
    for (const b of res.bounties) this.gold += b;

    // wave cleared?
    if (!this.betweenWaves && this.spawnQueue.length === 0 && this.creeps.count === 0) {
      this.gold += TD_WAVE_CLEAR_BONUS;
      if (this.wave >= TD_TOTAL_WAVES) this.result = { over: true, win: true };
      else { this.betweenWaves = true; this.nextWaveIn = NEXT_WAVE_DELAY; }
    }

    this.fireTowers(dt);
    this.updateTracers(dt);
    this.refreshHud();
  }

  // ── tower firing ──────────────────────────────────────────────────────────
  private fireTowers(dt: number) {
    if (this.towers.size === 0) return;
    const view = this.creeps.enemies();
    if (view.length === 0) { for (const t of this.towers.values()) t.cooldown = Math.max(0, t.cooldown - dt); return; }
    // adapt the creep snapshot to the targeting shape (x/z only)
    const targets: TdTargetable[] = view.map((e) => ({ id: e.id, pos: { x: e.pos.x, z: e.pos.z }, dist: e.dist, alive: e.alive }));
    for (const t of this.towers.values()) {
      t.cooldown -= dt;
      const st = towerStats(t.id, t.tier);
      const tid = pickTarget(t.pos.x, t.pos.z, st.range, targets);
      if (tid < 0) continue;
      const tgt = view.find((e) => e.id === tid);
      if (!tgt) continue;
      // always face the target
      t.barrel.rotation.y = Math.atan2(tgt.pos.x - t.pos.x, tgt.pos.z - t.pos.z);
      if (t.cooldown > 0) continue;
      t.cooldown = 1 / st.fireRate;
      // hit
      if (st.splash > 0) this.creeps.damageNear(tgt.pos, st.splash, st.damage);
      else this.creeps.damage(tid, st.damage);
      if (st.slow > 0) this.creeps.applySlow(tid, st.slow, st.slowTime);
      this.spawnTracer(t.pos, tgt.pos, TD_TOWERS[t.id].color);
    }
  }

  // ── visuals ─────────────────────────────────────────────────────────────
  private makeTurret(id: TdTowerId, tier: number): THREE.Group {
    const def = TD_TOWERS[id];
    const g = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.5, 1.5), voxelMaterial(0x6b7079));
    base.position.y = -0.35; base.castShadow = true;
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.0, 0.9, 1.0), voxelMaterial(def.color));
    body.position.y = 0.2; body.castShadow = true;
    const barrel = new THREE.Group();
    const tube = new THREE.Mesh(new THREE.BoxGeometry(0.32, 0.32, 1.1), voxelMaterial(0x2c2f36));
    tube.position.z = 0.7; tube.position.y = 0.25;
    const tip = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.42, 0.3), glowMaterial(def.color, 0.7));
    tip.position.z = 1.25; tip.position.y = 0.25;
    barrel.add(tube, tip);
    barrel.name = "barrel";
    g.add(base, body, barrel);
    g.scale.setScalar(1 + (tier - 1) * 0.14);
    return g;
  }

  private spawnTracer(from: THREE.Vector3, to: { x: number; z: number }, color: number) {
    _a.set(to.x - from.x, 0, to.z - from.z);
    const len = _a.length() || 0.01;
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.12, len), glowMaterial(color, 0.9));
    mesh.position.set((from.x + to.x) / 2, 0.85, (from.z + to.z) / 2);
    mesh.rotation.y = Math.atan2(_a.x, _a.z);
    (mesh.material as THREE.MeshStandardMaterial).transparent = true;
    this.fx.add(mesh);
    this.tracers.push({ mesh, life: TRACER_LIFE });
    if (this.tracers.length > 60) { const old = this.tracers.shift()!; this.fx.remove(old.mesh); old.mesh.geometry.dispose(); (old.mesh.material as THREE.Material).dispose(); }
  }
  private updateTracers(dt: number) {
    for (let i = this.tracers.length - 1; i >= 0; i--) {
      const tr = this.tracers[i];
      tr.life -= dt;
      const m = tr.mesh.material as THREE.MeshStandardMaterial;
      m.opacity = Math.max(0, tr.life / TRACER_LIFE);
      if (tr.life <= 0) {
        this.fx.remove(tr.mesh); tr.mesh.geometry.dispose(); m.dispose();
        this.tracers.splice(i, 1);
      }
    }
  }
  private disposeGroup(g: THREE.Object3D) {
    g.traverse((o) => {
      const m = o as THREE.Mesh;
      m.geometry?.dispose?.();
      const mat = m.material;
      if (Array.isArray(mat)) for (const x of mat) x.dispose();
      else (mat as THREE.Material | undefined)?.dispose?.();
    });
  }

  // ── HUD ───────────────────────────────────────────────────────────────────
  private buildHud() {
    if (this.hud) return;
    const el = document.createElement("div");
    el.id = "td-hud";
    (document.getElementById("ui") ?? document.body).appendChild(el);
    this.hud = el;
    this.refreshHud();
  }
  private refreshHud() {
    if (!this.hud) return;
    const phase = this.result.over
      ? (this.result.win ? "🏆 Cleared!" : "💀 Overrun")
      : this.betweenWaves
        ? `⏳ Wave ${this.wave + 1} in ${Math.ceil(this.nextWaveIn)}s`
        : `🌊 Wave ${this.wave}/${TD_TOTAL_WAVES}`;
    this.hud.innerHTML =
      `<span class="td-r td-gold">🪙 ${this.gold}</span>` +
      `<span class="td-r td-lives">❤ ${this.lives}</span>` +
      `<span class="td-r td-wave">${phase}</span>`;
  }
}
