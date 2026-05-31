import * as THREE from "three";
import { Pet, findAnyPet } from "./pets";

/**
 * Offscreen pet-model thumbnails for the shop. Renders each pet's actual voxel
 * model once to a small data-URL (cached by id), so the Pets tab can show a real
 * preview of what you're buying instead of a flat colour dot.
 *
 * One tiny shared WebGL renderer + scene, used lazily and synchronously. Each
 * model is built, snapshotted, then disposed — nothing lingers on the GPU.
 */

const SIZE = 96; // px (square); shown ~48px in the card, 2x for crispness
const cache = new Map<string, string>();

let renderer: THREE.WebGLRenderer | undefined;
let scene: THREE.Scene | undefined;
let camera: THREE.OrthographicCamera | undefined;

function ensure(): boolean {
  if (renderer) return true;
  try {
    renderer = new THREE.WebGLRenderer({ alpha: true, antialias: true, preserveDrawingBuffer: true });
    renderer.setSize(SIZE, SIZE);
    renderer.setClearColor(0x000000, 0); // transparent
    scene = new THREE.Scene();
    // soft 3/4 lighting so the voxel facets read
    const key = new THREE.DirectionalLight(0xffffff, 1.5);
    key.position.set(2, 4, 3);
    const amb = new THREE.AmbientLight(0xffffff, 0.85);
    scene.add(key, amb);
    // small orthographic box framing the ~1-unit-tall pet
    const half = 0.95;
    camera = new THREE.OrthographicCamera(-half, half, half, -half, 0.1, 100);
    camera.position.set(2.2, 1.9, 2.6);
    camera.lookAt(0, 0.1, 0);
    return true;
  } catch {
    renderer = undefined; // headless/no-WebGL — fall back to no thumbnail
    return false;
  }
}

function disposeGroup(obj: THREE.Object3D) {
  obj.traverse((o) => {
    const m = o as THREE.Mesh;
    if (m.geometry && !(m.geometry as { userData?: { shared?: boolean } }).userData?.shared) m.geometry.dispose();
    const mat = m.material as THREE.Material | THREE.Material[] | undefined;
    if (Array.isArray(mat)) mat.forEach((x) => x.dispose());
    else mat?.dispose();
  });
}

/**
 * A data-URL PNG of the pet's voxel model, or "" if WebGL is unavailable.
 * Cached per pet id — the render only happens once.
 */
export function petThumbnail(petId: string): string {
  const hit = cache.get(petId);
  if (hit !== undefined) return hit;
  const def = findAnyPet(petId);
  if (!def || !ensure() || !renderer || !scene || !camera) {
    cache.set(petId, "");
    return "";
  }
  // build the model at level 1, no shiny — a clean catalogue shot
  const pet = new Pet(def, 0, 1, false);
  pet.group.position.set(0, -0.15, 0);
  pet.group.rotation.y = Math.PI * 0.18; // slight turn so it's not dead-on flat
  scene.add(pet.group);
  let url = "";
  try {
    renderer.render(scene, camera);
    url = renderer.domElement.toDataURL("image/png");
  } catch {
    url = "";
  }
  scene.remove(pet.group);
  disposeGroup(pet.group);
  cache.set(petId, url);
  return url;
}
