import * as THREE from "three";
import { COSTS } from "./config";
import { COLORS, glowMaterial, toyMaterial } from "./palette";
import { WEAPONS } from "./weapons";

/** What an interactable needs from the game to do its thing. Avoids a circular import. */
export interface GameApi {
  readonly points: number;
  spend(amount: number): boolean;
  giveWeapon(id: string): void;
  randomBoxWeapon(): string;
  grantPerk(perk: "tough" | "quick"): void;
  hasPerk(perk: "tough" | "quick"): boolean;
  toast(msg: string): void;
}

export interface Interactable {
  pos: THREE.Vector3;
  range: number;
  /** Prompt shown when in range. `null` = nothing to show (e.g. already owned). */
  prompt(game: GameApi): { text: string; affordable: boolean } | null;
  interact(game: GameApi): void;
  update(dt: number): void;
}

class WallBuy implements Interactable {
  readonly group = new THREE.Group();
  range = 2.6;
  constructor(public pos: THREE.Vector3, private weaponId: string, private cost: number) {
    const def = WEAPONS[weaponId];
    const panel = new THREE.Mesh(new THREE.BoxGeometry(2, 1.3, 0.2), glowMaterial(COLORS.wallBuy, 0.5));
    panel.position.copy(pos);
    panel.position.y = 1.6;
    this.group.add(panel);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.3, 0.3), toyMaterial(0x3a2f25));
    gun.position.copy(pos);
    gun.position.y = 1.6;
    gun.position.z += 0.2;
    this.group.add(gun);
    this.def = def;
  }
  private def;
  prompt(game: GameApi) {
    return { text: `[E] Buy ${this.def.name} — ${this.cost}`, affordable: game.points >= this.cost };
  }
  interact(game: GameApi) {
    if (game.spend(this.cost)) {
      game.giveWeapon(this.weaponId);
      game.toast(`${this.def.name}!`);
    }
  }
  update() {}
}

class MysteryBox implements Interactable {
  readonly group = new THREE.Group();
  range = 2.8;
  private lid: THREE.Mesh;
  private t = 0;
  constructor(public pos: THREE.Vector3, private cost: number) {
    const box = new THREE.Mesh(new THREE.BoxGeometry(1.8, 1.2, 1.4), toyMaterial(0x7a5a36));
    box.position.copy(pos);
    box.position.y = 0.6;
    box.castShadow = true;
    this.group.add(box);
    this.lid = new THREE.Mesh(new THREE.BoxGeometry(1.9, 0.3, 1.5), glowMaterial(COLORS.boxGold, 1.1));
    this.lid.position.copy(pos);
    this.lid.position.y = 1.3;
    this.lid.castShadow = true;
    this.group.add(this.lid);
    const glow = new THREE.PointLight(COLORS.boxGold, 6, 8, 2);
    glow.position.copy(pos);
    glow.position.y = 1.8;
    this.group.add(glow);
  }
  prompt(game: GameApi) {
    return { text: `[E] Mystery Box — ${this.cost}`, affordable: game.points >= this.cost };
  }
  interact(game: GameApi) {
    if (game.spend(this.cost)) {
      const id = game.randomBoxWeapon();
      game.giveWeapon(id);
      game.toast(`${WEAPONS[id].name}!`);
    }
  }
  update(dt: number) {
    this.t += dt;
    this.lid.position.y = 1.3 + Math.sin(this.t * 2) * 0.08;
    this.lid.rotation.y = this.t * 0.6;
  }
}

class PerkPad implements Interactable {
  readonly group = new THREE.Group();
  range = 2.4;
  private ring: THREE.Mesh;
  private t = 0;
  constructor(
    public pos: THREE.Vector3,
    private perk: "tough" | "quick",
    private cost: number,
    private label: string,
    color: number,
  ) {
    const pad = new THREE.Mesh(new THREE.CylinderGeometry(1.1, 1.1, 0.3, 20), glowMaterial(color, 0.8));
    pad.position.copy(pos);
    pad.position.y = 0.15;
    this.group.add(pad);
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.08, 8, 24), glowMaterial(color, 1.3));
    this.ring.position.copy(pos);
    this.ring.position.y = 1.4;
    this.ring.rotation.x = Math.PI / 2;
    this.group.add(this.ring);
    const light = new THREE.PointLight(color, 4, 7, 2);
    light.position.copy(pos);
    light.position.y = 1.2;
    this.group.add(light);
  }
  prompt(game: GameApi) {
    if (game.hasPerk(this.perk)) return null;
    return { text: `[E] ${this.label} — ${this.cost}`, affordable: game.points >= this.cost };
  }
  interact(game: GameApi) {
    if (game.hasPerk(this.perk)) return;
    if (game.spend(this.cost)) {
      game.grantPerk(this.perk);
      game.toast(`${this.label} acquired!`);
    }
  }
  update(dt: number) {
    this.t += dt;
    this.ring.rotation.z = this.t * 1.5;
    this.ring.position.y = 1.4 + Math.sin(this.t * 2.4) * 0.06;
  }
}

/** Builds and manages all the buyable things in the arena. */
export class Interactables {
  readonly list: Interactable[] = [];

  constructor(scene: THREE.Scene, half: number) {
    const items: { i: Interactable; group: THREE.Group }[] = [];

    const wall = new WallBuy(new THREE.Vector3(0, 0, -half + 1.5), "buzzgun", COSTS.wallBuy);
    const box = new MysteryBox(new THREE.Vector3(half - 6, 0, half - 6), COSTS.mysteryBox);
    const tough = new PerkPad(
      new THREE.Vector3(-half + 6, 0, -half + 6), "tough", COSTS.perkTough, "Tough (+HP)", COLORS.perkTough,
    );
    const quick = new PerkPad(
      new THREE.Vector3(half - 6, 0, -half + 6), "quick", COSTS.perkQuick, "Quick (speed+reload)", COLORS.perkQuick,
    );

    items.push({ i: wall, group: wall.group });
    items.push({ i: box, group: box.group });
    items.push({ i: tough, group: tough.group });
    items.push({ i: quick, group: quick.group });

    for (const { i, group } of items) {
      this.list.push(i);
      scene.add(group);
    }
  }

  update(dt: number) {
    for (const i of this.list) i.update(dt);
  }

  /** Nearest interactable within its range of `pos`, or null. */
  nearest(pos: THREE.Vector3): Interactable | null {
    let best: Interactable | null = null;
    let bestD = Infinity;
    for (const i of this.list) {
      const dx = i.pos.x - pos.x;
      const dz = i.pos.z - pos.z;
      const d = dx * dx + dz * dz;
      if (d < i.range * i.range && d < bestD) {
        best = i;
        bestD = d;
      }
    }
    return best;
  }
}
