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
  /** Pack-a-Punch the currently equipped weapon. */
  upgradeCurrentWeapon(): void;
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

/**
 * The Mystery Box, reskinned as a Kintara-style **prize wheel**: a wheel of
 * fortune on a little stand. Spend points, it spins up, decelerates, and lands
 * on a random weapon. Mechanically identical to the old box.
 */
class PrizeWheel implements Interactable {
  readonly group = new THREE.Group();
  range = 2.9;
  private wheel = new THREE.Group(); // spinning part
  private t = 0;
  private spinning = false;
  private spinTimer = 0;
  private spinVel = 0;
  private pending?: () => void;

  // segment colors — bright, candy-ish, reads as a fortune wheel
  private static readonly SEG = [
    0xff6f91, 0x6ad7ff, 0xffd24a, 0x8fcf6f, 0xc792ea, 0xff9f43, 0x4ec9ff, 0xff5d8f,
  ];

  constructor(public pos: THREE.Vector3, private cost: number) {
    // base + posts (the stand)
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.9, 1.05, 0.5, 16), toyMaterial(0x6e4a2c));
    base.position.set(pos.x, 0.25, pos.z);
    base.castShadow = true;
    this.group.add(base);
    for (const dx of [-0.7, 0.7]) {
      const post = new THREE.Mesh(new THREE.BoxGeometry(0.18, 1.7, 0.18), toyMaterial(0x8a6a3a));
      post.position.set(pos.x + dx, 1.25, pos.z);
      post.castShadow = true;
      this.group.add(post);
    }

    // the wheel itself, tilted back so the diorama camera sees its face
    this.wheel.position.set(pos.x, 2.1, pos.z);
    this.wheel.rotation.x = -0.32;
    this.group.add(this.wheel);

    const disc = new THREE.Mesh(new THREE.CylinderGeometry(1.05, 1.05, 0.18, 24), glowMaterial(COLORS.boxGold, 0.5));
    disc.rotation.x = Math.PI / 2; // circular face toward +Z (camera)
    this.wheel.add(disc);

    const n = PrizeWheel.SEG.length;
    for (let i = 0; i < n; i++) {
      const a = (i / n) * Math.PI * 2;
      // colored prize gem near the rim
      const gem = new THREE.Mesh(new THREE.BoxGeometry(0.34, 0.34, 0.16), glowMaterial(PrizeWheel.SEG[i], 1.0));
      gem.position.set(Math.cos(a) * 0.66, Math.sin(a) * 0.66, 0.12);
      gem.rotation.z = a;
      this.wheel.add(gem);
      // divider spoke
      const spoke = new THREE.Mesh(new THREE.BoxGeometry(0.05, 1.9, 0.05), toyMaterial(0x4a3522));
      spoke.position.z = 0.1;
      spoke.rotation.z = a + Math.PI / n;
      this.wheel.add(spoke);
    }
    const hub = new THREE.Mesh(new THREE.CylinderGeometry(0.22, 0.22, 0.24, 16), glowMaterial(0xffffff, 1.2));
    hub.rotation.x = Math.PI / 2;
    hub.position.z = 0.14;
    this.wheel.add(hub);

    // fixed pointer at the top (does not spin)
    const pointer = new THREE.Mesh(new THREE.ConeGeometry(0.18, 0.4, 4), glowMaterial(0xffffff, 1.4));
    pointer.position.set(pos.x, 3.2, pos.z + 0.2);
    pointer.rotation.x = Math.PI; // point down into the wheel
    this.group.add(pointer);

    const glow = new THREE.PointLight(COLORS.boxGold, 6, 9, 2);
    glow.position.set(pos.x, 2.4, pos.z + 0.6);
    this.group.add(glow);
  }

  prompt(game: GameApi) {
    if (this.spinning) return null;
    return { text: `[E] Prize Wheel — ${this.cost}`, affordable: game.points >= this.cost };
  }

  interact(game: GameApi) {
    if (this.spinning) return;
    if (game.spend(this.cost)) {
      const id = game.randomBoxWeapon();
      this.spinning = true;
      this.spinTimer = 1.7;
      this.spinVel = 18; // rad/s, decays over the spin
      this.pending = () => {
        game.giveWeapon(id);
        game.toast(`${WEAPONS[id].name}!`);
      };
    }
  }

  update(dt: number) {
    this.t += dt;
    if (this.spinning) {
      this.spinTimer -= dt;
      this.spinVel *= Math.pow(0.12, dt); // ease-out deceleration
      this.wheel.rotation.z += this.spinVel * dt;
      if (this.spinTimer <= 0) {
        this.spinning = false;
        this.pending?.();
        this.pending = undefined;
      }
    } else {
      this.wheel.rotation.z += dt * 0.5; // gentle idle spin
    }
  }
}

/**
 * Pack-a-Punch machine: upgrades the player's current weapon in place.
 */
class PackAPunch implements Interactable {
  readonly group = new THREE.Group();
  range = 2.6;
  private ring: THREE.Mesh;
  private t = 0;
  constructor(public pos: THREE.Vector3, private cost: number) {
    const body = new THREE.Mesh(new THREE.BoxGeometry(1.8, 2.0, 1.2), toyMaterial(0x2f3b4a));
    body.position.set(pos.x, 1.0, pos.z);
    body.castShadow = true;
    this.group.add(body);
    // glowing intake slot
    const slot = new THREE.Mesh(new THREE.BoxGeometry(1.3, 0.3, 0.2), glowMaterial(0x6ad7ff, 1.4));
    slot.position.set(pos.x, 1.5, pos.z + 0.62);
    this.group.add(slot);
    // hovering halo ring above
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.07, 8, 24), glowMaterial(COLORS.boxGold, 1.4));
    this.ring.position.set(pos.x, 2.5, pos.z);
    this.ring.rotation.x = Math.PI / 2;
    this.group.add(this.ring);
    const light = new THREE.PointLight(0x6ad7ff, 5, 8, 2);
    light.position.set(pos.x, 2.0, pos.z + 0.5);
    this.group.add(light);
  }
  prompt(game: GameApi) {
    return { text: `[E] Pack-a-Punch — ${this.cost}`, affordable: game.points >= this.cost };
  }
  interact(game: GameApi) {
    game.upgradeCurrentWeapon();
  }
  update(dt: number) {
    this.t += dt;
    this.ring.rotation.z = this.t * 1.4;
    this.ring.position.y = 2.5 + Math.sin(this.t * 2.2) * 0.07;
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
    const wheel = new PrizeWheel(new THREE.Vector3(half - 6, 0, half - 6), COSTS.mysteryBox);
    const pap = new PackAPunch(new THREE.Vector3(-half + 6, 0, half - 6), COSTS.packAPunch);
    const tough = new PerkPad(
      new THREE.Vector3(-half + 6, 0, -half + 6), "tough", COSTS.perkTough, "Tough (+HP)", COLORS.perkTough,
    );
    const quick = new PerkPad(
      new THREE.Vector3(half - 6, 0, -half + 6), "quick", COSTS.perkQuick, "Quick (speed+reload)", COLORS.perkQuick,
    );

    items.push({ i: wall, group: wall.group });
    items.push({ i: wheel, group: wheel.group });
    items.push({ i: pap, group: pap.group });
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
