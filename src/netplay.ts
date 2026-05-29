import * as THREE from "three";
import { VoxelChar } from "./voxelChar";
import { ZOMBIE_TYPES } from "./config";
import { COLORS } from "./palette";
import { Player } from "./player";
import { Weapon, WEAPONS, BulletSystem } from "./weapons";
import { AssetManager } from "./assets";
import { NetClient, NetMsg, InputMsg, SnapMsg, PlayerSnap, ZombieSnap } from "./net";

/** How fast remote transforms chase their networked targets. */
const LERP = 12;

/** A smoothed visual stand-in for a networked player (everyone except yourself). */
class RemoteFigure {
  readonly group = new THREE.Group();
  private char: VoxelChar;
  private tx = 0;
  private tz = 0;
  private try_ = 0;
  private walking = false;

  constructor(private scene: THREE.Scene, color: number) {
    this.char = new VoxelChar({ body: color, head: COLORS.playerAccent, eye: 0x222222, hat: 0xf2c14e, gun: true });
    this.group.add(this.char.root);
    scene.add(this.group);
  }
  setTarget(x: number, z: number, ry: number, walking: boolean) {
    this.tx = x;
    this.tz = z;
    this.try_ = ry;
    this.walking = walking;
  }
  update(dt: number) {
    const k = 1 - Math.exp(-LERP * dt);
    this.group.position.x += (this.tx - this.group.position.x) * k;
    this.group.position.z += (this.tz - this.group.position.z) * k;
    // shortest-arc yaw lerp
    let d = this.try_ - this.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.group.rotation.y += d * k;
    this.char.play(this.walking ? "walk" : "idle");
    this.char.update(dt);
  }
  dispose() {
    this.scene.remove(this.group);
  }
}

/** Guest-side zombie visual, pooled by networked id. */
class ZombieView {
  readonly group = new THREE.Group();
  private char: VoxelChar;
  private tx = 0;
  private tz = 0;
  private try_ = 0;
  private state = 0;
  private lastType = -1;

  constructor(private scene: THREE.Scene) {
    this.char = new VoxelChar({ body: 0x8fcf6f, head: 0x5f9d4a, eye: 0x141414, zombie: true });
    this.group.add(this.char.root);
    scene.add(this.group);
  }
  apply(s: ZombieSnap) {
    if (s.type !== this.lastType) {
      const t = ZOMBIE_TYPES[s.type] ?? ZOMBIE_TYPES[0];
      this.char.setColor(t.body, t.head, t.blastRadius !== undefined ? t.body : 0x000000);
      this.group.scale.setScalar(t.scale);
      this.lastType = s.type;
    }
    this.tx = s.x;
    this.tz = s.z;
    this.try_ = s.ry;
    if (s.state !== this.state) {
      this.state = s.state;
      this.char.play(s.state === 1 ? "death" : "walk");
    }
  }
  update(dt: number) {
    const k = 1 - Math.exp(-LERP * dt);
    this.group.position.x += (this.tx - this.group.position.x) * k;
    this.group.position.z += (this.tz - this.group.position.z) * k;
    this.group.rotation.y = this.try_;
    this.char.update(dt);
  }
  dispose() {
    this.scene.remove(this.group);
  }
}

/** Host-side record for a connected guest: the Player we simulate for them. */
interface GuestSlot {
  player: Player;
  weapon: Weapon;
  input: InputMsg;
  aim: THREE.Vector3;
}

const PLAYER_COLORS = [COLORS.player, 0xe06a4a, 0x53b36a, 0xc78ad8];

/**
 * Owns all multiplayer state for a session. Two roles:
 *  - HOST: simulates a Player for every connected guest and broadcasts the
 *    authoritative world snapshot each network tick.
 *  - GUEST: sends local input every frame and renders the world from snapshots.
 */
export class NetPlay {
  readonly net: NetClient;
  private snapAccum = 0;
  private snapRate = 1 / 20; // 20 Hz

  // host state
  private guests = new Map<number, GuestSlot>();
  // guest state
  private latest?: SnapMsg;
  private remote = new Map<number, RemoteFigure>();
  private zviews = new Map<number, ZombieView>();
  netRound = 1;
  netPoints = 0;
  myHp = 100;
  myMaxHp = 100;

  constructor(
    net: NetClient,
    private scene: THREE.Scene,
    private assets: AssetManager,
    private tracers: BulletSystem,
  ) {
    this.net = net;
    net.onPeerJoin = (id) => this.addGuest(id);
    net.onPeerLeave = (id) => this.removePeer(id);
    net.onMessage = (from, msg) => this.onMessage(from, msg);
  }

  get isHost(): boolean {
    return this.net.isHost;
  }

  // ================= HOST =================
  private addGuest(id: number) {
    if (!this.isHost || this.guests.has(id)) return;
    const player = new Player(this.scene, this.assets);
    player.pos.set((Math.random() - 0.5) * 4, 0, 9);
    this.guests.set(id, {
      player,
      weapon: new Weapon(WEAPONS.peashooter),
      input: { t: "input", mx: 0, mz: 0, ax: 0, az: -1, fire: false, reload: false, swap: false, interact: false },
      aim: new THREE.Vector3(),
    });
  }

  /** Simulate every guest's Player from their last input. Call inside host sim. */
  hostSimulateGuests(dt: number, arena: { clamp: Function; resolveObstacles: Function }, bullets: BulletSystem, onShot: (x: number, z: number, dx: number, dz: number) => void) {
    if (!this.isHost) return;
    for (const slot of this.guests.values()) {
      const inp = slot.input;
      slot.aim.set(inp.ax, 0, inp.az);
      slot.player.update(dt, inp.mx, inp.mz, slot.aim);
      arena.clamp(slot.player.pos, 0.55);
      arena.resolveObstacles(slot.player.pos, 0.55);
      slot.player.group.position.copy(slot.player.pos);

      slot.weapon.update(dt, 1);
      if (inp.fire && slot.player.alive) {
        const before = slot.weapon.ammo;
        slot.weapon.tryFire(slot.player.muzzle, slot.player.aimDir, bullets);
        if (slot.weapon.ammo < before) {
          onShot(slot.player.muzzle.x, slot.player.muzzle.z, slot.player.aimDir.x, slot.player.aimDir.z);
        }
      }
      if (inp.reload) slot.weapon.reload();
    }
  }

  /** All player positions the host should consider (for zombie targeting). */
  hostPlayerPositions(localPlayer: Player): THREE.Vector3[] {
    const out = [localPlayer.pos];
    for (const s of this.guests.values()) if (s.player.alive) out.push(s.player.pos);
    return out;
  }

  /** Damage the nearest guest at a position (host applies zombie touches here). */
  hostGuestSlots(): GuestSlot[] {
    return [...this.guests.values()];
  }

  /** Build + broadcast the world snapshot (rate-limited). */
  hostBroadcast(dt: number, localPlayer: Player, zombies: ZombieSnap[], round: number, points: number, phase: string) {
    if (!this.isHost) return;
    this.snapAccum += dt;
    if (this.snapAccum < this.snapRate) return;
    this.snapAccum = 0;

    const players: PlayerSnap[] = [this.snapOf(1, localPlayer)];
    for (const [id, s] of this.guests) players.push(this.snapOf(id, s.player));

    const msg: SnapMsg = { t: "snap", players, zombies, round, points, phase };
    this.net.send(msg);
  }

  private snapOf(id: number, p: Player): PlayerSnap {
    return {
      id,
      x: p.pos.x,
      z: p.pos.z,
      ry: p.group.rotation.y,
      hp: p.health,
      maxHp: p.maxHealth,
      alive: p.alive,
      walking: true,
    };
  }

  /** Host: broadcast a tracer event so guests can draw the shot. */
  hostShot(x: number, z: number, dx: number, dz: number, color: number, scale: number) {
    if (!this.isHost) return;
    this.net.send({ t: "shot", x, z, dx, dz, color, scale });
  }

  // ================= GUEST =================
  /** Guest: push this frame's local input to the host. */
  guestSendInput(inp: InputMsg) {
    if (this.isHost) return;
    this.net.send(inp);
  }

  /** Guest: advance interpolation of all networked views. */
  guestRender(dt: number, localPlayer: Player, myId: number) {
    if (this.isHost || !this.latest) return;

    // local player + remotes from the latest snapshot
    for (const ps of this.latest.players) {
      if (ps.id === myId) {
        localPlayer.pos.set(ps.x, 0, ps.z);
        localPlayer.group.position.copy(localPlayer.pos);
        localPlayer.group.rotation.y = ps.ry;
        localPlayer.health = ps.hp;
        localPlayer.maxHealth = ps.maxHp;
        localPlayer.alive = ps.alive;
        this.myHp = ps.hp;
        this.myMaxHp = ps.maxHp;
        localPlayer.idle(dt);
      } else {
        let fig = this.remote.get(ps.id);
        if (!fig) {
          fig = new RemoteFigure(this.scene, PLAYER_COLORS[(ps.id - 1) % PLAYER_COLORS.length]);
          this.remote.set(ps.id, fig);
        }
        fig.setTarget(ps.x, ps.z, ps.ry, ps.walking);
      }
    }
    for (const fig of this.remote.values()) fig.update(dt);

    // zombies
    const seen = new Set<number>();
    for (const zs of this.latest.zombies) {
      seen.add(zs.id);
      let v = this.zviews.get(zs.id);
      if (!v) {
        v = new ZombieView(this.scene);
        this.zviews.set(zs.id, v);
      }
      v.apply(zs);
    }
    for (const [id, v] of this.zviews) {
      if (!seen.has(id)) {
        v.dispose();
        this.zviews.delete(id);
      } else {
        v.update(dt);
      }
    }

    this.netRound = this.latest.round;
    this.netPoints = this.latest.points;
  }

  // ================= shared =================
  private onMessage(from: number, msg: NetMsg) {
    if (msg.t === "input" && this.isHost) {
      const slot = this.guests.get(from);
      if (slot) slot.input = msg;
    } else if (msg.t === "snap" && !this.isHost) {
      this.latest = msg;
    } else if (msg.t === "shot" && !this.isHost) {
      // render a non-colliding tracer locally
      const origin = new THREE.Vector3(msg.x, 1.0, msg.z);
      const dir = new THREE.Vector3(msg.dx, 0, msg.dz);
      this.tracers.spawn(origin, dir, {
        speed: 64, damage: 0, pierce: 0, splashRadius: 0, splashDamage: 0, color: msg.color, scale: msg.scale,
      });
    }
  }

  private removePeer(id: number) {
    const slot = this.guests.get(id);
    if (slot) {
      this.scene.remove(slot.player.group);
      this.guests.delete(id);
    }
    this.remote.get(id)?.dispose();
    this.remote.delete(id);
  }

  dispose() {
    for (const s of this.guests.values()) this.scene.remove(s.player.group);
    this.guests.clear();
    for (const f of this.remote.values()) f.dispose();
    this.remote.clear();
    for (const v of this.zviews.values()) v.dispose();
    this.zviews.clear();
  }
}
