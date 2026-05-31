import * as THREE from "three";
import { VoxelChar } from "./voxelChar";
import { COLORS } from "./palette";
import { NetClient, NetMsg, PresenceMsg } from "./net";

/**
 * Island presence layer — lightweight, peer-to-peer (no authoritative host).
 *
 * Every client broadcasts its pose a few times a second over the relay; this
 * renders a smoothly-interpolated voxel figure for each other player on the
 * same island instance. Deliberately separate from NetPlay (which is the
 * heavyweight host-authoritative combat sim) — the hub only needs "see people
 * walk around", so this stays cheap and self-contained.
 */

const LERP = 12; // position/yaw smoothing toward the latest received pose
const SEND_HZ = 8; // pose broadcasts per second

class PeerFigure {
  readonly group = new THREE.Group();
  private char: VoxelChar;
  private tx = 0;
  private tz = 0;
  private ty = 0;
  private walking = false;
  private label?: THREE.Sprite;

  constructor(private scene: THREE.Scene, color: number, name?: string) {
    this.char = new VoxelChar({ body: color, head: COLORS.playerAccent, eye: 0x222222, hat: 0xf2c14e, gun: false });
    this.group.add(this.char.root);
    if (name) this.label = this.makeLabel(name);
    if (this.label) this.group.add(this.label);
    scene.add(this.group);
  }

  private makeLabel(name: string): THREE.Sprite {
    const c = document.createElement("canvas");
    c.width = 256;
    c.height = 64;
    const g = c.getContext("2d")!;
    g.font = "bold 30px system-ui, sans-serif";
    g.textAlign = "center";
    g.textBaseline = "middle";
    g.lineWidth = 6;
    g.strokeStyle = "rgba(0,0,0,0.8)";
    g.strokeText(name, 128, 32);
    g.fillStyle = "#ffffff";
    g.fillText(name, 128, 32);
    const tex = new THREE.CanvasTexture(c);
    tex.colorSpace = THREE.SRGBColorSpace;
    tex.generateMipmaps = false;
    tex.minFilter = THREE.LinearFilter;
    const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
    sprite.scale.set(2.2, 0.55, 1);
    sprite.position.set(0, 2.2, 0);
    return sprite;
  }

  setTarget(p: PresenceMsg) {
    this.tx = p.x;
    this.tz = p.z;
    this.ty = p.ry;
    this.walking = p.moving;
  }

  update(dt: number) {
    const k = 1 - Math.exp(-LERP * dt);
    this.group.position.x += (this.tx - this.group.position.x) * k;
    this.group.position.z += (this.tz - this.group.position.z) * k;
    let d = this.ty - this.group.rotation.y;
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

export class IslandNet {
  private peers = new Map<number, PeerFigure>();
  private sendAcc = 0;
  private skin: number;
  private name?: string;

  constructor(private net: NetClient, private scene: THREE.Scene, skin: number, name?: string) {
    this.skin = skin;
    this.name = name;
    net.onPeerJoin = (id) => this.ensurePeer(id);
    net.onPeerLeave = (id) => this.removePeer(id);
    net.onMessage = (from, msg) => this.onMessage(from, msg);
    // peers already present when we joined (sent in island-joined)
    for (const id of net.peers) this.ensurePeer(id);
  }

  /** Broadcast my pose on a fixed cadence + smooth every peer figure. */
  update(dt: number, me: { x: number; z: number; ry: number; moving: boolean }) {
    for (const f of this.peers.values()) f.update(dt);
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / SEND_HZ) {
      this.sendAcc = 0;
      const msg: PresenceMsg = { t: "presence", x: me.x, z: me.z, ry: me.ry, moving: me.moving, skin: this.skin, name: this.name };
      this.net.send(msg); // broadcast to the whole instance
    }
  }

  private ensurePeer(id: number, color = 0x4a78d6, name?: string): PeerFigure {
    let f = this.peers.get(id);
    if (!f) {
      f = new PeerFigure(this.scene, color, name);
      this.peers.set(id, f);
    }
    return f;
  }

  private removePeer(id: number) {
    this.peers.get(id)?.dispose();
    this.peers.delete(id);
  }

  private onMessage(from: number, msg: NetMsg) {
    if (msg.t !== "presence") return;
    let f = this.peers.get(from);
    if (!f) {
      // first pose from a peer also tells us their look — (re)create with it
      f = new PeerFigure(this.scene, msg.skin || 0x4a78d6, msg.name);
      this.peers.set(from, f);
    }
    f.setTarget(msg);
  }

  dispose() {
    for (const f of this.peers.values()) f.dispose();
    this.peers.clear();
    this.net.onPeerJoin = undefined;
    this.net.onPeerLeave = undefined;
    this.net.onMessage = undefined;
  }
}
