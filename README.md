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

## Project layout

```
src/
  main.ts           bootstrap + the Game class (loop, state machine, collisions)
  config.ts         tunable gameplay + art constants
  palette.ts        colors + shared toy/glow material helpers
  input.ts          keyboard/mouse + pointer→ground raycast
  arena.ts          the diorama world: ground, walls, props, lights, fog
  player.ts         player entity
  zombie.ts         zombie entity + steering/separation
  rounds.ts         RoundManager: spawn budget, scaling, intermission
  weapons.ts        weapon defs + bullet pool + firing
  interactables.ts  Mystery Box, wall-buy, perk pads
  hud.ts            DOM HUD + overlays
```

Roadmap / out-of-scope items (co-op, Pack-a-Punch, special enemies, buyable doors,
audio, mobile touch, leaderboards) are tracked in [`DESIGN.md`](./DESIGN.md).
