import * as THREE from "three";
import { BedWarsMap, type BwTeamId } from "./bwmap";
import { makeGenerator, tickGenerator, emptyWallet, addToWallet, type BwGenerator, type BwWallet } from "./bwresources";
import { createMatch, breakBed, updateMatch, type BwMatch } from "./bwteams";
import { BwBots } from "./bwbots";
import { BwShopUI } from "./bwshopui";
import { bwBuy, bwCanAfford, type BwShopItem } from "./bwshop";

interface Bed { team: BwTeamId; pos: THREE.Vector3; color: number; hp: number; max: number; dead: boolean; group: THREE.Group }

const WAVE_START = 7;      // seconds between raider waves at the start
const WAVE_MIN = 2.4;      // floor
const WAVE_RAMP = 0.985;   // interval *= this each wave
const MAX_RAIDERS = 10;
const BED_HP = 120;

/**
 * Bed Wars-lite controller (solo vs bots). Owns the world, beds (with HP), the
 * raider bots, the resource generators + wallet, the shop UI, and the win loop.
 * main drives it: enter() / tick() / resolveHit() / leave(), keeping the player,
 * camera, input and bullets.
 *
 * Loop: defend YOUR bed from raider waves while you shoot your way to the enemy
 * beds and destroy them. All enemy beds gone = win; your bed destroyed = loss.
 */
export class BedWarsMode {
  private map: BedWarsMap;
  private match: BwMatch;
  private beds = new Map<BwTeamId, Bed>();
  private bots: BwBots;
  private gens: { team: BwTeamId; gen: BwGenerator }[] = [];
  wallet: BwWallet = emptyWallet();
  readonly playerTeam: BwTeamId = "red";
  private active = false;
  private hud?: HTMLElement;
  private shop?: BwShopUI;
  private waveTimer = WAVE_START;
  private waveInterval = WAVE_START;
  /** Set when the match ends; main reads it to show win/lose + leave. */
  result: { over: boolean; win: boolean } = { over: false, win: false };

  constructor(scene: THREE.Scene) {
    this.map = new BedWarsMap(scene);
    this.match = createMatch([]);
    this.bots = new BwBots(scene);
  }

  spawn(): THREE.Vector3 {
    const t = this.map.teams.find((x) => x.id === this.playerTeam) ?? this.map.teams[0];
    return t.base.clone();
  }
  /** Where the Shop pad sits (the player's base) — main shows a prompt near it. */
  shopSpot(): THREE.Vector3 { return this.spawn(); }
  get shopOpen(): boolean { return !!this.shop?.isOpen; }

  clamp(pos: THREE.Vector3) {
    const max = 33;
    pos.x = Math.max(-max, Math.min(max, pos.x));
    pos.z = Math.max(-max, Math.min(max, pos.z));
    pos.y = 0;
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.result = { over: false, win: false };
    this.map.setVisible(true);
    this.beds.clear();
    for (const t of this.map.teams) {
      const group = this.map.makeBed(t.color);
      group.position.copy(t.bed);
      this.map.group.add(group);
      this.beds.set(t.id, { team: t.id, pos: t.bed.clone(), color: t.color, hp: BED_HP, max: BED_HP, dead: false, group });
    }
    this.gens = this.map.teams.map((t) => ({ team: t.id, gen: makeGenerator(`${t.id}-iron`, "iron") }));
    this.gens.push({ team: this.playerTeam, gen: makeGenerator(`${this.playerTeam}-gold`, "gold") });
    this.gens.push({ team: this.playerTeam, gen: makeGenerator("center-emerald", "emerald") });
    this.match = createMatch(this.map.teams.map((t, i) => ({ id: i + 1, team: t.id, bot: t.id !== this.playerTeam })));
    this.wallet = emptyWallet();
    this.waveInterval = WAVE_START;
    this.waveTimer = WAVE_START;
    if (!this.shop) this.shop = new BwShopUI(document.getElementById("ui") ?? document.body);
    this.buildHud();
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.map.setVisible(false);
    for (const b of this.beds.values()) this.map.group.remove(b.group);
    this.beds.clear();
    this.bots.clear();
    this.shop?.close();
    this.hud?.remove();
    this.hud = undefined;
  }

  /** Alive enemy beds (for the player's bullets to target). */
  private enemyBeds(): Bed[] {
    return [...this.beds.values()].filter((b) => b.team !== this.playerTeam && !b.dead);
  }

  /** A bullet impacted at `pos` with `dmg` — damage a raider or an enemy bed.
   *  Returns "bot" | "bed" | null so main can retire the bullet + spark. */
  resolveHit(pos: THREE.Vector3, dmg: number): "bot" | "bed" | null {
    // raiders first (tight radius)
    for (const r of this.bots.positions()) {
      const dx = r.pos.x - pos.x, dz = r.pos.z - pos.z;
      if (dx * dx + dz * dz < 0.9 * 0.9) { this.bots.damageNear(pos, 0.9, dmg); return "bot"; }
    }
    // then enemy beds
    for (const b of this.enemyBeds()) {
      const dx = b.pos.x - pos.x, dz = b.pos.z - pos.z;
      if (dx * dx + dz * dz < 1.7 * 1.7) { this.damageBed(b.team, dmg); return "bed"; }
    }
    return null;
  }

  private damageBed(team: BwTeamId, dmg: number) {
    const b = this.beds.get(team);
    if (!b || b.dead) return;
    b.hp -= dmg;
    if (b.hp <= 0) {
      b.dead = true;
      this.map.group.remove(b.group);
      breakBed(this.match, team);
      updateMatch(this.match);
      this.checkEnd();
    }
  }

  private checkEnd() {
    if (this.result.over) return;
    const mine = this.beds.get(this.playerTeam);
    if (mine?.dead) this.result = { over: true, win: false };
    else if (this.enemyBeds().length === 0) this.result = { over: true, win: true };
  }

  tick(dt: number) {
    if (!this.active || this.result.over) return;
    this.map.update(dt);
    for (const g of this.gens) {
      const drops = tickGenerator(g.gen, dt, 0);
      if (g.team === this.playerTeam) for (const d of drops) this.wallet = addToWallet(this.wallet, d.kind, d.amount);
    }
    this.bots.update(dt);
    // raider waves target the player's bed, from a random alive enemy base
    this.waveTimer -= dt;
    const myBed = this.beds.get(this.playerTeam);
    if (this.waveTimer <= 0 && myBed && !myBed.dead && this.bots.count < MAX_RAIDERS) {
      this.waveTimer = this.waveInterval;
      this.waveInterval = Math.max(WAVE_MIN, this.waveInterval * WAVE_RAMP);
      const foes = this.enemyBeds();
      if (foes.length) {
        const foe = foes[Math.floor(Math.random() * foes.length)];
        const target = { pos: myBed.pos, alive: () => !myBed.dead, onHit: (d: number) => this.damageBed(this.playerTeam, d) };
        const from = foe.pos.clone().multiplyScalar(1.15); // just outside the enemy island
        this.bots.spawn(this.beds.get(foe.team)!.color, from, target);
      }
    }
    this.refreshHud();
  }

  // ---- shop ----
  openShop() {
    if (!this.shop || this.shop.isOpen || this.result.over) return;
    this.shop.open(this.wallet, (item) => this.buy(item), () => { /* closed */ });
  }
  private buy(item: BwShopItem) {
    if (!bwCanAfford(this.wallet, item)) return;
    this.wallet = bwBuy(this.wallet, item);
    this.applyEffect(item);
    this.shop?.refresh(this.wallet);
    this.refreshHud();
  }
  /** Slice effects that touch the core loop; cosmetic ones just confirm. */
  private applyEffect(item: BwShopItem) {
    const k = item.effect.kind;
    if (k === "block") {
      const b = this.beds.get(this.playerTeam);
      if (b && !b.dead) { b.max += item.effect.value ?? 20; b.hp = Math.min(b.max, b.hp + (item.effect.value ?? 20)); }
    } else if (k === "tnt" || k === "fireball") {
      const foe = this.enemyBeds()[0];
      if (foe) this.damageBed(foe.team, k === "tnt" ? 45 : 28);
    }
  }

  // ---- resource HUD ----
  private buildHud() {
    if (this.hud) return;
    const el = document.createElement("div");
    el.id = "bw-res";
    (document.getElementById("ui") ?? document.body).appendChild(el);
    this.hud = el;
    this.refreshHud();
  }
  private refreshHud() {
    if (!this.hud) return;
    const w = this.wallet;
    const my = this.beds.get(this.playerTeam);
    const bedTxt = my && !my.dead ? `🛏 ${Math.max(0, Math.round(my.hp))}` : "🛏 ✖";
    const enemies = this.enemyBeds().length;
    this.hud.innerHTML =
      `<span class="bw-r bw-iron">⛓ ${w.iron}</span>` +
      `<span class="bw-r bw-gold">⛀ ${w.gold}</span>` +
      `<span class="bw-r bw-emerald">✦ ${w.emerald}</span>` +
      `<span class="bw-r bw-bed">${bedTxt}</span>` +
      `<span class="bw-r bw-foes">⚔ ${enemies} left</span>`;
  }
}
