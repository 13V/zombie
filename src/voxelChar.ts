import * as THREE from "three";
import { voxelMaterial } from "./palette";
import { AnimState, CharacterRig } from "./assets";
import { GunStyle, buildGun } from "./gunModels";

/** The cute social emotes a voxel figure can play in the island hub. */
export type EmoteId = "wave" | "dance" | "sit" | "cheer";
/** Default play length (seconds) per emote; "sit" loops until movement clears it. */
const EMOTE_DUR: Record<EmoteId, number> = { wave: 2.2, dance: 3.2, sit: 0, cheer: 2.0 };

export interface VoxelCharOpts {
  body: number;
  head: number;
  eye: number;
  hat?: number;
  /** Adds a forward gun nub (player). */
  gun?: boolean;
  /** Shambling gait + forward-reaching arms. */
  zombie?: boolean;
}

/**
 * A procedural blocky humanoid — the committed character style (Kintara-like:
 * boxy body, square head with two dot-eyes, optional hat). Animates walk / idle
 * / attack / death procedurally by swinging limb pivot groups. Implements the
 * same `CharacterRig` API as the GLB `Character`, so entities don't care which.
 */
export class VoxelChar implements CharacterRig {
  readonly root = new THREE.Group();
  private legL: THREE.Group;
  private legR: THREE.Group;
  private armL: THREE.Group;
  private armR: THREE.Group;
  private upper = new THREE.Group(); // torso + head + arms (for bob/lean)

  private state: AnimState = "idle";
  private t = 0;
  private deathT = 0;
  // ---- island emotes (procedural; layered over idle, not an AnimState) ----
  private emoteId: EmoteId | null = null;
  private emoteT = 0; // seconds elapsed in the current emote
  private emoteDur = 0; // 0 = loop until cleared (sit), >0 = one-shot
  private deathTilt = (Math.random() - 0.5) * 0.6;
  private gait: number;
  private reach: number;
  private bodyMat: THREE.MeshStandardMaterial;
  private headMat: THREE.MeshStandardMaterial;
  private baseEmissive = 0x000000;
  private gunHolder?: THREE.Group;
  private gunStyle?: GunStyle;

  constructor(opts: VoxelCharOpts) {
    this.gait = opts.zombie ? 6 : 10;
    this.reach = opts.zombie ? -0.5 : 0; // zombies hold arms forward

    const bodyMat = voxelMaterial(opts.body);
    const headMat = voxelMaterial(opts.head);
    this.bodyMat = bodyMat;
    this.headMat = headMat;

    const torso = new THREE.Mesh(new THREE.BoxGeometry(0.8, 0.9, 0.5), bodyMat);
    torso.position.y = 1.05;
    torso.castShadow = true;
    this.upper.add(torso);

    const head = new THREE.Mesh(new THREE.BoxGeometry(0.74, 0.74, 0.74), headMat);
    head.position.y = 1.85;
    head.castShadow = true;
    this.upper.add(head);

    const eyeMat = voxelMaterial(opts.eye);
    for (const dx of [-0.16, 0.16]) {
      const e = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.18, 0.06), eyeMat);
      e.position.set(dx, 1.88, 0.39);
      this.upper.add(e);
    }

    if (opts.hat !== undefined) {
      const hat = new THREE.Mesh(new THREE.BoxGeometry(0.82, 0.2, 0.82), voxelMaterial(opts.hat));
      hat.position.y = 2.28;
      hat.castShadow = true;
      this.upper.add(hat);
    }

    this.armL = this.makeArm(bodyMat, -0.52);
    this.armR = this.makeArm(bodyMat, 0.52);
    this.upper.add(this.armL, this.armR);

    if (opts.gun) {
      this.gunHolder = new THREE.Group();
      this.gunHolder.position.set(0.32, 1.02, 0.26); // right hand, barrel forward
      this.upper.add(this.gunHolder);
      this.setGun("pistol");
    }

    this.legL = this.makeLeg(bodyMat, -0.18);
    this.legR = this.makeLeg(bodyMat, 0.18);

    this.root.add(this.upper, this.legL, this.legR);
  }

  private makeArm(mat: THREE.Material, x: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 1.45, 0); // shoulder pivot
    const arm = new THREE.Mesh(new THREE.BoxGeometry(0.24, 0.62, 0.26), mat);
    arm.position.y = -0.31;
    // arms/legs don't cast shadow — halves shadow draw calls for the horde;
    // torso+head shadow already reads the silhouette fine.
    g.add(arm);
    return g;
  }

  private makeLeg(mat: THREE.Material, x: number): THREE.Group {
    const g = new THREE.Group();
    g.position.set(x, 0.62, 0); // hip pivot
    const leg = new THREE.Mesh(new THREE.BoxGeometry(0.3, 0.62, 0.32), mat);
    leg.position.y = -0.31;
    g.add(leg); // no shadow caster (see makeArm)
    return g;
  }

  hasAnim(): boolean {
    return true; // all states are procedural
  }

  /** Swap the held weapon model (no-op if unchanged or this rig has no gun). */
  setGun(style: GunStyle) {
    if (!this.gunHolder || this.gunStyle === style) return;
    this.gunStyle = style;
    this.gunHolder.clear(); // gun meshes share one geometry; nothing to dispose
    this.gunHolder.add(buildGun(style));
  }

  /** Recolor body/head (used to turn a pooled zombie into a special variant). */
  setColor(body: number, head: number, emissive = 0x000000) {
    this.bodyMat.color.set(body);
    this.bodyMat.emissive.set(emissive);
    this.bodyMat.emissiveIntensity = emissive === 0x000000 ? 1 : 0.5;
    this.baseEmissive = emissive;
    this.headMat.color.set(head);
  }

  /** White flash on hit (0..1); fades back to the variant's base emissive. */
  setHitFlash(amount: number) {
    if (amount <= 0) {
      this.bodyMat.emissive.set(this.baseEmissive);
      this.headMat.emissive.set(0x000000);
      this.bodyMat.emissiveIntensity = this.baseEmissive === 0x000000 ? 1 : 0.5;
      this.headMat.emissiveIntensity = 1;
      return;
    }
    // flash RED on damage so hits read clearly (was white)
    this.bodyMat.emissive.setRGB(amount, amount * 0.05, amount * 0.05);
    this.headMat.emissive.setRGB(amount, amount * 0.05, amount * 0.05);
    this.bodyMat.emissiveIntensity = 1.6;
    this.headMat.emissiveIntensity = 1.6;
  }

  play(state: AnimState, _opts: { once?: boolean } = {}) {
    if (state === this.state) return;
    this.state = state;
    // walking cancels any emote (you can't dance while running); idle does not,
    // so wave/cheer keep playing while you stand still.
    if (state === "walk") this.emoteId = null;
    if (state === "death") {
      this.deathT = 0;
    } else {
      this.root.rotation.set(0, 0, 0);
      this.root.position.y = 0;
      this.root.scale.setScalar(1);
    }
  }

  /** Start a social emote (island hub). Plays over idle; one-shot emotes auto-clear. */
  emote(id: EmoteId) {
    this.emoteId = id;
    this.emoteT = 0;
    this.emoteDur = EMOTE_DUR[id];
  }

  /** True while a non-looping emote is still playing (so callers can gate input). */
  get emoting(): boolean {
    return this.emoteId !== null;
  }

  // Procedural emote poses — simple, cute, voxel-style limb/torso animation.
  private applyEmote(id: EmoteId) {
    const et = this.emoteT;
    // reset legs/torso to a neutral stand each frame (poses set what they need)
    this.legL.rotation.x = 0;
    this.legR.rotation.x = 0;
    this.root.position.y = 0;
    this.root.rotation.set(0, 0, 0);
    this.upper.rotation.z = 0;
    switch (id) {
      case "wave": {
        // raise the right arm overhead and swish it side to side
        const s = Math.sin(et * 9);
        this.armR.rotation.x = -2.6;
        this.armR.rotation.z = 0.35 + s * 0.35;
        this.armL.rotation.x = this.reach;
        this.upper.position.y = 0.02 + Math.abs(s) * 0.02;
        break;
      }
      case "dance": {
        // bouncy hip-sway with alternating arm pumps + a little spin
        const b = Math.sin(et * 7);
        this.armL.rotation.x = -1.4 + b * 0.9;
        this.armR.rotation.x = -1.4 - b * 0.9;
        this.upper.rotation.z = b * 0.25;
        this.upper.position.y = Math.abs(Math.sin(et * 14)) * 0.12;
        this.root.rotation.y = Math.sin(et * 3.5) * 0.4;
        this.legL.rotation.x = b * 0.3;
        this.legR.rotation.x = -b * 0.3;
        break;
      }
      case "sit": {
        // lower the whole figure + bend legs forward like sitting cross-legged
        this.root.position.y = -0.5;
        this.legL.rotation.x = 1.4;
        this.legR.rotation.x = 1.4;
        this.armL.rotation.x = 0.5;
        this.armR.rotation.x = 0.5;
        this.upper.position.y = Math.sin(et * 2) * 0.02; // gentle breathing
        break;
      }
      case "cheer": {
        // both arms thrown up with little hops of excitement
        const hop = Math.abs(Math.sin(et * 8));
        this.armL.rotation.x = -2.7;
        this.armR.rotation.x = -2.7;
        this.armL.rotation.z = -0.3;
        this.armR.rotation.z = 0.3;
        this.root.position.y = hop * 0.18;
        this.upper.position.y = 0.02;
        break;
      }
    }
  }

  update(dt: number) {
    this.t += dt;
    // Emotes layer over idle (never over walk/death). One-shots auto-expire.
    if (this.emoteId && this.state !== "walk" && this.state !== "death") {
      this.emoteT += dt;
      if (this.emoteDur > 0 && this.emoteT >= this.emoteDur) {
        this.emoteId = null;
      } else {
        this.applyEmote(this.emoteId);
        return;
      }
    }
    switch (this.state) {
      case "death": {
        this.deathT += dt;
        const k = Math.min(1, this.deathT / 0.4);
        this.root.rotation.x = -1.5 * k;
        this.root.rotation.z = this.deathTilt * k;
        this.root.position.y = -0.25 * k;
        break;
      }
      case "walk": {
        const a = Math.sin(this.t * this.gait) * 0.7;
        this.legL.rotation.x = a;
        this.legR.rotation.x = -a;
        this.armL.rotation.x = this.reach - a * 0.6;
        this.armR.rotation.x = this.reach + a * 0.6;
        this.armL.rotation.z = 0;
        this.armR.rotation.z = 0;
        this.upper.position.y = Math.abs(Math.sin(this.t * this.gait)) * 0.06;
        this.upper.rotation.z = Math.sin(this.t * this.gait) * 0.05;
        break;
      }
      default: {
        // idle: gentle breathing + arm sway, legs neutral
        const b = Math.sin(this.t * 2);
        this.legL.rotation.x = 0;
        this.legR.rotation.x = 0;
        this.armL.rotation.x = this.reach + b * 0.04;
        this.armR.rotation.x = this.reach - b * 0.04;
        this.armL.rotation.z = 0;
        this.armR.rotation.z = 0;
        this.upper.position.y = b * 0.025;
        this.upper.rotation.z = 0;
      }
    }
  }
}
