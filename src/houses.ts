/**
 * House persistence — backend-first with a localStorage fallback.
 *
 * If a token/island backend URL is configured (getTokenApiUrl), houses round-
 * trip there so they persist cross-device and other players can visit. Until
 * then (and offline), houses save locally so building still works and isn't
 * lost — they sync up the first time a backend is set.
 */
import { HouseData, sanitizeHouse } from "./house";
import { getTokenApiUrl } from "./token";

const LS_KEY = "tinydead.houses"; // { [plotIndex]: HouseData }

function readLocal(): Record<string, HouseData> {
  try {
    const raw = localStorage.getItem(LS_KEY);
    return raw ? (JSON.parse(raw) as Record<string, HouseData>) : {};
  } catch {
    return {};
  }
}
function writeLocal(map: Record<string, HouseData>) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(map));
  } catch {
    /* storage unavailable */
  }
}

/** Social counters surfaced on a plot ("❤ N · M visits"). */
export interface HouseMeta {
  likes: number;
  visits: number;
}

/** Load a plot's house. Tries the backend, then falls back to local. When
 *  `visit` is set, the backend counts a visit (used for neighbours' plots). */
export async function loadHouse(plotIndex: number, owner: string, visit = false): Promise<HouseData | null> {
  const api = getTokenApiUrl();
  if (api && owner) {
    try {
      const r = await fetch(
        `${api}/house?owner=${encodeURIComponent(owner)}&plot=${plotIndex}${visit ? "&visit=1" : ""}`,
      );
      if (r.ok) {
        const j = (await r.json()) as { house?: unknown };
        if (j.house) return sanitizeHouse(j.house);
      }
    } catch {
      /* fall through to local */
    }
  }
  const local = readLocal()[plotIndex];
  return local ? sanitizeHouse(local) : null;
}

/** Read a plot's social counters from the backend (0/0 if offline). */
export async function getHouseMeta(plotIndex: number, owner: string): Promise<HouseMeta> {
  const api = getTokenApiUrl();
  if (api && owner) {
    try {
      const r = await fetch(`${api}/house?owner=${encodeURIComponent(owner)}&plot=${plotIndex}`);
      if (r.ok) {
        const j = (await r.json()) as Partial<HouseMeta>;
        return { likes: Number(j.likes ?? 0), visits: Number(j.visits ?? 0) };
      }
    } catch {
      /* offline */
    }
  }
  return { likes: 0, visits: 0 };
}

/** Like another player's house. Returns the new like count (or null offline). */
export async function likeHouse(plotIndex: number, owner: string): Promise<number | null> {
  const api = getTokenApiUrl();
  if (!api || !owner) return null;
  try {
    const r = await fetch(`${api}/house/like`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ owner, plot: plotIndex }),
    });
    if (r.ok) {
      const j = (await r.json()) as { likes?: number };
      return Number(j.likes ?? 0);
    }
  } catch {
    /* offline */
  }
  return null;
}

/** Save a plot's house. Writes local immediately + best-effort to the backend. */
export async function saveHouse(plotIndex: number, owner: string, data: HouseData): Promise<void> {
  const map = readLocal();
  map[plotIndex] = data;
  writeLocal(map);
  const api = getTokenApiUrl();
  if (api && owner) {
    try {
      await fetch(`${api}/house`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ owner, plot: plotIndex, house: data }),
      });
    } catch {
      /* local copy already saved; will resync next time */
    }
  }
}
