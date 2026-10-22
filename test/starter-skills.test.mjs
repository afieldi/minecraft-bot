// Offline tests for the hunt and shelter starter skills (formerly built-in
// goals), using a fake bot: they run on the general actions only.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Memory } from '../src/memory.js';
import { Executor } from '../src/actions.js';
import { SkillLibrary, registerSkillGoals } from '../src/skills.js';

const dir = '/tmp/claude-0/mcstarterskills';
fs.rmSync(dir, { recursive: true, force: true });

const ITEMS = ['dirt', 'cobblestone', 'beef', 'bread'];
const itemsByName = Object.fromEntries(ITEMS.map((n, i) => [n, { id: i + 1, name: n }]));
const world = new Map();
const key = (p) => `${p.x},${p.y},${p.z}`;
let slots = [];
const setInv = (inv) => { slots = Object.entries(inv).map(([name, count]) => ({ name, count, type: itemsByName[name].id })); };
const add = (name, n) => { const s = slots.find((x) => x.name === name); if (s) s.count += n; else slots.push({ name, count: n, type: itemsByName[name].id }); };
let held = null;
const placed = [];
const bot = {
  entity: { position: new Vec3(0.5, 64, 0.5) }, entities: {}, players: {}, game: { dimension: 'overworld' }, time: { timeOfDay: 1000 },
  health: 20, food: 20,
  registry: { blocksByName: {}, itemsByName, foodsByName: { beef: { foodPoints: 3 }, bread: { foodPoints: 5 } } },
  inventory: { items: () => slots.filter((s) => s.count > 0) },
  // Solid ground below y=64, air above, plus whatever was placed.
  blockAt: (p) => world.get(key(p)) ?? (p.y < 64 ? { name: 'stone', boundingBox: 'block', position: p } : { name: 'air', boundingBox: 'empty', position: p }),
  pathfinder: { goto: async () => {}, stop() {}, setGoal() {} }, pvp: { stop() {}, attack(e) { e.isValid = false; add('beef', 2); } },
  collectBlock: {}, clearControlStates() {}, setControlState() {}, async lookAt() {}, async waitForTicks() {},
  async equip(item) { held = item.name; },
  async placeBlock(ref, face) {
    const p = ref.position.plus(face);
    world.set(key(p), { name: held, boundingBox: 'block', position: p });
    slots.find((s) => s.name === held).count--;
    placed.push(key(p));
  },
  nearestEntity(pred) { return Object.values(this.entities).find((e) => e.isValid && pred(e)) ?? null; },
};

const memory = new Memory(dir, 'T');
const library = new SkillLibrary(memory);
registerSkillGoals(library);
assert.ok(library.index.hunt && library.index.shelter, 'hunt and shelter are starter skills');
const ex = new Executor(bot, memory);
const run = (goal) => new Promise((resolve) => { ex.onGoalFinished = resolve; ex.setGoal(goal); });

// Shelter with 12 dirt: a 1x1 pod (4 walls x 2 high, a roof support, the roof).
setInv({ dirt: 12 });
let r = await run({ type: 'skill', name: 'shelter' });
assert.ok(r.ok, r.message);
assert.equal(placed.length, 10);
assert.ok(placed.includes('0,66,0'), 'roof');
assert.ok(memory.locations.shelter);

// With 60 cobblestone it builds the 5x5 hut elsewhere.
world.clear(); placed.length = 0;
bot.entity.position = new Vec3(20.5, 64, 20.5);
setInv({ cobblestone: 60 });
r = await run({ type: 'skill', name: 'shelter' });
assert.ok(r.ok, r.message);
assert.equal(placed.length, 16 * 2 + 25);

// Not enough blocks: a clear failure.
setInv({ dirt: 3 });
r = await run({ type: 'skill', name: 'shelter' });
assert.equal(r.ok, false);
assert.match(r.message, /no building blocks/);

// Hunt: kills the cows in view until it has enough food.
setInv({});
bot.entities = {
  1: { name: 'cow', type: 'animal', position: new Vec3(25, 64, 20), isValid: true },
  2: { name: 'zombie', type: 'hostile', position: new Vec3(22, 64, 20), isValid: true },
  3: { name: 'cow', type: 'animal', position: new Vec3(28, 64, 20), isValid: true },
};
r = await run({ type: 'skill', name: 'hunt', args: { count: 4 } });
assert.ok(r.ok, r.message);
assert.match(r.message, /hunted for 4 food in 2 kills/);
assert.equal(bot.entities[2].isValid, true, 'left the zombie alone');

// Deleted starters stay deleted.
library.delete('hunt');
assert.ok(!new SkillLibrary(memory).index.hunt);

console.log('starter-skills.test: all assertions passed');
process.exit(0);
