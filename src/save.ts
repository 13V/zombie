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
  pets: string[]; // owned companion pet ids (bought with gold)
  petLevels: Record<string, number>; // pet id -> level (1+), leveled with gold
  petProgress: Record<string, Record<string, number>>; // pet id -> evolution-trial counters
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
    pets: [],
    petLevels: {},
    petProgress: {},
    stats: blankStats(),
    muted: false,
  };
}

/** Coerce to a finite, non-negative number — guards against corrupt/forged
 *  saves where a field is null / NaN / a string (which would otherwise turn
 *  the whole economy into NaN and permanently break the shop). */
function num(v: unknown, fallback = 0): number {
  const n = typeof v === "number" ? v : Number(v);
  return Number.isFinite(n) && n >= 0 ? n : fallback;
}

function sanitizeStash(raw: unknown): SavedItem[] {
  if (!Array.isArray(raw)) return [];
  const out: SavedItem[] = [];
  for (const it of raw) {
    if (!it || typeof it !== "object") continue;
    const o = it as Partial<SavedItem>;
    if (typeof o.id !== "string" || typeof o.name !== "string" || typeof o.rarity !== "string") continue;
    out.push({ id: o.id, name: o.name, rarity: o.rarity, gold: num(o.gold) });
  }
  return out;
}

function strArray(raw: unknown): string[] {
  return Array.isArray(raw) ? raw.filter((x): x is string => typeof x === "string") : [];
}

/** Nested pet-id -> { stat -> finite count } map; drops anything malformed. */
function sanitizePetProgress(raw: unknown): Record<string, Record<string, number>> {
  const out: Record<string, Record<string, number>> = {};
  if (raw && typeof raw === "object") {
    for (const [id, counters] of Object.entries(raw as Record<string, unknown>)) {
      if (!counters || typeof counters !== "object") continue;
      const inner: Record<string, number> = {};
      for (const [k, v] of Object.entries(counters as Record<string, unknown>)) {
        const n = typeof v === "number" ? v : Number(v);
        if (Number.isFinite(n) && n >= 0) inner[k] = n;
      }
      out[id] = inner;
    }
  }
  return out;
}

function sanitizeLevels(raw: unknown): Record<string, number> {
  const out: Record<string, number> = {};
  if (raw && typeof raw === "object") {
    for (const [k, v] of Object.entries(raw as Record<string, unknown>)) {
      const n = typeof v === "number" ? v : Number(v);
      if (Number.isFinite(n) && n >= 1) out[k] = Math.floor(n);
    }
  }
  return out;
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const data = JSON.parse(raw) as Partial<SaveData>;
    const skins = strArray(data.skins);
    return {
      essence: num(data.essence),
      gold: num(data.gold),
      goldEarned: num(data.goldEarned),
      bestRound: num(data.bestRound),
      bestScore: num(data.bestScore),
      owned: strArray(data.owned),
      skins: skins.length ? skins : ["classic"],
      skin: typeof data.skin === "string" ? data.skin : "classic",
      claimed: strArray(data.claimed),
      stash: sanitizeStash(data.stash),
      pets: strArray(data.pets),
      petLevels: sanitizeLevels(data.petLevels),
      petProgress: sanitizePetProgress(data.petProgress),
      stats: {
        kills: num(data.stats?.kills),
        crits: num(data.stats?.crits),
        bossKills: num(data.stats?.bossKills),
        drops: num(data.stats?.drops),
        games: num(data.stats?.games),
      },
      muted: !!data.muted,
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
