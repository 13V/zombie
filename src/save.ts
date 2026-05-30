/**
 * Tiny localStorage-backed save file. Persists meta-progression across runs so
 * every death still earns something — the "one more run" hook. Degrades to an
 * in-memory object if storage is unavailable (private mode, etc.).
 */
export interface LifetimeStats {
  kills: number;
  crits: number;
  bossKills: number;
  drops: number;
  games: number;
}

/** A tradable loot item stored in the player's stash. */
export interface SavedItem {
  id: string;
  name: string;
  rarity: string;
  gold: number;
}

export interface SaveData {
  essence: number; // permanent meta currency
  gold: number; // tradable soft currency (earned by selling loot)
  goldEarned: number; // lifetime gold earned (stats / future token bridge)
  bestRound: number;
  bestScore: number;
  owned: string[]; // purchased meta-upgrade ids
  skins: string[]; // unlocked cosmetic skin ids
  skin: string; // equipped skin id
  claimed: string[]; // completed challenge ids
  stash: SavedItem[]; // tradable loot inventory
  stats: LifetimeStats;
  muted: boolean;
}

const KEY = "tinydead.save.v1";

function blankStats(): LifetimeStats {
  return { kills: 0, crits: 0, bossKills: 0, drops: 0, games: 0 };
}

function blank(): SaveData {
  return {
    essence: 0,
    gold: 0,
    goldEarned: 0,
    bestRound: 0,
    bestScore: 0,
    owned: [],
    skins: ["classic"],
    skin: "classic",
    claimed: [],
    stash: [],
    stats: blankStats(),
    muted: false,
  };
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const data = JSON.parse(raw) as Partial<SaveData>;
    const base = blank();
    return {
      ...base,
      ...data,
      owned: data.owned ?? [],
      skins: data.skins && data.skins.length ? data.skins : ["classic"],
      skin: data.skin ?? "classic",
      claimed: data.claimed ?? [],
      stash: data.stash ?? [],
      stats: { ...base.stats, ...(data.stats ?? {}) },
    };
  } catch {
    return blank();
  }
}

export function writeSave(data: SaveData) {
  try {
    localStorage.setItem(KEY, JSON.stringify(data));
  } catch {
    /* storage unavailable — progression is session-only this run */
  }
}
