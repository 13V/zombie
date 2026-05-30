import "./style.css";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { CAMERA, COSTS, PLAYER, SCORE, ZOMBIE } from "./config";
import { glowMaterial } from "./palette";
import { Input } from "./input";
import { Arena } from "./arena";
import { Player } from "./player";
import { RoundManager } from "./rounds";
import { Zombie } from "./zombie";
import { BulletSystem, Weapon, WEAPONS, BOX_POOL, WONDER_POOL, styleForWeaponName, spreadForWeaponName, FireMods, Bullet } from "./weapons";
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
import { SKINS, findSkin } from "./cosmetics";
import { makeItem, rollRarity, rarityColorHex, RARITIES, LootItem } from "./loot";
import { CHALLENGES, RunStats, blankRunStats } from "./challenges";
import { NetClient, InputMsg, ZombieSnap, warmServer, getServerUrl, setServerUrl } from "./net";
import { TouchControls, isTouchDevice } from "./touchControls";
import { Wallet } from "./wallet";
import { NetPlay, GuestSlot } from "./netplay";
import { COLORS } from "./palette";
import { TiltShift } from "./tiltShift";

/** Tiny pooled "poof" particles for kill feedback. Hard-capped so chaotic
 *  moments (nukes, detonate chains, gibs) can't spawn unbounded meshes. */
class Puffs {
  private static readonly MAX_LIVE = 160;
  private pool: { m: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];
  private active: { m: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];
  private geo = new THREE.SphereGeometry(0.18, 6, 6);
  constructor(private scene: THREE.Scene) {}
  burst(pos: THREE.Vector3, color: number, count = 8) {
    for (let i = 0; i < count; i++) {
      // enforce the cap: recycle the oldest live puff instead of growing
      if (this.active.length >= Puffs.MAX_LIVE) {
        const old = this.active.shift();
        if (old) {
          old.m.visible = false;
          this.scene.remove(old.m);
          this.pool.push(old);
        }
      }
      let p = this.pool.pop();
      if (!p) p = { m: new THREE.Mesh(this.geo, glowMaterial(color, 0.8)), vel: new THREE.Vector3(), life: 0 };
      const m = p.m;
      (m.material as THREE.MeshStandardMaterial).color.set(color);
      (m.material as THREE.MeshStandardMaterial).emissive.set(color);
      m.position.copy(pos);
      m.position.y = 1;
      m.scale.setScalar(1);
      m.visible = true;
      this.scene.add(m);
      const a = Math.random() * Math.PI * 2;
      const up = 2 + Math.random() * 3;
      p.vel.set(Math.cos(a) * 3, up, Math.sin(a) * 3);
      p.life = 0.5;
      this.active.push(p);
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
        this.pool.push(p);
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
  private touch?: TouchControls;
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
  private wallet = new Wallet();

  // progression
  private save: SaveData = loadSave();
  private mods: RunMods = defaultMods();
  // level-up picker state
  private levelNum = 0;
  private levelCards: RunUpgrade[] = [];
  private rerollCost = 0;
  private levelPicking = false;
  private runStats: RunStats = blankRunStats();

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
  /** When set, GameApi buy/perk actions target this guest instead of the host. */
  private acting: GuestSlot | null = null;
  // reused scratch for guest-side cosmetic bullet impacts + homing/ricochet
  private guestZBuf: { x: number; z: number; r: number; color: number }[] = [];
  private hitTmp = new THREE.Vector3();
  private readonly UP = new THREE.Vector3(0, 1, 0);
  private healKills = 0; // counts toward Heal Nova upgrade
  // reused per-frame scratch to avoid GC churn in the hot loop
  private _axis = new THREE.Vector2();
  private _fire: FireMods = {};
  private _victims: Player[] = [];

  private tilt: TiltShift;

  private camTarget = new THREE.Vector3();
  private shake = 0;
  private _v2 = new THREE.Vector3();

  constructor(private assets: AssetManager) {
    const canvas = document.getElementById("scene") as HTMLCanvasElement;
    const ui = document.getElementById("ui") as HTMLElement;

    // antialias:false — SMAA in the composer handles edges; MSAA here would be
    // redundant cost. Cap pixelRatio at 1.5: every post pass runs at this res,
    // so fill-rate (not geometry) is the bottleneck on hi-dpi screens.
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false });
    this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1.5));
    this.renderer.shadowMap.enabled = true;
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap;
    this.renderer.toneMapping = THREE.ACESFilmicToneMapping;
    this.renderer.toneMappingExposure = 1.0;
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
    this.scene.environmentIntensity = 0.5;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // NOTE: GTAO (ambient occlusion) was removed — it painted transparent FX
    // (the aim guide at the gun, floating hit/CRIT text) as solid black boxes,
    // because they wrote into the AO depth pass. Soft contact shadow comes from
    // the directional light's shadow map instead; no black-box class of bug.
    // Gentle bloom — only the brightest emissives (windows, fire, pickups) glow.
    // Built at half-res: the blur is low-frequency so it's visually identical
    // but costs ~4× less fill (bloom is ~11 internal passes — the priciest one).
    const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.16, 0.5, 0.92);
    this.composer.addPass(bloom);
    // Tilt-shift kept SUBTLE: a wide sharp band so the play area stays crisp
    // (blur only creeps in at the very top/bottom edges, like the reference),
    // plus just a touch of saturation + warmth — not a haze.
    this.tilt = new TiltShift(innerWidth, innerHeight, {
      focus: 0.5, band: 0.42, strength: 1.8, vignette: 0.26, saturation: 1.08, warmth: 0.12,
    });
    this.composer.addPass(this.tilt.horizontal);
    this.composer.addPass(this.tilt.vertical);
    // Cheap, reliable edge anti-aliasing through the composer (replaces costly
    // MSAA): smooths the voxel stair-stepping without the framerate hit.
    this.composer.addPass(new SMAAPass(innerWidth, innerHeight));
    this.composer.addPass(new OutputPass());

    this.input = new Input(canvas);
    if (isTouchDevice()) {
      document.body.classList.add("touch");
      this.touch = new TouchControls(this.input);
    }
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

    // Menu progression UI (best run + Essence shop) + equipped cosmetic skin.
    this.hud.setBest(this.save.bestRound, this.save.bestScore);
    const skin = findSkin(this.save.skin);
    this.player.setSkin(skin.body, skin.head);
    this.renderShop();

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
    this.hud.onServer(() => this.changeServer());
    this.hud.onWallet(() => this.toggleWallet());
    this.wallet.onChange = () => this.syncWallet();
    this.wallet.tryEagerConnect();
    this.hud.onWallet(() => this.toggleWallet());
    this.wallet.onChange = () => this.syncWallet();
    this.wallet.tryEagerConnect();

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
    this.acting = null; // clear any dangling guest-interaction actor from last run
    this.healKills = 0;
    this.runStats = blankRunStats();
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
  /** Re-render all three menu shop tabs (upgrades / skins / challenges). */
  private renderShop() {
    const upgrades = META_UPGRADES.map((u) => ({
      id: u.id,
      name: u.name,
      desc: u.desc,
      cost: u.cost,
      owned: this.save.owned.includes(u.id),
      affordable: this.save.essence >= u.cost,
    }));
    this.hud.renderMeta(this.save.essence, upgrades, (id) => this.buyMeta(id));

    const skins = SKINS.map((s) => ({
      id: s.id,
      name: s.name,
      body: s.body,
      head: s.head,
      cost: s.cost,
      owned: this.save.skins.includes(s.id),
      equipped: this.save.skin === s.id,
      affordable: this.save.essence >= s.cost,
    }));
    this.hud.renderSkins(this.save.essence, skins, (id) => this.selectSkin(id));

    const chals = CHALLENGES.map((c) => ({
      name: c.name,
      desc: c.desc,
      reward: c.reward,
      progress: c.progress(this.save.stats, this.runStats),
      goal: c.goal,
      done: this.save.claimed.includes(c.id),
    }));
    this.hud.renderChallenges(this.save.essence, chals);

    // Market: sell tradable loot for gold (the in-game economy).
    this.hud.renderMarket(
      this.save.gold,
      this.save.stash.map((it) => ({ id: it.id, name: it.name, rarity: it.rarity, gold: it.gold, color: rarityColorHex(it.rarity as any) })),
      (id) => this.sellItem(id),
      () => this.sellAll(),
    );
  }

  /** Add a freshly-dropped item to the stash + announce it in-run. */
  private grantLoot(item: LootItem) {
    this.save.stash.push(item);
    writeSave(this.save);
    const info = RARITIES[item.rarity];
    this.floaters.spawn(this.player.pos, `${info.label} LOOT!`, rarityColorHex(item.rarity), 1.1, true);
    this.audio.powerup();
  }

  /** Sell one stashed item for its gold value. */
  private sellItem(id: string) {
    const i = this.save.stash.findIndex((it) => it.id === id);
    if (i < 0) return;
    const [item] = this.save.stash.splice(i, 1);
    this.save.gold += item.gold;
    this.save.goldEarned += item.gold;
    writeSave(this.save);
    this.audio.buy();
    this.renderShop();
  }

  /** Sell the whole stash at once. */
  private sellAll() {
    if (!this.save.stash.length) return;
    const total = this.save.stash.reduce((s, it) => s + it.gold, 0);
    this.save.gold += total;
    this.save.goldEarned += total;
    this.save.stash = [];
    writeSave(this.save);
    this.audio.powerup();
    this.renderShop();
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
    this.renderShop();
  }

  /** Equip an owned skin, or buy it with Essence then equip. */
  private selectSkin(id: string) {
    const skin = findSkin(id);
    if (!this.save.skins.includes(id)) {
      if (this.save.essence < skin.cost) {
        this.audio.deny();
        return;
      }
      this.save.essence -= skin.cost;
      this.save.skins.push(id);
      this.audio.powerup();
    } else {
      this.audio.ui();
    }
    this.save.skin = id;
    writeSave(this.save);
    this.player.setSkin(skin.body, skin.head);
    this.renderShop();
  }

  /** Return to the main menu (from the game-over screen) to spend Essence. */
  private toMenu() {
    this.teardownNet();
    this.state = "menu";
    this.resetRun();
    this.hud.hideGameOver();
    this.hud.setBest(this.save.bestRound, this.save.bestScore);
    this.renderShop();
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
    if (this.state === "over") return; // guard: never pay out essence / count stats twice
    this.state = "over";
    this.input.firing = false;
    this.audio.stopMusic();
    this.audio.hurt();
    this.hud.hideBoss();
    // Co-op host: let guests know the team wiped (they resume when host replays).
    this.netplay?.hostNotify("Team wiped — waiting for host…");

    // Every run pays out Essence and may set a new personal best.
    const earned = essenceFor(this.rounds.round, this.points, this.mods.essenceMul);
    this.save.essence += earned;
    const newBest = this.rounds.round > this.save.bestRound || (this.rounds.round === this.save.bestRound && this.points > this.save.bestScore);
    if (newBest) {
      this.save.bestRound = Math.max(this.save.bestRound, this.rounds.round);
      this.save.bestScore = Math.max(this.save.bestScore, this.points);
    }

    // Fold this run into lifetime stats, then settle any newly-met challenges.
    this.runStats.round = this.rounds.round;
    const s = this.save.stats;
    s.kills += this.runStats.kills;
    s.crits += this.runStats.crits;
    s.bossKills += this.runStats.bossKills;
    s.drops += this.runStats.drops;
    s.games += 1;
    const bonus = this.settleChallenges();

    writeSave(this.save);
    this.renderShop();
    this.hud.setBest(this.save.bestRound, this.save.bestScore);
    this.hud.showGameOver(this.rounds.round, this.points, earned + bonus, newBest);
  }

  /** Award Essence for any challenges completed this run. Returns the total. */
  private settleChallenges(): number {
    let total = 0;
    for (const c of CHALLENGES) {
      if (this.save.claimed.includes(c.id)) continue;
      if (c.progress(this.save.stats, this.runStats) >= c.goal) {
        this.save.claimed.push(c.id);
        this.save.essence += c.reward;
        total += c.reward;
        this.hud.toast(`Challenge: ${c.name}  +${c.reward} ✦`);
      }
    }
    return total;
  }

  // ---- multiplayer ----
  /** Let the player point the client at their own relay (no rebuild needed). */
  private changeServer() {
    const next = window.prompt(
      "Co-op relay server URL (wss://… or https://…):\n\nDeploy the server in /server to Render/Railway/Fly and paste its URL here.",
      getServerUrl(),
    );
    if (next && next.trim()) {
      const url = setServerUrl(next);
      this.hud.setLobbyStatus(`Server set to ${url}`);
    }
  }

  /** Connect the wallet, or disconnect if already connected. */
  private async toggleWallet() {
    if (this.wallet.state.connected) {
      await this.wallet.disconnect();
      return;
    }
    if (!this.wallet.available) {
      this.hud.setLobbyStatus("No Solana wallet found — install Phantom to connect.");
    }
    await this.wallet.connect();
  }

  /** Reflect wallet state on the menu (button label + Essence-as-token balance). */
  private syncWallet() {
    const s = this.wallet.state;
    // Until the token launches, show the player's earned Essence as their
    // claimable balance, so the "what will I earn" loop is visible now.
    const label = s.connected ? `${this.save.essence} ✦ to claim` : "";
    this.hud.setWallet(s.connected, this.wallet.short, label);
    if (s.connected) this.hud.setLobbyStatus("Wallet linked — earned Essence will convert at token launch.");
  }

  /** Tick a "<label>… (Ns)" status so a cold-starting server doesn't look frozen. */
  private connectingTicker(label: string): () => void {
    const t0 = Date.now();
    const tick = () => {
      const s = Math.floor((Date.now() - t0) / 1000);
      this.hud.setLobbyStatus(`${label}… ${s}s${s > 8 ? " (free server is waking up — up to ~45s)" : ""}`);
    };
    tick();
    const iv = window.setInterval(tick, 1000);
    return () => clearInterval(iv);
  }

  /**
   * Retry a connect attempt while the free server cold-starts. Render returns a
   * fast 502 (instant onerror) until the dyno is up, so a single try fails
   * immediately — we keep poking /health and retrying for up to ~55s.
   */
  private async connectWithRetry<T>(makeAttempt: () => Promise<T>, budgetMs = 55000): Promise<T> {
    const t0 = Date.now();
    let lastErr: unknown;
    while (Date.now() - t0 < budgetMs) {
      try {
        return await makeAttempt();
      } catch (e) {
        lastErr = e;
        this.net?.close();
        if (Date.now() - t0 >= budgetMs) break;
        warmServer(); // keep nudging the dyno awake
        await new Promise((r) => setTimeout(r, 2500));
      }
    }
    throw lastErr ?? new Error("could not reach the server");
  }

  private async hostGame() {
    warmServer(); // poke the dyno in case it's cold-starting
    const stop = this.connectingTicker("Connecting");
    try {
      const { code } = await this.connectWithRetry(() => {
        this.net = new NetClient();
        this.net.onClose = (r) => this.onNetClose(r);
        return this.net.host();
      });
      stop();
      this.netplay = new NetPlay(this.net!, this.scene, this.assets, this.bullets);
      this.myId = 1;
      this.startRun();
      this.hud.showRoomCode(code);
      this.hud.setLobbyStatus(`Hosting room ${code} — share the code!`);
    } catch (e) {
      stop();
      console.error("[coop] host failed:", e);
      this.teardownNet();
      this.hud.setLobbyStatus("Server unreachable — it may be asleep or down. Try again in a minute.");
    }
  }

  private async joinGame(code: string) {
    if (!code.trim()) {
      this.hud.setLobbyStatus("Enter a room code");
      return;
    }
    warmServer();
    const stop = this.connectingTicker("Joining");
    try {
      const { id } = await this.connectWithRetry(() => {
        this.net = new NetClient();
        this.net.onClose = (r) => this.onNetClose(r);
        return this.net!.join(code);
      });
      stop();
      this.myId = id;
      this.netplay = new NetPlay(this.net!, this.scene, this.assets, this.bullets);
      this.netplay.onToast = (m) => this.hud.toast(m); // host-pushed feedback
      // guests render the host's authoritative world; no local sim
      this.resetRun();
      this.hud.hideStart();
      this.hud.hideGameOver();
      this.state = "playing";
      this.hud.toast(`Joined ${this.net!.room}`);
    } catch (e) {
      stop();
      console.error("[coop] join failed:", e);
      this.teardownNet();
      this.hud.setLobbyStatus("Couldn't join — check the code, or the server may be down.");
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
  // Points are a shared team pool. When `this.acting` is set, weapon/perk
  // actions target that guest's inventory instead of the host's.
  spend(amount: number): boolean {
    if (this.points < amount) {
      this.toast("Not enough points");
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
  /** Weapon inventory of whoever is currently acting (host or a guest). */
  private actorWeapons(): Weapon[] {
    return this.acting ? this.acting.weapons : this.weapons;
  }
  private actorSlot(): number {
    return this.acting ? this.acting.activeSlot : this.activeSlot;
  }
  private setActorSlot(i: number) {
    if (this.acting) this.acting.activeSlot = i;
    else this.activeSlot = i;
  }
  private actorWeapon(): Weapon {
    return this.actorWeapons()[this.actorSlot()];
  }
  giveWeapon(id: string) {
    const def = WEAPONS[id];
    const weapons = this.actorWeapons();
    const existing = weapons.findIndex((w) => w.def.id === id);
    if (existing >= 0) {
      const w = weapons[existing];
      w.ammo = def.magSize;
      w.reserve = def.reserve;
      this.setActorSlot(existing);
    } else {
      const w = new Weapon(def);
      if (weapons.length < 2) {
        weapons.push(w);
        this.setActorSlot(weapons.length - 1);
      } else {
        weapons[this.actorSlot()] = w;
      }
    }
    if (!this.acting) this.syncWeaponHud();
  }
  randomBoxWeapon(): string {
    // ~12% of pulls are a wonder weapon; the rest are normal guns.
    if (Math.random() < 0.12) return WONDER_POOL[Math.floor(Math.random() * WONDER_POOL.length)];
    return BOX_POOL[Math.floor(Math.random() * BOX_POOL.length)];
  }
  grantPerk(perk: "tough" | "quick") {
    const perks = this.acting ? this.acting.perks : this.perks;
    const player = this.acting ? this.acting.player : this.player;
    perks.add(perk);
    if (perk === "tough") {
      player.maxHealth = 200;
      player.health = 200;
    } else {
      player.speedMul = 1.35;
      player.reloadMul = 1.7;
    }
  }
  hasPerk(perk: "tough" | "quick"): boolean {
    return (this.acting ? this.acting.perks : this.perks).has(perk);
  }
  upgradeCurrentWeapon() {
    const w = this.actorWeapon();
    if (w.upgraded) {
      this.toast("Already Pack-a-Punched");
      return;
    }
    if (!this.spend(COSTS.packAPunch)) return;
    w.upgrade();
    if (!this.acting) this.syncWeaponHud();
    this.toast(`${w.def.name}!`);
  }
  giveRandomGum() {
    const id = this.powerups.randomId();
    const def = this.powerups.grant(id);
    if (!def) return;
    if (id === "fullPockets") {
      for (const w of this.actorWeapons()) w.refill();
      if (!this.acting) this.syncWeaponHud();
    }
    this.audio.powerup();
    this.toast(`${def.name}!`);
  }
  /** Feedback message — shown locally for the host, sent over the wire to a guest. */
  toast(msg: string) {
    if (this.acting && this.netplay) this.netplay.hostToast(this.acting.id, msg);
    else this.hud.toast(msg);
  }

  private get weapon(): Weapon {
    return this.weapons[this.activeSlot];
  }
  private syncWeaponHud() {
    const w = this.weapon;
    this.hud.setWeapon(w.def.name, w.ammo, w.reserveLabel, w.reloading);
    this.player.setWeaponModel(w.def.style);
    this.player.setAimSpread(w.def.spread, w.def.pellets);
  }

  /** Run `fn` with `actor` as the acting player, restoring the previous actor
   *  after. Used so deferred interactable rewards bill the right inventory. */
  private withActor<T>(actor: GuestSlot, fn: () => T): T {
    const prev = this.acting;
    this.acting = actor;
    try {
      return fn();
    } finally {
      this.acting = prev;
    }
  }

  /**
   * A GameApi view bound to one guest. The Mystery Box (and anything else that
   * defers its reward to a later frame) captures this, so the deferred reward
   * still bills/credits the guest who pulled it — not whoever acts next.
   */
  private apiFor(actor: GuestSlot): GameApi {
    const self = this;
    return {
      get points() {
        return self.points;
      },
      spend: (a) => self.withActor(actor, () => self.spend(a)),
      giveWeapon: (id) => self.withActor(actor, () => self.giveWeapon(id)),
      randomBoxWeapon: () => self.randomBoxWeapon(),
      grantPerk: (p) => self.withActor(actor, () => self.grantPerk(p)),
      hasPerk: (p) => self.withActor(actor, () => self.hasPerk(p)),
      upgradeCurrentWeapon: () => self.withActor(actor, () => self.upgradeCurrentWeapon()),
      giveRandomGum: () => self.withActor(actor, () => self.giveRandomGum()),
      toast: (m) => self.withActor(actor, () => self.toast(m)),
    };
  }

  /** Host: run any guest interactions queued this tick (buy / perk / Pack-a-Punch). */
  private processGuestInteractions() {
    if (!this.netplay) return;
    for (const slot of this.netplay.hostGuestSlots()) {
      if (!slot.wantInteract) continue;
      slot.wantInteract = false;
      if (!slot.player.alive) continue;
      const near = this.interactables.nearest(slot.player.pos);
      if (near) near.interact(this.apiFor(slot));
    }
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

    this.touch?.setActive(this.state === "playing" || this.state === "paused");
    this.player.showAimGuide(this.state === "playing");
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

    const axis = this.input.moveAxis(this._axis);
    // Touch aim stick points the reticle relative to the player (twin-stick).
    if (this.input.touchAim) {
      this.input.aimPoint.set(
        this.player.pos.x + this.input.touchAim.x * 6,
        0,
        this.player.pos.z + this.input.touchAim.y * 6,
      );
    }
    // Camera looks down the -Z axis, so W (axis.y +1) moves toward -Z.
    this.player.update(dt, axis.x, -axis.y, this.input.aimPoint);
    this.arena.clamp(this.player.pos, PLAYER.radius);
    this.arena.resolveObstacles(this.player.pos, PLAYER.radius);
    this.player.group.position.copy(this.player.pos);

    // weapon
    const w = this.weapon;
    w.update(dt, this.player.reloadMul * this.mods.reloadMul);
    // On touch, holding the aim stick fires (all weapons); cooldown gates rate.
    const wantFire = this.input.touchAim ? true : w.def.auto ? this.input.firing : this.input.clicked();
    if (wantFire) {
      // Adrenaline: fire faster the lower your health is. Reuse _fire (no alloc).
      const adr = this.mods.adrenaline ? 1 + (1 - this.player.health / this.player.maxHealth) * 0.6 : 1;
      const f = this._fire;
      f.fireRateMul = this.powerups.fireRateMul() * this.mods.fireRateMul * adr;
      f.bonusPellets = this.mods.bonusPellets;
      f.pierceBonus = this.mods.pierceBonus;
      f.scaleMul = this.mods.bulletScaleMul;
      f.homing = this.mods.homing;
      f.bounces = this.mods.ricochet;
      if (w.tryFire(this.player.muzzle, this.player.aimDir, this.bullets, f)) {
        this.player.flash();
        this.audio.shoot(w.def.wonder ? 0.85 : 0.4);
        this.netplay?.hostShot(
          this.player.muzzle.x, this.player.muzzle.z, this.player.aimDir.x, this.player.aimDir.z,
          w.def.bulletColor ?? COLORS.bullet, w.def.bulletScale ?? 1,
        );
      }
    }
    if (this.input.pressed("KeyR")) w.reload();
    if (this.input.pressed("KeyQ") && this.weapons.length > 1) {
      this.activeSlot = (this.activeSlot + 1) % this.weapons.length;
    }

    // host also simulates each connected guest's player into the shared world
    if (this.netplay) {
      this.netplay.hostSimulateGuests(dt, this.arena, this.bullets, (x, z, dx, dz, color, scale) =>
        this.netplay!.hostShot(x, z, dx, dz, color, scale),
      );
      this.processGuestInteractions();
    }

    this.steerHomingBullets(dt);
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
      this.netplay.hostBroadcast(dt, this.player, this.weapon, zs, this.rounds.round, this.points, this.rounds.phase);
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
    this.runStats.drops++;
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
    // Route kills through damageZombie so they count toward stats / challenges /
    // combo / loot like every other kill (snapshot the list — damageZombie can
    // trigger detonate/splash that mutate alive state mid-loop).
    const targets = this.rounds.zombies.filter((z) => z.alive && !z.isBoss);
    for (const z of targets) {
      if (!z.alive) continue;
      this.damageZombie(z, 1e9, this.powerups.scoreMul());
    }
  }

  /** Guest path: send input to the host and render the authoritative snapshot. */
  private simulateGuest(dt: number) {
    const axis = this.input.moveAxis(new THREE.Vector2());
    // Touch aim relative to the guest's (snapshot-driven) position.
    if (this.input.touchAim) {
      this.input.aimPoint.set(
        this.player.pos.x + this.input.touchAim.x * 6,
        0,
        this.player.pos.z + this.input.touchAim.y * 6,
      );
    }
    const aim = this.input.aimPoint;
    const inp: InputMsg = {
      t: "input",
      mx: axis.x,
      mz: -axis.y,
      ax: aim.x,
      az: aim.z,
      fire: this.input.touchAim != null || this.input.firing || this.input.clicked(),
      reload: this.input.pressed("KeyR"),
      swap: this.input.pressed("KeyQ"),
      interact: this.input.pressed("KeyE") || this.input.pressed("Space"),
    };
    if (inp.fire) this.audio.shoot(0.4); // local fire feedback (host is authoritative)
    this.netplay!.guestSendInput(inp);
    this.netplay!.guestRender(dt, this.myId); // remotes + zombies + my auth state

    // --- client-side prediction for the guest's OWN player ---
    // Move locally at 60fps for instant response, then gently reconcile toward
    // the host's authoritative position so collisions/damage stay host-ruled.
    this.player.alive = this.netplay!.myAlive;
    if (this.player.alive) {
      this.player.update(dt, axis.x, -axis.y, aim);
      this.arena.clamp(this.player.pos, PLAYER.radius);
      this.arena.resolveObstacles(this.player.pos, PLAYER.radius);
    } else {
      this.player.idle(dt);
    }
    if (this.netplay!.myHasAuth) {
      const ex = this.netplay!.myX - this.player.pos.x;
      const ez = this.netplay!.myZ - this.player.pos.z;
      if (Math.hypot(ex, ez) > 3) {
        // large desync (spawn / knockback / teleport) → snap
        this.player.pos.set(this.netplay!.myX, 0, this.netplay!.myZ);
      } else {
        const k = 1 - Math.exp(-7 * dt); // soft pull toward authoritative
        this.player.pos.x += ex * k;
        this.player.pos.z += ez * k;
      }
      this.player.group.position.copy(this.player.pos);
    }

    this.bullets.update(dt); // moves the local tracer ghosts

    // Cosmetic only: stop tracers when they reach a zombie + puff, so bullets
    // visibly impact instead of passing through. The host does the real damage.
    this.netplay!.guestZombieViews(this.guestZBuf);
    if (this.guestZBuf.length) {
      for (const b of this.bullets.bullets) {
        if (!b.alive) continue;
        for (const zv of this.guestZBuf) {
          const dx = zv.x - b.mesh.position.x;
          const dz = zv.z - b.mesh.position.z;
          if (dx * dx + dz * dz < zv.r * zv.r) {
            this.hitTmp.set(zv.x, 0.9, zv.z);
            this.puffs.burst(this.hitTmp, zv.color, 5);
            this.audio.hit(false);
            this.bullets.retire(b);
            break;
          }
        }
      }
    }

    this.hud.setRound(this.netplay!.netRound);
    this.hud.setPoints(this.netplay!.netPoints);
    this.hud.setHealth(this.netplay!.myHp, this.netplay!.myMaxHp);
    this.hud.setWeapon(this.netplay!.myWeapon, this.netplay!.myAmmo, this.netplay!.myReserve, this.netplay!.myReloading);
    this.player.setWeaponModel(styleForWeaponName(this.netplay!.myWeapon));
    const sp = spreadForWeaponName(this.netplay!.myWeapon);
    this.player.setAimSpread(sp.spread, sp.pellets);

    // Local buy prompt: interactables sit at fixed positions, so the guest can
    // compute its own prompt from the snapshot-driven position + shared points.
    this.points = this.netplay!.netPoints; // so prompt affordability is correct
    const near = this.interactables.nearest(this.player.pos);
    if (near) {
      const p = near.prompt(this);
      if (p) this.hud.showPrompt(p.text, p.affordable);
      else this.hud.hidePrompt();
    } else {
      this.hud.hidePrompt();
    }
  }

  private resolveBulletHits() {
    const dmgMul = this.powerups.damageMul();
    const sMul = this.powerups.scoreMul();
    const grid = this.rounds.grid;
    for (const b of this.bullets.bullets) {
      if (!b.alive) continue;
      // query only zombies in cells near the bullet (was: scan all zombies)
      grid.forNear(b.mesh.position.x, b.mesh.position.z, ZOMBIE.radius * 2 + 0.25, (z) => {
        if (!b.alive) return false; // bullet already retired this pass
        if (!z.alive || b.hit.has(z.id)) return;
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
          z.knockback(b.mesh.position.x, b.mesh.position.z, Math.max(crit ? 5 : 3, b.knockback));
          if (this.mods.cryoSlow > 0) z.applySlow(this.mods.cryoSlow, 2);
          this.audio.hit(crit);
          if (crit) {
            this.runStats.crits++;
            this.floaters.spawn(z.pos, "CRIT", "#ffe14a", 1, true);
          }
          this.damageZombie(z, dmg, sMul, crit);
          // the bullet's own splash, or the Explosive Rounds upgrade
          const splashR = Math.max(b.splashRadius, this.mods.explosiveRadius);
          if (splashR > 0) {
            this.puffs.burst(z.pos, 0xffd0a0, 6);
            const sd = b.splashRadius > 0 ? b.splashDamage * dmgMul : dmg * 0.5;
            this.splash(z.pos, splashR, sd, z.id, sMul);
          }
          if (this.mods.chainCount > 0) this.chainLightning(z, dmg * 0.5, sMul);
          // pierce first, then ricochet, then the round stops (return false to
          // end this bullet's grid scan)
          if (b.pierce > 0) {
            b.pierce--;
          } else if (b.bounces > 0 && this.ricochetBullet(b)) {
            b.bounces--;
            return false;
          } else {
            this.bullets.retire(b);
            return false;
          }
        }
      });
    }
  }

  /** Steer homing rounds toward the nearest zombie each frame. */
  private steerHomingBullets(dt: number) {
    const turn = 1 - Math.exp(-7 * dt);
    for (const b of this.bullets.bullets) {
      if (!b.alive || b.homing <= 0) continue;
      const t = this.nearestZombie(b.mesh.position.x, b.mesh.position.z, 16, b.hit);
      if (!t) continue;
      const speed = Math.hypot(b.vel.x, b.vel.z) || 40;
      const dx = t.pos.x - b.mesh.position.x;
      const dz = t.pos.z - b.mesh.position.z;
      const len = Math.hypot(dx, dz) || 1;
      b.vel.x += ((dx / len) * speed - b.vel.x) * turn;
      b.vel.z += ((dz / len) * speed - b.vel.z) * turn;
      const nl = Math.hypot(b.vel.x, b.vel.z) || 1;
      b.vel.x = (b.vel.x / nl) * speed;
      b.vel.z = (b.vel.z / nl) * speed;
      this.hitTmp.set(b.vel.x, 0, b.vel.z).normalize();
      b.mesh.quaternion.setFromUnitVectors(this.UP, this.hitTmp);
    }
  }

  /** Redirect a ricocheting bullet to the nearest fresh zombie. */
  private ricochetBullet(b: Bullet): boolean {
    const t = this.nearestZombie(b.mesh.position.x, b.mesh.position.z, 9, b.hit);
    if (!t) return false;
    const speed = Math.hypot(b.vel.x, b.vel.z) || 40;
    const dx = t.pos.x - b.mesh.position.x;
    const dz = t.pos.z - b.mesh.position.z;
    const len = Math.hypot(dx, dz) || 1;
    b.vel.set((dx / len) * speed, 0, (dz / len) * speed);
    this.hitTmp.set(b.vel.x, 0, b.vel.z).normalize();
    b.mesh.quaternion.setFromUnitVectors(this.UP, this.hitTmp);
    b.life = Math.max(b.life, 0.7);
    return true;
  }

  /** Arc bonus damage to a few zombies near `from`. */
  private chainLightning(from: Zombie, dmg: number, sMul: number) {
    let hits = 0;
    this.rounds.grid.forNear(from.pos.x, from.pos.z, 5, (z) => {
      if (hits >= this.mods.chainCount) return false;
      if (!z.alive || z === from) return;
      this.puffs.burst(z.pos, 0x9fe8ff, 4);
      this.damageZombie(z, dmg, sMul);
      hits++;
    });
  }

  /** Nearest alive zombie to (x,z) within `range`, skipping ids in `skip`. */
  private nearestZombie(x: number, z: number, range: number, skip?: Set<number>): Zombie | null {
    let best: Zombie | null = null;
    let bd = range * range;
    for (const q of this.rounds.zombies) {
      if (!q.alive || skip?.has(q.id)) continue;
      const dx = q.pos.x - x;
      const dz = q.pos.z - z;
      const d = dx * dx + dz * dz;
      if (d < bd) {
        bd = d;
        best = q;
      }
    }
    return best;
  }

  /** Apply damage to one zombie and handle the score/FX if it dies. */
  private damageZombie(z: Zombie, dmg: number, scoreMul: number, crit = false) {
    const wasBoss = z.isBoss;
    const killed = z.hit(dmg);
    if (killed) {
      this.runStats.kills++;
      if (wasBoss) this.runStats.bossKills++;
      const mult = this.combo.onKill();
      const pts = Math.round(SCORE.kill * z.scoreMul * scoreMul * mult);
      this.addPoints(pts);
      this.floaters.spawn(z.pos, `+${pts}`, mult > 1 ? "#ffd24a" : "#ffffff", mult > 1 ? 1.2 : 1);
      this.puffs.burst(z.pos, z.puffColor);
      this.audio.kill();
      if (this.mods.lifeSteal > 0) this.player.heal(this.mods.lifeSteal);
      // Detonate: killed zombies explode, damaging (and chaining through) neighbors.
      if (this.mods.detonate > 0 && !wasBoss) {
        this.puffs.burst(z.pos, 0xffa23a, 12);
        this.splash(z.pos, this.mods.detonate, dmg * 0.6, z.id, scoreMul);
      }
      // Heal Nova: a healing pulse every 10th kill.
      if (this.mods.healNova > 0 && ++this.healKills >= 10) {
        this.healKills = 0;
        this.player.heal(this.mods.healNova);
        this.puffs.burst(this.player.pos, 0x7be08a, 8);
      }
      // a satisfying micro-freeze on crits / combo kills (local visual only)
      if (crit || mult >= 2 || wasBoss) this.hitStop = Math.min(wasBoss ? 0.12 : 0.07, this.hitStop + 0.045);
      // loot: bosses always drop something juicy; normal kills roll the dice
      // Tradable loot: bosses always drop a good item; normal kills rarely do.
      if (wasBoss) {
        this.grantLoot(makeItem(rollRarity(2))); // boss → biased toward rare+
      } else if (Math.random() < 0.03 + this.mods.dropChance * 0.25) {
        this.grantLoot(makeItem());
      }
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
    this.rounds.grid.forNear(center.x, center.z, radius, (z) => {
      if (!z.alive || z.id === exceptId) return;
      const dx = z.pos.x - center.x;
      const dz = z.pos.z - center.z;
      if (dx * dx + dz * dz < r2) {
        z.knockback(center.x, center.z, 4);
        this.damageZombie(z, dmg, scoreMul);
      }
    });
  }

  private resolveZombieTouch(dt: number) {
    const r = ZOMBIE.radius + PLAYER.radius;
    // candidate victims: local player + any guests (host-authoritative).
    // Reuse a scratch array each frame to avoid GC churn.
    const victims = this._victims;
    victims.length = 0;
    victims.push(this.player);
    if (this.netplay) for (const s of this.netplay.hostGuestSlots()) victims.push(s.player);
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
          z.touchCooldown = ZOMBIE.touchInterval;
          // Thorns: zombies that touch the host player take damage + get shoved.
          if (victim === this.player && this.mods.thorns > 0) {
            z.knockback(victim.pos.x, victim.pos.z, 6);
            this.damageZombie(z, this.mods.thorns, this.powerups.scoreMul());
          }
          // Dodge: the host player has a chance to shrug the hit off entirely.
          if (victim === this.player && this.mods.dodge > 0 && Math.random() < this.mods.dodge) {
            this.floaters.spawn(this.player.pos, "DODGE", "#9fe8ff", 1);
            break;
          }
          victim.damage(z.touchDamage);
          if (victim === this.player) {
            this.shake = Math.min(0.5, this.shake + 0.25);
            this.audio.hurt();
            this.runStats.tookDamage = true;
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
      this.runStats.tookDamage = true;
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
