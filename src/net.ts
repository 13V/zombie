/**
 * Client-side networking transport for online co-op.
 *
 * The backend (see `server/`) is a thin relay: it manages rooms by share-code
 * and forwards opaque application messages between peers. One peer per room is
 * the authoritative HOST (id 1); the others are guests. Everything above the
 * transport — snapshots, inputs — is defined by `NetMsg` and is opaque to the
 * server.
 */

/**
 * Where the relay server lives. Defaults to the deployed Render instance;
 * override with VITE_SERVER_URL at build time (e.g. ws://localhost:8080 for
 * local server testing).
 */
export const SERVER_URL: string =
  ((import.meta as any).env?.VITE_SERVER_URL as string | undefined) ?? "wss://zombie-kwhm.onrender.com";

// ---- application-level messages (carried inside relay `data`) ----

export interface PlayerSnap {
  id: number;
  x: number;
  z: number;
  ry: number;
  hp: number;
  maxHp: number;
  alive: boolean;
  walking: boolean;
}

export interface ZombieSnap {
  id: number;
  x: number;
  z: number;
  ry: number;
  /** Index into ZOMBIE_TYPES for color/scale. */
  type: number;
  /** 0 = alive, 1 = dying. */
  state: number;
}

/** Host → guests, broadcast every network tick. */
export interface SnapMsg {
  t: "snap";
  players: PlayerSnap[];
  zombies: ZombieSnap[];
  round: number;
  points: number;
  phase: string;
}

/** A fired-shot event so guests can render a tracer locally. */
export interface ShotMsg {
  t: "shot";
  x: number;
  z: number;
  dx: number;
  dz: number;
  color: number;
  scale: number;
}

/** Guest → host, sent each frame: that player's intent. */
export interface InputMsg {
  t: "input";
  mx: number;
  mz: number;
  /** Aim point on the ground plane. */
  ax: number;
  az: number;
  fire: boolean;
  reload: boolean;
  swap: boolean;
  interact: boolean;
}

export type NetMsg = SnapMsg | ShotMsg | InputMsg;

// ---- transport envelopes (to/from the relay server) ----

interface SrvHosted { t: "hosted"; room: string; id: number; }
interface SrvJoined { t: "joined"; room: string; id: number; host: boolean; }
interface SrvPeerJoin { t: "peer-join"; id: number; }
interface SrvPeerLeave { t: "peer-leave"; id: number; }
interface SrvRelay { t: "relay"; from: number; data: NetMsg; }
interface SrvError { t: "error"; msg: string; }
type SrvMsg = SrvHosted | SrvJoined | SrvPeerJoin | SrvPeerLeave | SrvRelay | SrvError;

export type NetRole = "host" | "guest";

/**
 * Thin wrapper over the WebSocket relay: connect, host/join a room, track
 * peers, and send/receive `NetMsg`s. Higher layers decide what to do with them.
 */
export class NetClient {
  private ws?: WebSocket;
  id = 0;
  role: NetRole = "host";
  room = "";
  readonly peers = new Set<number>();
  connected = false;

  // callbacks (assigned by the game layer)
  onPeerJoin?: (id: number) => void;
  onPeerLeave?: (id: number) => void;
  onMessage?: (from: number, msg: NetMsg) => void;
  onClose?: (reason: string) => void;

  get isHost(): boolean {
    return this.role === "host";
  }

  /** Open a room as host. Resolves with the share-code others will type. */
  host(): Promise<{ code: string }> {
    return this.open((ws, resolve, reject) => {
      ws.onmessage = (ev) => {
        const m = this.parse(ev.data);
        if (!m) return;
        if (m.t === "hosted") {
          this.id = m.id;
          this.role = "host";
          this.room = m.room;
          this.connected = true;
          this.ws!.onmessage = (e) => this.handle(e);
          resolve({ code: m.room });
        } else if (m.t === "error") {
          reject(new Error(m.msg));
        }
      };
      ws.send(JSON.stringify({ t: "host" }));
    });
  }

  /** Join an existing room by its share-code. */
  join(code: string): Promise<{ id: number }> {
    const room = code.trim().toUpperCase();
    return this.open((ws, resolve, reject) => {
      ws.onmessage = (ev) => {
        const m = this.parse(ev.data);
        if (!m) return;
        if (m.t === "joined") {
          this.id = m.id;
          this.role = "guest";
          this.room = m.room;
          this.connected = true;
          this.ws!.onmessage = (e) => this.handle(e);
          resolve({ id: m.id });
        } else if (m.t === "error") {
          reject(new Error(m.msg));
        }
      };
      ws.send(JSON.stringify({ t: "join", room }));
    });
  }

  /** Send an app message: to a specific peer, or broadcast to the rest of the room. */
  send(msg: NetMsg, to?: number) {
    if (!this.ws || this.ws.readyState !== WebSocket.OPEN) return;
    this.ws.send(JSON.stringify({ t: "relay", to, data: msg }));
  }

  close() {
    this.connected = false;
    this.ws?.close();
    this.ws = undefined;
  }

  // ---- internals ----
  private open(
    handshake: (ws: WebSocket, resolve: (v: any) => void, reject: (e: Error) => void) => void,
  ): Promise<any> {
    return new Promise((resolve, reject) => {
      let ws: WebSocket;
      try {
        ws = new WebSocket(SERVER_URL);
      } catch (e) {
        reject(e as Error);
        return;
      }
      this.ws = ws;
      const to = setTimeout(() => reject(new Error("Connection timed out")), 8000);
      ws.onerror = () => reject(new Error("Could not reach the server"));
      ws.onclose = () => {
        if (this.connected) {
          this.connected = false;
          this.onClose?.("Disconnected");
        }
      };
      ws.onopen = () => {
        clearTimeout(to);
        handshake(ws, resolve as any, reject);
      };
    });
  }

  private parse(data: unknown): SrvMsg | null {
    if (typeof data !== "string") return null;
    try {
      return JSON.parse(data) as SrvMsg;
    } catch {
      return null;
    }
  }

  private handle(ev: MessageEvent) {
    const m = this.parse(ev.data);
    if (!m) return;
    switch (m.t) {
      case "peer-join":
        this.peers.add(m.id);
        this.onPeerJoin?.(m.id);
        break;
      case "peer-leave":
        this.peers.delete(m.id);
        this.onPeerLeave?.(m.id);
        if (m.id === 1 && this.role === "guest") {
          // host left → room is gone
          this.connected = false;
          this.onClose?.("Host left");
        }
        break;
      case "relay":
        this.onMessage?.(m.from, m.data);
        break;
      case "error":
        this.onClose?.(m.msg);
        break;
    }
  }
}
