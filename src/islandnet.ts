import * as THREE from "three";
import { VoxelChar, EmoteId } from "./voxelChar";
import { NetClient, NetMsg, PresenceMsg } from "./net";
import { EMOTES, QUICK_CHAT } from "./emotes";

// The relay is untrusted: only accept emote ids / chat we actually broadcast.
const VALID_EMOTES = new Set<string>(EMOTES.map((e) => e.id));
const VALID_CHAT = new Set<string>(QUICK_CHAT);
const CHAT_MAX = 48; // hard cap even on accepted text

/**
 * Island presence layer — lightweight, peer-to-peer (no authoritative host).
 *
 * Every client broadcasts its pose a few times a second over the relay; this
 * renders a smoothly-interpolated voxel figure for each other player on the
 * same island instance. Deliberately separate from NetPlay (which is the
 * heavyweight host-authoritative combat sim) — the hub only needs "see people
 * walk around", so this stays cheap and self-contained.
 *
 * On top of pose it also carries the SOCIAL layer: peers play each other's
 * emotes, show preset quick-chat as speech bubbles, render the sender's actual
 * cosmetic skin (body + head), and show a "…" thinking bubble while a peer has
 * their emote/chat menu open. All canvas-sprite labels follow makeLabel's
 * cheap, mipmap-free recipe so they never stall the GPU.
 */

const LERP = 12; // position/yaw smoothing toward the latest received pose
const SEND_HZ = 8; // pose broadcasts per second
const BUBBLE_SECS = 3.0; // how long a speech bubble lingers

/** A peer's look + initial state, learned from their first presence message. */
export interface PeerLook {
  body: number;
  head: number;
  name?: string;
}

class PeerFigure {
  readonly group = new THREE.Group();
  private char: VoxelChar;
  private tx = 0;
  private tz = 0;
  private ty = 0;
  private walking = false;
  private label?: THREE.Sprite;
  // social overlays (canvas sprites above the head)
  private bubble?: THREE.Sprite;
  private bubbleT = 0; // seconds remaining on the current speech bubble
  private typing?: THREE.Sprite;

  constructor(private scene: THREE.Scene, look: PeerLook) {
    this.char = new VoxelChar({ body: look.body, head: look.head, eye: 0x222222, hat: 0xf2c14e, gun: false });
    this.group.add(this.char.root);
    if (look.name) {
      this.label = makeLabel(look.name);
      this.group.add(this.label);
    }
    scene.add(this.group);
  }

  setTarget(p: PresenceMsg) {
    this.tx = p.x;
    this.tz = p.z;
    this.ty = p.ry;
    this.walking = p.moving;
    this.setTyping(!!p.menuOpen);
  }

  /** Play an emote received from this peer. */
  playEmote(id: EmoteId) {
    this.char.emote(id);
  }

  /** Show a preset quick-chat phrase as a speech bubble for a few seconds. */
  say(text: string) {
    if (this.bubble) {
      this.group.remove(this.bubble);
      disposeSprite(this.bubble);
    }
    this.bubble = makeBubble(text);
    this.group.add(this.bubble);
    this.bubbleT = BUBBLE_SECS;
  }

  /** Toggle the small "…" thinking bubble (peer has a menu open). */
  private setTyping(on: boolean) {
    if (on && !this.typing) {
      this.typing = makeBubble("…");
      this.typing.position.y = 2.85;
      this.typing.scale.set(0.7, 0.42, 1);
      this.group.add(this.typing);
    } else if (!on && this.typing) {
      this.group.remove(this.typing);
      disposeSprite(this.typing);
      this.typing = undefined;
    }
  }

  update(dt: number) {
    const k = 1 - Math.exp(-LERP * dt);
    this.group.position.x += (this.tx - this.group.position.x) * k;
    this.group.position.z += (this.tz - this.group.position.z) * k;
    let d = this.ty - this.group.rotation.y;
    while (d > Math.PI) d -= Math.PI * 2;
    while (d < -Math.PI) d += Math.PI * 2;
    this.group.rotation.y += d * k;
    // emoting peers keep idle as the base state so the emote can layer over it
    this.char.play(this.walking ? "walk" : "idle");
    this.char.update(dt);
    // expire speech bubbles
    if (this.bubble) {
      this.bubbleT -= dt;
      if (this.bubbleT <= 0) {
        this.group.remove(this.bubble);
        disposeSprite(this.bubble);
        this.bubble = undefined;
      }
    }
  }

  dispose() {
    this.scene.remove(this.group);
    if (this.label) disposeSprite(this.label);
    if (this.bubble) disposeSprite(this.bubble);
    if (this.typing) disposeSprite(this.typing);
  }
}

export class IslandNet {
  private peers = new Map<number, PeerFigure>();
  private sendAcc = 0;
  private body: number;
  private head: number;
  private name?: string;
  private menuOpen = false;

  constructor(private net: NetClient, private scene: THREE.Scene, body: number, head = 0xfff4d6, name?: string) {
    this.body = body;
    this.head = head;
    this.name = name;
    net.onPeerJoin = (id) => this.ensurePeer(id);
    net.onPeerLeave = (id) => this.removePeer(id);
    net.onMessage = (from, msg) => this.onMessage(from, msg);
    // peers already present when we joined start as a default look until their
    // first presence message tells us their real skin/name.
    for (const id of net.peers) this.ensurePeer(id);
  }

  /** Number of OTHER players currently on this island instance. */
  get peerCount(): number {
    return this.peers.size;
  }

  /** Tell peers whether my emote/chat menu is open (drives their "…" bubble). */
  setMenuOpen(open: boolean) {
    this.menuOpen = open;
  }

  /** Broadcast an emote id to everyone (the local figure is played by main). */
  sendEmote(id: EmoteId) {
    this.net.send({ t: "emote", id });
  }

  /** Broadcast a preset quick-chat phrase to everyone. */
  sendChat(text: string) {
    this.net.send({ t: "chat", text });
  }

  /** Broadcast my pose on a fixed cadence + smooth every peer figure. */
  update(dt: number, me: { x: number; z: number; ry: number; moving: boolean }) {
    for (const f of this.peers.values()) f.update(dt);
    this.sendAcc += dt;
    if (this.sendAcc >= 1 / SEND_HZ) {
      this.sendAcc = 0;
      const msg: PresenceMsg = {
        t: "presence", x: me.x, z: me.z, ry: me.ry, moving: me.moving,
        skin: this.body, head: this.head, name: this.name, menuOpen: this.menuOpen,
      };
      this.net.send(msg); // broadcast to the whole instance
    }
  }

  private ensurePeer(id: number, look: PeerLook = { body: 0x4a78d6, head: 0xfff4d6 }): PeerFigure {
    let f = this.peers.get(id);
    if (!f) {
      f = new PeerFigure(this.scene, look);
      this.peers.set(id, f);
    }
    return f;
  }

  private removePeer(id: number) {
    this.peers.get(id)?.dispose();
    this.peers.delete(id);
  }

  private onMessage(from: number, msg: NetMsg) {
    if (msg.t === "presence") {
      // reject malformed coords/yaw so a hostile peer can't NaN our figures
      if (![msg.x, msg.z, msg.ry].every(Number.isFinite)) return;
      let f = this.peers.get(from);
      if (!f) {
        // first pose from a peer also tells us their look — (re)create with it
        f = new PeerFigure(this.scene, { body: msg.skin || 0x4a78d6, head: msg.head ?? 0xfff4d6, name: msg.name });
        this.peers.set(from, f);
      }
      f.setTarget(msg);
    } else if (msg.t === "emote") {
      if (VALID_EMOTES.has(msg.id)) this.peers.get(from)?.playEmote(msg.id as EmoteId);
    } else if (msg.t === "chat") {
      // only render preset phrases (defense in depth); cap length regardless
      if (typeof msg.text === "string" && VALID_CHAT.has(msg.text)) {
        this.peers.get(from)?.say(msg.text.slice(0, CHAT_MAX));
      }
    }
  }

  dispose() {
    for (const f of this.peers.values()) f.dispose();
    this.peers.clear();
    this.net.onPeerJoin = undefined;
    this.net.onPeerLeave = undefined;
    this.net.onMessage = undefined;
  }
}

// ---- canvas-sprite labels (cheap, mipmap-free; see feedback.ts/makeLabel) ----

/** A crisp outlined name label above a figure's head. */
export function makeLabel(name: string): THREE.Sprite {
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

/** A rounded speech bubble sprite carrying a short preset phrase / "…". */
export function makeBubble(text: string): THREE.Sprite {
  const c = document.createElement("canvas");
  c.width = 256;
  c.height = 128;
  const g = c.getContext("2d")!;
  g.clearRect(0, 0, 256, 128);
  // measure to size the rounded rect snugly around the text
  g.font = "bold 34px system-ui, sans-serif";
  const tw = Math.min(236, g.measureText(text).width + 36);
  const x = (256 - tw) / 2;
  const y = 12;
  const w = tw;
  const h = 76;
  const r = 22;
  g.fillStyle = "rgba(255,255,255,0.96)";
  g.strokeStyle = "rgba(0,0,0,0.28)";
  g.lineWidth = 4;
  roundRect(g, x, y, w, h, r);
  g.fill();
  g.stroke();
  // little tail at the bottom-center
  g.beginPath();
  g.moveTo(128 - 14, y + h - 2);
  g.lineTo(128, y + h + 22);
  g.lineTo(128 + 14, y + h - 2);
  g.closePath();
  g.fill();
  // the text
  g.fillStyle = "#1a1a22";
  g.textAlign = "center";
  g.textBaseline = "middle";
  g.fillText(text, 128, y + h / 2);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  tex.generateMipmaps = false;
  tex.minFilter = THREE.LinearFilter;
  const sprite = new THREE.Sprite(new THREE.SpriteMaterial({ map: tex, transparent: true, depthTest: false, depthWrite: false, toneMapped: false }));
  sprite.scale.set(2.4, 1.2, 1);
  sprite.position.set(0, 3.05, 0);
  return sprite;
}

function roundRect(g: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number) {
  g.beginPath();
  g.moveTo(x + r, y);
  g.arcTo(x + w, y, x + w, y + h, r);
  g.arcTo(x + w, y + h, x, y + h, r);
  g.arcTo(x, y + h, x, y, r);
  g.arcTo(x, y, x + w, y, r);
  g.closePath();
}

/** Free a sprite's texture + material (canvas textures aren't pooled). */
function disposeSprite(s: THREE.Sprite) {
  const m = s.material as THREE.SpriteMaterial;
  m.map?.dispose();
  m.dispose();
}
