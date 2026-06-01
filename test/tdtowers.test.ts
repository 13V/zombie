import test from "node:test";
import assert from "node:assert/strict";
import {
  TD_TOWERS, TD_TOWER_IDS, TD_MAX_TIER, tdTower, tdUpgradeCost, tdSellValue, towerStats, pickTarget,
  type TdTargetable,
} from "../src/td/tdtowers.ts";

test("catalog has the three archetypes with positive stats", () => {
  assert.equal(TD_TOWER_IDS.length, 3);
  for (const id of TD_TOWER_IDS) {
    const d = tdTower(id);
    assert.ok(d.cost > 0 && d.range > 0 && d.fireRate > 0 && d.damage > 0);
  }
  assert.ok(TD_TOWERS.cannon.splash > 0, "cannon splashes");
  assert.ok(TD_TOWERS.frost.slow > 0, "frost slows");
  assert.equal(TD_TOWERS.arrow.splash, 0, "arrow is single-target");
});

test("upgrade cost rises then goes null at max tier", () => {
  assert.ok((tdUpgradeCost("arrow", 1) ?? 0) > 0);
  assert.ok((tdUpgradeCost("arrow", 2) ?? 0) > (tdUpgradeCost("arrow", 1) ?? 0));
  assert.equal(tdUpgradeCost("arrow", TD_MAX_TIER), null);
});

test("towerStats scale up with tier (damage/range/fireRate)", () => {
  const t1 = towerStats("cannon", 1);
  const t3 = towerStats("cannon", 3);
  assert.ok(t3.damage > t1.damage);
  assert.ok(t3.range > t1.range);
  assert.ok(t3.fireRate > t1.fireRate);
  // tier clamps
  assert.deepEqual(towerStats("cannon", 99), towerStats("cannon", TD_MAX_TIER));
});

test("sell value grows with investment and is a fraction of it", () => {
  const s1 = tdSellValue("cannon", 1);
  const s3 = tdSellValue("cannon", 3);
  assert.ok(s3 > s1);
  assert.ok(s1 < TD_TOWERS.cannon.cost, "sell refunds less than you paid");
});

test("pickTarget chooses the in-range creep furthest along the path", () => {
  const creeps: TdTargetable[] = [
    { id: 1, pos: { x: 0, z: 0 }, dist: 5, alive: true },
    { id: 2, pos: { x: 2, z: 0 }, dist: 30, alive: true },   // furthest along, in range
    { id: 3, pos: { x: 100, z: 0 }, dist: 99, alive: true }, // furthest but OUT of range
    { id: 4, pos: { x: 1, z: 0 }, dist: 40, alive: false },  // dead, ignored
  ];
  assert.equal(pickTarget(0, 0, 10, creeps), 2);
  assert.equal(pickTarget(0, 0, 1, []), -1);
  // a tower far from every creep has nothing in range
  assert.equal(pickTarget(1000, 1000, 5, creeps), -1);
});
