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

type State = "menu" | "playing" | "paused" | "over";

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
    this.hud = new Hud(ui);

    this.rounds.onRoundStart = (n) => {
      this.hud.setRound(n);
      if (n > 1) this.hud.toast(`Round ${n}`);
    };
    this.rounds.onIntermission = () => {
      const cleared = this.rounds.round;
      const bonus = SCORE.roundBonusBase + (cleared - 1) * SCORE.roundBonusPerRound;
      this.addPoints(bonus);
      this.hud.toast(`Round clear  +${bonus}`);
    };

    this.hud.onStart(() => this.startRun());
    this.hud.onRestart(() => this.startRun());
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
    this.player.reset();
    this.player.pos.set(0, 0, 9); // start on the plaza, south of the fountain
    this.player.group.position.copy(this.player.pos);
    this.bullets.clear();
    this.rounds.reset();
    this.points = SCORE.startingPoints;
    this.weapons = [new Weapon(WEAPONS.peashooter)];
    this.activeSlot = 0;
    this.perks.clear();
    this.powerups.clear();
    this.hud.setPowerups([]);
    this.shake = 0;
    this.hud.setPoints(this.points);
    this.hud.setRound(1);
    if (!this.netplay) this.hud.hideRoomCode();
    this.syncWeaponHud();
  }

  private startRun() {
    this.resetRun();
    this.hud.hideStart();
    this.hud.hideGameOver();
    this.state = "playing";
    this.rounds.start();
  }

  private gameOver() {
    this.state = "over";
    this.input.firing = false;
    this.hud.showGameOver(this.rounds.round, this.points);
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
      return false;
    }
    this.points -= amount;
    this.hud.setPoints(this.points);
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
    const dt = Math.min(0.05, this.clock.getDelta());

    if (this.input.pressed("KeyP") || this.input.pressed("Escape")) {
      if (this.state === "playing") this.state = "paused";
      else if (this.state === "paused") this.state = "playing";
    }

    this.input.updateAim(this.camera);

    if (this.state === "playing") {
      if (this.netplay && !this.netplay.isHost) this.simulateGuest(dt);
      else this.simulate(dt);
    } else {
      this.player.idle(dt); // keep the figure breathing on menu / pause / over
    }

    this.arena.update(dt);
    this.interactables.update(dt);
    this.puffs.update(dt);
    this.updateCamera(dt);

    this.composer.render();
    this.input.endFrame();
  };

  private simulate(dt: number) {
    this.powerups.update(dt);
    // Sugar Rush stacks on the Quick perk for movement speed.
    this.player.speedMul = (this.perks.has("quick") ? 1.35 : 1) * this.powerups.speedMul();

    const axis = this.input.moveAxis(new THREE.Vector2());
    // Camera looks down the -Z axis, so W (axis.y +1) moves toward -Z.
    this.player.update(dt, axis.x, -axis.y, this.input.aimPoint);
    this.arena.clamp(this.player.pos, PLAYER.radius);
    this.arena.resolveObstacles(this.player.pos, PLAYER.radius);
    this.player.group.position.copy(this.player.pos);

    // weapon
    const w = this.weapon;
    w.update(dt, this.player.reloadMul);
    const wantFire = w.def.auto ? this.input.firing : this.input.clicked();
    if (wantFire && w.tryFire(this.player.muzzle, this.player.aimDir, this.bullets, this.powerups.fireRateMul())) {
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

    this.hud.setHealth(this.player.health, this.player.maxHealth);
    this.hud.setPowerups(this.powerups.list());
    this.syncWeaponHud();
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
        const hitR = ZOMBIE.radius * z.group.scale.x + 0.25;
        const dx = z.pos.x - b.mesh.position.x;
        const dz = z.pos.z - b.mesh.position.z;
        const dy = 1 - b.mesh.position.y; // bullets fly ~y=1, zombie body center ~1
        if (dx * dx + dz * dz + dy * dy < hitR * hitR) {
          b.hit.add(z.id);
          this.addPoints(Math.round(SCORE.hit * sMul));
          this.damageZombie(z, b.damage * dmgMul, sMul);
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
  private damageZombie(z: Zombie, dmg: number, scoreMul: number) {
    const killed = z.hit(dmg);
    if (killed) {
      this.addPoints(Math.round(SCORE.kill * z.scoreMul * scoreMul));
      this.puffs.burst(z.pos, z.puffColor);
      if (z.explodes) this.detonate(z);
    }
  }

  /** AoE damage to every zombie in range (except the one already hit directly). */
  private splash(center: THREE.Vector3, radius: number, dmg: number, exceptId: number, scoreMul: number) {
    const r2 = radius * radius;
    for (const z of this.rounds.zombies) {
      if (!z.alive || z.id === exceptId) continue;
      const dx = z.pos.x - center.x;
      const dz = z.pos.z - center.z;
      if (dx * dx + dz * dz < r2) this.damageZombie(z, dmg, scoreMul);
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
          if (victim === this.player) this.shake = Math.min(0.5, this.shake + 0.25);
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
