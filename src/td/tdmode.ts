import * as THREE from "three";
import { voxelMaterial, glowMaterial } from "../palette";
import { TdMap } from "./tdmap";
import { TdEnemies, type TdSpawnSpec } from "./tdenemy";
import { TD_PADS, TD_GOAL } from "./tdpath";
import {
  TD_TOWERS, TD_TOWER_IDS, towerStats, tdUpgradeCost, tdSellValue, pickTarget,
  TD_TARGET_MODES, type TdTowerId, type TdTargetMode, type TdTargetable, type TdTowerDef,
} from "./tdtowers";
import { buildWave, spawnInterval, waveClearBonus, TD_START_GOLD, TD_START_LIVES, TD_TOTAL_WAVES } from "./tdwaves";
import {
  duelInit, duelSend, duelPlayerLeak, duelEndWave, duelUnlockedSends, DUEL_MAX_HP,
  type DuelState,
} from "./tdduel";
import { TdFx } from "./tdfx";
import { TdHud, type TdHudState } from "./tdhud";
import { TdAudio } from "./tdaudio";
import type { TdDailyMods } from "./tddaily";

/** Entry options: endless keeps waves coming past TD_TOTAL_WAVES (score = wave
 *  reached); daily layers the day's seeded modifier on top of endless. */
export interface TdEnterOpts {
  endless?: boolean;
  daily?: TdDailyMods;
}

export type TdGameMode = "solo" | "duel";

/** A built turret occupying one pad. */
interface Tower {
  pad: number; id: TdTowerId; tier: number; target: TdTargetMode;
  def: TdTowerDef; pos: THREE.Vector3; cooldown: number;
  group: THREE.Group; barrel: THREE.Group;
  spin?: THREE.Object3D;   // orbiting energy ring (idle spin)
  spin2?: THREE.Object3D;  // inner counter-rotating ring
  scan?: THREE.Object3D;   // continuously spinning element (radar/etc.)
  core?: THREE.Object3D;   // pulsing energy core in the body
  muzzle?: THREE.Object3D; // glowing business-end (pulses + flashes on fire)
  sight?: THREE.Mesh;      // laser sight beam to the current target (world-space, in fx)
  aim: THREE.Vector3;      // current target world pos (when aiming)
  aiming: boolean;         // has a target this frame
  barrelY: number;         // rest Y of the barrel (for hover bob)
  deploy: number;          // 0..1 build/deploy animation progress
  recoil: number;          // 0..1 kickback decaying after a shot
  flash: number;           // 0..1 muzzle-flash decaying after a shot
  lastTarget: number;      // creep id locked last frame (for the acquire telegraph)
}

const BUILD_REACH = 4;
const TURRET_SCALE = 2.1;       // base turret size (they were dwarfed by the pads)
const NEXT_WAVE_DELAY = 10;     // auto-start the next wave after this many seconds
const EARLY_CALL_RATE = 2;      // bonus gold per second skipped when calling early

/** Spring-overshoot easing (0..1 → past 1 then settle) for the deploy pop. */
function easeOutBack(x: number): number {
  const c1 = 1.70158, c3 = c1 + 1;
  return 1 + c3 * Math.pow(x - 1, 3) + c1 * Math.pow(x - 1, 2);
}

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
  private scene: THREE.Scene;
  private fx = new THREE.Group();
  private vfx!: TdFx;                           // pooled muzzle/tracer/impact/text effects (per match)
  private ui?: TdHud;                           // build-palette + status HUD
  private ring: THREE.Mesh;                    // range preview around the nearest tower

  mode: TdGameMode = "solo";
  private duel?: DuelState;
  private duelDifficulty = 0.5;
  private pendingBotSends: TdSpawnSpec[] = [];

  // solo economy
  private soloGold = TD_START_GOLD;
  private soloLives = TD_START_LIVES;

  private audio = new TdAudio();
  private ghost?: THREE.Group;  // translucent build preview at the nearest empty pad
  wave = 0;
  /** Waves fully cleared this session (cross-mode daily-quest metric). */
  wavesCleared = 0;
  private opts: TdEnterOpts = {};
  private _tAnim = 0; // animation clock for turret idle motion
  private _shakeImpulse = 0; // camera shake to hand to main (consumed each frame)
  private _hitStop = 0;      // brief freeze request to hand to main (consumed each frame)
  private _ended = false;    // guards the one-shot win/lose sting
  private spawnQueue: TdSpawnSpec[] = [];
  private spawnTimer = 0;
  private betweenWaves = true;
  private nextWaveIn = NEXT_WAVE_DELAY;
  private active = false;

  result: { over: boolean; win: boolean } = { over: false, win: false };

  constructor(scene: THREE.Scene) {
    this.scene = scene;
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

  /** Layer the daily modifier (if any) onto a creep about to spawn. */
  private applyDailyMods(spec: TdSpawnSpec): TdSpawnSpec {
    const d = this.opts.daily;
    if (!d) return spec;
    return {
      ...spec,
      hp: Math.max(1, Math.round(spec.hp * d.hpMul)),
      speed: spec.speed * d.speedMul,
      bounty: Math.max(1, Math.round(spec.bounty * d.bountyMul)),
    };
  }

  /** Camera-shake impulse accrued since last frame (main applies + decays it). */
  consumeShake(): number { const s = this._shakeImpulse; this._shakeImpulse = 0; return s; }
  /** Base health fraction (0..1) for the shield dome. */
  private baseHealthFrac(): number {
    if (this.mode === "duel" && this.duel) return Math.max(0, this.duel.playerHp / DUEL_MAX_HP);
    return Math.max(0, this.soloLives / TD_START_LIVES);
  }

  enter(mode: TdGameMode = "solo", opts: TdEnterOpts = {}) {
    if (this.active) return;
    this.active = true;
    this.mode = mode;
    this.opts = opts;
    this.result = { over: false, win: false };
    this.map.setVisible(true);
    this.soloGold = Math.round(TD_START_GOLD * (opts.daily?.goldStartMul ?? 1));
    this.soloLives = TD_START_LIVES;
    this.duel = mode === "duel" ? duelInit() : undefined;
    this.pendingBotSends = [];
    this.wave = 0;
    this.wavesCleared = 0;
    this._ended = false;
    this.spawnQueue = [];
    this.spawnTimer = 0;
    this.betweenWaves = true;
    this.nextWaveIn = NEXT_WAVE_DELAY;
    this.vfx = new TdFx(this.scene);
    this.buildHud();
    this.ui?.banner(
      opts.daily ? `DAILY — ${opts.daily.name}` :
      mode === "duel" ? "1v1 DUEL" :
      opts.endless ? "ENDLESS" : "TOWER DEFENSE",
    );
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.map.setVisible(false);
    this.creeps.clear();
    for (const t of this.towers.values()) {
      this.fx.remove(t.group); this.disposeGroup(t.group);
      if (t.sight) { this.fx.remove(t.sight); t.sight.geometry.dispose(); (t.sight.material as THREE.Material).dispose(); }
    }
    this.towers.clear();
    this.vfx.clear();
    this.ring.visible = false;
    if (this.ghost) { this.fx.remove(this.ghost); this.disposeGroup(this.ghost); this.ghost = undefined; }
    this.map.setBossMood(false);
    this.ui?.destroy();
    this.ui = undefined;
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
    group.position.copy(pos).setY(this.turretY(1));
    this.fx.add(group);
    // a laser sight beam (world-space, lives in fx) that locks onto the target
    const sight = new THREE.Mesh(
      new THREE.BoxGeometry(0.05, 0.05, 1),
      glowMaterial(def.color, 1.2),
    );
    (sight.material as THREE.MeshStandardMaterial).transparent = true;
    sight.visible = false;
    this.fx.add(sight);
    const t: Tower = {
      pad, id, tier: 1, target: def.defaultTarget, def, pos, cooldown: 0, group,
      barrel: group.getObjectByName("barrel") as THREE.Group,
      sight, aim: new THREE.Vector3(), aiming: false, barrelY: 0, deploy: 0,
      recoil: 0, flash: 0, lastTarget: -1,
    };
    this.grabRefs(t, group);
    this.towers.set(pad, t);
    this.audio.build();
    this.refreshHud();
    return true;
  }
  /** Cache the animated child refs off a (re)built turret group. */
  private grabRefs(t: Tower, group: THREE.Group) {
    t.barrel = group.getObjectByName("barrel") as THREE.Group;
    t.spin = group.getObjectByName("spin") ?? undefined;
    t.spin2 = group.getObjectByName("spin2") ?? undefined;
    t.scan = group.getObjectByName("scan") ?? undefined;
    t.core = group.getObjectByName("core") ?? undefined;
    t.muzzle = group.getObjectByName("muzzle") ?? undefined;
    t.barrelY = t.barrel ? t.barrel.position.y : 0;
  }
  upgrade(pad: number): boolean {
    const t = this.towers.get(pad);
    if (!t || this.result.over) return false;
    const cost = tdUpgradeCost(t.id, t.tier);
    if (cost == null || this.gold < cost) return false;
    this.spendGold(cost);
    t.tier++;
    // rebuild the model so the tower visibly evolves (more shards, bigger weapon)
    this.fx.remove(t.group);
    this.disposeGroup(t.group);
    const ng = this.makeTurret(t.id, t.tier);
    ng.position.copy(t.pos).setY(this.turretY(t.tier));
    this.fx.add(ng);
    t.group = ng;
    this.grabRefs(t, ng);
    t.deploy = 0; // replay the deploy pop so the upgrade feels punchy
    if (t.sight) (t.sight.material as THREE.MeshStandardMaterial).color.setHex(t.def.color);
    this.audio.upgrade();
    this.refreshHud();
    return true;
  }
  sell(pad: number): boolean {
    const t = this.towers.get(pad);
    if (!t) return false;
    this.addGold(tdSellValue(t.id, t.tier));
    this.fx.remove(t.group);
    this.disposeGroup(t.group);
    if (t.sight) { this.fx.remove(t.sight); t.sight.geometry.dispose(); (t.sight.material as THREE.Material).dispose(); }
    this.towers.delete(pad);
    this.audio.sell();
    this.refreshHud();
    return true;
  }
  /** Brief hit-stop request (seconds) for main to apply, then reset. */
  consumeHitStop(): number { const s = this._hitStop; this._hitStop = 0; return s; }
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
    const boss = this.wave % 5 === 0;
    this.ui?.banner(boss ? `Wave ${this.wave} — BOSS` : `Wave ${this.wave}`);
    this.map.setBossMood(boss);   // ominous red haze on boss waves
    this.map.pulseSpawn();        // flare the spawn portal
    this.audio.waveStart(boss);
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
        this.creeps.spawn(this.applyDailyMods(this.spawnQueue.shift()!));
        this.spawnTimer = spawnInterval(this.wave);
      }
    }

    // advance creeps; bank kills, take leaks
    const res = this.creeps.update(dt);
    for (const b of res.bounties) this.addGold(b);
    if (res.leaked > 0) {
      this.map.flashBase(0.4);
      this.audio.leak();
      this._shakeImpulse = Math.min(0.5, this._shakeImpulse + 0.12 + res.leaked * 0.02);
      const dmg = this.mode === "duel" ? res.leakedDamage : res.leaked;
      this.vfx.floatText(new THREE.Vector3(TD_GOAL.x, 2.2, TD_GOAL.z), `-${dmg}`, 0xff5a4a);
      if (this.mode === "duel" && this.duel) {
        duelPlayerLeak(this.duel, res.leakedDamage);
        if (this.duel.over) this.result = { over: true, win: this.duel.win };
      } else {
        this.soloLives -= res.leaked;
        if (this.soloLives <= 0) { this.soloLives = 0; this.result = { over: true, win: false }; }
      }
    }
    this.map.setBaseHealth(this.baseHealthFrac());

    // detectors reveal camo creeps before towers pick targets
    for (const t of this.towers.values()) {
      if (t.def.detect) this.creeps.revealZone(t.pos, towerStats(t.id, t.tier).range);
    }

    this._tAnim += dt;
    this.fireTowers(dt);
    this.animateTowers(dt);
    this.vfx.update(dt);
    if (playerPos) { this.updateRing(playerPos); this.updateTowerPanel(playerPos); }

    // wave cleared?
    if (!this.betweenWaves && this.spawnQueue.length === 0 && this.creeps.count === 0) {
      this.map.setBossMood(false); // clear the boss haze once the wave is down
      this.wavesCleared++;
      if (this.mode === "duel" && this.duel) {
        this.pendingBotSends = duelEndWave(this.duel, this.duelDifficulty);
        if (this.duel.over) this.result = { over: true, win: this.duel.win };
        else { this.betweenWaves = true; this.nextWaveIn = NEXT_WAVE_DELAY; }
      } else {
        const bonus = waveClearBonus(this.wave);
        this.addGold(bonus);
        this.vfx.floatText(new THREE.Vector3(TD_GOAL.x, 3, TD_GOAL.z), `+${bonus}g`, 0xffd24a);
        // endless (and daily) runs never "win" — the score is the wave you fall on
        if (!this.opts.endless && this.wave >= TD_TOTAL_WAVES) this.result = { over: true, win: true };
        else { this.betweenWaves = true; this.nextWaveIn = NEXT_WAVE_DELAY; }
      }
    }

    // one-shot win/lose sting + clear any boss haze
    if (this.result.over && !this._ended) {
      this._ended = true;
      this.map.setBossMood(false);
      if (this.result.win) this.audio.win(); else this.audio.lose();
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
      t.aiming = false;
      const st = towerStats(t.id, t.tier);
      const tid = pickTarget(t.pos.x, t.pos.z, st.range, targets, t.target);
      if (tid < 0) continue;
      const tgt = view.find((e) => e.id === tid);
      if (!tgt) continue;
      t.barrel.rotation.y = Math.atan2(tgt.pos.x - t.pos.x, tgt.pos.z - t.pos.z);
      t.aiming = true;
      t.aim.set(tgt.pos.x, 0.7, tgt.pos.z); // for the laser sight
      // acquire telegraph: a quick lock-ring pops when a tower picks a NEW target
      if (tid !== t.lastTarget) {
        this.vfx.ring(new THREE.Vector3(tgt.pos.x, 0.6, tgt.pos.z), t.def.color, 1.1);
        t.lastTarget = tid;
      }
      if (t.cooldown > 0) continue;
      t.cooldown = 1 / st.fireRate;
      if (st.splash > 0) this.creeps.damageNear(tgt.pos, st.splash, st.damage, t.def.pierce);
      else this.creeps.damage(tid, st.damage, t.def.pierce);
      if (st.slow > 0) this.creeps.applySlow(tid, st.slow, st.slowTime);
      // VFX: muzzle flash at the barrel, a travelling shot, an impact on arrival
      const from = new THREE.Vector3(t.pos.x, 1.4, t.pos.z);
      const to = new THREE.Vector3(tgt.pos.x, 0.7, tgt.pos.z);
      const dir = new THREE.Vector3(tgt.pos.x - t.pos.x, 0, tgt.pos.z - t.pos.z).normalize();
      const kind = (t.id === "sniper" || t.id === "pylon") ? "beam" : t.id === "cannon" ? "shell" : "bolt";
      const big = st.splash > 0;
      this.vfx.muzzleFlash(from, dir, t.def.color);
      this.vfx.tracer(from, to, t.def.color, kind, (p, c) => { this.vfx.impact(p, c, big); this.audio.impact(big); });
      this.audio.fire(t.id);
      t.recoil = 1; t.flash = 1; // kick + muzzle glow
      if (t.id === "cannon") { // a heavy boom: shake + a sliver of hit-stop
        this._shakeImpulse = Math.min(0.5, this._shakeImpulse + 0.05);
        this._hitStop = Math.max(this._hitStop, 0.045);
      }
    }
  }

  /** Idle + firing life: a build/deploy pop, hovering weapon, counter-rotating
   *  energy rings, a spinning scanner, a pulsing core, recoil/flash, and a laser
   *  sight that locks onto the target. */
  private animateTowers(dt: number) {
    const tt = this._tAnim;
    for (const t of this.towers.values()) {
      // ---- deploy pop: spring up from the pad when built/upgraded ----
      if (t.deploy < 1) {
        t.deploy = Math.min(1, t.deploy + dt / 0.4);
        const e = easeOutBack(t.deploy);
        t.group.scale.setScalar(this.turretScale(t.tier) * e);
        t.group.position.y = this.turretY(t.tier) * (0.4 + 0.6 * t.deploy);
      }
      const charge = this.towerCharge(t);

      // ---- idle motion ----
      if (t.spin) {
        t.spin.rotation.y += dt * (1.0 + t.tier * 0.35);
        t.spin.position.y = 0.6 + Math.sin(tt * 1.6 + t.pad) * 0.08;
      }
      if (t.spin2) t.spin2.rotation.y -= dt * (1.6 + t.tier * 0.4); // counter-rotate
      if (t.scan) t.scan.rotation.y += dt * 2.6;                    // radar sweep
      // hover bob of the whole weapon (plus recoil along its aim axis)
      if (t.recoil > 0) t.recoil = Math.max(0, t.recoil - dt * 5);
      t.barrel.position.y = t.barrelY + Math.sin(tt * 2.0 + t.pad) * 0.06;
      t.barrel.position.z = -t.recoil * 0.32;

      // ---- pulsing energy core ----
      if (t.core) {
        const cm = (t.core as THREE.Mesh).material as THREE.MeshStandardMaterial;
        if (cm && cm.emissiveIntensity !== undefined) cm.emissiveIntensity = 0.7 + charge * 1.4 + Math.sin(tt * 4 + t.pad) * 0.3;
        t.core.rotation.y += dt * 1.4;
      }

      // ---- muzzle charge + flash ----
      if (t.muzzle) {
        const m = t.muzzle as THREE.Mesh;
        const mat = m.material as THREE.MeshStandardMaterial;
        if (t.flash > 0) t.flash = Math.max(0, t.flash - dt * 6);
        m.scale.setScalar(1 + t.flash * 1.4 + charge * 0.3);
        if (mat.emissiveIntensity !== undefined) mat.emissiveIntensity = 0.6 + charge * 1.3 + t.flash * 2.6 + Math.sin(tt * 3 + t.pad) * 0.2;
      }

      // ---- laser sight beam to the locked target ----
      if (t.sight) {
        if (t.aiming) {
          const fx = t.pos.x, fz = t.pos.z, fy = 1.5;
          const dx = t.aim.x - fx, dz = t.aim.z - fz, dy = t.aim.y - fy;
          const len = Math.hypot(dx, dy, dz) || 0.01;
          t.sight.position.set(fx + dx / 2, fy + dy / 2, fz + dz / 2);
          t.sight.scale.set(1, 1, len);
          t.sight.lookAt(t.aim);
          const sm = t.sight.material as THREE.MeshStandardMaterial;
          // sniper paints a bold beam; others just a faint targeting thread
          sm.opacity = (t.id === "sniper" ? 0.55 : 0.22) + charge * 0.25;
          t.sight.visible = true;
        } else if (t.sight.visible) {
          t.sight.visible = false;
        }
      }
    }
  }

  /** 0..1 charge toward the tower's next shot (drives core/muzzle brightness). */
  private towerCharge(t: Tower): number {
    const interval = 1 / towerStats(t.id, t.tier).fireRate;
    return interval > 0 ? Math.max(0, Math.min(1, 1 - t.cooldown / interval)) : 1;
  }

  // ---- visuals ----
  private updateRing(playerPos: THREE.Vector3) {
    const pad = this.nearestPad(playerPos);
    const t = pad >= 0 ? this.towers.get(pad) : undefined;
    if (t) {
      // standing at an owned tower → show its real range
      const r = towerStats(t.id, t.tier).range;
      this.ring.position.set(t.pos.x, 0.4, t.pos.z);
      this.ring.scale.set(r, r, 1);
      (this.ring.material as THREE.MeshBasicMaterial).color.setHex(t.def.color);
      this.ring.visible = true;
      this.hideGhost();
    } else if (pad >= 0) {
      // standing at an EMPTY pad → build preview: green range ring + a ghost turret
      const p = TD_PADS[pad];
      const r = TD_TOWERS.arrow.range;
      this.ring.position.set(p.x, 0.4, p.z);
      this.ring.scale.set(r, r, 1);
      (this.ring.material as THREE.MeshBasicMaterial).color.setHex(0x9fffb0);
      this.ring.visible = true;
      this.showGhost(p.x, p.z);
    } else {
      this.ring.visible = false;
      this.hideGhost();
    }
  }
  private showGhost(x: number, z: number) {
    if (!this.ghost) {
      this.ghost = new THREE.Group();
      const mat = () => new THREE.MeshStandardMaterial({ color: 0x9fffb0, emissive: 0x4fd06a, emissiveIntensity: 0.5, transparent: true, opacity: 0.32, depthWrite: false, toneMapped: false });
      const base = new THREE.Mesh(new THREE.CylinderGeometry(1.0, 1.3, 0.5, 8), mat()); base.position.y = 0.25;
      const body = new THREE.Mesh(new THREE.BoxGeometry(1.4, 1.4, 1.4), mat()); body.position.y = 1.3;
      const tip = new THREE.Mesh(new THREE.OctahedronGeometry(0.4, 0), mat()); tip.position.y = 2.3;
      this.ghost.add(base, body, tip);
      this.fx.add(this.ghost);
    }
    this.ghost.position.set(x, 0.4 + Math.sin(this._tAnim * 3) * 0.1, z);
    this.ghost.rotation.y = this._tAnim * 0.8;
    this.ghost.visible = true;
  }
  private hideGhost() { if (this.ghost) this.ghost.visible = false; }

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
      { const mz = glow(0.16, 0.16, 0.55, accent, 0, 0, 0.95, 1.1); mz.name = "muzzle"; barrel.add(mz); } // glowing bolt
      if (tier >= 3) { // beefier double-limb crossbow
        const l2L = box(0.16, 0.16, 0.8, woodDark, 0, -0.22, 0.5); l2L.rotation.y = 0.45;
        const l2R = box(0.16, 0.16, 0.8, woodDark, 0, -0.22, 0.5); l2R.rotation.y = -0.45;
        barrel.add(l2L, l2R, glow(0.13, 0.13, 0.45, accent, 0, -0.22, 0.85, 1.0));
      }
      if (tier >= 2) { // a quiver of arrows on the post
        g.add(box(0.3, 0.6, 0.3, woodDark, 0.5, 0.7, -0.2));
        for (const ax of [-0.06, 0.06, 0.18]) g.add(glow(0.05, 0.5, 0.05, accent, 0.5 + ax, 1.1, -0.2, 0.7));
      }
      barrel.position.y = 0.95;
    } else if (id === "frost") {
      g.add(box(1.5, 0.4, 1.5, stoneDark, 0, -0.4, 0));
      g.add(box(1.0, 0.5, 1.0, 0x9fc7e8, 0, 0.0, 0));
      for (const [cx, cz, s] of [[-0.32, -0.2, 1.0], [0.32, -0.1, 1.4], [0.0, 0.32, 1.15]] as const) {
        const cr = new THREE.Mesh(new THREE.OctahedronGeometry(0.26, 0), glowMaterial(0x9fe0ff, 0.65));
        cr.scale.set(1, s, 1); cr.position.set(cx, 0.45 + s * 0.25, cz); g.add(cr);
      }
      const orb = new THREE.Mesh(new THREE.OctahedronGeometry(0.34 + (tier - 1) * 0.06, 0), glowMaterial(accent, 1.15));
      orb.position.z = 0.15; orb.name = "muzzle"; barrel.add(orb);
      barrel.add(glow(0.5, 0.12, 0.12, accent, 0, 0, 0.55, 0.8));
      if (tier >= 2) { // a thicker crown of crystals
        for (const [cx, cz, s] of [[-0.5, 0.1, 1.3], [0.5, 0.2, 1.5], [0.1, -0.45, 1.2], [-0.15, 0.5, 1.4]] as const) {
          const cr = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), glowMaterial(0x9fe0ff, 0.7));
          cr.scale.set(1, s, 1); cr.position.set(cx, 0.4 + s * 0.25, cz); g.add(cr);
        }
      }
      if (tier >= 3) { // a frosty halo ring above the orb
        const halo = new THREE.Mesh(new THREE.TorusGeometry(0.55, 0.06, 6, 22), glowMaterial(0xc7f0ff, 1.0));
        halo.rotation.x = Math.PI / 2; halo.position.y = 0.35; barrel.add(halo);
      }
      barrel.position.y = 1.05;
    } else if (id === "pylon") {
      g.add(box(1.4, 0.4, 1.4, metal, 0, -0.4, 0));
      g.add(box(0.45, 1.5, 0.45, stoneDark, 0, 0.45, 0));
      // a continuously-spinning radar sweep bar (independent of aim)
      const scan = new THREE.Group(); scan.name = "scan"; scan.position.y = 1.45;
      scan.add(glow(0.1, 0.04, 1.1, accent, 0, 0, 0.45, 1.0));
      g.add(scan);
      const dish = new THREE.Mesh(new THREE.ConeGeometry(0.62, 0.45, 10, 1, true), glowMaterial(accent, 0.45));
      dish.rotation.x = Math.PI * 0.5 - 0.45; dish.position.z = 0.32; dish.position.y = 0.05;
      barrel.add(dish);
      { const mz = glow(0.22, 0.22, 0.22, accent, 0, 0.08, 0.5, 1.3); mz.name = "muzzle"; barrel.add(mz); } // scanner lens
      barrel.add(box(0.06, 0.55, 0.06, metal, 0, 0.4, 0));            // antenna
      if (tier >= 2) { // a second smaller dish stacked above
        const d2 = new THREE.Mesh(new THREE.ConeGeometry(0.4, 0.3, 8, 1, true), glowMaterial(accent, 0.45));
        d2.rotation.x = Math.PI * 0.5 - 0.45; d2.position.set(0, 0.55, 0.22); barrel.add(d2);
      }
      if (tier >= 3) { // bristling antenna array + blinking tips
        for (const ax of [-0.28, 0.28]) {
          barrel.add(box(0.05, 0.65, 0.05, metal, ax, 0.45, -0.1));
          barrel.add(glow(0.1, 0.1, 0.1, accent, ax, 0.8, -0.1, 1.2));
        }
      }
      barrel.position.y = 1.3;
    } else if (id === "cannon") {
      g.add(box(1.8, 0.5, 1.8, stone, 0, -0.35, 0));
      for (const sx of [-1, 1]) for (const sz of [-1, 1]) g.add(box(0.36, 0.6, 0.36, stoneDark, sx * 0.72, 0.1, sz * 0.72));
      g.add(box(1.05, 0.7, 1.05, stoneDark, 0, 0.25, 0));
      const tube = new THREE.Mesh(new THREE.CylinderGeometry(0.34, 0.42, 1.3, 10), voxelMaterial(metal));
      tube.rotation.x = Math.PI / 2 - 0.22; tube.position.set(0, 0.2, 0.55); tube.castShadow = true;
      barrel.add(tube);
      { const mz = glow(0.52, 0.52, 0.22, accent, 0, 0.42, 1.05, 0.8); mz.name = "muzzle"; barrel.add(mz); } // muzzle ring
      if (tier >= 3) { // twin barrels
        for (const ox of [-0.34, 0.34]) {
          const t2 = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.28, 1.1, 8), voxelMaterial(metal));
          t2.rotation.x = Math.PI / 2 - 0.22; t2.position.set(ox, 0.05, 0.5); t2.castShadow = true; barrel.add(t2);
        }
      }
      if (tier >= 2) { // bolted side armor plates
        for (const sx of [-1, 1]) g.add(box(0.2, 0.7, 1.1, metal, sx * 0.62, 0.3, 0));
      }
      barrel.position.y = 0.75;
    } else { // sniper
      g.add(box(1.2, 0.4, 1.2, stone, 0, -0.4, 0));
      g.add(box(0.85, 1.7, 0.85, stoneDark, 0, 0.65, 0));
      g.add(box(1.05, 0.3, 1.05, wood, 0, 1.55, 0));
      const roof = new THREE.Mesh(new THREE.ConeGeometry(0.88, 0.75, 4), voxelMaterial(accent));
      roof.position.y = 2.1; roof.rotation.y = Math.PI / 4; roof.castShadow = true; g.add(roof);
      const barrelLen = 1.9 + (tier - 1) * 0.5; // rifle grows longer per tier
      barrel.add(box(0.14, 0.14, barrelLen, metal, 0, 0, barrelLen / 2 - 0.2));
      barrel.add(box(0.22, 0.22, 0.42, stoneDark, 0, 0.14, 0.05));    // scope
      { const mz = glow(0.12, 0.12, 0.2, accent, 0, 0, barrelLen - 0.25, 1.3); mz.name = "muzzle"; barrel.add(mz); } // muzzle glow
      if (tier >= 3) { // a steadying bipod under the long barrel
        for (const sx of [-1, 1]) { const leg = box(0.06, 0.7, 0.06, metal, sx * 0.18, -0.35, 0.9); leg.rotation.z = sx * 0.3; barrel.add(leg); }
      }
      if (tier >= 2) { // a banner down the tower
        const banner = new THREE.Mesh(new THREE.BoxGeometry(0.5, 1.0, 0.08), glowMaterial(accent, 0.4));
        banner.position.set(0, 0.7, 0.46); g.add(banner);
      }
      barrel.position.y = 1.6;
    }

    g.add(barrel);

    // ---- shared flourishes (life + an upgrade tell) ----
    // a glowing rune ring grounding the turret (matches the build pads)
    const rune = new THREE.Mesh(new THREE.TorusGeometry(0.95, 0.07, 6, 24), glowMaterial(accent, 0.5));
    rune.rotation.x = Math.PI / 2; rune.position.y = -0.18;
    g.add(rune);
    // orbiting energy shards — MORE + faster per tier (so upgrades read at a glance)
    const spin = new THREE.Group(); spin.name = "spin"; spin.position.y = 0.6;
    const shards = 2 + tier; // 3 / 4 / 5
    for (let k = 0; k < shards; k++) {
      const a = (k / shards) * Math.PI * 2;
      const sh = new THREE.Mesh(new THREE.OctahedronGeometry(0.1 + tier * 0.02, 0), glowMaterial(accent, 1.0));
      sh.position.set(Math.cos(a) * 1.0, 0, Math.sin(a) * 1.0);
      spin.add(sh);
    }
    g.add(spin);
    // an inner counter-rotating ring (tighter, glows brighter) for extra life
    const spin2 = new THREE.Group(); spin2.name = "spin2"; spin2.position.y = 0.9;
    const inner = 2 + tier;
    for (let k = 0; k < inner; k++) {
      const a = (k / inner) * Math.PI * 2 + 0.5;
      const sh = new THREE.Mesh(new THREE.OctahedronGeometry(0.08, 0), glowMaterial(0xffffff, 1.2));
      sh.position.set(Math.cos(a) * 0.6, 0, Math.sin(a) * 0.6);
      spin2.add(sh);
    }
    g.add(spin2);
    // a pulsing energy CORE floating in the turret body
    const core = new THREE.Mesh(new THREE.OctahedronGeometry(0.22, 0), glowMaterial(accent, 1.0));
    core.name = "core"; core.position.y = 0.55; core.scale.y = 1.4;
    g.add(core);
    // tier crown: a floating gem above tier-2/3 turrets
    if (tier >= 2) {
      const crown = new THREE.Mesh(new THREE.OctahedronGeometry(0.16 + (tier - 2) * 0.08, 0), glowMaterial(0xfff2c0, 1.3));
      crown.position.y = (id === "sniper" ? 2.7 : id === "pylon" ? 2.1 : 1.7);
      g.add(crown);
    }

    g.scale.setScalar(this.turretScale(tier));
    return g;
  }

  /** Overall turret scale at a tier (base size + a small per-tier bump). */
  private turretScale(tier: number): number {
    return TURRET_SCALE * (1 + (tier - 1) * 0.1);
  }
  /** Y to seat a turret so its base rests on the pad at the given tier. */
  private turretY(tier: number): number {
    return 0.6 * this.turretScale(tier);
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
    if (this.ui) return;
    this.ui = new TdHud(document.getElementById("ui") ?? document.body);
    this.ui.setTowers(TD_TOWER_IDS.map((id, i) => ({
      name: TD_TOWERS[id].name, cost: TD_TOWERS[id].cost, key: String(i + 1), color: TD_TOWERS[id].color,
    })));
    this.refreshHud();
  }
  /** Build the per-frame HUD state snapshot. */
  private hudState(): TdHudState {
    if (this.mode === "duel" && this.duel) {
      const d = this.duel;
      return {
        mode: "duel", gold: Math.floor(d.playerGold), wave: this.wave || d.wave,
        betweenWaves: this.betweenWaves, earlyCallBonus: this.earlyCallBonus(),
        playerHp: d.playerHp, botHp: d.botHp, income: Math.round(d.playerIncome),
        over: this.result.over, win: this.result.win,
      };
    }
    return {
      mode: "solo", gold: Math.floor(this.soloGold), wave: this.wave,
      totalWaves: this.opts.endless ? undefined : TD_TOTAL_WAVES, // endless shows a bare wave count
      betweenWaves: this.betweenWaves, earlyCallBonus: this.earlyCallBonus(), lives: this.soloLives,
      over: this.result.over, win: this.result.win,
    };
  }
  private refreshHud() {
    this.ui?.update(this.hudState());
  }
  /** Drive the bottom panel: show an owned tower's upgrade/sell/target info when
   *  the engineer stands at it, else the build palette. Called from tick. */
  private updateTowerPanel(playerPos: THREE.Vector3) {
    if (!this.ui) return;
    const pad = this.nearestPad(playerPos);
    const t = pad >= 0 ? this.towers.get(pad) : undefined;
    if (t) {
      this.ui.showTowerPanel({
        name: t.def.name, tier: t.tier, target: t.target,
        upgradeCost: tdUpgradeCost(t.id, t.tier), sellValue: tdSellValue(t.id, t.tier),
      });
    } else {
      this.ui.showTowerPanel(null);
    }
  }
}
