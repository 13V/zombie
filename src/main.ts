import "./style.css";
import * as THREE from "three";
import { EffectComposer } from "three/examples/jsm/postprocessing/EffectComposer.js";
import { RenderPass } from "three/examples/jsm/postprocessing/RenderPass.js";
import { UnrealBloomPass } from "three/examples/jsm/postprocessing/UnrealBloomPass.js";
import { OutputPass } from "three/examples/jsm/postprocessing/OutputPass.js";
import { SMAAPass } from "three/examples/jsm/postprocessing/SMAAPass.js";
import { RoomEnvironment } from "three/examples/jsm/environments/RoomEnvironment.js";

import { CAMERA, COSTS, PETS_TUNING, PLAYER, SCORE, ZOMBIE } from "./config";
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
import { Explosions } from "./explosions";
import { Island, IslandZone } from "./island";
import { IslandNet, makeBubble } from "./islandnet";
import { EmoteMenu } from "./emotes";
import type { EmoteId } from "./voxelChar";
import { HouseView, HouseData, HousePart, PartKind, HOUSE_PARTS, PART_CATS, HOUSE_SWATCHES, TROPHY_TIERS, trophyTierForRound, starterHouse, sanitizeHouse } from "./house";
import { loadHouse, saveHouse, getHouseMeta, likeHouse, localOwnerId } from "./houses";
import { rateHouse } from "./houserating";
import { Sparks } from "./particles";
import { Pet, PETS, findAnyPet, petLevelCost, isTrialComplete, RARITY_COLOR, type Rarity, type PetDef } from "./pets";
import { RunMods, defaultMods, cloneMods, diffMods } from "./mods";
import { loadSave, writeSave, SaveData } from "./save";
import { META_UPGRADES, essenceFor } from "./meta";
import { RUN_UPGRADES, rollUpgrades, RunUpgrade } from "./upgrades";
import { SKINS, findSkin } from "./cosmetics";
import { makeItem, rollRarity, rollRarityPity, resetPity, rarityColorHex, RARITIES, LootItem } from "./loot";
import { CHALLENGES, RunStats, blankRunStats } from "./challenges";
import { NetClient, InputMsg, ZombieSnap, warmServer, getServerUrl, setServerUrl } from "./net";
import { TouchControls, isTouchDevice } from "./touchControls";
import { Wallet } from "./wallet";
import { getTokenApiUrl, setTokenApiUrl, fetchClaimable } from "./token";
import { NetPlay, GuestSlot } from "./netplay";
import { COLORS } from "./palette";
import { TiltShift } from "./tiltShift";

/** Tiny pooled "poof" particles for kill feedback. Hard-capped so chaotic
 *  moments (nukes, detonate chains, gibs) can't spawn unbounded meshes. */
class Puffs {
  private pool: { m: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];
  private active: { m: THREE.Mesh; vel: THREE.Vector3; life: number }[] = [];
  // lower-poly sphere + tighter cap on weak hardware
  private geo: THREE.SphereGeometry;
  private cap: number;
  private lowSpec: boolean;
  constructor(private scene: THREE.Scene, lowSpec = false) {
    this.lowSpec = lowSpec;
    this.cap = lowSpec ? 70 : 160;
    this.geo = new THREE.SphereGeometry(0.18, lowSpec ? 4 : 6, lowSpec ? 4 : 6);
  }
  // cheaper unlit material on mobile; lit emissive sphere on desktop
  private makeMat(color: number): THREE.Material {
    if (this.lowSpec) {
      return new THREE.MeshBasicMaterial({ color, transparent: true, opacity: 0.9, depthWrite: false, toneMapped: false });
    }
    return glowMaterial(color, 0.8);
  }
  burst(pos: THREE.Vector3, color: number, count = 8) {
    // thin out puff counts on weak hardware (mirrors Sparks/Explosions)
    const n = this.lowSpec ? Math.max(2, Math.round(count * 0.55)) : count;
    for (let i = 0; i < n; i++) {
      // enforce the cap: recycle the oldest live puff instead of growing
      if (this.active.length >= this.cap) {
        const old = this.active.shift();
        if (old) {
          old.m.visible = false;
          this.scene.remove(old.m);
          this.pool.push(old);
        }
      }
      let p = this.pool.pop();
      if (!p) p = { m: new THREE.Mesh(this.geo, this.makeMat(color)), vel: new THREE.Vector3(), life: 0 };
      const m = p.m;
      const mat = m.material as THREE.MeshStandardMaterial;
      mat.color.set(color);
      if (mat.emissive) mat.emissive.set(color);
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

type State = "menu" | "island" | "playing" | "paused" | "over" | "levelup";

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
  private island!: Island;
  private islandNet?: IslandNet;
  private emoteMenu?: EmoteMenu;
  private footstepAcc = 0; // throttles island footstep puffs
  private islandPop = -1; // last-rendered "N players here" count (-1 = unset)
  private selfBubble?: THREE.Sprite; // my own speech bubble above my head
  private selfBubbleT = 0; // seconds remaining on my speech bubble
  private houseViews = new Map<number, HouseView>();
  private editingPlot = -1; // plot index currently in build mode (-1 = none)
  private editData: HouseData = { parts: [] };
  private editPart: PartKind = "wall";
  private editCat = "structure"; // active build-bar category tab
  private editRot: 0 | 1 | 2 | 3 = 0; // current placement yaw
  private editColor: number | null = null; // null = part's default color
  private editPaint = false; // paint mode: clicking recolors existing parts
  private editPetId = ""; // pet to attach to the next placed "perch"
  private editReadOnly = false; // visiting someone else's plot (no edits)
  private undoStack: string[] = []; // JSON snapshots of editData (cap 20)
  private ghost?: THREE.Object3D; // translucent placement preview
  private ghostMat?: THREE.MeshBasicMaterial;
  private player: Player;
  private bullets: BulletSystem;
  private rounds: RoundManager;
  private interactables: Interactables;
  private hud: Hud;
  private puffs: Puffs;
  private floaters: FloatingText;
  private drops: Drops;
  private explosions: Explosions;
  private sparks: Sparks;
  private pets: Pet[] = [];
  private _petTgt = { x: 0, z: 0 };
  private _petDir = new THREE.Vector3();
  private _petGold = 0; // fractional gold accumulator for banker pets
  private _bankerRoundGold = 0; // gold minted by bankers this round (per-round cap)
  private _bankerRound = -1; // round the above was last reset for
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
  private _runCasts: Record<string, number> = {}; // per-pet ability casts this run (trial tracking)

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
  // reused camera offset (CAMERA.offset is constant) — avoids a per-frame Vector3 alloc
  private _camOffset = new THREE.Vector3(CAMERA.offset.x, CAMERA.offset.y, CAMERA.offset.z);
  // juice: transient camera punch-zoom (0 = none) + last combo tier shown
  private zoomPunch = 0;
  private lastComboTier = 1;
  // Nuke panic button: charge builds from kills; press F to wipe the screen.
  private nukeCharge = 1;

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

    // LOW-SPEC (mobile): cap pixel ratio harder, drop the heavy post stack
    // (bloom + tilt-shift are the fill-rate hogs), and shrink the bullet cap —
    // a phone GPU can't afford 140 additive tracers + full post.
    const lowSpec = isTouchDevice();
    if (lowSpec) this.renderer.setPixelRatio(Math.min(devicePixelRatio, 1));

    // Soft image-based ambient light — the key to the "soft 3D" cozy look.
    const pmrem = new THREE.PMREMGenerator(this.renderer);
    this.scene.environment = pmrem.fromScene(new RoomEnvironment(), 0.04).texture;
    this.scene.environmentIntensity = 0.5;

    this.composer = new EffectComposer(this.renderer);
    this.composer.addPass(new RenderPass(this.scene, this.camera));
    // Gentle bloom — only the brightest emissives glow. Half-res; skipped on mobile.
    if (!lowSpec) {
      const bloom = new UnrealBloomPass(new THREE.Vector2(innerWidth / 2, innerHeight / 2), 0.16, 0.5, 0.92);
      this.composer.addPass(bloom);
    }
    // Tilt-shift: subtle miniature-diorama blur + grade. Two full-screen passes —
    // skipped on mobile (biggest fill-rate win there).
    this.tilt = new TiltShift(innerWidth, innerHeight, {
      focus: 0.5, band: 0.42, strength: 1.8, vignette: 0.26, saturation: 1.08, warmth: 0.12,
    });
    if (!lowSpec) {
      this.composer.addPass(this.tilt.horizontal);
      this.composer.addPass(this.tilt.vertical);
    }
    this.composer.addPass(new SMAAPass(innerWidth, innerHeight));
    this.composer.addPass(new OutputPass());

    this.input = new Input(canvas);
    if (isTouchDevice()) {
      document.body.classList.add("touch");
      this.touch = new TouchControls(this.input);
    }
    this.arena = new Arena(this.scene);
    this.island = new Island(this.scene);
    this.player = new Player(this.scene, this.assets);
    this.bullets = new BulletSystem(this.scene);
    if (lowSpec) this.bullets.maxLive = 70; // fewer live tracers on mobile GPUs
    this.rounds = new RoundManager(this.scene, this.assets);
    if (lowSpec) this.rounds.maxAliveCeiling = 42; // survivable carnage on phones
    this.interactables = new Interactables(this.scene, this.arena.half);
    this.puffs = new Puffs(this.scene, lowSpec);
    this.floaters = new FloatingText(this.scene);
    this.drops = new Drops(this.scene, this.audio);
    this.explosions = new Explosions(this.scene, lowSpec);
    this.sparks = new Sparks(this.scene, lowSpec);
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
      if (n > 1) {
        const tag = this.rounds.isBossRound ? " — BOSS" : this.rounds.isSwarmRound ? " — SWARM!" : "";
        this.hud.toast(`Round ${n}${tag}`);
      }
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
    this.hud.onIsland(() => this.enterIsland());
    this.hud.onLeaveIsland(() => this.leaveIsland());
    // Island social: emote wheel + preset quick-chat (T key or on-screen button).
    this.emoteMenu = new EmoteMenu(ui, {
      onEmote: (id) => this.playSelfEmote(id),
      onChat: (text) => this.saySelf(text),
      onOpenChange: (open) => this.islandNet?.setMenuOpen(open),
    });
    this.hud.onWallet(() => this.toggleWallet());
    this.hud.onClaim(() => this.claimTokens(), () => this.changeTokenApi());
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
    this.spawnPets();
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
    this.lastComboTier = 1;
    this.zoomPunch = 0;
    this.nukeCharge = 1;
    this.runStats = blankRunStats();
    this._runCasts = {};
    this.combo.windowBonus = this.mods.comboWindowBonus;
    this.hud.setPowerups([]);
    this.shake = 0;
    this.combo.reset();
    resetPity(); // fresh bad-luck-protection streak each run (non-cashable)
    this.floaters.clear();
    this.drops.clear();
    this.explosions.clear();
    this.sparks.clear();
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

    // Pets: buy companions with gold (the gold sink + late-game chaos).
    this.hud.renderPets(
      this.save.gold,
      PETS.map((base) => {
        // If this pet has evolved, show its evolved form (continue leveling it).
        const evoId = base.evolvesTo;
        const isEvolved = !!evoId && this.save.pets.includes(evoId);
        const p = isEvolved ? (findAnyPet(evoId!) ?? base) : base;
        const ownId = isEvolved ? evoId! : base.id;
        const owned = this.save.pets.includes(ownId);
        const level = this.save.petLevels[ownId] ?? 1;
        const upCost = petLevelCost(base, level); // cost curve keyed off the base
        const rarity = (base.rarity ?? "common") as Rarity;
        // Evolution-trial progress (only for an owned, not-yet-evolved evolver).
        let trial: { label: string; cur: number; goal: number; done: boolean }[] | undefined;
        if (owned && !isEvolved && base.trial && base.evolveLevel) {
          const prog = this.save.petProgress[ownId] ?? {};
          trial = [
            { label: `Reach Lv ${base.evolveLevel}`, cur: Math.min(level, base.evolveLevel), goal: base.evolveLevel, done: level >= base.evolveLevel },
            ...base.trial.goals.map((go) => {
              const cur = prog[go.stat] ?? 0;
              return { label: go.label, cur: Math.min(cur, go.goal), goal: go.goal, done: cur >= go.goal };
            }),
          ];
        }
        return {
          id: ownId, name: p.name, desc: p.desc, cost: base.cost,
          color: `#${p.color.toString(16).padStart(6, "0")}`,
          owned, level,
          upCost,
          affordable: owned ? this.save.gold >= upCost : this.save.gold >= base.cost,
          rarity,
          rarityColor: RARITY_COLOR[rarity],
          ability: p.ability?.name ?? base.ability?.name,
          trial,
        };
      }),
      (id) => this.buyOrLevelPet(id),
    );
  }

  /** Buy a companion pet with gold; it joins you on the next run (and this one). */
  /** Buy a pet if unowned, else spend gold to level it up (the idle loop). */
  private buyOrLevelPet(id: string) {
    const def = findAnyPet(id);
    if (!def) return;
    // For an evolved pet, the level-cost curve still uses the base pet's cost.
    const baseForCost = PETS.find((p) => p.evolvesTo === id) ?? def;
    const owned = this.save.pets.includes(id);
    if (!owned) {
      if (this.save.gold < def.cost) { this.audio.deny(); return; }
      this.save.gold -= def.cost;
      this.save.pets.push(id);
      this.save.petLevels[id] = 1;
    } else {
      const level = this.save.petLevels[id] ?? 1;
      const cost = petLevelCost(baseForCost, level);
      if (this.save.gold < cost) { this.audio.deny(); return; }
      this.save.gold -= cost;
      const newLevel = level + 1;
      this.save.petLevels[id] = newLevel;
      const live = this.pets.find((p) => p.def.id === id);
      if (live) live.setLevel(newLevel);
      // Evolution is gated on level + trial — only fires when both are met.
      this.checkPetEvolutions();
    }
    writeSave(this.save);
    this.audio.powerup();
    if (!owned) this.spawnPets();
    this.renderShop();
  }

  /** Accumulate this run's "while-equipped" totals into each owned pet's trial. */
  private foldPetTrials() {
    for (const id of this.save.pets) {
      const def = findAnyPet(id);
      if (!def || !def.trial) continue; // evolved already, or never evolves
      const pr = (this.save.petProgress[id] ??= {});
      pr.kills = (pr.kills ?? 0) + this.runStats.kills;
      pr.bosses = (pr.bosses ?? 0) + this.runStats.bossKills;
      pr.crits = (pr.crits ?? 0) + this.runStats.crits;
      pr.runs = (pr.runs ?? 0) + 1;
      pr.casts = (pr.casts ?? 0) + (this._runCasts[id] ?? 0);
      pr.bestRound = Math.max(pr.bestRound ?? 0, this.runStats.round);
    }
  }

  /** Evolve any owned pet that has met BOTH its level and trial requirements. */
  private checkPetEvolutions() {
    let evolved = false;
    for (const id of [...this.save.pets]) {
      const def = findAnyPet(id);
      if (!def || !def.evolvesTo || !def.evolveLevel) continue;
      if ((this.save.petLevels[id] ?? 1) < def.evolveLevel) continue;
      if (!isTrialComplete(def, this.save.petProgress[id])) continue;
      this.evolvePet(id, def);
      evolved = true;
    }
    if (evolved) {
      writeSave(this.save);
      this.spawnPets();
      this.renderShop();
    }
  }

  /** Swap an owned base pet for its evolved form (level carries over). */
  private evolvePet(id: string, def: PetDef) {
    if (!def.evolvesTo) return;
    const idx = this.save.pets.indexOf(id);
    if (idx < 0) return;
    const lvl = this.save.petLevels[id] ?? 1;
    this.save.pets[idx] = def.evolvesTo;
    this.save.petLevels[def.evolvesTo] = lvl;
    delete this.save.petLevels[id];
    delete this.save.petProgress[id];
    this.audio.levelUp();
    this.hud.toast("✦ Evolved into " + (findAnyPet(def.evolvesTo)?.name ?? "?") + "!");
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
    this.hud.hideGuestDown(); // clear the co-op spectator overlay if it was up
    this.hud.setBest(this.save.bestRound, this.save.bestScore);
    this.renderShop();
    this.hud.showStart();
  }

  /** Pause the breather and offer 1 of 3 stacking run upgrades. */
  private offerLevelUp() {
    this.levelNum++;
    this.levelCards = rollUpgrades(3, this.rounds.round);
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
    this.levelCards = rollUpgrades(3, this.rounds.round);
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
    // leaving the hub for the zombie world: swap scenes back to the arena
    this.island.setVisible(false);
    this.arena.group.visible = true;
    this.hud.setIslandMode(false);
    this.hud.hidePrompt();
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
    this.foldPetTrials();
    this.checkPetEvolutions();

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

  /** Reflect wallet state on the menu, then ask the backend what's claimable. */
  private async syncWallet() {
    const s = this.wallet.state;
    if (!s.connected || !s.address) {
      this.hud.setWallet(false, "", "");
      this.hud.setClaimStatus("");
      return;
    }
    // Optimistic label until the authoritative backend answers.
    this.hud.setWallet(true, this.wallet.short, "checking…");
    this.hud.setLobbyStatus("Wallet linked.");
    // The ONLY source of truth for claimable tokens is the server ledger.
    const claimable = await fetchClaimable(s.address);
    if (claimable !== null) {
      this.hud.setWallet(true, this.wallet.short, `${claimable} $TOKEN claimable`);
      this.hud.setClaimStatus(claimable > 0 ? "Ready to claim" : "Keep playing to earn");
    } else {
      // No backend yet — show local Essence as a provisional, unverified preview.
      this.hud.setWallet(true, this.wallet.short, `${this.save.essence} ✦ pending`);
      this.hud.setClaimStatus(getTokenApiUrl() ? "Backend unreachable" : "Set token backend ⚙ to enable claims");
    }
  }

  /** Ask the reward backend to pay out earnings to the connected wallet. */
  private async claimTokens() {
    this.hud.setClaimStatus("Requesting claim…");
    const r = await this.wallet.requestClaim();
    this.hud.setClaimStatus(r.message);
    this.audio[r.ok ? "powerup" : "deny"]();
    if (r.ok) this.syncWallet();
  }

  /** Point the client at a deployed token-backend (claims route through it). */
  private changeTokenApi() {
    const next = window.prompt(
      "Token reward backend URL (https://…):\n\nDeploy /token-backend and paste its URL here. The backend verifies your wallet, reads its own ledger, and signs the payout — the game client never mints tokens.",
      getTokenApiUrl(),
    );
    if (next === null) return;
    const url = setTokenApiUrl(next);
    this.hud.setClaimStatus(url ? `Backend set: ${url}` : "Backend cleared");
    this.syncWallet();
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
    this.disconnectIslandPresence(); // free the island socket before co-op
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
    this.disconnectIslandPresence(); // free the island socket before co-op
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
      this.island.setVisible(false);
      this.arena.group.visible = true;
      this.hud.setIslandMode(false);
      this.hud.hidePrompt();
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
    this.hud.hideGuestDown(); // a downed guest forced out (e.g. host left) clears the overlay
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

  /** Quantize a points value for the floating "+N" text so we don't mint a
   *  unique GPU texture for every exact number (that churn caused frame hitches).
   *  Buckets keep the distinct-string count small and stable. */
  private floatNum(n: number): string {
    if (n < 100) return `+${Math.round(n / 5) * 5}`;
    if (n < 1000) return `+${Math.round(n / 25) * 25}`;
    return `+${(Math.round(n / 100) / 10).toFixed(1)}k`;
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
    if (this.input.pressed("KeyF") && this.state === "playing" && this.nukeCharge >= 1) {
      this.nukeCharge = 0;
      this.nukeBoard();
      this.zoomPunch = 1;
      this.floaters.spawn(this.player.pos, "NUKE!", "#ff7a3a", 1.6, true);
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

    this.touch?.setActive(this.state === "playing" || this.state === "paused" || this.state === "island");
    this.player.showAimGuide(this.state === "playing");
    if (this.state === "playing") {
      if (this.netplay && !this.netplay.isHost) this.simulateGuest(dt);
      else this.simulate(dt);
    } else if (this.state === "island") {
      this.simulateIsland(dt);
    } else {
      this.player.idle(dt); // keep the figure breathing on menu / pause / over
    }

    this.island.update(dt);
    this.arena.update(dt);
    this.interactables.update(dt);
    this.puffs.update(dt);
    this.explosions.update(dt);
    this.sparks.update(dt);
    this.floaters.update(dt);
    this.updateCamera(dt);

    this.composer.render();
    this.input.endFrame();
  };

  /** Enter the island hub: hide the arena, show the island, drop the player in. */
  private enterIsland() {
    this.teardownNet();
    this.state = "island";
    this.hud.hideStart();
    this.hud.hideGameOver();
    this.arena.group.visible = false;
    this.island.setVisible(true);
    this.player.alive = true;
    this.player.pos.set(0, 0, 6); // stand just south of the plaza
    this.player.group.position.copy(this.player.pos);
    this.hud.setIslandMode(true);
    this.emoteMenu?.setAvailable(true);
    this.islandPop = -1; // force the population indicator to refresh
    // spawn burst: a friendly arrival pop so dropping in feels like an event
    this.portalBurst(this.player.pos);
    this.connectIslandPresence();
    this.loadIslandHouses();
  }

  /** Render any saved houses onto their plots when entering the hub. */
  private async loadIslandHouses() {
    for (const plot of this.island.plots) {
      const data = await loadHouse(plot.index, this.plotOwner(plot.index));
      if (!data) continue;
      let view = this.houseViews.get(plot.index);
      if (!view) {
        view = new HouseView(this.scene, plot.pos);
        this.houseViews.set(plot.index, view);
      }
      view.render(sanitizeHouse(data));
    }
  }

  /** Join the shared island instance so other players appear (best-effort). */
  private async connectIslandPresence() {
    if (this.islandNet || this.net) return; // already social, or in a co-op room
    warmServer();
    try {
      this.net = new NetClient();
      this.net.onClose = () => this.disconnectIslandPresence();
      await this.net.island();
      const skin = findSkin(this.save.skin);
      this.islandNet = new IslandNet(this.net, this.scene, skin.body, skin.head);
      this.islandNet.setMenuOpen(this.emoteMenu?.isOpen ?? false);
      this.hud.toast("Island: press T to emote 👋");
    } catch {
      // presence is optional — the hub still works solo if the relay is asleep
      this.net?.close();
      this.net = undefined;
      this.hud.setLobbyStatus("Island presence offline (relay asleep) — hub still works.");
    }
  }

  private disconnectIslandPresence() {
    this.islandNet?.dispose();
    this.islandNet = undefined;
    this.net?.close();
    this.net = undefined;
  }

  /** Leave the island back to the classic menu (arena visible behind it). */
  private leaveIsland() {
    if (this.editingPlot >= 0) this.exitBuildMode();
    this.disconnectIslandPresence();
    for (const v of this.houseViews.values()) v.dispose(this.scene);
    this.houseViews.clear();
    // free the build-mode ghost preview mesh + material
    if (this.ghost) {
      this.scene.remove(this.ghost);
      (this.ghost as THREE.Mesh).geometry?.dispose();
      this.ghostMat?.dispose();
      this.ghost = undefined;
      this.ghostMat = undefined;
    }
    this.island.setVisible(false);
    this.arena.group.visible = true;
    this.hud.setIslandMode(false);
    this.hud.hidePrompt();
    this.emoteMenu?.setAvailable(false); // also closes the menu if open
    this.hud.setIslandPopulation(-1); // hide the "N players here" chip
    this.updateSelfBubble(999); // drop any lingering speech bubble
    this.state = "menu";
    this.hud.showStart();
  }

  /** Free-roam the island: walk the character, clamp to shore, drive prompts. */
  private simulateIsland(dt: number) {
    const axis = this.input.moveAxis(this._axis);
    const moving = axis.x !== 0 || axis.y !== 0;
    // aiming=false → the character faces where it walks (no gun aim in the hub)
    this.player.update(dt, axis.x, -axis.y, this.input.aimPoint, false);
    this.island.clamp(this.player.pos);
    this.player.group.position.copy(this.player.pos);

    // open the emote wheel + quick-chat with "T" (touch uses the on-screen button)
    if (this.input.pressed("KeyT")) this.emoteMenu?.toggle();

    // footstep puff under the chibi while walking (throttled + pooled)
    if (moving) {
      this.footstepAcc += dt;
      if (this.footstepAcc >= 0.18) {
        this.footstepAcc = 0;
        this.sparks.burst(this.player.pos, 0xe6d9a8, 3, { speed: 1.6, spread: 0.8, gravity: 10 });
      }
    } else {
      this.footstepAcc = 0.18; // puff immediately on the next step
    }

    // my own speech bubble lifetime + reactive pads (bounce/brighten on stand)
    this.updateSelfBubble(dt);
    this.island.reactPads(this.player.pos, dt);

    // broadcast my pose + render other players on this island instance
    this.islandNet?.update(dt, {
      x: this.player.pos.x, z: this.player.pos.z,
      ry: this.player.group.rotation.y, moving,
    });

    // "N players here" social presence chip (only refresh on change)
    const pop = (this.islandNet?.peerCount ?? 0) + 1; // +1 = me
    if (pop !== this.islandPop) {
      this.islandPop = pop;
      this.hud.setIslandPopulation(pop);
    }

    // ---- build mode: ghost preview + click to place/paint/remove ----
    if (this.editingPlot >= 0) {
      this.hud.showPrompt(
        this.editReadOnly ? "Visiting — [L] like · [E] to leave" : "Click to build · R rotate · [E] to finish & save",
        true,
      );
      this.updateGhost();
      if (!this.editReadOnly) {
        if (this.input.pressed("KeyR")) this.rotateBuild();
        // Ctrl+Z / Cmd+Z undo (the on-screen button also calls undoBuild)
        if (this.input.pressed("KeyZ") && (this.input.down("ControlLeft") || this.input.down("MetaLeft"))) this.undoBuild();
        if (this.input.clicked()) this.placeAtGround(this.input.aimPoint);
      } else if (this.input.pressed("KeyL")) {
        this.likeCurrentHouse();
      }
      if (this.input.pressed("KeyE")) this.exitBuildMode();
      return;
    }

    // proximity prompt for the nearest interactive pad / plot
    const near = this.island.nearestZone(this.player.pos);
    if (near) this.hud.showPrompt(near.label + "  [E]", true);
    else this.hud.hidePrompt();

    // E (or tap-confirm) activates whatever you're standing on
    if (near && (this.input.pressed("KeyE") || this.input.pressed("Space"))) {
      this.activateIslandZone(near);
    }
  }

  /** Act on the pad the player triggered. */
  private activateIslandZone(zone: IslandZone) {
    // co-op pads warp you to the zombie world — give the launch a portal burst.
    if (zone.kind === "host" || zone.kind === "join") this.portalBurst(zone.pos);
    switch (zone.kind) {
      case "host":
        this.hostGame();
        break;
      case "join": {
        const code = window.prompt("Enter your friend's 4-letter room code:");
        if (code && code.trim()) this.joinGame(code.trim());
        break;
      }
      case "shop":
        this.hud.openShop();
        break;
      case "plot": {
        const idx = zone.plotIndex ?? 0;
        // Your own plot is editable; the rest are neighbours you visit read-only.
        if (this.isOwnPlot(idx)) this.enterBuildMode(idx);
        else this.enterVisitMode(idx);
        break;
      }
      case "play":
        this.startRun();
        break;
    }
  }

  /** A juicy warp/portal pop at a pad (flash + pillar + sparks + sfx). */
  private portalBurst(pos: THREE.Vector3) {
    this.explosions.flash(pos, 3.2, 0xbfe0ff);
    this.explosions.beam(pos, 6, 0x8fd0ff);
    this.explosions.shockwave(pos, 4, 0xffffff);
    this.sparks.burst(pos, 0xbfe0ff, 18, { speed: 8, spread: 5, streak: true });
    this.audio.powerup();
    this.shake = Math.min(0.6, this.shake + 0.25);
  }

  // ---- island social: emote + quick-chat on MY figure ----
  /** Play an emote on my own voxel figure + broadcast it to peers. */
  private playSelfEmote(id: EmoteId) {
    this.player.voxelRig?.emote(id);
    this.islandNet?.sendEmote(id);
    this.audio.ui();
  }

  /** Show a speech bubble above MY head + broadcast the preset phrase. */
  private saySelf(text: string) {
    if (this.selfBubble) {
      this.player.group.remove(this.selfBubble);
      (this.selfBubble.material as THREE.SpriteMaterial).map?.dispose();
      (this.selfBubble.material as THREE.SpriteMaterial).dispose();
    }
    this.selfBubble = makeBubble(text);
    this.player.group.add(this.selfBubble);
    this.selfBubbleT = 3.0;
    this.islandNet?.sendChat(text);
    this.audio.ui();
  }

  /** Tick my own speech bubble lifetime (called from simulateIsland + on leave). */
  private updateSelfBubble(dt: number) {
    if (!this.selfBubble) return;
    this.selfBubbleT -= dt;
    if (this.selfBubbleT <= 0) {
      this.player.group.remove(this.selfBubble);
      (this.selfBubble.material as THREE.SpriteMaterial).map?.dispose();
      (this.selfBubble.material as THREE.SpriteMaterial).dispose();
      this.selfBubble = undefined;
    }
  }

  // ---- house building -----------------------------------------------------
  private static readonly CELL = 1.2; // plot grid cell size (matches house.ts)

  // v1: all 8 plots are YOURS to build on, each persisted independently under
  // your id (build a little neighbourhood). isOwnPlot() ALWAYS returns true ON
  // PURPOSE for v1 — this is not a bug. The consequence is that the visit-mode
  // path (enterVisitMode + likeCurrentHouse, reached only when isOwnPlot is
  // false at main.ts ~activateIslandZone) is intentionally DORMANT: it is fully
  // wired and ready but unreachable until a real cross-player plot-claim system
  // with shared identities lands (a backend follow-up). Do NOT remove that code
  // as "dead" — flipping this to a real ownership check activates it.
  private isOwnPlot(_plotIndex: number): boolean {
    return true;
  }
  /** Backend owner key for a plot — namespaced per plot so each saves separately.
   *  Keyed on a STABLE per-device id (not the wallet address): connecting a
   *  wallet must not change the key and orphan / lose a player's houses. See
   *  localOwnerId() in houses.ts. */
  private plotOwner(plotIndex: number): string {
    return `${localOwnerId()}:p${plotIndex}`;
  }

  /** Enter build mode for a plot: load its layout + show the build bar. */
  private async enterBuildMode(plotIndex: number) {
    if (this.editingPlot >= 0) return; // guard against re-entry during the load await
    const owner = this.plotOwner(plotIndex);
    this.editingPlot = plotIndex; // claim immediately so a second E press no-ops
    const existing = await loadHouse(plotIndex, owner);
    this.editData = existing ? sanitizeHouse(existing) : starterHouse();
    this.editReadOnly = false;
    this.editPart = "wall";
    this.editCat = "structure"; // reset catalog tab so the active part is visible
    this.editRot = 0;
    this.editColor = null;
    this.editPaint = false;
    this.undoStack = [];
    let view = this.houseViews.get(plotIndex);
    if (!view) {
      const plot = this.island.plots.find((p) => p.index === plotIndex)!;
      view = new HouseView(this.scene, plot.pos);
      this.houseViews.set(plotIndex, view);
    }
    view.render(this.editData);
    this.refreshBuildBar();
    this.hud.toast(`Building Plot ${plotIndex + 1} — R rotate · Ctrl+Z undo · E to finish`);
  }

  /** (Re)build the build bar from current tool state — call after any toggle. */
  private refreshBuildBar() {
    const tTier = trophyTierForRound(this.save.bestRound);
    this.hud.showBuildBar({
      cats: PART_CATS.map((c) => ({ id: c.id, label: c.label })),
      // the trophy chip advertises the tier the player has unlocked
      parts: HOUSE_PARTS.map((p) =>
        p.kind === "trophy"
          ? { kind: p.kind, label: `${TROPHY_TIERS[tTier].label} Trophy`, color: TROPHY_TIERS[tTier].color, cat: p.cat }
          : { kind: p.kind, label: p.label, color: p.color, cat: p.cat },
      ),
      swatches: HOUSE_SWATCHES,
      activeCat: this.editCat,
      activePart: this.editPart,
      activeColor: this.editColor,
      paint: this.editPaint,
      onPickCat: (id) => { this.editCat = id; this.refreshBuildBar(); },
      onPickPart: (k) => {
        this.editPart = k as PartKind;
        this.editPaint = false; // selecting a part leaves paint mode
        if (k === "perch") this.pickPerchPet();
        else this.hud.hidePetPicker();
        this.refreshBuildBar();
      },
      onPickColor: (c) => { this.editColor = c; this.refreshBuildBar(); },
      onRotate: () => this.rotateBuild(),
      onTogglePaint: () => { this.editPaint = !this.editPaint; this.refreshBuildBar(); },
      onUndo: () => this.undoBuild(),
      onDone: () => this.exitBuildMode(),
    });
  }

  /** Cycle the placement yaw 0->1->2->3->0. */
  private rotateBuild() {
    this.editRot = ((this.editRot + 1) % 4) as 0 | 1 | 2 | 3;
    this.audio.ui();
    this.updateGhost();
  }

  /** Push a JSON snapshot before a mutating edit (cap 20). */
  private pushUndo() {
    this.undoStack.push(JSON.stringify(this.editData));
    if (this.undoStack.length > 20) this.undoStack.shift();
  }
  /** Restore the most recent snapshot. */
  private undoBuild() {
    const snap = this.undoStack.pop();
    if (!snap) { this.audio.deny(); return; }
    try { this.editData = sanitizeHouse(JSON.parse(snap)); } catch { return; }
    this.houseViews.get(this.editingPlot)?.render(this.editData);
    this.audio.ui();
  }

  /** Show a picker of owned pets to attach to the next placed perch. */
  private pickPerchPet() {
    const owned = this.save.pets
      .map((id) => findAnyPet(id))
      .filter((d): d is PetDef => !!d)
      .map((d) => ({ id: d.id, name: d.name, color: `#${d.color.toString(16).padStart(6, "0")}` }));
    if (!owned.length) {
      this.hud.toast("Buy a pet first to display it!");
      this.editPetId = "";
      this.hud.hidePetPicker();
      return;
    }
    if (!this.editPetId || !owned.some((o) => o.id === this.editPetId)) this.editPetId = owned[0].id;
    this.hud.showPetPicker(owned, this.editPetId, (id) => { this.editPetId = id; });
  }

  /** Project the aim point to a plot-local grid cell, or null if off the pad. */
  private aimCell(world: THREE.Vector3): { gx: number; gz: number } | null {
    const plot = this.island.plots.find((p) => p.index === this.editingPlot);
    if (!plot) return null;
    const gx = Math.round((world.x - plot.pos.x) / Game.CELL);
    const gz = Math.round((world.z - plot.pos.z) / Game.CELL);
    if (Math.abs(gx) > 2 || Math.abs(gz) > 2) return null; // outside the plot pad
    return { gx, gz };
  }

  /** Place/paint/remove a part at the plot cell under the click. */
  private placeAtGround(world: THREE.Vector3) {
    if (this.editingPlot < 0 || this.editReadOnly) return;
    const cell = this.aimCell(world);
    if (!cell) return;
    const { gx, gz } = cell;
    const atCell = this.editData.parts.filter((p) => p.gx === gx && p.gz === gz);

    // Paint mode: recolour the topmost part at this cell instead of placing.
    if (this.editPaint) {
      const target = atCell[atCell.length - 1];
      if (!target) { this.audio.deny(); return; }
      this.pushUndo();
      if (this.editColor === null) delete target.color;
      else target.color = this.editColor;
      this.houseViews.get(this.editingPlot)?.render(this.editData);
      this.audio.ui();
      return;
    }

    const tall = !!HOUSE_PARTS.find((d) => d.kind === this.editPart)?.tall;
    // toggle: clicking the existing identical top part removes it
    const top = atCell.reduce<HousePart | null>((hi, p) => (!hi || p.gy > hi.gy ? p : hi), null);
    this.pushUndo();
    if (top && top.kind === this.editPart) {
      this.editData.parts = this.editData.parts.filter((p) => p !== top);
    } else {
      if (this.editData.parts.length >= 400) { this.undoStack.pop(); this.audio.deny(); return; }
      const gy = tall ? (top ? top.gy + 1 : 1) : 0;
      const part: HousePart = { kind: this.editPart, gx, gy, gz };
      if (this.editColor !== null) part.color = this.editColor;
      if (this.editRot) part.rot = this.editRot;
      if (this.editPart === "perch" && this.editPetId) part.petId = this.editPetId;
      if (this.editPart === "trophy") part.tier = trophyTierForRound(this.save.bestRound);
      this.editData.parts.push(part);
    }
    this.houseViews.get(this.editingPlot)?.render(this.editData);
  }

  /** Translucent preview at the aim cell — green = valid, red = off-plot,
   *  amber = paint. */
  private updateGhost() {
    if (this.editingPlot < 0 || this.editReadOnly) { this.hideGhost(); return; }
    const plot = this.island.plots.find((p) => p.index === this.editingPlot);
    if (!plot) { this.hideGhost(); return; }
    if (!this.ghost) {
      this.ghostMat = new THREE.MeshBasicMaterial({ color: 0x55ff66, transparent: true, opacity: 0.4, depthWrite: false });
      this.ghost = new THREE.Mesh(new THREE.BoxGeometry(Game.CELL, Game.CELL, Game.CELL), this.ghostMat);
      this.scene.add(this.ghost);
    }
    const cell = this.aimCell(this.input.aimPoint);
    if (cell) {
      this.ghostMat!.color.set(this.editPaint ? 0xffd24a : 0x55ff66);
      this.ghost.position.set(plot.pos.x + cell.gx * Game.CELL, plot.pos.y + Game.CELL / 2 + 0.2, plot.pos.z + cell.gz * Game.CELL);
    } else {
      this.ghostMat!.color.set(0xff5555);
      this.ghost.position.set(this.input.aimPoint.x, Game.CELL / 2 + 0.2, this.input.aimPoint.z);
    }
    this.ghost.rotation.y = (this.editRot * Math.PI) / 2;
    this.ghost.visible = true;
  }
  private hideGhost() {
    if (this.ghost) this.ghost.visible = false;
  }

  /** Visit a neighbour's plot read-only: load it + show its social counters. */
  private async enterVisitMode(plotIndex: number) {
    const owner = this.plotOwner(plotIndex);
    this.editingPlot = plotIndex;
    this.editReadOnly = true;
    this.editData = { parts: [] };
    this.undoStack = [];
    const data = await loadHouse(plotIndex, owner, true); // counts a visit
    this.editData = data ?? { parts: [] };
    let view = this.houseViews.get(plotIndex);
    if (!view) {
      const plot = this.island.plots.find((p) => p.index === plotIndex)!;
      view = new HouseView(this.scene, plot.pos);
      this.houseViews.set(plotIndex, view);
    }
    view.render(this.editData);
    this.hud.hidePetPicker();
    const meta = await getHouseMeta(plotIndex, owner);
    this.hud.showPlotMeta(meta.likes, meta.visits);
    this.hud.toast(`Visiting Plot ${plotIndex + 1} — [L] to like, [E] to leave`);
  }

  /** Like the neighbour's house you're currently visiting. */
  private async likeCurrentHouse() {
    if (this.editingPlot < 0 || !this.editReadOnly) return;
    const owner = this.plotOwner(this.editingPlot);
    const likes = await likeHouse(this.editingPlot, owner);
    if (likes === null) { this.hud.toast("Likes need the backend online"); return; }
    this.audio.powerup();
    const meta = await getHouseMeta(this.editingPlot, owner);
    this.hud.showPlotMeta(likes, meta.visits);
    this.hud.toast("❤ Liked!");
  }

  /** Save the edited house, show the report card, and exit build mode. */
  private exitBuildMode() {
    if (this.editingPlot < 0) return;
    const wasEditing = !this.editReadOnly;
    let clean: HouseData | null = null;
    if (wasEditing) {
      const owner = this.plotOwner(this.editingPlot);
      clean = sanitizeHouse(this.editData);
      void saveHouse(this.editingPlot, owner, clean);
      this.houseViews.get(this.editingPlot)?.render(clean);
      this.hud.toast(`Plot ${this.editingPlot + 1} saved!`);
    }
    this.editingPlot = -1;
    this.editReadOnly = false;
    this.undoStack = [];
    this.hideGhost();
    this.hud.hideBuildBar();
    this.hud.hidePetPicker();
    this.hud.hidePlotMeta();
    this.hud.hidePrompt();
    // "Tiny Home Academy" report card for your own (non-empty) house.
    if (wasEditing && clean && clean.parts.length) {
      this.audio.powerup();
      this.hud.showHouseRating(rateHouse(clean), () => {});
    }
  }

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
    // Face the aim while firing; otherwise face the movement direction.
    const aiming = this.input.firing || this.input.touchAim != null;
    this.player.update(dt, axis.x, -axis.y, this.input.aimPoint, aiming);
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
    this.updatePets(dt);
    this.resolveRangedFliers();

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

    // Co-op death: gameOver only fires for the host/solo (in simulate), so a
    // downed guest would otherwise be stuck in "playing" with no UI and no exit.
    // Show a spectator overlay driven by myAlive; its button bails to the menu
    // (tearing down the net session via toMenu). Suppress the buy prompt while
    // down. Hidden again automatically if the host revives them (myAlive true).
    if (!this.netplay!.myAlive) {
      this.hud.showGuestDown(() => this.toMenu());
      this.hud.hidePrompt();
      return;
    }
    this.hud.hideGuestDown();

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
          // keep the rising-pitch ladder in sync on every connect (0 when no chain)
          this.audio.comboStep(this.combo.active ? this.combo.count : 0);
          this.audio.hit(crit);
          if (crit) {
            this.runStats.crits++;
            this.floaters.spawn(z.pos, "CRIT", "#ffe14a", 1, true);
            this.sparks.burst(z.pos, 0xffe14a, 5, { speed: 9, spread: 2, streak: true });
          }
          this.damageZombie(z, dmg, sMul, crit);
          // the bullet's own splash, or the Explosive Rounds upgrade
          const splashR = Math.max(b.splashRadius, this.mods.explosiveRadius);
          if (splashR > 0) {
            this.puffs.burst(z.pos, 0xffd0a0, 6);
            this.explosions.burst(z.pos, splashR * 1.2, 0xffc06a);
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

  /** Rebuild live pets from the owned list (called on run start / purchase). */
  private spawnPets() {
    for (const p of this.pets) this.scene.remove(p.group);
    this.pets = [];
    // Active-squad cap: bankers/buffers (non-combat) always spawn; combat pets are
    // limited to the first N owned (in save order) so a huge collection can't blanket
    // the screen. Owning >N is fine — the rest just stay benched, save.pets is untouched.
    let combat = 0;
    const defs: { def: ReturnType<typeof findAnyPet>; lvl: number }[] = [];
    for (const id of this.save.pets) {
      const def = findAnyPet(id);
      if (!def) continue;
      const isCombat = def.role !== "banker" && def.role !== "buffer";
      if (isCombat) {
        if (combat >= PETS_TUNING.activeSquadCap) continue;
        combat++;
      }
      defs.push({ def, lvl: this.save.petLevels[id] ?? 1 });
    }
    defs.forEach((d, i) => {
      const pet = new Pet(d.def!, (i / Math.max(1, defs.length)) * Math.PI * 2, d.lvl);
      this.scene.add(pet.group);
      this.pets.push(pet);
    });
  }

  /** Tick companion pets: orbit the player, auto-target, fire real bullets. */
  private updatePets(dt: number) {
    if (!this.pets.length) return;
    const px = this.player.pos.x;
    const pz = this.player.pos.z;
    const grid = this.rounds.grid;
    // Power Totem(s): sum their buff so combat pets hit harder (+roleValue x level),
    // then HARD-CLAMP the total to buffCap. Without the clamp, 3 totems at L20 stack
    // to ~7x and one-shot the late game (see audit). Stacking still helps, but caps.
    let petBuff = 1;
    for (const p of this.pets) {
      if (p.def.role === "buffer") petBuff += (p.def.roleValue ?? 0) * p.level;
    }
    petBuff = Math.min(petBuff, PETS_TUNING.buffCap);
    // Pets inherit your whole upgrade tree, exactly like your own gun. Fire Rate
    // (incl. Adrenaline) speeds their cadence the same way it speeds yours.
    const adr = this.mods.adrenaline ? 1 + (1 - this.player.health / this.player.maxHealth) * 0.6 : 1;
    const petFireRate = this.powerups.fireRateMul() * this.mods.fireRateMul * adr;
    for (let i = 0; i < this.pets.length; i++) {
      const pet = this.pets[i];
      // Signature ability (Epic+): periodic special, fires regardless of role.
      if (pet.tickAbility(dt)) this.firePetAbility(pet, petBuff);
      // Banker (Piggy Bank): earn gold over time — the idle-economy hook. Output
      // is FLATTENED (roleValue * (1 + level*scale), not * level) and CAPPED per
      // round so it stays meaningful idle income, not a level-20 firehose.
      if (pet.def.role === "banker") {
        if (this.rounds.round !== this._bankerRound) {
          this._bankerRound = this.rounds.round;
          this._bankerRoundGold = 0;
        }
        const rate = (pet.def.roleValue ?? 0) * (1 + (pet.level - 1) * PETS_TUNING.bankerLevelScale);
        this._petGold += rate * dt;
        if (this._petGold >= 1 && this._bankerRoundGold < PETS_TUNING.bankerGoldPerRoundCap) {
          let g = Math.floor(this._petGold);
          this._petGold -= g;
          g = Math.min(g, PETS_TUNING.bankerGoldPerRoundCap - this._bankerRoundGold);
          this._bankerRoundGold += g;
          this.save.gold += g;
          this.save.goldEarned += g;
        }
        pet.update(dt, px, pz, i, this.pets.length, null); // orbit/animate only
        continue;
      }
      // nearest zombie to the pet, within its range
      const near = grid.nearest(pet.group.position.x, pet.group.position.z, pet.def.range);
      let tgt: { x: number; z: number } | null = null;
      if (near) {
        this._petTgt.x = near.pos.x;
        this._petTgt.z = near.pos.z;
        tgt = this._petTgt;
      }
      const shot = pet.update(dt, px, pz, i, this.pets.length, tgt, petFireRate);
      if (shot) {
        const d = pet.def;
        // Base damage only — damageMul / crit / cryo / explosive / chain are
        // applied for ALL bullets in resolveBulletHits (the shared player path),
        // so pets scale with Damage 1:1 with you (no double-dip). Here we attach
        // the spawn-time mods your gun gets: pierce, bullet size, ricochet,
        // homing, and Multishot (extra fanned pellets).
        const baseDamage = d.damage * pet.damageMul * petBuff;
        const pellets = 1 + Math.max(0, this.mods.bonusPellets);
        for (let s = 0; s < pellets; s++) {
          if (s === 0) {
            this._petDir.set(shot.dx, 0, shot.dz);
          } else {
            // fan the extra multishot pellets symmetrically around the aim
            const ang = (s % 2 === 0 ? 1 : -1) * Math.ceil(s / 2) * 0.12;
            const c = Math.cos(ang), sn = Math.sin(ang);
            this._petDir.set(shot.dx * c - shot.dz * sn, 0, shot.dx * sn + shot.dz * c);
          }
          this.hitTmp.set(shot.ox, 1.0, shot.oz);
          this.bullets.spawn(this.hitTmp, this._petDir, {
            speed: 56, damage: baseDamage, pierce: d.pierce + this.mods.pierceBonus,
            splashRadius: d.splashRadius, splashDamage: d.splashDamage, color: d.bulletColor,
            scale: d.bulletScale * this.mods.bulletScaleMul, homing: Math.max(d.homing, this.mods.homing),
            bounces: this.mods.ricochet,
          });
        }
      }
    }
  }

  private _abilTmp = new THREE.Vector3();
  /**
   * Resolve a pet's signature ability. Everything routes through the existing
   * bullet / splash / explosion / damageZombie machinery so kills still count
   * toward combo, loot, stats and challenges. Damage scales with the pet's
   * level (damageMul) and any Power Totem buff — so abilities snowball too.
   */
  private firePetAbility(pet: Pet, petBuff: number) {
    const ab = pet.def.ability;
    if (!ab) return;
    const grid = this.rounds.grid;
    const px = pet.group.position.x;
    const pz = pet.group.position.z;
    const sMul = this.powerups.scoreMul();
    const dmg = ab.power * pet.damageMul * petBuff;
    // Bullet-based abilities (nova/volley/coins) inherit Damage via resolveBulletHits.
    // Direct-hit abilities (chain/meteor/smite/execute/obliterate) bypass it, so
    // bake your Damage upgrade in here for the same 1:1 scaling.
    const dmgDirect = dmg * this.mods.damageMul;
    const col = pet.def.bulletColor;
    const near = grid.nearest(px, pz, 64);
    // count this cast toward the pet's evolution trial (per-pet, free to attribute)
    this._runCasts[pet.def.id] = (this._runCasts[pet.def.id] ?? 0) + 1;
    // distinct, power-scaled cast sound per ability kind
    this.audio.ability(ab.kind, ab.power / 200);

    switch (ab.kind) {
      case "nova": {
        const n = ab.count ?? 10;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          this._abilTmp.set(px, 1.0, pz);
          this._petDir.set(Math.cos(a), 0, Math.sin(a));
          this.bullets.spawn(this._abilTmp, this._petDir, {
            speed: 50, damage: dmg, pierce: 3, splashRadius: ab.radius ?? 0,
            splashDamage: ab.radius ? dmg * 0.5 : 0, color: col, scale: pet.def.bulletScale * 1.25, homing: 0,
          });
        }
        // radiant double-pop: hot core flash + a big ring racing out with the shells
        this._abilTmp.set(px, 0.6, pz);
        this.explosions.flash(this._abilTmp, 2.8, col);
        this.explosions.shockwave(this._abilTmp, 4 + n * 0.22, col);
        this.sparks.burst(this._abilTmp, col, Math.min(20, n), { speed: 12, spread: 3, streak: true });
        if (ab.slow) for (const z of this.rounds.zombies) if (z.alive) z.applySlow(ab.slow, 2.5);
        break;
      }
      case "volley": {
        if (!near) break;
        const n = ab.count ?? 12;
        for (let k = 0; k < n; k++) {
          const dx = near.pos.x - px;
          const dz = near.pos.z - pz;
          const len = Math.hypot(dx, dz) || 1;
          this._abilTmp.set(px, 1.0, pz);
          this._petDir.set(dx / len + (Math.random() - 0.5) * 0.5, 0, dz / len + (Math.random() - 0.5) * 0.5).normalize();
          this.bullets.spawn(this._abilTmp, this._petDir, {
            speed: 66, damage: dmg, pierce: 4, splashRadius: 0, splashDamage: 0, color: col, scale: pet.def.bulletScale, homing: 1,
          });
        }
        // muzzle pop + tracer sparks spraying toward the cluster
        this._abilTmp.set(px, 1.0, pz);
        this.explosions.flash(this._abilTmp, 1.7, col);
        this.sparks.burst(this._abilTmp, col, 8, { speed: 10, spread: 2, streak: true });
        break;
      }
      case "chain": {
        let cur = near;
        const hit = new Set<number>();
        let jumps = ab.count ?? 6;
        while (cur && jumps-- > 0) {
          hit.add(cur.id);
          // electric snap at each arc node
          this.explosions.flash(cur.pos, 1.5, 0x9fe8ff);
          this.sparks.burst(cur.pos, 0xcdefff, 6, { speed: 9, spread: 3, streak: true });
          this.damageZombie(cur, dmgDirect, sMul);
          cur = this.nearestZombie(cur.pos.x, cur.pos.z, 7, hit);
        }
        break;
      }
      case "meteor": {
        const n = ab.count ?? 4;
        const r = ab.radius ?? 2.6;
        const pool = this.rounds.zombies.filter((z) => z.alive && !z.isBoss);
        for (let k = 0; k < n; k++) {
          const z = pool.length ? pool[(Math.random() * pool.length) | 0] : null;
          const cx = z ? z.pos.x : px + (Math.random() - 0.5) * 12;
          const cz = z ? z.pos.z : pz + (Math.random() - 0.5) * 12;
          this._abilTmp.set(cx, 0.6, cz);
          // fiery impact column + blast + chunky debris kicking off the ground
          this.explosions.beam(this._abilTmp, 5.5, 0xffb04a);
          this.explosions.burst(this._abilTmp, r * 1.2, 0xff7a3a);
          this.sparks.burst(this._abilTmp, 0xffa23a, 8, { speed: 7, spread: 5 });
          this.splash(this._abilTmp, r, dmgDirect, -1, sMul);
        }
        this.shake = Math.min(0.6, this.shake + 0.18);
        break;
      }
      case "smite": {
        const r = ab.radius ?? 5;
        const cx = near ? near.pos.x : px;
        const cz = near ? near.pos.z : pz;
        this._abilTmp.set(cx, 0.6, cz);
        // pillar of light slams down with a blast + radiant sparks
        this.explosions.beam(this._abilTmp, 9, col);
        this.explosions.flash(this._abilTmp, r, col);
        this.explosions.burst(this._abilTmp, r * 1.1, col);
        this.sparks.burst(this._abilTmp, col, 14, { speed: 9, spread: 6, streak: true });
        this.splash(this._abilTmp, r, dmgDirect, -1, sMul);
        if (ab.slow) grid.forNear(cx, cz, r, (z) => { if (z.alive) z.applySlow(ab.slow!, 2.5); });
        if (ab.heal) {
          this.player.heal(ab.heal);
          this.sparks.burst(this.player.pos, 0x7be08a, 8, { speed: 5, spread: 4, streak: true });
        }
        this.shake = Math.min(0.6, this.shake + 0.14);
        break;
      }
      case "execute": {
        const r = ab.radius ?? 6;
        const thr = ab.frac ?? 0.35;
        const r2 = r * r;
        this._abilTmp.set(px, 0.6, pz);
        // dark reaper column + soul-purple shroud
        this.explosions.beam(this._abilTmp, 7, 0x9a5ad6);
        this.explosions.burst(this._abilTmp, r, 0x9a5ad6);
        this.sparks.burst(this._abilTmp, 0xc0a0ff, 10, { speed: 8, spread: 4, streak: true });
        grid.forNear(px, pz, r, (z) => {
          if (!z.alive) return;
          const dx = z.pos.x - px;
          const dz = z.pos.z - pz;
          if (dx * dx + dz * dz > r2) return;
          const lethal = !z.isBoss && z.health <= z.maxHealth * thr;
          if (lethal) this.sparks.burst(z.pos, 0xc0a0ff, 5, { speed: 7, spread: 4, streak: true });
          this.damageZombie(z, lethal ? 1e9 : dmgDirect, sMul);
        });
        break;
      }
      case "jackpot": {
        const g = Math.round((ab.gold ?? 200) * (1 + (pet.level - 1) * 0.15));
        this.save.gold += g;
        this.save.goldEarned += g;
        this.floaters.spawn(pet.group.position, `+⛀${g}`, "#ffd24a", 1.5, true);
        // a glittering fountain of coins erupting off the pet
        this._abilTmp.set(px, 1.0, pz);
        this.explosions.flash(this._abilTmp, 2.0, 0xffd24a);
        this.sparks.burst(this._abilTmp, 0xffd24a, 16, { speed: 8, spread: 7, streak: true });
        // a damaging shower of coins so even the bankers join the carnage
        const n = ab.count ?? 8;
        for (let k = 0; k < n; k++) {
          const a = (k / n) * Math.PI * 2;
          this._abilTmp.set(px, 1.0, pz);
          this._petDir.set(Math.cos(a), 0, Math.sin(a));
          this.bullets.spawn(this._abilTmp, this._petDir, {
            speed: 48, damage: dmg, pierce: 2, splashRadius: 0, splashDamage: 0, color: 0xffd24a, scale: 0.8, homing: 0,
          });
        }
        // Midas-tier banker also pulps everything nearby into gold.
        if (ab.radius) {
          this._abilTmp.set(px, 0.6, pz);
          this.explosions.burst(this._abilTmp, ab.radius, 0xffd24a);
          this.explosions.beam(this._abilTmp, 7, 0xffe07a);
          this.sparks.burst(this._abilTmp, 0xffe07a, 18, { speed: 10, spread: 8, streak: true });
          this.splash(this._abilTmp, ab.radius, dmgDirect, -1, sMul);
        }
        break;
      }
      case "obliterate": {
        const r = ab.radius ?? 14;
        this.shake = Math.min(0.8, this.shake + 0.6);
        this._abilTmp.set(px, 0.6, pz);
        // cataclysm: twin light pillars, layered blast, twin shockwaves, shrapnel
        this.explosions.beam(this._abilTmp, 16, 0xff3aff);
        this.explosions.beam(this._abilTmp, 11, 0xffffff);
        this.explosions.burst(this._abilTmp, r, 0xff3aff);
        this.explosions.shockwave(this._abilTmp, r * 1.3, 0xff7aff);
        this.explosions.shockwave(this._abilTmp, r * 0.65, 0xffffff);
        this.sparks.burst(this._abilTmp, 0xff7aff, 24, { speed: 14, spread: 8, streak: true });
        this.splash(this._abilTmp, r, dmgDirect, -1, sMul);
        this.floaters.spawn(pet.group.position, "ANNIHILATE!", "#ff3aff", 1.7, true);
        break;
      }
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

  /** Nearest alive zombie to (x,z) within `range`, skipping ids in `skip`.
   *  Thin wrapper over the spatial grid (O(local) not O(n)). The grid is rebuilt
   *  in rounds.update (after steerHomingBullets in simulate), so callers here may
   *  see a 1-frame-stale grid — fine for homing/ricochet/chain targeting. */
  private nearestZombie(x: number, z: number, range: number, skip?: Set<number>): Zombie | null {
    return this.rounds.grid.nearest(x, z, range, skip);
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
      // Per-kill gold drip: COMBAT is the primary gold faucet (bankers are now
      // capped). Scales with the zombie's worth + scoreMul (Double Points etc).
      const kg = Math.max(1, Math.round(PETS_TUNING.killGoldBase * z.scoreMul * scoreMul));
      this.save.gold += kg;
      this.save.goldEarned += kg;
      // tiered pop: crit > combo > plain (color/size handled by FloatingText)
      this.floaters.spawn(z.pos, this.floatNum(pts), "#ffffff", 1, crit ? "crit" : mult > 1 ? "combo" : "normal");
      // beefier, warmer burst on crit / combo kills; ragdoll fling on big hits
      const burstN = crit ? 13 : mult >= 3 ? 11 : 8;
      this.puffs.burst(z.pos, crit ? 0xffe14a : z.puffColor, burstN);
      // crunchy gib sparks flinging off the corpse (streaky, bigger on crit/combo)
      this.sparks.burst(z.pos, crit ? 0xffe14a : z.puffColor, crit || mult >= 3 ? 7 : 4, { speed: 7, spread: 4, streak: true });
      z.flingDeath(crit || mult >= 3 ? 6 : 2);
      // rising-pitch streak: feed the live combo length so kill/hit tones ascend
      this.audio.comboStep(this.combo.count);
      this.audio.kill();
      // combo milestone celebration: a big "xN!" pop when the tier climbs
      if (mult > this.lastComboTier && mult >= 2) {
        this.floaters.spawn(this.player.pos, `x${mult}!`, "#ffd24a", 1.6, true);
        this.audio.levelUp();
      }
      this.lastComboTier = mult;
      if (this.mods.lifeSteal > 0) this.player.heal(this.mods.lifeSteal);
      if (this.nukeCharge < 1) this.nukeCharge = Math.min(1, this.nukeCharge + 0.012); // ~85 kills to recharge
      // Detonate: killed zombies explode, damaging (and chaining through) neighbors.
      if (this.mods.detonate > 0 && !wasBoss) {
        this.puffs.burst(z.pos, 0xffa23a, 10);
        this.explosions.burst(z.pos, this.mods.detonate * 1.3, 0xffa23a);
        this.audio.boom();
        this.splash(z.pos, this.mods.detonate, dmg * 0.4, z.id, scoreMul);
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
        // pity-aware rarity: dry rare-less streaks self-correct (non-cashable)
        this.grantLoot(makeItem(rollRarityPity()));
      }
      if (wasBoss) {
        this.hud.hideBoss();
        this.audio.boom();
        this.audio.levelUp(); // victory fanfare
        for (let i = 0; i < 3; i++) this.drops.maybeSpawn(z.pos, 1, true);
        // boss candy explosion: multi-color radial puff blast + camera punch-zoom
        const candy = [0xff5d8f, 0x6ad7ff, 0xffd24a, 0x8fcf6f, 0xc792ea];
        for (let i = 0; i < 5; i++) this.puffs.burst(z.pos, candy[i], 10);
        this.shake = Math.min(0.8, this.shake + 0.5);
        this.zoomPunch = 1;
        this.hitStop = Math.min(0.18, this.hitStop + 0.12);
      } else {
        this.drops.maybeSpawn(z.pos, this.mods.dropChance);
      }
      if (z.explodes) {
        this.detonate(z);
        this.audio.boom();
      }
      // Splitter: spawn its smaller copies at the corpse (anti-cluster pressure).
      if (z.splitInto) this.rounds.splitOn(z);
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

  /** Stinger fliers spit a ranged hit at the player (a quick splash at the
   *  player's spot — punishes ignoring them / standing still). */
  private resolveRangedFliers() {
    for (const z of this.rounds.zombies) {
      if (!z.alive || !z.wantsRangedShot) continue;
      z.wantsRangedShot = false;
      // telegraph + hit: a goo splash under the player; partial damage if close.
      this.hitTmp.set(this.player.pos.x, 0.1, this.player.pos.z);
      this.explosions.burst(this.hitTmp, 1.6, 0x9fb04a);
      const dx = this.player.pos.x - z.pos.x;
      const dz = this.player.pos.z - z.pos.z;
      if (dx * dx + dz * dz < 18 * 18 && this.player.alive) {
        this.player.damage(z.touchDamage);
        this.shake = Math.min(0.4, this.shake + 0.18);
        this.audio.hurt();
        this.runStats.tookDamage = true;
      }
    }
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
          // Scales with round so it stays relevant against beefy late zombies.
          if (victim === this.player && this.mods.thorns > 0) {
            z.knockback(victim.pos.x, victim.pos.z, 6);
            this.damageZombie(z, this.mods.thorns + 8 * this.rounds.round, this.powerups.scoreMul());
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
    this.explosions.burst(z.pos, z.blastRadius * 1.2, 0xff7a3a);
    const dx = this.player.pos.x - z.pos.x;
    const dz = this.player.pos.z - z.pos.z;
    if (dx * dx + dz * dz < z.blastRadius * z.blastRadius) {
      this.player.damage(z.blastDamage);
      this.shake = Math.min(0.7, this.shake + 0.4);
      this.runStats.tookDamage = true;
    }
  }

  private updateCamera(dt: number) {
    this._v2.copy(this.player.pos).add(this._camOffset);
    const k = 1 - Math.exp(-CAMERA.follow * dt);
    this.camera.position.lerp(this._v2, k);

    this.camTarget.lerp(this.player.pos, k);
    this.camera.lookAt(this.camTarget.x, this.camTarget.y + 1, this.camTarget.z);

    if (this.shake > 0.001) {
      this.camera.position.x += (Math.random() - 0.5) * this.shake;
      this.camera.position.y += (Math.random() - 0.5) * this.shake;
      this.shake *= Math.pow(0.0001, dt); // fast decay
    }

    // punch-zoom: briefly zoom the ortho view in on boss death, then ease back
    if (this.zoomPunch > 0.001) {
      this.zoomPunch *= Math.pow(0.02, dt);
      const aspect = innerWidth / innerHeight;
      const vs = this.viewSize * (1 - this.zoomPunch * 0.18);
      this.camera.left = -vs * aspect;
      this.camera.right = vs * aspect;
      this.camera.top = vs;
      this.camera.bottom = -vs;
      this.camera.updateProjectionMatrix();
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
