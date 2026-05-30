import "./style.css";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { CAMERA, COSTS, PLAYER, SCORE, ZOMBIE } from "./config";
import { glowMaterial } from "./palette";
import { Input } from "./input";
import { Arena } from "./arena";
import { Player } from "./player";
import { RoundManager } from "./rounds";
import { Zombie } from "./zombie";
import { BulletSystem, Weapon, WEAPONS, BOX_POOL, WONDER_POOL } from "./weapons";
import { Interactables, GameApi } from "./interactables";
import { Hud } from "./hud";
import { AssetManager } from "./assets";
import { Powerups } from "./powerups";
import { FloatingText } from "./feedback";
import { Audio } from "./audio";
import { Combo } from "./combo";
import { Drops, DropKind } from "./drops";
import { RunMods, defaultMods, cloneMods, diffMods } from "./mods";
import { loadSave, writeSave, SaveData } from "./save";
import { META_UPGRADES, essenceFor } from "./meta";
import { RUN_UPGRADES, rollUpgrades, RunUpgrade } from "./upgrades";
import { NetClient, InputMsg, ZombieSnap } from "./net";
import { NetPlay } from "./netplay";
import { COLORS } from "./palette";
import { TiltShift } from "./tiltShift";

/** Tiny pooled "poof" particles for kill feedback. */
class Puffs {
  private pool: THREE.Mesh[] = [];
  private active: { m: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];
  private geo = new THREE.SphereGeometry(0.18, 6, 6);
  constructor(private scene: THREE.Scene) {}
  burst(pos: THREE.Vector3, color: number, count = 8) {
    for (let i = 0; i < count; i++) {
      let m = this.pool.pop();
      if (!m) m = new THREE.Mesh(this.geo, glowMaterial(color, 0.8));
      (m.material as THREE.MeshStandardMaterial).color.set(color);
      (m.material as THREE.MeshStandardMaterial).emissive.set(color);
      m.position.copy(pos);
      m.position.y = 1;
      m.scale.setScalar(1);
      m.visible = true;
      this.scene.add(m);
      const a = Math.random() * Math.PI * 2;
      const up = 2 + Math.random() * 3;
      this.active.push({
        m,
        vel: new THREE.Vector3(Math.cos(a) * 3, up, Math.sin(a) * 3),
        life: 0.5,
      });
    }
  }
  update(dt: number) {
    for (let i = this.active.length - 1; i >= 0; i--) {
      const p = this.active[i];
      p.life -= dt;
      p.vel.y -= 12 * dt;
      p.m.position.addScaledVector(p.vel, dt);
      p.m.scale.setScalar(Math.max(0.01, p.life * 2));
      if (p.life <= 0) {
        p.m.visible = false;
        this.scene.remove(p.m);
        this.pool.push(p.m);
        this.active.splice(i, 1);
      }
    }
  }
}

type State = "menu" | "playing" | "paused" | "over" | "levelup";

class Game implements GameApi {
  private renderer: THREE.WebGLRenderer;
  private scene = new THREE.Scene();
  private camera: THREE.OrthographicCamera;
  private viewSize = 15; // half-height of the orthographic view, in world units
  private composer: EffectComposer;
  private clock = new THREE.Clock();

  private input: Input;
  private arena: Arena;
  private player: Player;
  private bullets: BulletSystem;
  private rounds: RoundManager;
  private interactables: Interactables;
  private hud: Hud;
  private puffs: Puffs;
  private floaters: FloatingText;
  private drops: Drops;
  private audio = new Audio();
  private combo = new Combo();
  private hitStop = 0; // seconds of remaining sim freeze (game feel)

  // progression
  private save: SaveData = loadSave();
  private mods: RunMods = defaultMods();
  // level-up picker state
  private levelNum = 0;
  private levelCards: RunUpgrade[] = [];
  private rerollCost = 0;
  private levelPicking = false;

  points = 0;
  private weapons: Weapon[] = [];
  private activeSlot = 0;
  private perks = new Set<"tough" | "quick">();
  private powerups = new Powerups();
  private state: State = "menu";

  // multiplayer (undefined = single-player)
  private net?: NetClient;
  private netplay?: NetPlay;
  private myId = 1;

  private tilt: TiltShift;

  private camTarget = new THREE.Vector3();
  private shake = 0;
  private _v2 = new THREE.Vector3();

  constructor(private assets: AssetManager) {
    const canvas = document.getElementById("scene") as HTMLCanvasElement;
    const ui = document.getElementById("ui") as HTMLElement;

    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: true });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 2));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.05;
    this.renderer.outputColorSpace = THREE.SRGBColorSpace;

    // Orthographic = true isometric look (no perspective convergence), like both refs.
    const aspect = innerWidth / innerHeight;
    this.camera = new THREE.OrthographicCamera(
      -this.viewSize * aspect, this.viewSize * aspect, this.viewSize, -this.viewSize, 0.1, 1000,
    );
    this.camera.position.set(CAMERA.offset.x, CAMERA.offset.y, CAMERA.offset.z);
    this.camera.lookAt(0, 0, 0);

    // Soft image-based ambient light — the key to the "soft 3D" cozy look.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.55;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth, innerHeight), 0.45, 0.6, 0.86);
    this.composer.addPass(bloom);
    this.tilt = new TiltShift(innerWidth, innerHeight, { focus: 0.58, band: 0.2, strength: 3.0, vignette: 0.4 });
    this.composer.addPass(this.tilt.horizontal);
    this.composer.addPass(this.tilt.vertical);
    this.composer.addPass(new OutputPass());

    this.input = new Input(canvas);
    this.arena = new Arena(this.scene);
    this.player = new Player(this.scene, this.assets);
    this.bullets = new BulletSystem(this.scene);
    this.rounds = new RoundManager(this.scene, this.assets);
    this.interactables = new Interactables(this.scene, this.arena.half);
    this.puffs = new Puffs(this.scene);
    this.floaters = new FloatingText(this.scene);
    this.drops = new Drops(this.scene);
    this.hud = new Hud(ui);

    // Resume audio on the first user gesture (browser autoplay policy).
    const unlock = () => this.audio.unlock();
    addEventListener("pointerdown", unlock, { once: true });
    addEventListener("keydown", unlock, { once: true });
    this.audio.setEnabled(!this.save.muted);

    // Menu progression UI (best run + Essence shop).
    this.hud.setBest(this.save.bestRound, this.save.bestScore);
    this.renderMetaShop();

    this.rounds.onRoundStart = (n) => {
      this.hud.setRound(n);
      if (n > 1) this.hud.toast(this.rounds.isBossRound ? `Round ${n} — BOSS` : `Round ${n}`);
      this.audio.roundStart();
      this.audio.setIntensity(n / 20);
    };
    this.rounds.onIntermission = () => {
      const cleared = this.rounds.round;
      const bonus = SCORE.roundBonusBase + (cleared - 1) * SCORE.roundBonusPerRound;
      this.addPoints(bonus);
      this.hud.toast(`Round clear  +${bonus}`);
      // Solo: offer a level-up pick during the breather (skipped in co-op).
      if (!this.netplay) this.offerLevelUp();
    };
    this.rounds.onBossSpawn = () => {
      this.audio.roundStart();
      this.hud.toast("A BOSS APPROACHES");
      this.shake = Math.min(0.6, this.shake + 0.4);
    };

    this.hud.onStart(() => this.startRun());
    this.hud.onRestart(() => this.startRun());
    this.hud.onMenu(() => this.toMenu());
    this.hud.onHost(() => this.hostGame());
    this.hud.onJoin((code) => this.joinGame(code));

    addEventListener("resize", this.onResize);
    this.onResize();
    this.hud.showStart();

    this.resetRun(); // place player + default weapon so the menu scene looks alive
    requestAnimationFrame(this.loop);
  }

  // ---- run lifecycle ----
  private resetRun() {
    // Rebuild this run's modifier bundle from owned permanent meta-upgrades.
    this.mods = defaultMods();
    for (const u of META_UPGRADES) if (this.save.owned.includes(u.id)) u.apply(this.mods);

    this.player.reset();
    this.player.maxHealth = PLAYER.maxHealth + this.mods.maxHealthBonus;
    this.player.health = this.player.maxHealth;
    this.player.pos.set(0, 0, 9); // start on the plaza, south of the fountain
    this.player.group.position.copy(this.player.pos);
    this.bullets.clear();
    this.rounds.reset();
    this.points = SCORE.startingPoints + this.mods.startPointsBonus;
    const starter = this.mods.startWeapon && WEAPONS[this.mods.startWeapon] ? WEAPONS[this.mods.startWeapon] : WEAPONS.peashooter;
    this.weapons = [new Weapon(starter)];
    this.activeSlot = 0;
    this.perks.clear();
    this.powerups.clear();
    this.levelNum = 0;
    this.levelPicking = false;
    this.combo.windowBonus = this.mods.comboWindowBonus;
    this.hud.setPowerups([]);
    this.shake = 0;
    this.combo.reset();
    this.floaters.clear();
    this.drops.clear();
    this.hitStop = 0;
    this.hud.setCombo(0, 0);
    this.hud.hideBoss();
    this.hud.hideLevelUp();
    this.hud.setPoints(this.points);
    this.hud.setRound(1);
    if (!this.netplay) this.hud.hideRoomCode();
    this.syncWeaponHud();
  }

  // ---- progression / menus ----
  private renderMetaShop() {
    const rows = META_UPGRADES.map((u) => ({
      id: u.id,
      name: u.name,
      desc: u.desc,
      cost: u.cost,
      owned: this.save.owned.includes(u.id),
      affordable: this.save.essence >= u.cost,
    }));
    this.hud.renderMeta(this.save.essence, rows, (id) => this.buyMeta(id));
  }

  private buyMeta(id: string) {
    const u = META_UPGRADES.find((m) => m.id === id);
    if (!u || this.save.owned.includes(id)) return;
    if (this.save.essence < u.cost) {
      this.audio.deny();
      return;
    }
    this.save.essence -= u.cost;
    this.save.owned.push(id);
    writeSave(this.save);
    this.audio.powerup();
    this.renderMetaShop();
  }

  /** Return to the main menu (from the game-over screen) to spend Essence. */
  private toMenu() {
    this.teardownNet();
    this.state = "menu";
    this.resetRun();
    this.hud.hideGameOver();
    this.hud.setBest(this.save.bestRound, this.save.bestScore);
    this.renderMetaShop();
    this.hud.showStart();
  }

  /** Pause the breather and offer 1 of 3 stacking run upgrades. */
  private offerLevelUp() {
    this.levelNum++;
    this.levelCards = rollUpgrades(3);
    this.rerollCost = 500;
    this.levelPicking = false;
    this.state = "levelup";
    this.audio.levelUp();
    this.renderLevelUp();
  }

  /** Build card view-models (with live stat previews) and hand them to the HUD. */
  private renderLevelUp() {
    const cards = this.levelCards.map((u) => {
      const after = cloneMods(this.mods);
      u.apply(after);
      return { id: u.id, name: u.name, desc: u.desc, icon: u.icon, color: u.color, tier: u.tier, deltas: diffMods(this.mods, after) };
    });
    this.hud.showLevelUp({
      level: this.levelNum,
      cards,
      rerollCost: this.rerollCost,
      canReroll: this.points >= this.rerollCost,
      onPick: (id) => this.applyUpgrade(id),
      onReroll: () => this.rerollLevel(),
    });
  }

  /** Spend points to re-roll the three offered cards (cost escalates). */
  private rerollLevel() {
    if (this.levelPicking) return;
    if (!this.spend(this.rerollCost)) return; // handles "can't afford" feedback
    this.rerollCost += 250;
    this.levelCards = rollUpgrades(3);
    this.audio.ui();
    this.renderLevelUp();
  }

  private applyUpgrade(id: string) {
    if (this.levelPicking) return;
    const u = RUN_UPGRADES.find((x) => x.id === id);
    if (!u) return;
    this.levelPicking = true;
    u.apply(this.mods);
    // a few upgrades change live state immediately
    this.player.maxHealth = PLAYER.maxHealth + this.mods.maxHealthBonus;
    this.player.heal(25); // small reward heal on every pick
    this.combo.windowBonus = this.mods.comboWindowBonus;
    this.hud.toast(`${u.name}!`);
    this.audio.powerup();
    // let the card's selection animation finish before unfreezing the game
    setTimeout(() => {
      this.hud.hideLevelUp();
      this.levelPicking = false;
      if (this.state === "levelup") this.state = "playing";
    }, 420);
  }

  private startRun() {
    this.resetRun();
    this.hud.hideStart();
    this.hud.hideGameOver();
    this.state = "playing";
    this.rounds.start();
    this.audio.startMusic(0);
  }

  private gameOver() {
    this.state = "over";
    this.input.firing = false;
    this.audio.stopMusic();
    this.audio.hurt();
    this.hud.hideBoss();

    // Every run pays out Essence and may set a new personal best.
    const earned = essenceFor(this.rounds.round, this.points, this.mods.essenceMul);
    this.save.essence += earned;
    const newBest = this.rounds.round > this.save.bestRound || (this.rounds.round === this.save.bestRound && this.points > this.save.bestScore);
    if (newBest) {
      this.save.bestRound = Math.max(this.save.bestRound, this.rounds.round);
      this.save.bestScore = Math.max(this.save.bestScore, this.points);
    }
    writeSave(this.save);
    this.renderMetaShop();
    this.hud.setBest(this.save.bestRound, this.save.bestScore);
    this.hud.showGameOver(this.rounds.round, this.points, earned, newBest);
  }

  // ---- multiplayer ----
  private async hostGame() {
    this.hud.setLobbyStatus("Connecting…");
    try {
      this.net = new NetClient();
      this.net.onClose = (r) => this.onNetClose(r);
      const { code } = await this.net.host();
      this.netplay = new NetPlay(this.net, this.scene, this.assets, this.bullets);
      this.myId = 1;
      this.startRun();
      this.hud.showRoomCode(code);
    } catch (e) {
      this.teardownNet();
      this.hud.setLobbyStatus(`Couldn't reach server (${(e as Error).message})`);
    }
  }

  private async joinGame(code: string) {
    if (!code.trim()) {
      this.hud.setLobbyStatus("Enter a room code");
      return;
    }
    this.hud.setLobbyStatus("Joining…");
    try {
      this.net = new NetClient();
      this.net.onClose = (r) => this.onNetClose(r);
      const { id } = await this.net.join(code);
      this.myId = id;
      this.netplay = new NetPlay(this.net, this.scene, this.assets, this.bullets);
      // guests render the host's authoritative world; no local sim
      this.resetRun();
      this.hud.hideStart();
      this.hud.hideGameOver();
      this.state = "playing";
      this.hud.toast(`Joined ${this.net.room}`);
    } catch (e) {
      this.teardownNet();
      this.hud.setLobbyStatus(`Join failed (${(e as Error).message})`);
    }
  }

  private onNetClose(reason: string) {
    this.teardownNet();
    this.state = "menu";
    this.hud.showStart();
    this.hud.setLobbyStatus(reason);
  }

  private teardownNet() {
    this.netplay?.dispose();
    this.netplay = undefined;
    this.net?.close();
    this.net = undefined;
  }

  // ---- GameApi (used by interactables) ----
  spend(amount: number): boolean {
    if (this.points < amount) {
      this.hud.toast("Not enough points");
      this.audio.deny();
      return false;
    }
    this.points -= amount;
    this.hud.setPoints(this.points);
    this.audio.buy();
    return true;
  }
  private addPoints(n: number) {
    this.points += n;
    this.hud.setPoints(this.points);
  }
  giveWeapon(id: string) {
    const def = WEAPONS[id];
    const existing = this.weapons.findIndex((w) => w.def.id === id);
    if (existing >= 0) {
      const w = this.weapons[existing];
      w.ammo = def.magSize;
      w.reserve = def.reserve;
      this.activeSlot = existing;
    } else {
      const w = new Weapon(def);
      if (this.weapons.length < 2) {
        this.weapons.push(w);
        this.activeSlot = this.weapons.length - 1;
      } else {
        this.weapons[this.activeSlot] = w;
      }
    }
    this.syncWeaponHud();
  }
  randomBoxWeapon(): string {
    // ~12% of pulls are a wonder weapon; the rest are normal guns.
    if (Math.random() < 0.12) return WONDER_POOL[Math.floor(Math.random() * WONDER_POOL.length)];
    return BOX_POOL[Math.floor(Math.random() * BOX_POOL.length)];
  }
  grantPerk(perk: "tough" | "quick") {
    this.perks.add(perk);
    if (perk === "tough") {
      this.player.maxHealth = 200;
      this.player.health = 200;
    } else {
      this.player.speedMul = 1.35;
      this.player.reloadMul = 1.7;
    }
  }
  hasPerk(perk: "tough" | "quick"): boolean {
    return this.perks.has(perk);
  }
  upgradeCurrentWeapon() {
    const w = this.weapon;
    if (w.upgraded) {
      this.hud.toast("Already Pack-a-Punched");
      return;
    }
    if (!this.spend(COSTS.packAPunch)) return;
    w.upgrade();
    this.syncWeaponHud();
    this.hud.toast(`${w.def.name}!`);
  }
  giveRandomGum() {
    const id = this.powerups.randomId();
    const def = this.powerups.grant(id);
    if (!def) return;
    if (id === "fullPockets") {
      for (const w of this.weapons) w.refill();
      this.syncWeaponHud();
    }
    this.audio.powerup();
    this.hud.toast(`${def.name}!`);
  }
  toast(msg: string) {
    this.hud.toast(msg);
  }

  private get weapon(): Weapon {
    return this.weapons[this.activeSlot];
  }
  private syncWeaponHud() {
    const w = this.weapon;
    this.hud.setWeapon(w.def.name, w.ammo, w.reserveLabel, w.reloading);
  }

  // ---- main loop ----
  private loop = () => {
    requestAnimationFrame(this.loop);
    let dt = Math.min(0.05, this.clock.getDelta());

    if (this.input.pressed("KeyP") || this.input.pressed("Escape")) {
      if (this.state === "playing") this.state = "paused";
      else if (this.state === "paused") this.state = "playing";
    }
    if (this.input.pressed("KeyM")) {
      this.audio.setEnabled(!this.audio.enabled);
      this.save.muted = !this.audio.enabled;
      writeSave(this.save);
    }

    // Level-up picker: keyboard shortcuts (1/2/3 to pick, R to reroll).
    if (this.state === "levelup") {
      if (this.input.pressed("Digit1")) this.hud.pickLevelByIndex(0);
      else if (this.input.pressed("Digit2")) this.hud.pickLevelByIndex(1);
      else if (this.input.pressed("Digit3")) this.hud.pickLevelByIndex(2);
      else if (this.input.pressed("KeyR")) this.hud.triggerReroll();
    }

    this.input.updateAim(this.camera);

    // Hit-stop: briefly freeze the sim (not rendering/FX) for impact weight.
    if (this.hitStop > 0) {
      this.hitStop -= dt;
      dt = 0;
    }

    if (this.state === "playing") {
      if (this.netplay && !this.netplay.isHost) this.simulateGuest(dt);
      else this.simulate(dt);
    } else {
      this.player.idle(dt); // keep the figure breathing on menu / pause / over
    }

    this.arena.update(dt);
    this.interactables.update(dt);
    this.puffs.update(dt);
    this.floaters.update(dt);
    this.updateCamera(dt);

    this.composer.render();
    this.input.endFrame();
  };

  private simulate(dt: number) {
    this.powerups.update(dt);
    this.combo.update(dt);
    // Sugar Rush stacks on the Quick perk + upgrades for movement speed.
    this.player.speedMul = (this.perks.has("quick") ? 1.35 : 1) * this.powerups.speedMul() * this.mods.moveSpeedMul;

    const axis = this.input.moveAxis(new THREE.Vector2());
    // Camera looks down the -Z axis, so W (axis.y +1) moves toward -Z.
    this.player.update(dt, axis.x, -axis.y, this.input.aimPoint);
    this.arena.clamp(this.player.pos, PLAYER.radius);
    this.arena.resolveObstacles(this.player.pos, PLAYER.radius);
    this.player.group.position.copy(this.player.pos);

    // weapon
    const w = this.weapon;
    w.update(dt, this.player.reloadMul * this.mods.reloadMul);
    const wantFire = w.def.auto ? this.input.firing : this.input.clicked();
    if (wantFire && w.tryFire(this.player.muzzle, this.player.aimDir, this.bullets, this.powerups.fireRateMul() * this.mods.fireRateMul)) {
      this.player.flash();
      this.audio.shoot(w.def.wonder ? 0.85 : 0.4);
      this.netplay?.hostShot(
        this.player.muzzle.x, this.player.muzzle.z, this.player.aimDir.x, this.player.aimDir.z,
        w.def.bulletColor ?? COLORS.bullet, w.def.bulletScale ?? 1,
      );
    }
    if (this.input.pressed("KeyR")) w.reload();
    if (this.input.pressed("KeyQ") && this.weapons.length > 1) {
      this.activeSlot = (this.activeSlot + 1) % this.weapons.length;
    }

    // host also simulates each connected guest's player into the shared world
    if (this.netplay) {
      this.netplay.hostSimulateGuests(dt, this.arena, this.bullets, (x, z, dx, dz) =>
        this.netplay!.hostShot(x, z, dx, dz, COLORS.bullet, 1),
      );
    }

    this.bullets.update(dt);
    const targets = this.netplay ? this.netplay.hostPlayerPositions(this.player) : [this.player.pos];
    this.rounds.update(dt, this.arena, targets);

    this.resolveBulletHits();
    this.resolveZombieTouch(dt);

    // broadcast the authoritative snapshot to guests
    if (this.netplay) {
      const zs: ZombieSnap[] = [];
      for (const z of this.rounds.zombies) {
        if (!z.alive && !z.dying) continue;
        zs.push({ id: z.id, x: z.pos.x, z: z.pos.z, ry: z.group.rotation.y, type: z.typeIndex, state: z.dying ? 1 : 0 });
      }
      this.netplay.hostBroadcast(dt, this.player, zs, this.rounds.round, this.points, this.rounds.phase);
    }

    // interaction prompt + buy
    const near = this.interactables.nearest(this.player.pos);
    if (near) {
      const p = near.prompt(this);
      if (p) this.hud.showPrompt(p.text, p.affordable);
      else this.hud.hidePrompt();
      if (this.input.pressed("KeyE") || this.input.pressed("Space")) near.interact(this);
    } else {
      this.hud.hidePrompt();
    }

    // game over when every player (host + guests) is down
    const anyAlive = this.player.alive || this.netplay?.hostGuestSlots().some((s) => s.player.alive);
    if (!anyAlive) {
      this.gameOver();
      return;
    }

    // loot pickups: bob + collect anything the player walks over
    this.drops.update(dt, this.player.pos, (kind, label, color) => this.collectDrop(kind, label, color));

    // boss health bar
    const boss = this.rounds.boss;
    if (boss) this.hud.setBoss(boss.typeName, boss.health / boss.maxHealth);
    else this.hud.hideBoss();

    // occasional ambient groan scaled to how many are shambling about
    if (this.rounds.aliveCount > 0 && Math.random() < dt * (0.5 + this.rounds.aliveCount * 0.08)) {
      this.audio.groan();
    }

    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setPowerups(this.powerups.list());
    this.hud.setCombo(this.combo.active ? this.combo.multiplier : 0, this.combo.fraction);
    this.syncWeaponHud();
  }

  /** Apply a collected loot drop. */
  private collectDrop(kind: DropKind, label: string, color: number) {
    this.floaters.spawn(this.player.pos, label, `#${color.toString(16).padStart(6, "0")}`, 1.1, true);
    this.audio.powerup();
    switch (kind) {
      case "ammo":
        for (const w of this.weapons) w.refill();
        this.syncWeaponHud();
        break;
      case "points":
        this.addPoints(250);
        break;
      case "heal":
        this.player.heal(60);
        break;
      case "doublePoints":
        this.powerups.grant("doublePoints");
        break;
      case "rapidFire":
        this.powerups.grant("rapidFire");
        break;
      case "instakill":
        this.powerups.grant("instakill");
        break;
      case "treasure":
        this.save.essence += 30;
        writeSave(this.save);
        this.hud.toast("+30 ✦ Essence");
        break;
      case "nuke":
        this.nukeBoard();
        break;
    }
  }

  /** Nuke drop: wipe every living zombie on the field for points. */
  private nukeBoard() {
    this.audio.boom();
    this.shake = Math.min(0.6, this.shake + 0.4);
    for (const z of this.rounds.zombies) {
      if (!z.alive || z.isBoss) continue; // bosses shrug off the nuke
      this.puffs.burst(z.pos, z.puffColor);
      z.hit(1e9);
      this.addPoints(SCORE.kill);
    }
  }

  /** Guest path: send input to the host and render the authoritative snapshot. */
  private simulateGuest(dt: number) {
    const axis = this.input.moveAxis(new THREE.Vector2());
    const aim = this.input.aimPoint;
    const inp: InputMsg = {
      t: "input",
      mx: axis.x,
      mz: -axis.y,
      ax: aim.x,
      az: aim.z,
      fire: this.input.firing || this.input.clicked(),
      reload: this.input.pressed("KeyR"),
      swap: this.input.pressed("KeyQ"),
      interact: this.input.pressed("KeyE") || this.input.pressed("Space"),
    };
    if (inp.fire) this.audio.shoot(0.4); // local fire feedback (host is authoritative)
    this.netplay!.guestSendInput(inp);
    this.netplay!.guestRender(dt, this.player, this.myId);
    this.bullets.update(dt); // moves the local tracer ghosts

    this.hud.setRound(this.netplay!.netRound);
    this.hud.setPoints(this.netplay!.netPoints);
    this.hud.setHealth(this.netplay!.myHp, this.netplay!.myMaxHp);
    this.hud.hidePrompt();
  }

  private resolveBulletHits() {
    const dmgMul = this.powerups.damageMul();
    const sMul = this.powerups.scoreMul();
    for (const b of this.bullets.bullets) {
      if (!b.alive) continue;
      for (const z of this.rounds.zombies) {
        if (!z.alive || b.hit.has(z.id)) continue;
        const scale = z.group.scale.x;
        const hitR = ZOMBIE.radius * scale + 0.25;
        const dx = z.pos.x - b.mesh.position.x;
        const dz = z.pos.z - b.mesh.position.z;
        const horiz2 = dx * dx + dz * dz;
        if (horiz2 < hitR * hitR) {
          b.hit.add(z.id);
          // Crit = precise center hit OR a random roll from crit-chance upgrades.
          const crit = horiz2 < (hitR * 0.4) * (hitR * 0.4) || Math.random() < this.mods.critChance;
          const critMul = crit ? this.mods.critMul : 1;
          const dmg = b.damage * dmgMul * this.mods.damageMul * critMul;
          this.addPoints(Math.round(SCORE.hit * sMul * (crit ? 2 : 1)));
          z.knockback(b.mesh.position.x, b.mesh.position.z, crit ? 5 : 3);
          this.audio.hit(crit);
          if (crit) this.floaters.spawn(z.pos, "CRIT", "#ffe14a", 1, true);
          this.damageZombie(z, dmg, sMul, crit);
          if (b.splashRadius > 0) {
            this.puffs.burst(z.pos, 0xffd0a0, 6);
            this.splash(z.pos, b.splashRadius, b.splashDamage * dmgMul, z.id, sMul);
          }
          // piercing rounds keep flying; everything else stops on first contact
          if (b.pierce > 0) b.pierce--;
          else {
            this.bullets.retire(b);
            break;
          }
        }
      }
    }
  }

  /** Apply damage to one zombie and handle the score/FX if it dies. */
  private damageZombie(z: Zombie, dmg: number, scoreMul: number, crit = false) {
    const wasBoss = z.isBoss;
    const killed = z.hit(dmg);
    if (killed) {
      const mult = this.combo.onKill();
      const pts = Math.round(SCORE.kill * z.scoreMul * scoreMul * mult);
      this.addPoints(pts);
      this.floaters.spawn(z.pos, `+${pts}`, mult > 1 ? "#ffd24a" : "#ffffff", mult > 1 ? 1.2 : 1);
      this.puffs.burst(z.pos, z.puffColor);
      this.audio.kill();
      if (this.mods.lifeSteal > 0) this.player.heal(this.mods.lifeSteal);
      // a satisfying micro-freeze on crits / combo kills (local visual only)
      if (crit || mult >= 2 || wasBoss) this.hitStop = Math.min(wasBoss ? 0.12 : 0.07, this.hitStop + 0.045);
      // loot: bosses always drop something juicy; normal kills roll the dice
      if (wasBoss) {
        this.hud.hideBoss();
        this.audio.boom();
        for (let i = 0; i < 3; i++) this.drops.maybeSpawn(z.pos, 1, true);
        this.puffs.burst(z.pos, 0xffd24a, 26);
      } else {
        this.drops.maybeSpawn(z.pos, this.mods.dropChance);
      }
      if (z.explodes) {
        this.detonate(z);
        this.audio.boom();
      }
    }
  }

  /** AoE damage to every zombie in range (except the one already hit directly). */
  private splash(center: THREE.Vector3, radius: number, dmg: number, exceptId: number, scoreMul: number) {
    const r2 = radius * radius;
    for (const z of this.rounds.zombies) {
      if (!z.alive || z.id === exceptId) continue;
      const dx = z.pos.x - center.x;
      const dz = z.pos.z - center.z;
      if (dx * dx + dz * dz < r2) {
        z.knockback(center.x, center.z, 4);
        this.damageZombie(z, dmg, scoreMul);
      }
    }
  }

  private resolveZombieTouch(dt: number) {
    const r = ZOMBIE.radius + PLAYER.radius;
    // candidate victims: local player + any guests (host-authoritative)
    const victims = [this.player, ...(this.netplay ? this.netplay.hostGuestSlots().map((s) => s.player) : [])];
    for (const z of this.rounds.zombies) {
      if (!z.alive) continue;
      if (z.touchCooldown > 0) {
        z.touchCooldown -= dt;
        continue;
      }
      const reach = r * z.group.scale.x; // bigger variants reach a little farther
      for (const victim of victims) {
        if (!victim.alive) continue;
        const dx = z.pos.x - victim.pos.x;
        const dz = z.pos.z - victim.pos.z;
        if (dx * dx + dz * dz < reach * reach) {
          victim.damage(z.touchDamage);
          z.touchCooldown = ZOMBIE.touchInterval;
          if (victim === this.player) {
            this.shake = Math.min(0.5, this.shake + 0.25);
            this.audio.hurt();
          }
          break;
        }
      }
    }
  }

  /** Bomber death: orange burst + AoE damage if the player is in range. */
  private detonate(z: Zombie) {
    this.puffs.burst(z.pos, 0xff7a3a, 20);
    const dx = this.player.pos.x - z.pos.x;
    const dz = this.player.pos.z - z.pos.z;
    if (dx * dx + dz * dz < z.blastRadius * z.blastRadius) {
      this.player.damage(z.blastDamage);
      this.shake = Math.min(0.7, this.shake + 0.4);
    }
  }

  private updateCamera(dt: number) {
    this._v2.copy(this.player.pos).add(
      new THREE.Vector3(CAMERA.offset.x, CAMERA.offset.y, CAMERA.offset.z),
    );
    const k = 1 - Math.exp(-CAMERA.follow * dt);
    this.camera.position.lerp(this._v2, k);

    this.camTarget.lerp(this.player.pos, k);
    this.camera.lookAt(this.camTarget.x, this.camTarget.y + 1, this.camTarget.z);

    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.pow(0.0001, dt); // fast decay
    }
  }

  private onResize = () => {
    const aspect = innerWidth / innerHeight;
    this.camera.left = -this.viewSize * aspect;
    this.camera.right = this.viewSize * aspect;
    this.camera.top = this.viewSize;
    this.camera.bottom = -this.viewSize;
    this.camera.updateProjectionMatrix();
    this.renderer.setSize(innerWidth, innerHeight);
    this.composer.setSize(innerWidth, innerHeight);
    this.tilt.setSize(innerWidth, innerHeight);
  };
}

// Load GLB models (best-effort; falls back to primitives) then start the game.
(async () => {
  const assets = new AssetManager();
  await assets.loadAll();
  new Game(assets);
})();
