# Tiny Dead — PartyKit relay

An **always-on, free** WebSocket relay for online co-op, as an alternative to the
Node server in [`../server`](../server). It speaks the exact same wire protocol,
so the game client connects unchanged.

It uses **no storage** — rooms live only in memory while players are connected,
so PartyKit's 24-hour storage expiry is irrelevant here.

## Deploy (once)

You need Node 18+. From this folder:

```bash
cd partykit
npx partykit@latest login     # opens GitHub to authenticate (free account)
npx partykit@latest deploy
```

Deploy prints your URL, of the form:

```
https://tiny-dead.<your-github-username>.partykit.dev
```

## Point the game at it

In the game's title screen, click **⚙ Co-op server** and paste that URL
(`https://…` is fine — the client converts it to `wss://` and appends the
PartyKit room path automatically). Or open the game with
`?server=https://tiny-dead.<you>.partykit.dev` once.

To make it the default for everyone, set the repo Actions **Variable**
`VITE_SERVER_URL` to:

```
wss://tiny-dead.<your-github-username>.partykit.dev/parties/main/tinydead
```

## Local dev

```bash
npx partykit@latest dev        # serves on http://127.0.0.1:1999
```

Then point the game at `?server=ws://127.0.0.1:1999/parties/main/tinydead`.

## How it works

All players connect to one shared PartyKit room (`tinydead`); this single
always-on instance multiplexes many game rooms in memory by a 4-letter share
code (host = id 1, guests 2–4), forwarding opaque messages between peers.
Fine for hobby scale. See [`server.ts`](./server.ts).

---

# Cloud save party

A second, **separate** party (`save`, in [`save.ts`](./save.ts)) adds durable,
wallet-authenticated cloud saves. It is registered alongside the relay in
[`partykit.json`](./partykit.json) under `"parties": { "save": "save.ts" }` and
deploys with the same `npx partykit deploy` (one deploy ships both parties).

Each player's save lives in its own room keyed by their Solana wallet address —
**the PartyKit room id _is_ the wallet address** — and is stored in PartyKit's
durable per-room KV storage, so gold/pets/progress follow the wallet across
devices.

## URL shape

```
https://tiny-dead.<your-github-username>.partykit.dev/parties/save/<wallet-address>
wss://tiny-dead.<your-github-username>.partykit.dev/parties/save/<wallet-address>
```

The base host is the same one the deploy prints. The game reaches the save
backend over HTTP (`POST`/`GET`), not WebSocket.

## Point the game at it

Set the build-time variable **`VITE_SAVE_URL`** to the PartyKit **base host**
(no path — the client appends `/parties/save/<address>` itself):

```
VITE_SAVE_URL=https://tiny-dead.<your-github-username>.partykit.dev
```

In CI, add it as a repo Actions **Variable** named `VITE_SAVE_URL` with that
value. For local dev, the base host is `http://127.0.0.1:1999`.

## Auth + wire contract

Reads are public; writes require a wallet-signed bearer token.

1. **`POST /parties/save/<addr>/login`** — body `{ message, signature }`.
   `message` must equal exactly:
   ```
   Tiny Dead save sync
   address: <addr>
   ts: <unix-ms>
   ```
   where `<addr>` is the room id and `<ts>` is within ±5 min of now. `signature`
   is base64 of the ed25519 signature of `message` by the wallet. On success
   returns `{ ok:true, token, save, updated }` (token lives 6 h). The current
   save (or `null`) is returned so the client can merge on login.
2. **`POST /parties/save/<addr>`** — header `Authorization: Bearer <token>`,
   body `{ save, updated }`. Server clock sets the authoritative `updated`.
   Bodies over 256 KB are rejected (413). Returns `{ ok:true, updated }`.
3. **`GET /parties/save/<addr>`** — public read: `{ ok:true, save, updated }`.
4. `OPTIONS` is answered with permissive CORS for browser preflight.

Verification uses [`tweetnacl`](https://www.npmjs.com/package/tweetnacl)
(ed25519) and [`bs58`](https://www.npmjs.com/package/bs58) (decode the address
to the 32-byte pubkey) — both pure-JS and workerd-compatible, listed in
[`package.json`](./package.json).
