import * as THREE from "three";
import { PLAYER } from "./config";
import { COLORS } from "./palette";
import { AssetManager, CharacterRig } from "./assets";
import { VoxelChar } from "./voxelChar";
import { GunStyle } from "./gunModels";

/** Soft gradient strip texture for the aim guide (bright near the player, faint at the tip). */
function makeGuideTexture(): THREE.Texture {
  const c = document.createElement("canvas");
  c.width = 8;
  c.height = 64;
  const g = c.getContext("2d")!;
  const grad = g.createLinearGradient(0, 64, 0, 0); // bottom (near) -> top (far)
  grad.addColorStop(0, "rgba(255,255,255,0.85)");
  grad.addColorStop(0.6, "rgba(255,255,255,0.35)");
  grad.addColorStop(1, "rgba(255,255,255,0)");
  g.fillStyle = grad;
  g.fillRect(0, 0, 8, 64);
  const tex = new THREE.CanvasTexture(c);
  tex.colorSpace = THREE.SRGBColorSpace;
  return tex;
}

/**
 * The little hero. Driven by a CharacterRig — a voxel blocky figure by default
 * (the committed style), or a KayKit GLB if one is dropped in. Handles movement,
 * aim, health.
 */
export class Player {
  readonly group = new THREE.Group();
  readonly pos = new THREE.Vector3(0, 0, 0);
  readonly muzzle = new THREE.Vector3();
  /** Unit aim direction on the XZ plane. */
  readonly aimDir = new THREE.Vector3(0, 0, -1);

  health = PLAYER.maxHealth;
  maxHealth = PLAYER.maxHealth;
  timeSinceHit = 99;
  alive = true;
  /** True while the figure is walking this frame (for networked animation). */
  moving = false;

  // buffs (perks)
  speedMul = 1;
  reloadMul = 1;

  private char: CharacterRig;
  private muzzleFlash: THREE.Sprite;
  private flashLife = 0;
  private aimGuide: THREE.Mesh;

  constructor(scene: THREE.Scene, assets: AssetManager) {
    this.char =
      assets.createCharacter("player") ??
      new VoxelChar({ body: COLORS.player, head: COLORS.playerAccent, eye: 0x222222, hat: 0xf2c14e, gun: true });
    this.group.add(this.char.root);
    this.group.position.copy(this.pos);

    // pooled muzzle flash: one billboarded glow, toggled per shot (no per-shot allocs)
    const mat = new THREE.SpriteMaterial({
      color: 0xffe9a8,
      transparent: true,
      opacity: 0,
      depthWrite: false,
      blending: THREE.AdditiveBlending,
    });
    this.muzzleFlash = new THREE.Sprite(mat);
    this.muzzleFlash.scale.set(1.1, 1.1, 1);
    this.muzzleFlash.position.set(0, 1.0, 0.9);
    this.group.add(this.muzzleFlash);

    // Brawl-Stars-style aim guide: a soft beam on the ground from the player
    // toward where they're aiming. Child of the group, so it inherits the
    // facing rotation and extends forward (+Z = aim direction).
    const guideLen = 9;
    this.aimGuide = new THREE.Mesh(
      new THREE.PlaneGeometry(0.62, guideLen),
      new THREE.MeshBasicMaterial({
        map: makeGuideTexture(),
        color: 0xfff0c8,
        transparent: true,
        opacity: 0,
        depthWrite: false,
      }),
    );
    this.aimGuide.rotation.x = -Math.PI / 2; // lie flat on the ground
    this.aimGuide.position.set(0, 0.06, guideLen / 2 + 0.6);
    this.aimGuide.renderOrder = 2;
    this.group.add(this.aimGuide);

    scene.add(this.group);
  }

  /** Fade the aim guide in/out (shown only during active play). */
  showAimGuide(on: boolean) {
    const mat = this.aimGuide.material as THREE.MeshBasicMaterial;
    const target = on ? 0.18 : 0;
    mat.opacity += (target - mat.opacity) * 0.3;
  }

  /** Pop the muzzle flash (called when a shot actually fires). */
  flash() {
    this.flashLife = 0.06;
    this.muzzleFlash.position.set(0, 1.0, 0.9);
  }

  /** Apply a cosmetic skin (recolors the voxel hero; no-op for GLB rigs). */
  setSkin(body: number, head: number) {
    if (this.char instanceof VoxelChar) this.char.setColor(body, head);
  }

  /** Swap the held weapon model to match the active weapon (cheap if unchanged). */
  setWeaponModel(style: GunStyle) {
    if (this.char instanceof VoxelChar) this.char.setGun(style);
  }

  damage(amount: number) {
    if (!this.alive) return;
    this.health = Math.max(0, this.health - amount);
    this.timeSinceHit = 0;
    if (this.health <= 0) this.alive = false;
  }

  /** Restore HP (medkits, life-steal), capped at max. */
  heal(amount: number) {
    if (!this.alive) return;
    this.health = Math.min(this.maxHealth, this.health + amount);
  }

  /** Active gameplay update: move by `(moveX, moveZ)`, aim toward `aimPoint`. */
  update(dt: number, moveX: number, moveZ: number, aimPoint: THREE.Vector3) {
    if (!this.alive) {
      this.char.update(dt);
      return;
    }

    const speed = PLAYER.speed * this.speedMul;
    this.pos.x += moveX * speed * dt;
    this.pos.z += moveZ * speed * dt;

    const dx = aimPoint.x - this.pos.x;
    const dz = aimPoint.z - this.pos.z;
    if (dx * dx + dz * dz > 0.0004) {
      this.aimDir.set(dx, 0, dz).normalize();
      this.group.rotation.y = Math.atan2(this.aimDir.x, this.aimDir.z);
    }

    const moving = moveX !== 0 || moveZ !== 0;
    this.moving = moving;
    this.char.play(moving ? "walk" : "idle");
    this.char.update(dt);
    this.updateFlash(dt);

    this.timeSinceHit += dt;
    if (this.timeSinceHit > PLAYER.regenDelay && this.health < this.maxHealth) {
      this.health = Math.min(this.maxHealth, this.health + PLAYER.regenRate * dt);
    }

    this.group.position.copy(this.pos);
    this.muzzle.copy(this.pos).addScaledVector(this.aimDir, 0.9);
    this.muzzle.y = 1.0;
  }

  private updateFlash(dt: number) {
    const mat = this.muzzleFlash.material as THREE.SpriteMaterial;
    if (this.flashLife > 0) {
      this.flashLife -= dt;
      const k = Math.max(0, this.flashLife / 0.06);
      mat.opacity = k;
      this.muzzleFlash.scale.setScalar(0.8 + (1 - k) * 0.6);
    } else if (mat.opacity !== 0) {
      mat.opacity = 0;
    }
  }

  /** Used on the menu / paused screens so the figure keeps breathing. */
  idle(dt: number) {
    this.char.play("idle");
    this.char.update(dt);
    this.updateFlash(dt);
  }

  /** Animate the rig (walk/idle) without moving — for a guest's own networked
   *  figure, whose position comes from the host snapshot. */
  netAnimate(dt: number, walking: boolean) {
    this.char.play(walking ? "walk" : "idle");
    this.char.update(dt);
    this.updateFlash(dt);
  }

  reset() {
    this.pos.set(0, 0, 0);
    this.group.position.copy(this.pos);
    this.group.rotation.y = 0;
    this.health = PLAYER.maxHealth;
    this.maxHealth = PLAYER.maxHealth;
    this.timeSinceHit = 99;
    this.alive = true;
    this.speedMul = 1;
    this.reloadMul = 1;
  }
}
