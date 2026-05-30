# Tiny Dead — Cozy Crypt Survival

A toy-diorama take on round-based zombie survival. The soft-lit, chunky charm of
[Kintara](https://x.com/playkintara) and [Tiny Worlds](https://x.com/tinyworldsapp)
fused with the escalating dread and point economy of **Call of Duty: Zombies**.

Built with **Three.js** + **TypeScript** + **Vite**.

> See [`DESIGN.md`](./DESIGN.md) for the full game design (pillars, art direction,
> systems, and roadmap).

![status](https://img.shields.io/badge/stage-playable%20prototype-ffcf52)

## Run it

```bash
npm install
npm run dev      # http://localhost:5173
```

```bash
npm run build    # typecheck + production build into dist/
npm run preview  # serve the production build
```

### Play in the browser (GitHub Pages)

A workflow (`.github/workflows/deploy.yml`) builds and publishes the game on every
push. **One-time setup:** in the GitHub repo go to **Settings → Pages → Build and
deployment → Source: "GitHub Actions"**. After the next push, the live URL appears
in the Actions run (and under Settings → Pages) — open it on any device.

## Online co-op (up to 4)

The game supports host-authoritative online co-op. There are two pieces:

1. **The relay server** (`server/`) — a small Node WebSocket server that manages
   rooms by share-code. It can't run on GitHub Pages; deploy it once to a host
   that gives you a `wss://` URL (Render blueprint included):
   ```bash
   cd server && npm install && npm run dev   # local: ws://localhost:8080
   ```
   See [`server/README.md`](./server/README.md) for Render/Fly/Railway steps.

2. **The client** points at that server via the `VITE_SERVER_URL` build var. For
   the Pages build, set a repo **Variable** named `VITE_SERVER_URL` (Settings →
   Secrets and variables → Actions → Variables) to your `wss://…` URL.

Then on the title screen: **Host Co-op** prints a 4-letter room code; friends
pick **Join**, type the code, and drop into your world. One player (the host) is
the authoritative simulation; everyone shares the round, the horde, and points.
Solo play needs none of this.

## Controls

| Input            | Action            |
| ---------------- | ----------------- |
| **W A S D**      | Move              |
| **Mouse**        | Aim               |
| **Left click**   | Fire (hold = auto)|
| **R**            | Reload            |
| **E** / **Space**| Interact / buy    |
| **Q**            | Swap weapon       |
| **P** / **Esc**  | Pause             |
| **M**            | Mute / unmute     |

## What's in the prototype

- Cozy diorama arena: soft lighting, gentle bloom, fog, chunky low-poly props.
- Player movement, mouse aiming, shooting, reloading, health + COD-style regen.
- Round-based zombie director with scaling count / HP / speed and intermissions.
- Points economy: earn on hits, kills, and surviving rounds.
- **Mystery Box** (random weapon gamble), a **wall-buy** weapon, and **two perk pads**
  (Tough = more HP, Quick = faster movement + reload).
- HUD: round, points, health, weapon + ammo, interaction prompts; start / game-over flow.

### Game feel & juice
- **Procedural audio** (`audio.ts`) — every sound is synthesized live with the Web
  Audio API (no asset files): gunfire, hit ticks, crit pops, zombie groans, kill
  thuds, explosions, pickup jingles, buy/deny blips, a round-start sting, and an
  escalating ambient drone. Press **M** to mute.
- **Floating combat text** (`feedback.ts`) — pooled, billboarded damage / "+points"
  / CRIT numbers that rise and fade (capped for performance).
- **Hit feedback** — white hit-flash on zombies, knockback shove, muzzle flash, and
  brief **hit-stop** (sim micro-freeze) on crits / combo kills for impact weight.
- **Center-hit crits** — precise shots (near the body axis) deal ×2 and pop "CRIT".
- **Kill-combo multiplier** (`combo.ts`) — chaining kills ramps a points multiplier
  (up to ×5) shown with a draining HUD bar; lapses if you stop killing.

### Progression hooks (the "addicting" loops)
- **Meta-progression** (`save.ts`, `meta.ts`) — runs bank **Essence** (saved to
  localStorage, even on death); spend it in the tabbed menu shop. Personal best
  round/score is tracked and celebrated.
- **Cosmetic skins** (`cosmetics.ts`) — visual-only hero recolors bought with
  Essence and equipped from the **Skins** tab (no balance impact).
- **Challenges** (`challenges.ts`) — one-time goals (lifetime kills/crits/bosses,
  reach round 10/15, flawless boss kill) that pay Essence; progress shown on the
  **Challenges** tab. Run stats are tracked live and settled on death.
- **Level-up picker** (`upgrades.ts`, `mods.ts`) — clear a round and choose 1 of 3
  stacking upgrades on an animated card screen: icons, rarity tiers (common / rare /
  shimmering **legendary**), live stat-delta previews (e.g. `Damage 120% → 140%`), a
  **reroll** for points, and **1/2/3** keyboard picks. All stats funnel through a
  single `RunMods` bundle that both meta + level-ups write to.
- **Bosses** — every 5th round spawns a boss with its own health bar and a loot dump.
- **Loot drops** (`drops.ts`) — kills roll a weighted table of glowing pickups
  (max ammo, bonus points, medkit, 2× points, rapid fire, insta-kill, nuke, treasure).

## Matching the cozy soft-3D art style

The Kintara / Tiny Worlds look comes from three layers, all wired up here:

1. **Characters.** By default these are **procedural voxel figures** (`voxelChar.ts`)
   — boxy body, square head with two dot-eyes — animated procedurally
   (walk/idle/attack/death). Optionally, drop **KayKit** GLBs into `public/models/`
   (`player.glb`, `zombie.glb`) and they're used instead, with animations
   fuzzy-matched by clip name. See [`public/models/README.md`](./public/models/README.md).
2. **Render / look-dev.** Image-based ambient lighting (`RoomEnvironment` env map)
   for the soft "expensive" glow, soft shadows, gentle bloom, ACES tone mapping,
   and a **tilt-shift + vignette** post pass for the "miniature diorama" feel.
3. **Materials.** High-roughness, metalness-free toy plastic lit by the env map.

## Project layout

```
src/
  main.ts           bootstrap + the Game class (loop, state machine, collisions)
  config.ts         tunable gameplay + art constants
  palette.ts        colors + shared toy/glow material helpers
  input.ts          keyboard/mouse + pointer→ground raycast
  arena.ts          the diorama world: ground, walls, props, lights, fog
  assets.ts         GLB loader + AnimationMixer wrapper (KayKit-ready, fuzzy clips)
  tiltShift.ts      tilt-shift + vignette post-processing (the "miniature" look)
  player.ts         player entity (GLB character or primitive fallback)
  zombie.ts         zombie entity + steering/separation (GLB or primitive)
  rounds.ts         RoundManager: spawn budget, scaling, intermission
  weapons.ts        weapon defs + bullet pool + firing
  interactables.ts  Mystery Box, wall-buy, perk pads
  hud.ts            DOM HUD + overlays
public/models/      drop KayKit GLBs here (see its README)
```

Roadmap / out-of-scope items (co-op, Pack-a-Punch, special enemies, buyable doors,
audio, mobile touch, leaderboards) are tracked in [`DESIGN.md`](./DESIGN.md).
