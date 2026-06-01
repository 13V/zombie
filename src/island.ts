import * as THREE from "three";
import { voxelMaterial, glowMaterial, VOX, COLORS } from "./palette";
import { VoxelChar } from "./voxelChar";
import { makeBubble, makeLabel } from "./islandnet";

/**
 * The Island — a persistent social hub / lobby the player spawns into (think a
 * cozy Roblox-style starting world). You walk around your voxel character here,
 * see other people (multiplayer presence is layered on top via NetPlay), hatch
 * pets at the egg ring in the middle, and step onto game-mode structures to
 * start a Solo / Duo / Squad run.
 *
 * This module owns ONLY the static world + the interactive "zones" (proximity
 * pads). Movement, camera and presence are driven by main.ts so the island can
 * reuse the existing Player / NetClient / camera systems.
 */

export const ISLAND = {
  half: 34, // half-extent of the island ground (bigger than the arena)
  shore: 30, // grass radius; beyond this is sand, then water
};

/** An interactive spot on the island the player can walk up to. */
export interface IslandZone {
  id: string;
  kind: "mode" | "join" | "shop" | "egg";
  pos: THREE.Vector3;
  radius: number; // proximity radius that triggers the prompt
  label: string; // shown in the proximity prompt
  /** game-mode portals (kind === "mode"): how many players the structure hosts. */
  modePlayers?: 1 | 2 | 4;
  /** egg zones (kind === "egg"): which gacha egg this pedestal hatches. */
  eggId?: string;
}

export class Island {
  readonly group = new THREE.Group();
  readonly zones: IslandZone[] = [];
  private water?: THREE.Mesh;
  private beacons: THREE.Mesh[] = [];
  private t = 0;
  // interactive pads, tracked so they can bounce-scale + brighten when stood on
  private pads: { id: string; group: THREE.Group; ring: THREE.Mesh; pos: THREE.Vector3; lit: number }[] = [];
  // greeter NPC (static voxel figure near spawn) + the floating "go here" arrow
  private greeter?: VoxelChar;
  private arrow?: THREE.Mesh;
  // egg pedestals (spin + bob in update) and the game-mode portal structures
  private eggs: { id: string; group: THREE.Group; pos: THREE.Vector3 }[] = [];
  private modeRings: { ring: THREE.Mesh; pos: THREE.Vector3 }[] = [];

  constructor(scene: THREE.Scene) {
    this.buildGround();
    this.buildWater();
    this.buildDecor();
    this.buildPlaza();
    this.buildZones();
    this.buildModes();
    this.buildEggs();
    this.buildGreeter();
    scene.add(this.group);
    this.group.visible = false; // shown only while in the island state
  }

  setVisible(on: boolean) {
    this.group.visible = on;
  }

  /** Keep the player inside the grassy shore (soft circular clamp). */
  clamp(pos: THREE.Vector3) {
    const r = Math.hypot(pos.x, pos.z);
    const max = ISLAND.shore - 1.2;
    if (r > max) {
      pos.x = (pos.x / r) * max;
      pos.z = (pos.z / r) * max;
    }
  }

  /** Nearest zone within its trigger radius (for the walk-up prompt), or null. */
  nearestZone(pos: THREE.Vector3): IslandZone | null {
    let best: IslandZone | null = null;
    let bd = Infinity;
    for (const z of this.zones) {
      const dx = z.pos.x - pos.x;
      const dz = z.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < z.radius * z.radius && d < bd) {
        bd = d;
        best = z;
      }
    }
    return best;
  }

  update(dt: number) {
    if (!this.group.visible) return;
    this.t += dt;
    // gentle water bob + beacon pulse for life
    if (this.water) this.water.position.y = -0.35 + Math.sin(this.t * 0.8) * 0.05;
    for (const b of this.beacons) {
      const m = b.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.8 + (Math.sin(this.t * 2.4) + 1) * 0.5;
      b.rotation.y += dt * 1.2;
    }
    // greeter waves on a loop (re-trigger the one-shot when it finishes)
    if (this.greeter) {
      if (!this.greeter.emoting) this.greeter.emote("wave");
      this.greeter.update(dt);
    }
    if (this.arrow) {
      this.arrow.position.y = 3.1 + Math.sin(this.t * 2.2) * 0.18;
      this.arrow.rotation.y += dt * 1.5;
    }
    this.animateInteractables();
  }

  /**
   * A friendly static greeter NPC near spawn with a welcome speech bubble + name
   * label, plus a floating arrow over the host pad pointing players at the action.
   */
  private buildGreeter() {
    const npc = new VoxelChar({ body: 0x6e4a9e, head: COLORS.playerAccent, eye: 0x222222, hat: 0xffd24a, gun: false });
    npc.root.position.set(2.6, 0, 6.2); // beside the spawn point, facing the plaza
    npc.root.rotation.y = Math.PI; // look south toward arriving players
    npc.play("idle");
    npc.emote("wave"); // perpetual friendly wave (sit/wave loop handled by emote)
    this.greeter = npc;
    const label = makeLabel("Guide");
    npc.root.add(label);
    const bubble = makeBubble("Hatch pets at the eggs, then step into a SOLO / DUO / SQUAD gate to fight! Press T to wave 👋");
    bubble.scale.set(5.4, 1.4, 1);
    bubble.position.set(0, 3.1, 0);
    npc.root.add(bubble);
    this.group.add(npc.root);

    // floating arrow over the DUO gate (center-back of the plaza, z = -11)
    const cone = new THREE.ConeGeometry(0.5, 1.0, 4);
    cone.rotateX(Math.PI); // point down
    this.arrow = new THREE.Mesh(cone, glowMaterial(0x6ad7ff, 1.2));
    this.arrow.position.set(0, 3.4, -11);
    this.group.add(this.arrow);
  }

  // ---- world building -----------------------------------------------------

  private buildGround() {
    const g = new THREE.Group();
    const grass = voxelMaterial(VOX.grass);
    const grassDark = voxelMaterial(VOX.grassDark);
    const sand = voxelMaterial(0xe6d9a8);
    // chunky voxel terrain: a disc of 2x2 tiles, sand near the rim
    const TILE = 2;
    const n = Math.ceil(ISLAND.half / TILE);
    for (let ix = -n; ix <= n; ix++) {
      for (let iz = -n; iz <= n; iz++) {
        const x = ix * TILE;
        const z = iz * TILE;
        const r = Math.hypot(x, z);
        if (r > ISLAND.half) continue;
        const onSand = r > ISLAND.shore;
        const mat = onSand ? sand : (ix + iz) % 2 === 0 ? grass : grassDark;
        const h = onSand ? 0.6 : 1.0;
        const tile = new THREE.Mesh(new THREE.BoxGeometry(TILE, h, TILE), mat);
        tile.position.set(x, h / 2 - 0.5, z);
        g.add(tile);
      }
    }
    this.group.add(g);
  }

  private buildWater() {
    const geo = new THREE.CircleGeometry(120, 48);
    const mat = new THREE.MeshStandardMaterial({
      color: VOX.water, transparent: true, opacity: 0.86, roughness: 0.3, metalness: 0.0,
    });
    const w = new THREE.Mesh(geo, mat);
    w.rotation.x = -Math.PI / 2;
    w.position.y = -0.35;
    this.water = w;
    this.group.add(w);
  }

  private buildDecor() {
    // scattered palm-ish trees + rocks around the shore (skip the central plaza)
    const trunk = voxelMaterial(0x8a5a32);
    const leaf = voxelMaterial(0x5fb04a);
    const rock = voxelMaterial(0x9b9b90);
    let seed = 1337;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
    for (let i = 0; i < 46; i++) {
      const a = rnd() * Math.PI * 2;
      const r = 9 + rnd() * (ISLAND.shore - 10);
      const x = Math.cos(a) * r;
      const z = Math.sin(a) * r;
      if (Math.hypot(x, z) < 8) continue; // keep the plaza clear
      if (rnd() < 0.75) {
        const tree = new THREE.Group();
        const th = 1.6 + rnd() * 1.4;
        const tk = new THREE.Mesh(new THREE.BoxGeometry(0.5, th, 0.5), trunk);
        tk.position.y = th / 2;
        const top = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.4, 1.8), leaf);
        top.position.y = th + 0.4;
        const top2 = new THREE.Mesh(new THREE.BoxGeometry(1.2, 1.0, 1.2), leaf);
        top2.position.y = th + 1.3;
        tree.add(tk, top, top2);
        tree.position.set(x, 0, z);
        this.group.add(tree);
      } else {
        const s = 0.7 + rnd() * 0.9;
        const rk = new THREE.Mesh(new THREE.BoxGeometry(s, s * 0.7, s), rock);
        rk.position.set(x, s * 0.35, z);
        rk.rotation.y = rnd() * Math.PI;
        this.group.add(rk);
      }
    }
  }

  private buildPlaza() {
    // a cobble plaza at the center where players gather + the portals live
    const cobble = voxelMaterial(VOX.cobble ?? 0xc2c2b6);
    const disc = new THREE.Mesh(new THREE.CylinderGeometry(7.5, 7.5, 0.4, 32), cobble);
    disc.position.y = 0.05;
    this.group.add(disc);
    // a welcoming central fountain
    const base = new THREE.Mesh(new THREE.CylinderGeometry(1.6, 1.8, 0.6, 16), voxelMaterial(VOX.stone ?? 0x9b9b90));
    base.position.y = 0.4;
    const water = new THREE.Mesh(new THREE.CylinderGeometry(1.3, 1.3, 0.3, 16), glowMaterial(VOX.water, 0.5));
    water.position.y = 0.72;
    this.group.add(base, water);
  }

  /** Build the utility pads (join + shop) near the plaza edge. Game-mode
   *  portals live in buildModes(); egg pedestals in buildEggs(). */
  private buildZones() {
    // JOIN pad — enter a friend's room code
    this.addPad("join", "join", new THREE.Vector3(6.5, 0, 4.5), 0x6ad7ff, "Join a Friend's Run");
    // SHOP pad — open the pet/upgrade shop from the hub
    this.addPad("shop", "shop", new THREE.Vector3(-6.5, 0, 4.5), 0xffd24a, "Open Shop");
  }

  private addPad(id: string, kind: IslandZone["kind"], pos: THREE.Vector3, color: number, label: string) {
    const pad = new THREE.Group();
    const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.5, 1.5, 0.2, 24), glowMaterial(color, 0.9));
    ring.position.y = 0.12;
    const beacon = new THREE.Mesh(new THREE.BoxGeometry(0.5, 2.2, 0.5), glowMaterial(color, 1.0));
    beacon.position.y = 1.3;
    this.beacons.push(beacon);
    pad.add(ring, beacon);
    pad.position.copy(pos);
    this.group.add(pad);
    this.pads.push({ id, group: pad, ring, pos: pos.clone(), lit: 0 });
    this.zones.push({ id, kind, pos: pos.clone(), radius: 2.2, label });
  }

  /**
   * Game-mode portals — three voxel archway structures the player steps into to
   * start a Solo (1), Duo (2), or Squad (4) run. Each is a colored gate with a
   * glowing floor ring + a count of figures, arranged across the back of the
   * plaza. Difficulty scales with the player count the structure hosts.
   */
  private buildModes() {
    const modes: { id: string; players: 1 | 2 | 4; pos: THREE.Vector3; color: number; label: string }[] = [
      { id: "mode_solo", players: 1, pos: new THREE.Vector3(-9, 0, -9), color: 0x7be08a, label: "SOLO — 1 player" },
      { id: "mode_duo", players: 2, pos: new THREE.Vector3(0, 0, -11), color: 0x6ad7ff, label: "DUO — 2 players (2× harder)" },
      { id: "mode_quad", players: 4, pos: new THREE.Vector3(9, 0, -9), color: 0xff5a3a, label: "SQUAD — 4 players (4× harder)" },
    ];
    for (const m of modes) {
      const gate = new THREE.Group();
      const post = (x: number) => {
        const p = new THREE.Mesh(new THREE.BoxGeometry(0.5, 3.0, 0.5), glowMaterial(m.color, 0.8));
        p.position.set(x, 1.5, 0);
        gate.add(p);
      };
      post(-1.4); post(1.4);
      const lintel = new THREE.Mesh(new THREE.BoxGeometry(3.7, 0.5, 0.5), glowMaterial(m.color, 0.9));
      lintel.position.set(0, 3.05, 0);
      gate.add(lintel);
      // glowing floor ring
      const ring = new THREE.Mesh(new THREE.CylinderGeometry(1.7, 1.7, 0.18, 28), glowMaterial(m.color, 0.85));
      ring.position.y = 0.1;
      gate.add(ring);
      // little voxel figures showing the party size (1 / 2 / 4 stubby blocks)
      for (let i = 0; i < m.players; i++) {
        const a = m.players === 1 ? 0 : (i / m.players) * Math.PI * 2;
        const fig = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.8, 0.34), glowMaterial(m.color, 1.1));
        fig.position.set(Math.cos(a) * 0.6, 0.5, Math.sin(a) * 0.6 + 0.1);
        gate.add(fig);
      }
      gate.position.copy(m.pos);
      gate.lookAt(0, 0, 0); // face the plaza center
      this.group.add(gate);
      this.modeRings.push({ ring, pos: m.pos.clone() });
      this.zones.push({ id: m.id, kind: "mode", pos: m.pos.clone(), radius: 2.6, label: m.label, modePlayers: m.players });
    }
  }

  /**
   * The egg ring — five gacha pedestals around the central fountain. Each holds
   * a floating, slowly-spinning egg tinted to its tier; walking up lets the
   * player hatch a random pet (handled in main via the gacha module).
   */
  private buildEggs(eggDefs: { id: string; color: number; label: string }[] = DEFAULT_EGG_VISUALS) {
    const ringR = 4.6;
    eggDefs.forEach((e, i) => {
      const a = (i / eggDefs.length) * Math.PI * 2 - Math.PI / 2;
      const x = Math.cos(a) * ringR;
      const z = Math.sin(a) * ringR;
      const pos = new THREE.Vector3(x, 0, z);
      const g = new THREE.Group();
      // pedestal
      const ped = new THREE.Mesh(new THREE.CylinderGeometry(0.5, 0.6, 0.7, 12), voxelMaterial(VOX.stone ?? 0x9b9b90));
      ped.position.y = 0.35;
      g.add(ped);
      // the egg: a slightly squashed glowing box, spins/bobs in update()
      const egg = new THREE.Mesh(new THREE.BoxGeometry(0.55, 0.7, 0.55), glowMaterial(e.color, 1.0));
      egg.position.y = 1.15;
      egg.name = "egg";
      // a couple of accent speckles
      const spot = new THREE.Mesh(new THREE.BoxGeometry(0.16, 0.16, 0.16), glowMaterial(0xffffff, 1.2));
      spot.position.set(0.12, 1.25, 0.26);
      g.add(egg, spot);
      g.position.copy(pos);
      this.group.add(g);
      this.eggs.push({ id: e.id, group: g, pos: pos.clone() });
      this.zones.push({ id: e.id, kind: "egg", pos: pos.clone(), radius: 1.9, label: e.label, eggId: e.id });
    });
  }

  /**
   * Reactive pads — the pad nearest the player bounce-scales up + brightens its
   * ring while stood on, easing back to rest otherwise. Cheap (a few pads).
   */
  reactPads(playerPos: THREE.Vector3, dt: number) {
    for (const p of this.pads) {
      const dx = p.pos.x - playerPos.x;
      const dz = p.pos.z - playerPos.z;
      const on = dx * dx + dz * dz < 2.2 * 2.2;
      // ease the "lit" amount toward the target (1 when stood on, else 0)
      p.lit += ((on ? 1 : 0) - p.lit) * Math.min(1, dt * 8);
      const s = 1 + p.lit * 0.18 + (on ? Math.sin(this.t * 8) * 0.04 : 0);
      p.group.scale.set(s, 1 + p.lit * 0.12, s);
      const m = p.ring.material as THREE.MeshStandardMaterial;
      m.emissiveIntensity = 0.9 + p.lit * 1.6;
    }
  }

  /** Spin + bob the floating eggs and pulse the mode rings (called in update). */
  private animateInteractables() {
    for (const e of this.eggs) {
      const egg = e.group.getObjectByName("egg");
      if (egg) {
        egg.rotation.y = this.t * 1.2;
        egg.position.y = 1.15 + Math.sin(this.t * 2 + e.pos.x) * 0.08;
      }
    }
    for (const m of this.modeRings) {
      const mat = m.ring.material as THREE.MeshStandardMaterial;
      mat.emissiveIntensity = 0.7 + (Math.sin(this.t * 2.5 + m.pos.x) + 1) * 0.25;
    }
  }
}

/** Default visual set for the 5 egg pedestals; main can override the labels via
 *  setEggLabels but the island ships sensible defaults so it works standalone. */
const DEFAULT_EGG_VISUALS: { id: string; color: number; label: string }[] = [
  { id: "egg_common", color: 0x8fcf5a, label: "Mossy Egg" },
  { id: "egg_uncommon", color: 0x6ad7ff, label: "River Egg" },
  { id: "egg_rare", color: 0x5aa9ff, label: "Storm Egg" },
  { id: "egg_epic", color: 0xc792ea, label: "Astral Egg" },
  { id: "egg_legendary", color: 0xffb84a, label: "Mythic Egg" },
];

/** Re-exported so main can tint prompts consistently with the hub. */
export const ISLAND_COLORS = COLORS;
