import * as THREE from "three";
import { voxelMaterial, glowMaterial } from "../palette";
import { TdMap } from "./tdmap";
import { TdEnemies, type TdSpawnSpec } from "./tdenemy";
import { TD_PADS } from "./tdpath";
import {
  TD_TOWERS, towerStats, tdUpgradeCost, tdSellValue, pickTarget,
  TD_TARGET_MODES, type TdTowerId, type TdTargetMode, type TdTargetable, type TdTowerDef,
} from "./tdtowers";
import { buildWave, spawnInterval, waveClearBonus, TD_START_GOLD, TD_START_LIVES, TD_TOTAL_WAVES } from "./tdwaves";
import {
  duelInit, duelSend, duelPlayerLeak, duelEndWave, duelUnlockedSends,
  type DuelState,
} from "./tdduel";

export type TdGameMode = "solo" | "duel";

/** A built turret occupying one pad. */
interface Tower {
  pad: number; id: TdTowerId; tier: number; target: TdTargetMode;
  def: TdTowerDef; pos: THREE.Vector3; cooldown: number;
  group: THREE.Group; barrel: THREE.Group;
}
interface Tracer { mesh: THREE.Mesh; life: number }

const BUILD_REACH = 4;
const NEXT_WAVE_DELAY = 10;     // auto-start the next wave after this many seconds
const EARLY_CALL_RATE = 2;      // bonus gold per second skipped when calling early
const TRACER_LIFE = 0.12;
const _a = new THREE.Vector3();

/**
 * Tower-Defense controller, Solo + 1v1 Duel.
 *
 * Solo: survive TD_TOTAL_WAVES; lives lost on leaks. Duel: you + an AI bot each
 * defend a lane against the same shared waves; you spend gold to SEND creeps at
 * the bot (which permanently grows your income), leaks chip base HP, first to 0
 * loses. The bot's lane is simulated in tdduel; only yours is rendered.
 *
 * main drives it: enter(mode) / tick() / build/upgrade/sell/cycleTarget / send /
 * startNextWave / leave, keeping the player (the engineer), camera and input.
 */
export class TdMode {
  private map: TdMap;
  private creeps: TdEnemies;
  private towers = new Map<number, Tower>(); // keyed by pad index
  private fx = new THREE.Group();
  private tracers: Tracer[] = [];
  private ring: THREE.Mesh;                    // range preview around the nearest tower

  mode: TdGameMode = "solo";
  private duel?: DuelState;
  private duelDifficulty = 0.5;
  private pendingBotSends: TdSpawnSpec[] = [];

  // solo economy
  private soloGold = TD_START_GOLD;
  private soloLives = TD_START_LIVES;

  wave = 0;
  private spawnQueue: TdSpawnSpec[] = [];
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
    this.ring = new THREE.Mesh(
      new THREE.TorusGeometry(1, 0.12, 6, 40),
      new THREE.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.35, depthWrite: false }),
    );
    this.ring.rotation.x = Math.PI / 2;
    this.ring.visible = false;
    this.fx.add(this.ring);
  }

  spawn(): THREE.Vector3 { return new THREE.Vector3(0, 0, 0); }
  clamp(pos: THREE.Vector3) {
    pos.x = Math.max(-34, Math.min(34, pos.x));
    pos.z = Math.max(-26, Math.min(30, pos.z));
    pos.y = 0;
  }

  // ---- gold helpers (solo bank vs duel state) ----
  get gold(): number { return this.mode === "duel" && this.duel ? this.duel.playerGold : this.soloGold; }
  private addGold(n: number) { if (this.mode === "duel" && this.duel) this.duel.playerGold += n; else this.soloGold += n; }
  private spendGold(n: number) { this.addGold(-n); }

  enter(mode: TdGameMode = "solo") {
    if (this.active) return;
    this.active = true;
    this.mode = mode;
    this.result = { over: false, win: false };
    this.map.setVisible(true);
    this.soloGold = TD_START_GOLD;
    this.soloLives = TD_START_LIVES;
    this.duel = mode === "duel" ? duelInit() : undefined;
    this.pendingBotSends = [];
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
    for (const t of this.towers.values()) { this.fx.remove(t.group); this.disposeGroup(t.group); }
    this.towers.clear();
    for (const tr of this.tracers) { this.fx.remove(tr.mesh); tr.mesh.geometry.dispose(); (tr.mesh.material as THREE.Material).dispose(); }
    this.tracers.length = 0;
    this.ring.visible = false;
    this.hud?.remove();
    this.hud = undefined;
  }

  // ---- pads / building ----
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
  towerAt(i: number): { id: TdTowerId; tier: number; target: TdTargetMode } | null {
    const t = this.towers.get(i);
    return t ? { id: t.id, tier: t.tier, target: t.target } : null;
  }

  build(pad: number, id: TdTowerId): boolean {
    if (this.towers.has(pad) || this.result.over) return false;
    const def = TD_TOWERS[id];
    if (this.gold < def.cost) return false;
    this.spendGold(def.cost);
    const p = TD_PADS[pad];
    const pos = new THREE.Vector3(p.x, 0, p.z);
    const group = this.makeTurret(id, 1);
    group.position.copy(pos).setY(0.6);
    this.fx.add(group);
    const barrel = group.getObjectByName("barrel") as THREE.Group;
    this.towers.set(pad, { pad, id, tier: 1, target: def.defaultTarget, def, pos, cooldown: 0, group, barrel });
    this.refreshHud();
    return true;
  }
  upgrade(pad: number): boolean {
    const t = this.towers.get(pad);
    if (!t || this.result.over) return false;
    const cost = tdUpgradeCost(t.id, t.tier);
    if (cost == null || this.gold < cost) return false;
    this.spendGold(cost);
    t.tier++;
    t.group.scale.setScalar(1 + (t.tier - 1) * 0.14);
    this.refreshHud();
    return true;
  }
  sell(pad: number): boolean {
    const t = this.towers.get(pad);
    if (!t) return false;
    this.addGold(tdSellValue(t.id, t.tier));
    this.fx.remove(t.group);
    this.disposeGroup(t.group);
    this.towers.delete(pad);
    this.refreshHud();
    return true;
  }
  /** Cycle a tower's target priority (First→Last→Strong→Close). */
  cycleTarget(pad: number): boolean {
    const t = this.towers.get(pad);
    if (!t) return false;
    const i = TD_TARGET_MODES.indexOf(t.target);
    t.target = TD_TARGET_MODES[(i + 1) % TD_TARGET_MODES.length];
    this.refreshHud();
    return true;
  }

  // ---- duel sends ----
  /** Unlocked send ids for the prompt (duel only). */
  unlockedSendIds(): string[] {
    return this.mode === "duel" && this.duel ? duelUnlockedSends(this.duel).map((s) => s.id) : [];
  }
  /** Spend gold to send creeps at the bot (raises your income). Returns success. */
  send(id: string): boolean {
    if (this.mode !== "duel" || !this.duel) return false;
    return duelSend(this.duel, id);
  }

  // ---- waves ----
  get isBetweenWaves(): boolean { return this.betweenWaves; }
  /** Bonus gold you'd get for calling the next wave RIGHT NOW (early-call). */
  earlyCallBonus(): number {
    return this.betweenWaves ? Math.round(EARLY_CALL_RATE * Math.max(0, this.nextWaveIn)) : 0;
  }
  startNextWave() {
    if (!this.betweenWaves || this.result.over) return;
    this.addGold(this.earlyCallBonus()); // reward calling early
    if (this.mode === "duel" && this.duel) {
      this.wave = this.duel.wave;
      this.spawnQueue = buildWave(this.wave).concat(this.pendingBotSends);
      this.pendingBotSends = [];
    } else {
      this.wave++;
      this.spawnQueue = buildWave(this.wave);
    }
    this.spawnTimer = 0;
    this.betweenWaves = false;
    this.refreshHud();
  }

  tick(dt: number, playerPos?: THREE.Vector3) {
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

    // advance creeps; bank kills, take leaks
    const res = this.creeps.update(dt);
    for (const b of res.bounties) this.addGold(b);
    if (res.leaked > 0) {
      this.map.flashBase(0.4);
      if (this.mode === "duel" && this.duel) {
        duelPlayerLeak(this.duel, res.leakedDamage);
        if (this.duel.over) this.result = { over: true, win: this.duel.win };
      } else {
        this.soloLives -= res.leaked;
        if (this.soloLives <= 0) { this.soloLives = 0; this.result = { over: true, win: false }; }
      }
    }

    // detectors reveal camo creeps before towers pick targets
    for (const t of this.towers.values()) {
      if (t.def.detect) this.creeps.revealZone(t.pos, towerStats(t.id, t.tier).range);
    }

    this.fireTowers(dt);
    this.updateTracers(dt);
    if (playerPos) this.updateRing(playerPos);

    // wave cleared?
    if (!this.betweenWaves && this.spawnQueue.length === 0 && this.creeps.count === 0) {
      if (this.mode === "duel" && this.duel) {
        this.pendingBotSends = duelEndWave(this.duel, this.duelDifficulty);
        if (this.duel.over) this.result = { over: true, win: this.duel.win };
        else { this.betweenWaves = true; this.nextWaveIn = NEXT_WAVE_DELAY; }
      } else {
        this.addGold(waveClearBonus(this.wave));
        if (this.wave >= TD_TOTAL_WAVES) this.result = { over: true, win: true };
        else { this.betweenWaves = true; this.nextWaveIn = NEXT_WAVE_DELAY; }
      }
    }

    this.refreshHud();
  }

  // ---- tower firing ----
  private fireTowers(dt: number) {
    if (this.towers.size === 0) return;
    const view = this.creeps.enemies();
    // adapt to the targeting shape (camo gated by reveal)
    const targets: TdTargetable[] = view.map((e) => ({
      id: e.id, pos: { x: e.pos.x, z: e.pos.z }, dist: e.dist, hp: e.hp,
      alive: e.alive, targetable: !e.camo || e.revealed,
    }));
    for (const t of this.towers.values()) {
      t.cooldown -= dt;
      const st = towerStats(t.id, t.tier);
      const tid = pickTarget(t.pos.x, t.pos.z, st.range, targets, t.target);
      if (tid < 0) continue;
      const tgt = view.find((e) => e.id === tid);
      if (!tgt) continue;
      t.barrel.rotation.y = Math.atan2(tgt.pos.x - t.pos.x, tgt.pos.z - t.pos.z);
      if (t.cooldown > 0) continue;
      t.cooldown = 1 / st.fireRate;
      if (st.splash > 0) this.creeps.damageNear(tgt.pos, st.splash, st.damage, t.def.pierce);
      else this.creeps.damage(tid, st.damage, t.def.pierce);
      if (st.slow > 0) this.creeps.applySlow(tid, st.slow, st.slowTime);
      this.spawnTracer(t.pos, tgt.pos, t.def.color);
    }
  }

  // ---- visuals ----
  private updateRing(playerPos: THREE.Vector3) {
    const pad = this.nearestPad(playerPos);
    const t = pad >= 0 ? this.towers.get(pad) : undefined;
    if (t) {
      const r = towerStats(t.id, t.tier).range;
      this.ring.position.set(t.pos.x, 0.4, t.pos.z);
      this.ring.scale.set(r, r, 1);
      (this.ring.material as THREE.MeshBasicMaterial).color.setHex(t.def.color);
      this.ring.visible = true;
    } else {
      this.ring.visible = false;
    }
  }

  /**
   * A distinct voxel turret model per archetype (the rotating weapon lives in a
   * child group named "barrel" that aims at the target; the pedestal stays put):
   *   arrow  — wooden post + a rotating crossbow with a glowing bolt
   *   frost  — icy plinth ringed by crystals + a spinning frost orb
   *   pylon  — tech pole + a tilted radar dish & glowing scanner lens
   *   cannon — wide stone fort + a fat angled mortar barrel + muzzle ring
   *   sniper — tall watchtower w/ peaked roof + a long scoped rifle
   */
  private makeTurret(id: TdTowerId, tier: number): THREE.Group {
    const accent = TD_TOWERS[id].color;
    const stone = 0x6b7079, stoneDark = 0x4e535b, wood = 0x6b4a2b, woodDark = 0x4a3320, metal = 0x33363d;
    const g = new THREE.Group();
    const barrel = new THREE.Group(); barrel.name = "barrel";
    const box = (w: number, h: number, d: number, color: number, x: number, y: number, z: number) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), voxelMaterial(color));
      m.position.set(x, y, z); m.castShadow = true; return m;
    };
    const glow = (w: number, h: number, d: number, color: number, x: number, y: number, z: number, i = 0.9) => {
      const m = new THREE.Mesh(new THREE.BoxGeometry(w, h, d), glowMaterial(color, i));
      m.position.set(x, y, z); return m;
    };

    if (id === "arrow") {
      g.add(box(1.5, 0.4, 1.5, stone, 0, -0.4, 0));
      g.add(box(0.6, 1.1, 0.6, wood, 0, 0.25, 0));
      barrel.add(box(0.26, 0.26, 1.1, wood, 0, 0, 0.35));          // stock
      const lL = box(0.16, 0.16, 0.95, woodDark, 0, 0, 0.6); lL.rotation.y = 0.55;
      const lR = box(0.16, 0.16, 0.95, woodDark, 0, 0, 0.6); lR.rotation.y = -0.55;
      barrel.add(lL, lR);                                           // crossbow limbs
      barrel.add(glow(0.16, 0.16, 0.55, accent, 0, 0, 0.95, 1.1));  // glowing bolt
      barrel.position.y = 0.95;
    } else if (id === "frost") {
      g.add(box(1.5, 0.4, 1.5, stoneDark, 0, -0.4, 0));
      g.add(box(1.0, 0.5, 1.0, 0x9fc7e8, 0, 0.0, 0));
      for (const [cx, cz, s] of [[-0.32, -0.2, 1.0], [0.32, -0.1, 1.4], [0.0, 0.32, 1.15]] as const) {
        const cr = new THREE.Mesh(new THREE.OctahedronGeometry(0.26, 0), glowMaterial(0x9fe0ff, 0.65));
        cr.scale.set(1, s, 1); cr.position.set(cx, 0.45 + s * 0.25, cz); g.add(cr);
      }
      const orb = new THREE.Mesh(new THREE.OctahedronGeometry(0.34, 0), glowMaterial(accent, 1.15));
      orb.position.z = 0.15; barrel.add(orb);
      barrel.add(glow(0.5, 0.12, 0.12, accent, 0, 0, 0.55, 0.8));
      barrel.position.y = 1.05;
    } else if (id === "pylon") {
      g.add(box(1.4, 0.4, 1.4, metal, 0, -0.4, 0));
      g.add(box(0.45, 1.5, 0.45, stoneDark, 0, 0.45, 0));
      const dish = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.45, 10, 1, true), glowMaterial(accent, 0.45));
      dish.rotation.x = Math.PI * 0.5 - 0.45; dish.position.z = 0.32; dish.position.y = 0.05;
      barrel.add(dish);
      barrel.add(glow(0.22, 0.22, 0.22, accent, 0, 0.08, 0.5, 1.3)); // scanner lens
      barrel.add(box(0.06, 0.55, 0.06, metal, 0, 0.4, 0));            // antenna
      barrel.position.y = 1.3;
    } else if (id === "cannon") {
      g.add(box(1.8, 0.5, 1.8, stone, 0, -0.35, 0));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(0.36, 0.6, 0.36, stoneDark, sx * 0.72, 0.1, sz * 0.72));
      g.add(box(1.05, 0.7, 1.05, stoneDark, 0, 0.25, 0));
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 1.3, 10), voxelMaterial(metal));
      tube.rotation.x = Math.PI / 2 - 0.22; tube.position.set(0, 0.2, 0.55); tube.castShadow = true;
      barrel.add(tube);
      barrel.add(glow(0.52, 0.52, 0.22, accent, 0, 0.42, 1.05, 0.8)); // muzzle ring
      barrel.position.y = 0.75;
    } else { // sniper
      g.add(box(1.2, 0.4, 1.2, stone, 0, -0.4, 0));
      g.add(box(0.85, 1.7, 0.85, stoneDark, 0, 0.65, 0));
      g.add(box(1.05, 0.3, 1.05, wood, 0, 1.55, 0));
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.88, 0.75, 4), voxelMaterial(accent));
      roof.position.y = 2.1; roof.rotation.y = Math.PI / 4; roof.castShadow = true; g.add(roof);
      barrel.add(box(0.14, 0.14, 1.9, metal, 0, 0, 0.75));            // long rifle barrel
      barrel.add(box(0.22, 0.22, 0.42, stoneDark, 0, 0.14, 0.05));    // scope
      barrel.add(glow(0.12, 0.12, 0.2, accent, 0, 0, 1.65, 1.3));     // muzzle glow
      barrel.position.y = 1.6;
    }

    g.add(barrel);
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
      if (tr.life <= 0) { this.fx.remove(tr.mesh); tr.mesh.geometry.dispose(); m.dispose(); this.tracers.splice(i, 1); }
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

  // ---- HUD ----
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
      ? (this.result.win ? "🏆 Victory!" : "💀 Defeat")
      : this.betweenWaves
        ? `⏳ Wave ${(this.mode === "duel" && this.duel ? this.duel.wave : this.wave + 1)} — Space (+${this.earlyCallBonus()}g)`
        : `🌊 Wave ${this.wave}${this.mode === "duel" ? "" : "/" + TD_TOTAL_WAVES}`;
    if (this.mode === "duel" && this.duel) {
      const d = this.duel;
      this.hud.innerHTML =
        `<span class="td-r td-lives">❤ ${Math.ceil(d.playerHp)}</span>` +
        `<span class="td-r td-bot">🤖 ${Math.ceil(d.botHp)}</span>` +
        `<span class="td-r td-gold">🪙 ${Math.floor(d.playerGold)}</span>` +
        `<span class="td-r td-income">📈 ${Math.round(d.playerIncome)}/wave</span>` +
        `<span class="td-r td-wave">${phase}</span>`;
    } else {
      this.hud.innerHTML =
        `<span class="td-r td-gold">🪙 ${Math.floor(this.soloGold)}</span>` +
        `<span class="td-r td-lives">❤ ${this.soloLives}</span>` +
        `<span class="td-r td-wave">${phase}</span>`;
    }
  }
}
