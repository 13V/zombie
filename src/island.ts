import * as THREE from "three";
import { voxelMaterial, glowMaterial, toyMaterial, VOX, COLORS } from "./palette";
import { VoxelChar } from "./voxelChar";
import { makeBubble, makeLabel } from "./islandnet";

/**
 * The Island — a persistent social hub / lobby the player spawns into (think a
 * cozy Roblox-style starting world). You walk around your voxel character here,
 * see other people (multiplayer presence is layered on top via NetPlay), visit
 * house plots, and step onto interactive pads to start co-op runs.
 *
 * This module owns ONLY the static world + the interactive "zones" (proximity
 * pads). Movement, camera, presence and house contents are driven by main.ts so
 * the island can reuse the existing Player / NetClient / camera systems.
 */

export const ISLAND = {
  half: 34, // half-extent of the island ground (bigger than the arena)
  shore: 30, // grass radius; beyond this is sand, then water
};

/** An interactive spot on the island the player can walk up to. */
export interface IslandZone {
  id: string;
  kind: "play" | "host" | "join" | "shop" | "plot";
  pos: THREE.Vector3;
  radius: number; // proximity radius that triggers the prompt
  label: string; // shown in the proximity prompt
  /** house-plot ownership (kind === "plot"): filled in by main from the backend. */
  plotIndex?: number;
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
  /** Plot anchor points so houses can be (re)built onto them by main. */
  readonly plots: { index: number; pos: THREE.Vector3 }[] = [];

  constructor(scene: THREE.Scene) {
    this.buildGround();
    this.buildWater();
    this.buildDecor();
    this.buildPlaza();
    this.buildZones();
    this.buildPlots();
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
    const bubble = makeBubble("Walk to the red portal to fight — or hang out! Press T to wave 👋");
    bubble.scale.set(4.2, 1.4, 1);
    bubble.position.set(0, 3.1, 0);
    npc.root.add(bubble);
    this.group.add(npc.root);

    // floating arrow over the host pad (host pad sits at z = -5.5)
    const cone = new THREE.ConeGeometry(0.5, 1.0, 4);
    cone.rotateX(Math.PI); // point down
    this.arrow = new THREE.Mesh(cone, glowMaterial(0xff5a3a, 1.2));
    this.arrow.position.set(0, 3.1, -5.5);
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

  /** Build the interactive pads (portals) + register their zones. */
  private buildZones() {
    // PLAY pad — start / host a co-op run (the "portal to the zombie world")
    this.addPad("host", "host", new THREE.Vector3(0, 0, -5.5), 0xff5a3a, "Start / Host Co-op Run");
    // JOIN pad — enter a friend's room code
    this.addPad("join", "join", new THREE.Vector3(5, 0, 2.5), 0x6ad7ff, "Join a Friend's Run");
    // SHOP pad — open the pet/upgrade shop from the hub
    this.addPad("shop", "shop", new THREE.Vector3(-5, 0, 2.5), 0xffd24a, "Open Shop");
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

  /** Lay out house plots in a ring behind the plaza; main fills them with houses. */
  private buildPlots() {
    const count = 8;
    const ringR = 20;
    const frame = toyMaterial(0xb6a273);
    for (let i = 0; i < count; i++) {
      const a = (i / count) * Math.PI * 2;
      const x = Math.cos(a) * ringR;
      const z = Math.sin(a) * ringR;
      const pos = new THREE.Vector3(x, 0, z);
      // a flat foundation pad marking the plot
      const pad = new THREE.Mesh(new THREE.BoxGeometry(6, 0.3, 6), frame);
      pad.position.set(x, 0.05, z);
      pad.rotation.y = -a;
      this.group.add(pad);
      this.plots.push({ index: i, pos });
      this.zones.push({ id: `plot${i}`, kind: "plot", pos: pos.clone(), radius: 3.2, label: `House Plot ${i + 1}`, plotIndex: i });
    }
  }
}

/** Re-exported so main can tint prompts consistently with the hub. */
export const ISLAND_COLORS = COLORS;
