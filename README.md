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

## What's in the prototype

- Cozy diorama arena: soft lighting, gentle bloom, fog, chunky low-poly props.
- Player movement, mouse aiming, shooting, reloading, health + COD-style regen.
- Round-based zombie director with scaling count / HP / speed and intermissions.
- Points economy: earn on hits, kills, and surviving rounds.
- **Mystery Box** (random weapon gamble), a **wall-buy** weapon, and **two perk pads**
  (Tough = more HP, Quick = faster movement + reload).
- HUD: round, points, health, weapon + ammo, interaction prompts; start / game-over flow.

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
