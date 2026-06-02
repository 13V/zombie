import test from "node:test";
import assert from "node:assert/strict";
import {
  TD_TOWERS, TD_TOWER_IDS, TD_MAX_TIER, TD_TARGET_MODES, tdTower, tdUpgradeCost, tdSellValue,
  towerStats, pickTarget, type TdTargetable,
} from "../src/td/tdtowers.ts";

test("catalog has five archetypes with the right roles", () => {
  assert.equal(TD_TOWER_IDS.length, 5);
  for (const id of TD_TOWER_IDS) {
    const d = tdTower(id);
    assert.ok(d.cost > 0 && d.range > 0 && d.fireRate > 0 && d.damage > 0);
  }
  assert.ok(TD_TOWERS.cannon.splash > 0 && TD_TOWERS.cannon.pierce, "cannon splashes + pierces armor");
  assert.ok(TD_TOWERS.frost.slow > 0, "frost slows");
  assert.ok(TD_TOWERS.pylon.detect, "pylon detects camo");
  assert.ok(TD_TOWERS.sniper.pierce && TD_TOWERS.sniper.defaultTarget === "strong", "sniper pierces + targets strong");
  assert.equal(TD_TOWERS.arrow.splash, 0, "arrow is single-target");
});

test("upgrade cost rises then null at max; sell refunds a fraction", () => {
  assert.ok((tdUpgradeCost("arrow", 1) ?? 0) > 0);
  assert.ok((tdUpgradeCost("arrow", 2) ?? 0) > (tdUpgradeCost("arrow", 1) ?? 0));
  assert.equal(tdUpgradeCost("arrow", TD_MAX_TIER), null);
  assert.ok(tdSellValue("cannon", 3) > tdSellValue("cannon", 1));
  assert.ok(tdSellValue("cannon", 1) < TD_TOWERS.cannon.cost);
});

test("towerStats scale up with tier and clamp", () => {
  const t1 = towerStats("cannon", 1), t3 = towerStats("cannon", 3);
  assert.ok(t3.damage > t1.damage && t3.range > t1.range && t3.fireRate > t1.fireRate);
  assert.deepEqual(towerStats("cannon", 99), towerStats("cannon", TD_MAX_TIER));
});

const C = (id: number, x: number, dist: number, hp: number, targetable = true): TdTargetable =>
  ({ id, pos: { x, z: 0 }, dist, hp, alive: true, targetable });

test("pickTarget honors each target priority", () => {
  const creeps = [C(1, 1, 5, 100), C(2, 2, 30, 50), C(3, 3, 20, 200)];
  assert.equal(pickTarget(0, 0, 10, creeps, "first"), 2, "first = furthest along");
  assert.equal(pickTarget(0, 0, 10, creeps, "last"), 1, "last = least far");
  assert.equal(pickTarget(0, 0, 10, creeps, "strong"), 3, "strong = most HP");
  assert.equal(pickTarget(0, 0, 10, creeps, "close"), 1, "close = nearest to tower");
  assert.equal(pickTarget(0, 0, 10, []), -1);
});

test("pickTarget ignores out-of-range, dead, and un-revealed camo creeps", () => {
  assert.equal(pickTarget(1000, 1000, 5, [C(1, 1, 5, 100)]), -1, "out of range");
  const dead = { ...C(1, 1, 5, 100), alive: false };
  assert.equal(pickTarget(0, 0, 10, [dead]), -1, "dead");
  const camo = C(2, 1, 5, 100, false); // un-revealed camo
  assert.equal(pickTarget(0, 0, 10, [camo]), -1, "un-targetable camo");
});

test("target modes list is the standard four", () => {
  assert.deepEqual([...TD_TARGET_MODES].sort(), ["close", "first", "last", "strong"]);
});
