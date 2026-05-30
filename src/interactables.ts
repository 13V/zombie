import * as THREE from "three";
import { RoundedBoxGeometry } from "three/examples/jsm/geometries/RoundedBoxGeometry.js";
import { COSTS, GUMS } from "./config";
import { COLORS, VOX, glowMaterial, voxelMaterial } from "./palette";
import { WEAPONS } from "./weapons";
import { GunStyle, buildGun } from "./gunModels";

/** Shared beveled unit cube, scaled per-mesh into chunky voxel forms. */
const BOX = new RoundedBoxGeometry(1, 1, 1, 2, 0.08);

/** Helper: a beveled voxel box at (x,y,z) sized (w,h,d) with the given material. */
function vox(
  w: number, h: number, d: number,
  x: number, y: number, z: number,
  mat: THREE.Material,
  shadow = false,
): THREE.Mesh {
  const m = new THREE.Mesh(BOX, mat);
  m.scale.set(w, h, d);
  m.position.set(x, y, z);
  if (shadow) m.castShadow = true;
  return m;
}

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
    const { x, z } = pos;
    const crateMat = voxelMaterial(VOX.crate);
    const crateDarkMat = voxelMaterial(VOX.crateDark);
    const steelMat = voxelMaterial(VOX.steelDark);
    // backing board / mounted crate
    this.group.add(vox(2.0, 1.4, 0.2, x, 1.6, z, crateMat, true));
    // crate plank frame (darker beveled trim)
    this.group.add(vox(2.0, 0.16, 0.26, x, 2.25, z, crateDarkMat));
    this.group.add(vox(2.0, 0.16, 0.26, x, 0.95, z, crateDarkMat));
    this.group.add(vox(0.16, 1.4, 0.26, x - 0.9, 1.6, z, crateDarkMat));
    this.group.add(vox(0.16, 1.4, 0.26, x + 0.9, 1.6, z, crateDarkMat));
    // pegs the rifle rests on
    this.group.add(vox(0.1, 0.1, 0.36, x - 0.5, 1.45, z + 0.2, steelMat));
    this.group.add(vox(0.1, 0.1, 0.36, x + 0.5, 1.45, z + 0.2, steelMat));
    // chunky voxel rifle: body + barrel + magazine + stock
    this.group.add(vox(1.0, 0.22, 0.22, x, 1.62, z + 0.34, steelMat, true));
    this.group.add(vox(0.62, 0.12, 0.12, x + 0.62, 1.62, z + 0.34, steelMat));
    this.group.add(vox(0.18, 0.34, 0.18, x - 0.12, 1.4, z + 0.34, voxelMaterial(VOX.toolboxDark)));
    this.group.add(vox(0.34, 0.18, 0.18, x - 0.56, 1.6, z + 0.34, crateDarkMat));
    // glowing "buyable" accent strip
    this.group.add(vox(2.0, 0.12, 0.06, x, 2.36, z + 0.12, glowMaterial(COLORS.wallBuy, 0.9)));
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
    const { x, z } = pos;
    const wood = voxelMaterial(VOX.crate);
    const woodDark = voxelMaterial(VOX.crateDark);
    const gold = glowMaterial(COLORS.boxGold, 0.6);

    // chunky voxel chest body
    const base = vox(1.5, 0.85, 1.05, x, 0.45, z, wood, true);
    base.receiveShadow = true;
    this.group.add(base);
    // gold trim bands on the body
    for (const dx of [-0.62, 0.62]) {
      this.group.add(vox(0.14, 0.9, 1.12, x + dx, 0.45, z, gold));
    }
    this.group.add(vox(0.28, 0.32, 0.12, x, 0.7, z + 0.56, gold)); // front clasp

    // lid on a hinge at the back-top edge (local coords inside the pivot)
    this.lidPivot.position.set(x, 0.86, z - 0.52);
    this.group.add(this.lidPivot);
    this.lidPivot.add(vox(1.5, 0.32, 1.05, 0, 0.16, 0.52, woodDark, true));
    for (const dx of [-0.62, 0.62]) {
      this.lidPivot.add(vox(0.14, 0.36, 1.1, dx, 0.16, 0.52, gold));
    }

    // where the prize floats while cycling
    this.prizeAnchor.position.set(x, 1.7, z);
    this.group.add(this.prizeAnchor);

    this.glow = new THREE.PointLight(COLORS.boxGold, 5, 9, 2);
    this.glow.position.set(x, 1.5, z + 0.4);
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
    const { x, z } = pos;
    const steelMat = voxelMaterial(VOX.steel);
    const steelDarkMat = voxelMaterial(VOX.steelDark);
    // chunky steel voxel machine body
    this.group.add(vox(1.8, 2.0, 1.2, x, 1.0, z, steelDarkMat, true));
    // bolted steel panel + side ribs
    this.group.add(vox(1.3, 1.4, 0.14, x, 1.2, z + 0.6, steelMat));
    this.group.add(vox(0.18, 2.0, 1.2, x - 0.9, 1.0, z, steelMat));
    this.group.add(vox(0.18, 2.0, 1.2, x + 0.9, 1.0, z, steelMat));
    // vent stack on top
    this.group.add(vox(0.4, 0.5, 0.4, x + 0.5, 2.25, z, steelDarkMat, true));
    // glowing intake slot
    this.group.add(vox(1.3, 0.3, 0.2, x, 1.5, z + 0.62, glowMaterial(VOX.rvWindow, 1.4)));
    // hovering halo ring above (glow accent the bloom catches)
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.6, 0.07, 8, 24), glowMaterial(COLORS.boxGold, 1.4));
    this.ring.position.set(x, 2.5, z);
    this.ring.rotation.x = Math.PI / 2;
    this.group.add(this.ring);
    const light = new THREE.PointLight(0x6ad7ff, 5, 8, 2);
    light.position.set(x, 2.0, z + 0.5);
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
    const { x, z } = pos;
    const bodyMat = voxelMaterial(VOX.toolbox);
    const bodyDarkMat = voxelMaterial(VOX.toolboxDark);
    // boxy voxel vending machine / cooler body
    this.group.add(vox(1.1, 2.2, 0.9, x, 1.1, z, bodyMat, true));
    // dark base + top trim
    this.group.add(vox(1.2, 0.3, 1.0, x, 0.15, z, bodyDarkMat, true));
    this.group.add(vox(1.2, 0.22, 1.0, x, 2.3, z, bodyDarkMat));
    // glowing display window on the front
    this.group.add(vox(0.8, 1.0, 0.12, x, 1.45, z + 0.46, glowMaterial(VOX.windowGlow, 0.7)));
    // dispense tray at the bottom
    this.group.add(vox(0.7, 0.28, 0.18, x, 0.6, z + 0.46, bodyDarkMat));
    // colored power-up gum voxels stacked behind the glass (GUMS colors)
    for (let i = 0; i < 6; i++) {
      const c = GUMS[i % GUMS.length].color;
      const col = i % 2;
      const row = Math.floor(i / 2);
      this.group.add(vox(0.26, 0.26, 0.1, x - 0.18 + col * 0.36, 1.15 + row * 0.34, z + 0.5, glowMaterial(c, 0.7)));
    }
    // spinning power-up display element (animated by update)
    this.globe = vox(0.34, 0.34, 0.34, x, 1.95, z + 0.3, glowMaterial(GUMS[0].color, 1.1));
    this.group.add(this.globe);
    const light = new THREE.PointLight(0xff7ab0, 3, 6, 2);
    light.position.set(x, 1.7, z + 0.4);
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
    this.globe.position.y = 1.95 + Math.sin(this.t * 2) * 0.05;
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
    const { x, z } = pos;
    // voxel rubble pile (beveled rock voxels) — blocks the spot until cleared
    for (let i = 0; i < 9; i++) {
      const s = 0.5 + Math.random() * 0.5;
      const rock = vox(
        s, s, s,
        x + (Math.random() - 0.5) * 1.6,
        0.2 + Math.random() * 0.7,
        z + (Math.random() - 0.5) * 1.0,
        voxelMaterial(i % 2 ? VOX.rock : VOX.rockDark),
        true,
      );
      rock.rotation.set(Math.random() * 0.4, Math.random(), Math.random() * 0.4);
      this.rubble.add(rock);
    }
    // glowing hazard-tape accent
    const tape = vox(2.2, 0.14, 0.06, x, 1.0, z + 0.2, glowMaterial(VOX.emberHot, 0.9));
    tape.rotation.z = -0.12;
    this.rubble.add(tape);
    this.group.add(this.rubble);

    // hidden voxel weapon stall/crate revealed after clearing
    const def = WEAPONS[weaponId];
    const crateMat = voxelMaterial(VOX.crate);
    const crateDarkMat = voxelMaterial(VOX.crateDark);
    const steelMat = voxelMaterial(VOX.steelDark);
    this.stall.add(vox(2.0, 1.4, 0.2, x, 1.6, z, crateMat, true));
    this.stall.add(vox(2.0, 0.16, 0.26, x, 2.25, z, crateDarkMat));
    this.stall.add(vox(2.0, 0.16, 0.26, x, 0.95, z, crateDarkMat));
    // chunky voxel rifle on the stall
    this.stall.add(vox(1.0, 0.22, 0.22, x, 1.62, z + 0.32, steelMat, true));
    this.stall.add(vox(0.6, 0.12, 0.12, x + 0.6, 1.62, z + 0.32, steelMat));
    this.stall.add(vox(0.18, 0.34, 0.18, x - 0.12, 1.4, z + 0.32, voxelMaterial(VOX.toolboxDark)));
    this.stall.add(vox(2.0, 0.12, 0.06, x, 2.36, z + 0.12, glowMaterial(COLORS.wallBuy, 0.9)));
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
    const { x, z } = pos;
    // chunky voxel supply pad on the ground, in the perk color
    this.group.add(vox(2.0, 0.3, 2.0, x, 0.15, z, voxelMaterial(VOX.steelDark)));
    this.group.add(vox(1.5, 0.22, 1.5, x, 0.34, z, glowMaterial(color, 0.8)));
    // a low voxel crate marker in the middle
    this.group.add(vox(0.7, 0.6, 0.7, x, 0.6, z, voxelMaterial(VOX.crate), true));
    this.ring = new THREE.Mesh(new THREE.TorusGeometry(0.8, 0.08, 8, 24), glowMaterial(color, 1.3));
    this.ring.position.set(x, 1.4, z);
    this.ring.rotation.x = Math.PI / 2;
    this.group.add(this.ring);
    const light = new THREE.PointLight(color, 4, 7, 2);
    light.position.set(x, 1.2, z);
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
