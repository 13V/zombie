/**
 * Integration test for the Duo/Squad co-op gather handshake against the REAL
 * relay server. Two clients join the island, both step into the same mode
 * portal, the lowest-id leader hosts a co-op room and broadcasts the code, and
 * the other joins it — mirroring the (corrected) client logic in main.ts.
 *
 * Asserts: both clients end up in the SAME co-op room and each sees the other as
 * a peer. Run: `node coop-handshake.test.mjs` (after `npm run build`).
 */
import { WebSocketServer, WebSocket } from "ws";
import http from "node:http";
import { RoomManager, HOST_ID } from "./dist/rooms.js";

// ---- spin up the relay (same wiring as index.ts, trimmed for the test) ------
const rooms = new RoomManager();
const state = new WeakMap();
const httpServer = http.createServer((req, res) => {
  if (req.url === "/health") { res.writeHead(200); res.end("ok"); return; }
  res.writeHead(404); res.end();
});
const wss = new WebSocketServer({ server: httpServer });
const send = (s, m) => { if (s.readyState === WebSocket.OPEN) s.send(JSON.stringify(m)); };
wss.on("connection", (socket) => {
  state.set(socket, {});
  socket.on("message", (raw) => {
    let msg; try { msg = JSON.parse(raw.toString()); } catch { return; }
    const s = state.get(socket);
    if (msg.t === "host") {
      const { room, member } = rooms.createRoom(socket);
      s.room = room; s.member = member;
      send(socket, { t: "hosted", room: room.code, id: member.id });
    } else if (msg.t === "join") {
      const r = rooms.joinRoom(String(msg.room), socket);
      if (!r.ok) { send(socket, { t: "error", msg: r.reason }); return; }
      s.room = r.room; s.member = r.member;
      send(socket, { t: "joined", room: r.room.code, id: r.member.id, host: false });
      for (const o of rooms.others(r.room, r.member.id)) send(o.socket, { t: "peer-join", id: r.member.id });
    } else if (msg.t === "island") {
      const { room, member } = rooms.joinIsland(socket);
      s.room = room; s.member = member;
      const peers = rooms.others(room, member.id).map((m) => m.id);
      send(socket, { t: "island-joined", room: room.code, id: member.id, peers });
      for (const o of rooms.others(room, member.id)) send(o.socket, { t: "peer-join", id: member.id });
    } else if (msg.t === "relay") {
      const room = s.room, fromId = s.member.id;
      const payload = { t: "relay", from: fromId, data: msg.data };
      if (typeof msg.to === "number") {
        const tgt = room.members.get(msg.to);
        if (tgt && tgt.id !== fromId) send(tgt.socket, payload);
      } else {
        for (const o of rooms.others(room, fromId)) send(o.socket, payload);
      }
    }
  });
  socket.on("close", () => {
    const s = state.get(socket); state.delete(socket);
    if (!s || !s.room || !s.member) return;
    const room = s.room, leavingId = s.member.id;
    if (leavingId === HOST_ID && !room.isIsland) {
      const remaining = rooms.others(room, HOST_ID);
      rooms.deleteRoom(room);
      for (const g of remaining) { send(g.socket, { t: "peer-leave", id: HOST_ID }); send(g.socket, { t: "error", msg: "host left" }); }
      return;
    }
    const remaining = rooms.removeMember(room, leavingId);
    for (const o of remaining) send(o.socket, { t: "peer-leave", id: leavingId });
  });
});

// ---- a tiny client that mirrors main.ts's gather→host→join handshake --------
// `ws` = the island/presence socket (stays alive to broadcast portal-start).
// `coop` = a SECOND socket for the actual co-op room (host/join), exactly like
// startPortalMatchAsHost (coopNet) and joinGame (new NetClient) in main.ts.
class Client {
  constructor(name, url) { this.name = name; this.url = url; this.peers = new Set(); this.portals = new Map(); this.coopPeers = new Set(); }
  connect() {
    return new Promise((res) => {
      this.ws = new WebSocket(this.url);
      this.ws.on("open", () => this.ws.send(JSON.stringify({ t: "island" })));
      this.ws.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "island-joined") { this.id = m.id; this.room = m.room; m.peers.forEach((p) => this.peers.add(p)); res(); }
        else if (m.t === "relay") this._onRelay?.(m.from, m.data);
      });
    });
  }
  // Open the co-op room on a fresh socket; resolve once hosted/joined.
  openCoop(req) {
    return new Promise((res, rej) => {
      this.coop = new WebSocket(this.url);
      this.coop.on("open", () => this.coop.send(JSON.stringify(req)));
      this.coop.on("message", (raw) => {
        const m = JSON.parse(raw.toString());
        if (m.t === "hosted" || m.t === "joined") { this.coopRoom = m.room; this.coopId = m.id; res(m.room); }
        else if (m.t === "error") rej(new Error(m.msg));
        else if (m.t === "peer-join") this.coopPeers.add(m.id);
        else if (m.t === "peer-leave") this.coopPeers.delete(m.id);
      });
    });
  }
  send(data, to) { this.ws.send(JSON.stringify({ t: "relay", to, data })); }
  // broadcast my presence (incl. which portal I'm standing in)
  presence(portal) { this.send({ t: "presence", x: 0, z: 0, ry: 0, moving: false, skin: 0, portal }); }
  // occupants of a portal = peers whose last presence reported that portal
  occupants(portal) { return [...this.portals].filter(([, p]) => p === portal).map(([id]) => id); }
  onRelay(fn) { this._onRelay = (from, data) => { if (data.t === "presence") this.portals.set(from, data.portal || ""); fn?.(from, data); }; }
}

const PORT = 8099;
const URL = `ws://127.0.0.1:${PORT}`;
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

function fail(msg) { console.error("❌ FAIL:", msg); process.exit(1); }

await new Promise((r) => httpServer.listen(PORT, r));

const A = new Client("A", URL);
const B = new Client("B", URL);

// guard against a hung test
const guard = setTimeout(() => fail("timed out — handshake never completed"), 8000);

let coopJoined = false;

await A.connect();
await B.connect();
console.log(`• A joined island as id=${A.id}, B as id=${B.id} (room ${A.room})`);
if (A.room !== B.room) fail("clients landed in different island instances");

// each tracks the other's portal from presence; run the gather state machine
const PORTAL = "mode_duo", TARGET = 2;
let aStarted = false, bStarted = false;

function gatherTick(self, target) {
  const occ = [self.id, ...self.occupants(PORTAL)];
  if (occ.length >= target && !self._portalStarting) {
    if (self.id === Math.min(...occ)) {
      // leader: host on a SECOND socket, then broadcast the code over the still-
      // open island socket (mirrors startPortalMatchAsHost in main.ts).
      self._portalStarting = true;
      self.openCoop({ t: "host" }).then((code) => self.send({ t: "portal-start", portal: PORTAL, code }));
    }
    // non-leader: do nothing — wait for portal-start (the bug we fixed)
  }
}

function onPortalStart(self, data) {
  // mirrors onPortalStart → joinGame: only join if not already starting
  if (data.t !== "portal-start" || self._portalStarting) return;
  self._portalStarting = true;
  self.openCoop({ t: "join", room: data.code }).then(() => { coopJoined = true; });
}

A.onRelay((_from, data) => { onPortalStart(A, data); gatherTick(A, TARGET); });
B.onRelay((_from, data) => { onPortalStart(B, data); gatherTick(B, TARGET); });

// both step onto the duo pad and broadcast presence on a cadence
const beat = setInterval(() => { A.presence(PORTAL); B.presence(PORTAL); gatherTick(A, TARGET); gatherTick(B, TARGET); }, 60);

// wait for the co-op room to form
for (let i = 0; i < 100 && !(A.coopRoom && B.coopRoom); i++) await wait(50);
clearInterval(beat);
await wait(300); // let peer-join propagate inside the co-op room

clearTimeout(guard);

console.log(`• A coopRoom=${A.coopRoom} (id ${A.coopId}), B coopRoom=${B.coopRoom} (id ${B.coopId})`);

if (!A.coopRoom || !B.coopRoom) fail("a client never entered a co-op room");
if (A.coopRoom !== B.coopRoom) fail(`clients in different co-op rooms: ${A.coopRoom} vs ${B.coopRoom}`);
const host = A.coopId === HOST_ID ? A : B;
const guest = host === A ? B : A;
if (host.coopId !== HOST_ID) fail("no client took host id 1");
if (guest.coopId === HOST_ID) fail("both clients claimed host id");
if (!host.coopPeers.has(guest.coopId)) fail("host does not see the guest as a peer");

console.log(`✅ PASS — both clients in co-op room ${A.coopRoom}; host id=${host.coopId} sees guest id=${guest.coopId}`);
A.ws.close(); B.ws.close();
wss.close(); httpServer.close(() => process.exit(0));
