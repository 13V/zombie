import * as THREE from "three";
import { BedWarsMap, type BwTeamId } from "./bwmap";
import { makeGenerator, tickGenerator, emptyWallet, addToWallet, type BwGenerator, type BwWallet } from "./bwresources";
import { createMatch, breakBed, killPlayer, respawnPlayer, isTeamOut, aliveTeams, type BwMatch } from "./bwteams";
import { BwBots } from "./bwbots";
import { BwShopUI } from "./bwshopui";
import { bwBuy, bwCanAfford, type BwShopItem } from "./bwshop";
import { VoxelChar } from "../voxelChar";

interface Bed { team: BwTeamId; pos: THREE.Vector3; color: number; hp: number; max: number; dead: boolean; group: THREE.Group }

/** An enemy team's lone defender — the unit that embodies its "lives". While the
 *  team's bed stands, killing the guardian just respawns it; once the bed is
 *  broken, the next kill ELIMINATES the team (classic Bed Wars). */
interface Guardian { team: BwTeamId; playerId: number; char: VoxelChar; pos: THREE.Vector3; hp: number; max: number; alive: boolean; respawn: number; flash: number }

const WAVE_START = 7;      // seconds between raider waves at the start
const WAVE_MIN = 2.4;      // floor
const WAVE_RAMP = 0.985;   // interval *= this each wave
const MAX_RAIDERS = 10;
const BED_HP = 120;

const PLAYER_HP = 100;     // your Bed Wars health pool (separate from the run)
const PLAYER_RESPAWN = 5;  // seconds dead before you re-materialise at your base
const RAIDER_DPS = 11;     // contact damage per raider within reach of you, per sec
const RAIDER_TOUCH = 1.7;  // how close a raider must be to chip your health

const GUARD_HP = 70;
const GUARD_RESPAWN = 4;   // guardian respawn delay (only while the bed is alive)
const GUARD_HIT_R = 1.3;   // bullet hit radius around a guardian

/**
 * Bed Wars-lite controller (solo vs bots). Owns the world, beds (with HP), the
 * raider bots, an enemy GUARDIAN per team, the resource generators + wallet, the
 * shop UI, your health + respawn, and the win loop. main drives it:
 * enter() / tick() / resolveHit() / leave(), keeping the player, camera, input
 * and bullets.
 *
 * Lives rule (https://hypixel.fandom.com/wiki/Bed_Wars): while a team's bed
 * stands, its deaths are RESPAWNS; once the bed is gone, the next death is
 * FINAL. Destroy every enemy bed AND finish their guardians to win; lose when
 * your bed is gone and you die.
 */
export class BedWarsMode {
  private map: BedWarsMap;
  private match: BwMatch;
  private beds = new Map<BwTeamId, Bed>();
  private guards: Guardian[] = [];
  private bots: BwBots;
  private gens: { team: BwTeamId; gen: BwGenerator }[] = [];
  wallet: BwWallet = emptyWallet();
  readonly playerTeam: BwTeamId = "red";
  private readonly playerId = 1; // the human's slot in the match roster
  private active = false;
  private hud?: HTMLElement;
  private shop?: BwShopUI;
  private waveTimer = WAVE_START;
  private waveInterval = WAVE_START;

  // ---- your life ----
  playerHp = PLAYER_HP;
  readonly playerMax = PLAYER_HP;
  /** > 0 while you're dead and waiting to respawn (your bed is still alive). */
  respawnTimer = 0;
  /** Set the frame your respawn completes so main can re-seat you at base. */
  private respawnReady = false;

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
  /** True while you're dead and the respawn clock is running. */
  get playerWaiting(): boolean { return this.respawnTimer > 0; }
  /** Consume the one-shot "you just respawned" edge (main re-seats you at base). */
  consumeRespawn(): boolean { const r = this.respawnReady; this.respawnReady = false; return r; }

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
    // one player per team: the human on playerTeam, a bot defender on each other.
    this.match = createMatch(this.map.teams.map((t, i) => ({ id: i + 1, team: t.id, bot: t.id !== this.playerTeam })));
    this.spawnGuardians();
    this.wallet = emptyWallet();
    this.waveInterval = WAVE_START;
    this.waveTimer = WAVE_START;
    this.playerHp = PLAYER_HP;
    this.respawnTimer = 0;
    this.respawnReady = false;
    if (!this.shop) this.shop = new BwShopUI(document.getElementById("ui") ?? document.body);
    this.buildHud();
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.map.setVisible(false);
    for (const b of this.beds.values()) this.map.group.remove(b.group);
    this.beds.clear();
    for (const g of this.guards) this.disposeGuardian(g);
    this.guards.length = 0;
    this.bots.clear();
    this.shop?.close();
    this.hud?.remove();
    this.hud = undefined;
  }

  // ---- enemy guardians ----
  private spawnGuardians() {
    this.guards = [];
    for (const t of this.map.teams) {
      if (t.id === this.playerTeam) continue;
      const playerId = this.map.teams.findIndex((x) => x.id === t.id) + 1;
      // stand at the base, a touch toward the centre so it screens the bed.
      const pos = t.base.clone().add(this.map.center.clone().sub(t.base).normalize().multiplyScalar(1.4));
      pos.y = 0;
      const g: Guardian = { team: t.id, playerId, char: this.makeGuardianChar(t.color, pos), pos, hp: GUARD_HP, max: GUARD_HP, alive: true, respawn: 0, flash: 0 };
      this.guards.push(g);
    }
  }
  private makeGuardianChar(color: number, pos: THREE.Vector3): VoxelChar {
    const char = new VoxelChar({ body: color, head: 0xf2c9a0, eye: 0x222222 });
    char.setColor(color, 0xf2c9a0);
    char.play("idle");
    char.root.position.copy(pos);
    // face the centre of the map
    char.root.rotation.y = Math.atan2(this.map.center.x - pos.x, this.map.center.z - pos.z);
    this.map.group.add(char.root);
    return char;
  }
  private disposeGuardian(g: Guardian) {
    this.map.group.remove(g.char.root);
    g.char.root.traverse((o) => {
      const mesh = o as THREE.Mesh;
      mesh.geometry?.dispose?.();
      const mat = mesh.material;
      if (Array.isArray(mat)) for (const m of mat) m.dispose();
      else mat?.dispose?.();
    });
  }

  /** Alive enemy beds (for the player's bullets to target). */
  private enemyBeds(): Bed[] {
    return [...this.beds.values()].filter((b) => b.team !== this.playerTeam && !b.dead);
  }

  /** A bullet impacted at `pos` with `dmg`. Priority: raiders → guardians →
   *  enemy beds. Returns the kind so main can retire the bullet + spark. */
  resolveHit(pos: THREE.Vector3, dmg: number): "bot" | "guard" | "bed" | null {
    // raiders first (tight radius)
    for (const r of this.bots.positions()) {
      const dx = r.pos.x - pos.x, dz = r.pos.z - pos.z;
      if (dx * dx + dz * dz < 0.9 * 0.9) { this.bots.damageNear(pos, 0.9, dmg); return "bot"; }
    }
    // then enemy guardians (must be cleared before you can finish a broken-bed team)
    for (const g of this.guards) {
      if (!g.alive) continue;
      const dx = g.pos.x - pos.x, dz = g.pos.z - pos.z;
      if (dx * dx + dz * dz < GUARD_HIT_R * GUARD_HIT_R) { this.damageGuardian(g, dmg); return "guard"; }
    }
    // then enemy beds
    for (const b of this.enemyBeds()) {
      const dx = b.pos.x - pos.x, dz = b.pos.z - pos.z;
      if (dx * dx + dz * dz < 1.7 * 1.7) { this.damageBed(b.team, dmg); return "bed"; }
    }
    return null;
  }

  private damageGuardian(g: Guardian, dmg: number) {
    if (!g.alive) return;
    g.hp -= dmg;
    g.flash = 0.12;
    g.char.setHitFlash(1);
    if (g.hp <= 0) {
      g.alive = false;
      this.map.group.remove(g.char.root);
      const r = killPlayer(this.match, g.playerId); // respawn (bed up) or eliminate
      if (r === "respawn") g.respawn = GUARD_RESPAWN;
      this.checkEnd();
    }
  }

  private damageBed(team: BwTeamId, dmg: number) {
    const b = this.beds.get(team);
    if (!b || b.dead) return;
    b.hp -= dmg;
    if (b.hp <= 0) {
      b.dead = true;
      this.map.group.remove(b.group);
      breakBed(this.match, team);
      this.checkEnd();
    }
  }

  /** A raider hit your bed for `dmg`. */
  private damageMyBed(dmg: number) {
    const b = this.beds.get(this.playerTeam);
    if (!b || b.dead) return;
    b.hp -= dmg;
    if (b.hp <= 0) {
      b.dead = true;
      this.map.group.remove(b.group);
      breakBed(this.match, this.playerTeam);
      this.checkEnd();
    }
  }

  private checkEnd() {
    if (this.result.over) return;
    // you're out the instant your bed is gone AND you've died for good.
    if (isTeamOut(this.match, this.playerTeam)) { this.result = { over: true, win: false }; return; }
    const alive = aliveTeams(this.match);
    if (alive.length === 1 && alive[0] === this.playerTeam) this.result = { over: true, win: true };
  }

  /** Advance the world. `playerPos` lets raiders chip your health on contact and
   *  drives your death → respawn (or elimination) per the lives rule. */
  tick(dt: number, playerPos?: THREE.Vector3) {
    if (!this.active || this.result.over) return;
    this.map.update(dt);
    for (const g of this.gens) {
      const drops = tickGenerator(g.gen, dt, 0);
      if (g.team === this.playerTeam) for (const d of drops) this.wallet = addToWallet(this.wallet, d.kind, d.amount);
    }
    this.bots.update(dt);
    this.updateGuardians(dt);

    // raider waves target the player's bed, from a random alive enemy base
    this.waveTimer -= dt;
    const myBed = this.beds.get(this.playerTeam);
    if (this.waveTimer <= 0 && myBed && !myBed.dead && this.bots.count < MAX_RAIDERS) {
      this.waveTimer = this.waveInterval;
      this.waveInterval = Math.max(WAVE_MIN, this.waveInterval * WAVE_RAMP);
      const foes = this.enemyBeds();
      if (foes.length) {
        const foe = foes[Math.floor(Math.random() * foes.length)];
        const target = { pos: myBed.pos, alive: () => !myBed.dead, onHit: (d: number) => this.damageMyBed(d) };
        const from = foe.pos.clone().multiplyScalar(1.15); // just outside the enemy island
        this.bots.spawn(this.beds.get(foe.team)!.color, from, target);
      }
    }

    this.updatePlayerLife(dt, playerPos);
    this.refreshHud();
  }

  /** Guardians idle at their base; respawn after a delay only while their bed is
   *  alive (killPlayer already gated that — respawn>0 is only set then). */
  private updateGuardians(dt: number) {
    for (const g of this.guards) {
      if (g.alive) {
        if (g.flash > 0) { g.flash -= dt; g.char.setHitFlash(Math.max(0, g.flash / 0.12)); }
        g.char.update(dt);
        continue;
      }
      if (g.respawn > 0) {
        g.respawn -= dt;
        if (g.respawn <= 0) {
          g.hp = g.max; g.alive = true; g.flash = 0;
          g.char.setHitFlash(0);
          this.map.group.add(g.char.root);
          respawnPlayer(this.match, g.playerId);
        }
      }
    }
  }

  /** Contact damage from nearby raiders, then your death → respawn/elimination. */
  private updatePlayerLife(dt: number, playerPos?: THREE.Vector3) {
    if (this.respawnTimer > 0) {
      this.respawnTimer -= dt;
      if (this.respawnTimer <= 0) {
        this.respawnTimer = 0;
        respawnPlayer(this.match, this.playerId);
        this.playerHp = this.playerMax;
        this.respawnReady = true; // main re-seats you at base this frame
      }
      return; // dead: no contact damage while waiting
    }
    if (!playerPos) return;
    let dps = 0;
    for (const r of this.bots.positions()) {
      const dx = r.pos.x - playerPos.x, dz = r.pos.z - playerPos.z;
      if (dx * dx + dz * dz < RAIDER_TOUCH * RAIDER_TOUCH) dps += RAIDER_DPS;
    }
    if (dps > 0) this.playerHp = Math.max(0, this.playerHp - dps * dt);
    if (this.playerHp <= 0) {
      const r = killPlayer(this.match, this.playerId);
      if (r === "respawn") this.respawnTimer = PLAYER_RESPAWN; // bed up → come back
      else this.checkEnd(); // eliminated → you've lost
    }
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
    } else if (k === "heal") {
      this.playerHp = Math.min(this.playerMax, this.playerHp + (item.effect.value ?? 40));
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
    const bedTxt = my && !my.dead ? `🛏 ${Math.max(0, Math.round(my.hp))}` : "🛏 ✖ FINAL LIFE";
    const enemies = aliveTeams(this.match).filter((t) => t !== this.playerTeam).length;
    const hpTxt = this.respawnTimer > 0 ? `💀 respawn ${Math.ceil(this.respawnTimer)}s` : `❤ ${Math.round(this.playerHp)}`;
    this.hud.innerHTML =
      `<span class="bw-r bw-hp">${hpTxt}</span>` +
      `<span class="bw-r bw-iron">⛓ ${w.iron}</span>` +
      `<span class="bw-r bw-gold">⛀ ${w.gold}</span>` +
      `<span class="bw-r bw-emerald">✦ ${w.emerald}</span>` +
      `<span class="bw-r bw-bed">${bedTxt}</span>` +
      `<span class="bw-r bw-foes">⚔ ${enemies} left</span>`;
  }
}
