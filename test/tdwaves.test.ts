import test from "node:test";
import assert from "node:assert/strict";
import {
  buildWave, waveSize, spawnInterval, TD_START_GOLD, TD_START_LIVES, TD_TOTAL_WAVES,
} from "../src/td/tdwaves.ts";

test("starting economy constants are sane", () => {
  assert.ok(TD_START_GOLD > 0);
  assert.ok(TD_START_LIVES > 0);
  assert.ok(TD_TOTAL_WAVES >= 5);
});

test("waves grow: more creeps and tougher than the wave before", () => {
  const w1 = buildWave(1);
  const w2 = buildWave(2);
  assert.ok(w1.length > 0);
  assert.ok(w2.length >= w1.length);
  const maxHp1 = Math.max(...w1.map((s) => s.hp));
  const maxHp2 = Math.max(...w2.map((s) => s.hp));
  assert.ok(maxHp2 > maxHp1);
  for (const s of w1) assert.ok(s.bounty > 0 && s.hp > 0 && s.speed > 0);
});

test("every 5th wave is a boss wave with one fat creep", () => {
  const boss = buildWave(5);
  const tanks = boss.filter((s) => s.kind === "boss");
  assert.equal(tanks.length, 1);
  // the boss has far more hp than a normal wave-5 grunt
  const grunt5 = Math.max(...buildWave(4).map((s) => s.hp));
  assert.ok(tanks[0].hp > grunt5 * 3);
});

test("spawnInterval shrinks as waves climb but stays positive", () => {
  assert.ok(spawnInterval(1) > spawnInterval(10));
  assert.ok(spawnInterval(50) >= 0.35);
});

test("waveSize matches buildWave length", () => {
  assert.equal(waveSize(3), buildWave(3).length);
});
