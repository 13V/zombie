import * as THREE from "three";
import { COSTS, GUMS } from "./config";
import { COLORS, glowMaterial, toyMaterial } from "./palette";
import { WEAPONS } from "./weapons";
import { GunStyle, buildGun } from "./gunModels";

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
  /** Dispense a random Gobblegum power-up. */
  giveRandomGum(): void;
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
 * The Mystery Box as a **COD-style treasure chest**: spend points, the lid
 * springs open, weapon models tumble up and cycle faster→slower, the cycle
 * lands on one gun which rises and glows — that's the weapon you get — then the
 * lid closes. The award is decided up front; the cycling is pure showmanship.
 */
const CYCLE_STYLES: GunStyle[] = ["pistol", "smg", "shotgun", "cannon", "rifle", "arc", "singularity", "pyroclasm"];
type ChestPhase = "idle" | "opening" | "cycling" | "reveal" | "closing";
const LID_OPEN = -1.95; // radians

class MysteryChest implements Interactable {
  readonly group = new THREE.Group();
  range = 2.9;
  private lidPivot = new THREE.Group();
  private prizeAnchor = new THREE.Group();
  private gun?: THREE.Group;
  private glow: THREE.PointLight;
  private t = 0;
  private phase: ChestPhase = "idle";
  private timer = 0;
  private swapAccum = 0;
  private awardStyle: GunStyle = "pistol";
  private pending?: () => void;

  constructor(public pos: THREE.Vector3, private cost: number) {
    const wood = toyMaterial(0x6e4a2c);
    const gold = glowMaterial(COLORS.boxGold, 0.6);

    // chest body
    const base = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.85, 1.05), wood);
    base.position.set(pos.x, 0.45, pos.z);
    base.castShadow = true;
    base.receiveShadow = true;
    this.group.add(base);
    // gold trim bands on the body
    for (const dx of [-0.62, 0.62]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.9, 1.12), gold);
      band.position.set(pos.x + dx, 0.45, pos.z);
      this.group.add(band);
    }
    const clasp = new THREE.Mesh(new THREE.BoxGeometry(0.26, 0.3, 0.12), gold);
    clasp.position.set(pos.x, 0.7, pos.z + 0.56);
    this.group.add(clasp);

    // lid on a hinge at the back-top edge
    this.lidPivot.position.set(pos.x, 0.86, pos.z - 0.52);
    this.group.add(this.lidPivot);
    const lid = new THREE.Mesh(new THREE.BoxGeometry(1.5, 0.32, 1.05), wood);
    lid.position.set(0, 0.16, 0.52);
    lid.castShadow = true;
    this.lidPivot.add(lid);
    for (const dx of [-0.62, 0.62]) {
      const band = new THREE.Mesh(new THREE.BoxGeometry(0.12, 0.36, 1.1), gold);
      band.position.set(dx, 0.16, 0.52);
      this.lidPivot.add(band);
    }

    // where the prize floats while cycling
    this.prizeAnchor.position.set(pos.x, 1.7, pos.z);
    this.group.add(this.prizeAnchor);

    this.glow = new THREE.PointLight(COLORS.boxGold, 5, 9, 2);
    this.glow.position.set(pos.x, 1.5, pos.z + 0.4);
    this.group.add(this.glow);
  }

  prompt(game: GameApi) {
    if (this.phase !== "idle") return null;
    return { text: `[E] Mystery Box — ${this.cost}`, affordable: game.points >= this.cost };
  }

  interact(game: GameApi) {
    if (this.phase !== "idle") return;
    if (!game.spend(this.cost)) return;
    const id = game.randomBoxWeapon();
    this.awardStyle = WEAPONS[id].style;
    this.phase = "opening";
    this.timer = 0.45;
    this.pending = () => {
      game.giveWeapon(id);
      game.toast(`${WEAPONS[id].name}!`);
    };
  }

  private disposeGun() {
    // gun meshes share one geometry — only the per-mesh materials need freeing
    this.gun?.traverse((o) => {
      const m = (o as THREE.Mesh).material as THREE.Material | undefined;
      m?.dispose?.();
    });
  }

  private showGun(style: GunStyle) {
    this.disposeGun();
    this.prizeAnchor.clear();
    this.gun = buildGun(style);
    this.gun.scale.setScalar(1.7);
    this.prizeAnchor.add(this.gun);
  }

  update(dt: number) {
    this.t += dt;
    this.glow.intensity = 4 + Math.sin(this.t * 3) * 1.5;

    switch (this.phase) {
      case "idle":
        break;

      case "opening": {
        this.timer -= dt;
        const k = 1 - Math.max(0, this.timer) / 0.45;
        this.lidPivot.rotation.x = LID_OPEN * (1 - (1 - k) * (1 - k)); // ease-out
        if (this.timer <= 0) {
          this.phase = "cycling";
          this.timer = 2.2;
          this.swapAccum = 0;
        }
        break;
      }

      case "cycling": {
        this.timer -= dt;
        if (this.gun) this.gun.rotation.y += dt * 9;
        this.swapAccum -= dt;
        if (this.swapAccum <= 0) {
          this.showGun(CYCLE_STYLES[Math.floor(Math.random() * CYCLE_STYLES.length)]);
          const prog = 1 - Math.max(0, this.timer) / 2.2; // 0→1; intervals grow (decel)
          this.swapAccum = 0.05 + prog * prog * 0.28;
        }
        if (this.timer <= 0) {
          this.phase = "reveal";
          this.timer = 1.3;
          this.showGun(this.awardStyle); // land on the actual prize
        }
        break;
      }

      case "reveal": {
        this.timer -= dt;
        const rk = 1 - Math.max(0, this.timer) / 1.3;
        if (this.gun) {
          this.gun.rotation.y += dt * 3;
          this.gun.position.y = rk * 0.45;
          this.gun.scale.setScalar(1.7 + Math.sin(this.t * 6) * 0.1);
        }
        this.glow.intensity = 8 + Math.sin(this.t * 10) * 3;
        if (this.timer <= 0) {
          this.pending?.(); // hand over the weapon
          this.pending = undefined;
          this.phase = "closing";
          this.timer = 0.4;
        }
        break;
      }

      case "closing": {
        this.timer -= dt;
        this.lidPivot.rotation.x = LID_OPEN * Math.max(0, this.timer) / 0.4;
        if (this.timer <= 0) {
          this.lidPivot.rotation.x = 0;
          this.disposeGun();
          this.prizeAnchor.clear();
          this.gun = undefined;
          this.phase = "idle";
        }
        break;
      }
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

/**
 * Bubblegum machine — a gumball globe that dispenses a random COD-style
 * power-up (Double Points, Insta-Kill, Rapid Fire, Sugar Rush, Full Pockets).
 */
class Bubblegum implements Interactable {
  readonly group = new THREE.Group();
  range = 2.5;
  private globe: THREE.Mesh;
  private t = 0;
  constructor(public pos: THREE.Vector3, private cost: number) {
    const base = new THREE.Mesh(new THREE.CylinderGeometry(0.55, 0.7, 0.9, 16), toyMaterial(0xd23b3b));
    base.position.set(pos.x, 0.45, pos.z);
    base.castShadow = true;
    this.group.add(base);
    const neck = new THREE.Mesh(new THREE.CylinderGeometry(0.45, 0.55, 0.25, 16), toyMaterial(0xf0c33a));
    neck.position.set(pos.x, 0.95, pos.z);
    this.group.add(neck);
    // glass globe
    this.globe = new THREE.Mesh(
      new THREE.SphereGeometry(0.62, 18, 14),
      new THREE.MeshStandardMaterial({ color: 0xeaf6ff, roughness: 0.1, metalness: 0, transparent: true, opacity: 0.35 }),
    );
    this.globe.position.set(pos.x, 1.65, pos.z);
    this.group.add(this.globe);
    // candy gumballs in the colors of the actual gums
    for (let i = 0; i < 14; i++) {
      const c = GUMS[i % GUMS.length].color;
      const ball = new THREE.Mesh(new THREE.SphereGeometry(0.12, 8, 8), glowMaterial(c, 0.6));
      const a = Math.random() * Math.PI * 2;
      const rr = Math.random() * 0.36;
      ball.position.set(pos.x + Math.cos(a) * rr, 1.45 + Math.random() * 0.35, pos.z + Math.sin(a) * rr);
      this.group.add(ball);
    }
    const light = new THREE.PointLight(0xff7ab0, 3, 6, 2);
    light.position.set(pos.x, 1.7, pos.z + 0.4);
    this.group.add(light);
  }
  prompt(game: GameApi) {
    return { text: `[E] Bubblegum — ${this.cost}`, affordable: game.points >= this.cost };
  }
  interact(game: GameApi) {
    if (game.spend(this.cost)) game.giveRandomGum();
  }
  update(dt: number) {
    this.t += dt;
    this.globe.rotation.y = this.t * 0.8;
    this.globe.position.y = 1.65 + Math.sin(this.t * 2) * 0.03;
  }
}

/**
 * A buyable map spot: a rubble pile you clear with points to "unlock" the area,
 * which reveals a wall-buy weapon stall behind it. Two-phase interactable.
 */
class DebrisGate implements Interactable {
  readonly group = new THREE.Group();
  range = 2.7;
  private rubble = new THREE.Group();
  private stall = new THREE.Group();
  private cleared = false;
  constructor(
    public pos: THREE.Vector3,
    private clearCost: number,
    private weaponId: string,
    private buyCost: number,
  ) {
    // rubble pile (blocks the spot until cleared)
    for (let i = 0; i < 9; i++) {
      const s = 0.5 + Math.random() * 0.5;
      const rock = new THREE.Mesh(new THREE.BoxGeometry(s, s, s), toyMaterial(i % 2 ? 0x8a8a80 : 0x6f6f66));
      rock.position.set(pos.x + (Math.random() - 0.5) * 1.6, 0.2 + Math.random() * 0.7, pos.z + (Math.random() - 0.5) * 1.0);
      rock.rotation.set(Math.random(), Math.random(), Math.random());
      rock.castShadow = true;
      this.rubble.add(rock);
    }
    const tape = new THREE.Mesh(new THREE.BoxGeometry(2.2, 0.12, 0.12), glowMaterial(0xffd24a, 0.8));
    tape.position.set(pos.x, 1.0, pos.z + 0.2);
    this.rubble.add(tape);
    this.group.add(this.rubble);

    // hidden weapon stall revealed after clearing
    const def = WEAPONS[weaponId];
    const panel = new THREE.Mesh(new THREE.BoxGeometry(2, 1.3, 0.2), glowMaterial(COLORS.wallBuy, 0.5));
    panel.position.set(pos.x, 1.6, pos.z);
    this.stall.add(panel);
    const gun = new THREE.Mesh(new THREE.BoxGeometry(1.1, 0.3, 0.3), toyMaterial(0x3a2f25));
    gun.position.set(pos.x, 1.6, pos.z + 0.2);
    this.stall.add(gun);
    this.stall.visible = false;
    this.group.add(this.stall);
    this.def = def;
  }
  private def;
  prompt(game: GameApi) {
    if (!this.cleared) {
      return { text: `[E] Clear rubble — ${this.clearCost}`, affordable: game.points >= this.clearCost };
    }
    return { text: `[E] Buy ${this.def.name} — ${this.buyCost}`, affordable: game.points >= this.buyCost };
  }
  interact(game: GameApi) {
    if (!this.cleared) {
      if (game.spend(this.clearCost)) {
        this.cleared = true;
        this.rubble.visible = false;
        this.stall.visible = true;
        game.toast("Area unlocked!");
      }
    } else if (game.spend(this.buyCost)) {
      game.giveWeapon(this.weaponId);
      game.toast(`${this.def.name}!`);
    }
  }
  update() {}
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
    const wheel = new MysteryChest(new THREE.Vector3(half - 6, 0, half - 6), COSTS.mysteryBox);
    const pap = new PackAPunch(new THREE.Vector3(-half + 6, 0, half - 6), COSTS.packAPunch);
    const gum = new Bubblegum(new THREE.Vector3(5, 0, 9), COSTS.gobblegum);
    const tough = new PerkPad(
      new THREE.Vector3(-half + 6, 0, -half + 6), "tough", COSTS.perkTough, "Tough (+HP)", COLORS.perkTough,
    );
    const quick = new PerkPad(
      new THREE.Vector3(half - 6, 0, -half + 6), "quick", COSTS.perkQuick, "Quick (speed+reload)", COLORS.perkQuick,
    );
    // buyable map spots: clear rubble to reveal a wall-buy weapon stall
    const gateW = new DebrisGate(new THREE.Vector3(-half + 3, 0, 0), COSTS.debris, "boomstick", COSTS.wallBuy + 500);
    const gateE = new DebrisGate(new THREE.Vector3(half - 3, 0, 0), COSTS.debris, "marksman", COSTS.wallBuy + 1500);

    items.push({ i: wall, group: wall.group });
    items.push({ i: wheel, group: wheel.group });
    items.push({ i: pap, group: pap.group });
    items.push({ i: gum, group: gum.group });
    items.push({ i: tough, group: tough.group });
    items.push({ i: quick, group: quick.group });
    items.push({ i: gateW, group: gateW.group });
    items.push({ i: gateE, group: gateE.group });

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
