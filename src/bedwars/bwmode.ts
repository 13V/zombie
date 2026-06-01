import * as THREE from "three";
import { BedWarsMap, type BwTeamId } from "./bwmap";
import { makeGenerator, tickGenerator, emptyWallet, addToWallet, type BwGenerator, type BwWallet } from "./bwresources";
import { createMatch, type BwMatch } from "./bwteams";

/**
 * Bed Wars-lite mode controller (vertical slice). Owns the BW world, the match
 * state, resource generators + the player's wallet, the bed objects, and a small
 * resource HUD. main.ts drives it: enter() / tick(dt, playerPos) / leave(), and
 * keeps ownership of the player + camera + input (mirrors the island pattern).
 *
 * SLICE SCOPE: walk your island, generators tick resources into your wallet
 * (shown in the HUD), beds + the arena render. Combat, bot raiders, the shop,
 * and the win loop are the next iteration (the foundation modules already exist).
 */
export class BedWarsMode {
  private map: BedWarsMap;
  private beds = new Map<BwTeamId, THREE.Group>();
  private match: BwMatch;
  private gens: { team: BwTeamId; gen: BwGenerator }[] = [];
  wallet: BwWallet = emptyWallet();
  readonly playerTeam: BwTeamId = "red";
  private active = false;
  private hud?: HTMLElement;

  constructor(scene: THREE.Scene) {
    this.map = new BedWarsMap(scene);
    this.match = createMatch([]);
  }

  /** Live match state (drives the win loop in the next iteration). */
  get matchState(): BwMatch {
    return this.match;
  }

  /** Player spawn = the centre of their team island. */
  spawn(): THREE.Vector3 {
    const t = this.map.teams.find((x) => x.id === this.playerTeam) ?? this.map.teams[0];
    return t.base.clone();
  }

  /** Soft-clamp the player inside the arena so they don't wander into the void. */
  clamp(pos: THREE.Vector3) {
    const max = 33;
    pos.x = Math.max(-max, Math.min(max, pos.x));
    pos.z = Math.max(-max, Math.min(max, pos.z));
    pos.y = 0;
  }

  enter() {
    if (this.active) return;
    this.active = true;
    this.map.setVisible(true);
    // place a bed on every team island
    for (const t of this.map.teams) {
      const bed = this.map.makeBed(t.color);
      bed.position.copy(t.bed);
      this.map.group.add(bed);
      this.beds.set(t.id, bed);
    }
    // generators: every base gets an iron spawner; the player's base also a gold
    // spawner; the centre forges emerald (collected when standing near it).
    this.gens = this.map.teams.map((t) => ({ team: t.id, gen: makeGenerator(`${t.id}-iron`, "iron") }));
    this.gens.push({ team: this.playerTeam, gen: makeGenerator(`${this.playerTeam}-gold`, "gold") });
    this.gens.push({ team: this.playerTeam, gen: makeGenerator("center-emerald", "emerald") });
    // match: player team + 3 bot teams (one bot player each)
    this.match = createMatch(this.map.teams.map((t, i) => ({ id: i + 1, team: t.id, bot: t.id !== this.playerTeam })));
    this.wallet = emptyWallet();
    this.buildHud();
  }

  leave() {
    if (!this.active) return;
    this.active = false;
    this.map.setVisible(false);
    for (const bed of this.beds.values()) this.map.group.remove(bed);
    this.beds.clear();
    this.hud?.remove();
    this.hud = undefined;
  }

  tick(dt: number) {
    if (!this.active) return;
    this.map.update(dt);
    // SLICE: auto-collect the player's own generators into the wallet.
    for (const g of this.gens) {
      const drops = tickGenerator(g.gen, dt, 0);
      if (g.team === this.playerTeam) for (const d of drops) this.wallet = addToWallet(this.wallet, d.kind, d.amount);
    }
    this.refreshHud();
  }

  // ---- resource HUD (self-managed DOM so hud.ts stays untouched) ----
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
    this.hud.innerHTML =
      `<span class="bw-r bw-iron">⛓ ${w.iron}</span>` +
      `<span class="bw-r bw-gold">⛀ ${w.gold}</span>` +
      `<span class="bw-r bw-emerald">✦ ${w.emerald}</span>`;
  }
}
