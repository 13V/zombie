/**
 * Tiny localStorage-backed save file. Persists meta-progression across runs so
 * every death still earns something — the "one more run" hook. Degrades to an
 * in-memory object if storage is unavailable (private mode, etc.).
 */
export interface SaveData {
  essence: number; // permanent meta currency
  bestRound: number;
  bestScore: number;
  owned: string[]; // purchased meta-upgrade ids
  muted: boolean;
}

const KEY = "tinydead.save.v1";

function blank(): SaveData {
  return { essence: 0, bestRound: 0, bestScore: 0, owned: [], muted: false };
}

export function loadSave(): SaveData {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return blank();
    const data = JSON.parse(raw) as Partial<SaveData>;
    return { ...blank(), ...data, owned: data.owned ?? [] };
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
