/**
 * Security-surface tests for src/save.ts loadSave + its sanitizers.
 *
 * Forged / corrupt saves are an attack surface: a single NaN or string in a
 * numeric field would otherwise poison the whole economy. loadSave reads
 * localStorage, so we install a minimal in-memory localStorage shim on
 * globalThis BEFORE importing the module (the module captures the global at
 * call time, not import time, so a late shim is fine — but we set it up front
 * to be safe).
 *
 * Runner: `npm run test:save` -> node --test --experimental-strip-types
 * (mirrors the existing test:rating setup; save.ts has no THREE/DOM imports).
 */
import test from "node:test";
import assert from "node:assert/strict";

// ---- minimal localStorage shim -------------------------------------------
class MemStorage {
  private m = new Map<string, string>();
  getItem(k: string): string | null {
    return this.m.has(k) ? (this.m.get(k) as string) : null;
  }
  setItem(k: string, v: string) {
    this.m.set(k, String(v));
  }
  removeItem(k: string) {
    this.m.delete(k);
  }
  clear() {
    this.m.clear();
  }
}
const store = new MemStorage();
(globalThis as unknown as { localStorage: MemStorage }).localStorage = store;

const KEY = "tinydead.save.v1";

const { loadSave } = await import("../src/save.ts");

/** Helper: write a raw blob under the save key, then load it. */
function load(raw: unknown) {
  if (raw === undefined) store.removeItem(KEY);
  else store.setItem(KEY, typeof raw === "string" ? raw : JSON.stringify(raw));
  return loadSave();
}

test("missing save returns a valid blank", () => {
  const s = load(undefined);
  assert.equal(s.essence, 0);
  assert.equal(s.gold, 0);
  assert.deepEqual(s.skins, ["classic"]);
  assert.equal(s.skin, "classic");
  assert.deepEqual(s.owned, []);
  assert.deepEqual(s.stash, []);
  assert.deepEqual(s.pets, []);
  assert.deepEqual(s.petLevels, {});
  assert.deepEqual(s.petProgress, {});
  assert.deepEqual(s.stats, { kills: 0, crits: 0, bossKills: 0, drops: 0, games: 0 });
  assert.equal(s.muted, false);
});

test("totally garbage (non-JSON) blob returns a valid blank", () => {
  const s = load("this is not json {{{");
  assert.equal(s.essence, 0);
  assert.deepEqual(s.skins, ["classic"]);
  assert.deepEqual(s.stats, { kills: 0, crits: 0, bossKills: 0, drops: 0, games: 0 });
});

test("JSON 'null' blob returns a valid blank", () => {
  const s = load("null");
  assert.equal(s.gold, 0);
  assert.deepEqual(s.owned, []);
});

test("numeric fields: NaN / string / null / negative / missing all default to 0", () => {
  const s = load({
    essence: "abc", // non-numeric string -> NaN -> 0
    gold: null, // null -> 0
    goldEarned: -50, // negative -> 0 (rejected)
    bestRound: Number.NaN, // serialises to null in JSON, then NaN -> 0
    // bestScore missing entirely -> 0
  });
  assert.equal(s.essence, 0);
  assert.equal(s.gold, 0);
  assert.equal(s.goldEarned, 0);
  assert.equal(s.bestRound, 0);
  assert.equal(s.bestScore, 0);
});

test("numeric fields: valid non-negative numbers (incl. numeric strings) pass through", () => {
  const s = load({ essence: 123, gold: "456", goldEarned: 0, bestRound: 7.5, bestScore: 9001 });
  assert.equal(s.essence, 123);
  assert.equal(s.gold, 456); // Number("456") === 456 is accepted
  assert.equal(s.goldEarned, 0);
  assert.equal(s.bestRound, 7.5);
  assert.equal(s.bestScore, 9001);
});

test("non-array owned/skins/claimed/pets become [] (skins falls back to classic)", () => {
  const s = load({ owned: "nope", skins: 42, claimed: { a: 1 }, pets: null });
  assert.deepEqual(s.owned, []);
  assert.deepEqual(s.skins, ["classic"]); // empty -> default skin
  assert.deepEqual(s.claimed, []);
  assert.deepEqual(s.pets, []);
});

test("string arrays drop non-string members", () => {
  const s = load({ owned: ["a", 1, null, "b", {}], skins: ["red", 2, "blue"], pets: ["dog", false] });
  assert.deepEqual(s.owned, ["a", "b"]);
  assert.deepEqual(s.skins, ["red", "blue"]);
  assert.deepEqual(s.pets, ["dog"]);
});

test("skin: non-string defaults to 'classic'", () => {
  assert.equal(load({ skin: 12345 }).skin, "classic");
  assert.equal(load({ skin: null }).skin, "classic");
  assert.equal(load({ skin: "midnight" }).skin, "midnight");
});

test("stats: non-object / NaN / negative members default to 0", () => {
  const s = load({ stats: { kills: -5, crits: "x", bossKills: null, drops: 3, games: Number.NaN } });
  assert.deepEqual(s.stats, { kills: 0, crits: 0, bossKills: 0, drops: 3, games: 0 });
});

test("stats: a non-object stats blob yields all-zero stats", () => {
  assert.deepEqual(load({ stats: "broken" }).stats, { kills: 0, crits: 0, bossKills: 0, drops: 0, games: 0 });
  assert.deepEqual(load({ stats: null }).stats, { kills: 0, crits: 0, bossKills: 0, drops: 0, games: 0 });
  assert.deepEqual(load({ stats: 99 }).stats, { kills: 0, crits: 0, bossKills: 0, drops: 0, games: 0 });
});

test("stash: a corrupt item is dropped, valid items kept (gold coerced)", () => {
  const s = load({
    stash: [
      { id: "i1", name: "Sword", rarity: "rare", gold: 100 }, // valid
      { id: "i2", name: "Shield", rarity: "common", gold: "bad" }, // gold NaN -> 0, item kept
      { id: 5, name: "X", rarity: "r", gold: 1 }, // id not string -> dropped
      { name: "NoId", rarity: "r", gold: 1 }, // missing id -> dropped
      { id: "i5", rarity: "r", gold: 1 }, // missing name -> dropped
      null, // -> dropped
      "string", // -> dropped
      42, // -> dropped
    ],
  });
  assert.deepEqual(s.stash, [
    { id: "i1", name: "Sword", rarity: "rare", gold: 100 },
    { id: "i2", name: "Shield", rarity: "common", gold: 0 },
  ]);
});

test("stash: negative gold on an item is rejected to 0", () => {
  const s = load({ stash: [{ id: "x", name: "n", rarity: "r", gold: -777 }] });
  assert.deepEqual(s.stash, [{ id: "x", name: "n", rarity: "r", gold: 0 }]);
});

test("stash: non-array becomes []", () => {
  assert.deepEqual(load({ stash: "nope" }).stash, []);
  assert.deepEqual(load({ stash: { 0: { id: "a", name: "b", rarity: "c", gold: 1 } } }).stash, []);
});

test("petLevels: non-object -> {}, members < 1 / NaN dropped, valid floored", () => {
  assert.deepEqual(load({ petLevels: "nope" }).petLevels, {});
  const s = load({ petLevels: { dog: 3.9, cat: 0, bird: -2, fish: "x", owl: 1 } });
  assert.deepEqual(s.petLevels, { dog: 3, owl: 1 }); // 0/-2/NaN dropped; 3.9 floored
});

test("petProgress: nested map cleaned; non-object inner / NaN / negative dropped", () => {
  const s = load({
    petProgress: {
      dog: { kills: 10, crits: "bad", neg: -3, ok: 0 }, // kills+ok kept, crits/neg dropped
      cat: "not-an-object", // inner non-object -> still produces an entry? see assertion
      bird: { x: 5.5 },
    },
  });
  assert.deepEqual(s.petProgress.dog, { kills: 10, ok: 0 });
  assert.deepEqual(s.petProgress.bird, { x: 5.5 });
  // "cat" had a non-object counter map -> skipped entirely (no key)
  assert.equal("cat" in s.petProgress, false);
});

test("petProgress: non-object top-level -> {}", () => {
  assert.deepEqual(load({ petProgress: 123 }).petProgress, {});
  assert.deepEqual(load({ petProgress: null }).petProgress, {});
});

test("muted coerces to a strict boolean", () => {
  assert.equal(load({ muted: 1 }).muted, true);
  assert.equal(load({ muted: 0 }).muted, false);
  assert.equal(load({ muted: "yes" }).muted, true);
  assert.equal(load({ muted: undefined }).muted, false);
});

// ---- v1 idle/prestige fields (migration defaults + sanitization) ----------

test("missing idle fields default cleanly (version 1, zeroed currencies, blank streak/daily)", () => {
  const s = load({ essence: 5 }); // legacy save with no idle fields
  assert.equal(s.version, 1);
  assert.equal(s.lastSeen, 0);
  assert.equal(s.prestige, 0);
  assert.equal(s.lifetimeGold, 0);
  assert.deepEqual(s.streak, { count: 0, lastDayUtc: 0, freezes: 0 });
  assert.deepEqual(s.daily, { dayUtc: 0, progress: {}, claimed: [] });
});

test("version clamps to >=1 even when corrupt/zero/negative", () => {
  assert.equal(load({ version: 0 }).version, 1);
  assert.equal(load({ version: -3 }).version, 1);
  assert.equal(load({ version: "bad" }).version, 1);
  assert.equal(load({ version: 2 }).version, 2);
  assert.equal(load({ version: 3.9 }).version, 3); // floored
});

test("prestige/lifetimeGold/lastSeen coerce like other numerics (NaN/neg/string -> 0)", () => {
  const s = load({ prestige: -5, lifetimeGold: "abc", lastSeen: Number.NaN });
  assert.equal(s.prestige, 0);
  assert.equal(s.lifetimeGold, 0);
  assert.equal(s.lastSeen, 0);
  const t = load({ prestige: 4.7, lifetimeGold: 12345, lastSeen: 1700000000000 });
  assert.equal(t.prestige, 4); // floored
  assert.equal(t.lifetimeGold, 12345);
  assert.equal(t.lastSeen, 1700000000000);
});

test("streak: corrupt members floor/zero; non-object -> blank", () => {
  assert.deepEqual(load({ streak: "nope" }).streak, { count: 0, lastDayUtc: 0, freezes: 0 });
  const s = load({ streak: { count: 6.9, lastDayUtc: -2, freezes: "x" } });
  assert.deepEqual(s.streak, { count: 6, lastDayUtc: 0, freezes: 0 });
});

test("daily: progress keeps finite non-negative; claimed drops non-strings; non-object -> blank", () => {
  assert.deepEqual(load({ daily: 99 }).daily, { dayUtc: 0, progress: {}, claimed: [] });
  const s = load({
    daily: { dayUtc: 20000.5, progress: { runs: 1, kills: -3, bad: "x", ok: 0 }, claimed: ["runs", 5, null] },
  });
  assert.equal(s.daily.dayUtc, 20000); // floored
  assert.deepEqual(s.daily.progress, { runs: 1, ok: 0 }); // negatives/NaN dropped
  assert.deepEqual(s.daily.claimed, ["runs"]); // non-strings dropped
  assert.equal(Array.isArray(s.daily.progress), false);
});

test("a fully-forged adversarial blob still yields a structurally valid save", () => {
  const s = load({
    essence: "9e999", // -> Number("9e999") === Infinity -> not finite -> 0
    gold: Infinity, // serialises to null -> 0
    owned: 12345,
    skins: [null, null],
    stash: [{}],
    pets: "x",
    petLevels: [1, 2, 3], // array is typeof object -> entries by index, all < 1? values 1,2,3 floored -> {0:?}
    petProgress: { a: [1] }, // inner array typeof object
    stats: [],
    muted: [],
    version: [],
    prestige: "lots",
    lifetimeGold: -1,
    streak: 42,
    daily: [1, 2],
  });
  // idle fields safe
  assert.equal(s.version, 1);
  assert.equal(s.prestige, 0);
  assert.equal(s.lifetimeGold, 0);
  assert.deepEqual(s.streak, { count: 0, lastDayUtc: 0, freezes: 0 });
  assert.deepEqual(s.daily, { dayUtc: 0, progress: {}, claimed: [] });
  // economy fields safe
  assert.equal(Number.isFinite(s.essence), true);
  assert.equal(s.essence, 0);
  assert.equal(s.gold, 0);
  // arrays valid
  assert.ok(Array.isArray(s.owned) && s.owned.length === 0);
  assert.deepEqual(s.skins, ["classic"]);
  assert.ok(Array.isArray(s.stash) && s.stash.length === 0);
  assert.ok(Array.isArray(s.pets) && s.pets.length === 0);
  // maps are plain objects with only finite values
  for (const v of Object.values(s.petLevels)) assert.ok(Number.isFinite(v) && v >= 1);
  for (const inner of Object.values(s.petProgress))
    for (const v of Object.values(inner)) assert.ok(Number.isFinite(v) && v >= 0);
  // stats fully zeroed (array .kills etc are undefined -> 0)
  assert.deepEqual(s.stats, { kills: 0, crits: 0, bossKills: 0, drops: 0, games: 0 });
  assert.equal(s.muted, true); // [] is truthy
});
