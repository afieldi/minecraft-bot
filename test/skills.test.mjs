// Offline tests for the step interpreter, the skill library and the starter
// farming skill, using a fake bot.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Memory } from '../src/memory.js';
import { Executor } from '../src/actions.js';
import { SkillLibrary, registerSkillGoals, runSteps } from '../src/skills.js';

const dir = '/tmp/claude-0/mcskilltest';
fs.rmSync(dir, { recursive: true, force: true });

const BLOCKS = ['air', 'farmland', 'wheat', 'dirt', 'chest'];
const blocksByName = Object.fromEntries(BLOCKS.map((n, i) => [n, { id: i, name: n }]));
const ITEMS = ['wheat_seeds', 'wheat', 'iron_hoe', 'diamond'];
const itemsByName = Object.fromEntries(ITEMS.map((n, i) => [n, { id: 100 + i, name: n }]));

const world = new Map();
const key = (p) => `${p.x},${p.y},${p.z}`;
function setBlock(p, name, props = {}) {
  world.set(key(p), { name, type: blocksByName[name].id, position: new Vec3(p.x, p.y, p.z), boundingBox: name === 'air' || name === 'wheat' ? 'empty' : 'block', getProperties: () => props });
}
let slots = [{ name: 'wheat_seeds', count: 2, type: itemsByName.wheat_seeds.id }];
const give = (name, n) => { const s = slots.find((x) => x.name === name); if (s) s.count += n; else slots.push({ name, count: n, type: itemsByName[name].id }); };
let held = null;
const bot = {
  entity: { position: new Vec3(0, 64, 0) },
  entities: {}, game: { dimension: 'overworld' }, time: { timeOfDay: 1000 }, health: 20, food: 20,
  registry: { blocksByName, itemsByName, foodsByName: {} },
  inventory: { items: () => slots.filter((s) => s.count > 0) },
  blockAt: (p) => world.get(key(p)) ?? { name: 'air', type: 0, position: p, boundingBox: 'empty', getProperties: () => ({}) },
  findBlocks: ({ matching, count }) => [...world.values()].filter((b) => matching.includes(b.type)).slice(0, count).map((b) => b.position),
  pathfinder: { goto: async () => {}, stop() {}, setGoal() {}, bestHarvestTool: () => null },
  pvp: { stop() {} }, collectBlock: {}, clearControlStates() {},
  async equip(item) { held = item.name; },
  async dig(block) {
    if (block.name === 'wheat' && block.getProperties().age === 7) { give('wheat', 1); give('wheat_seeds', 2); }
    setBlock(block.position, 'air');
  },
  async placeBlock(ref, face) {
    const target = ref.position.plus(face);
    if (held === 'wheat_seeds' && ref.name === 'farmland') { setBlock(target, 'wheat', { age: 0 }); slots.find((s) => s.name === 'wheat_seeds').count--; return; }
    throw new Error('cannot place');
  },
  async activateBlock() {}, async lookAt() {}, async unequip() {},
};

setBlock({ x: 1, y: 63, z: 0 }, 'farmland');
setBlock({ x: 1, y: 64, z: 0 }, 'wheat', { age: 7 });
setBlock({ x: 2, y: 63, z: 0 }, 'farmland');
setBlock({ x: 2, y: 64, z: 0 }, 'wheat', { age: 3 });

const memory = new Memory(dir, 'T');
const library = new SkillLibrary(memory);
registerSkillGoals(library);
assert.ok(library.index.tend_wheat && library.index.start_wheat_field, 'starter skills seeded');

const ex = new Executor(bot, memory);
const run = (goal) => new Promise((resolve) => { ex.onGoalFinished = resolve; ex.setGoal(goal); });

// --- starter skill through the executor, with stats recorded
let r = await run({ type: 'skill', name: 'tend_wheat' });
assert.ok(r.ok, r.message);
assert.equal(r.message, 'harvested 1');
assert.equal(bot.blockAt({ x: 1, y: 64, z: 0 }).name, 'wheat', 'replanted');
assert.equal(bot.blockAt({ x: 1, y: 64, z: 0 }).getProperties().age, 0);
assert.equal(bot.blockAt({ x: 2, y: 64, z: 0 }).getProperties().age, 3, 'unripe wheat left alone');
assert.equal(library.index.tend_wheat.runs, 1);
assert.equal(library.index.tend_wheat.successes, 1);

// --- a skill the brain writes, saved and reused by a fresh library (new instance)
library.save('count_seeds', 'Return how many seeds I hold', [{ return: { inv: 'wheat_seeds' } }]);
const library2 = new SkillLibrary(new Memory(dir, 'T'));
assert.equal(await runSteps(library2.read('count_seeds'), {}, { bot, memory, check() {}, library: library2 }), '3');
assert.match(library2.summary(), /count_seeds: Return how many seeds I hold/);

// --- validation catches mistakes before anything runs
assert.throws(() => library.save('Bad Name', 'x', []), /lowercase/);
assert.throws(() => library.save('oops', 'x', [{ do: 'explode' }]), /unknown action "explode"/);
assert.throws(() => library.save('oops', 'x', [{ frobnicate: 1 }]), /not a recognised step/);

// --- try/catch keeps going and exposes the error
const ctx = { bot, memory, check() {}, library };
const out = await runSteps([
  { try: [{ do: 'withdraw', args: { pos: { x: 9, y: 64, z: 9 }, item: 'diamond' } }], catch: [{ log: '$error' }] },
  { return: 'carried on' },
], {}, ctx);
assert.match(out, /^carried on\nlog:\n.*not mine or shared/);

// --- args, loops and arithmetic
assert.equal(await runSteps([
  { set: 'n', value: 0 },
  { repeat: '$args.times', steps: [{ set: 'n', value: { add: ['$n', '$i'] } }] },
  { return: '$n' },
], { times: 4 }, ctx), '6');

// --- runaway loops are stopped by the deadline
await assert.rejects(runSteps([{ while: true, max: 1e9, steps: [{ do: 'wait', args: { seconds: 0.2 } }] }], {}, { ...ctx, timeoutS: 1 }), /ran out of time/);

// --- a goal change cancels a running skill
const long = { type: 'steps', steps: [{ do: 'wait', args: { seconds: 30 } }, { return: 'finished' }] };
ex.onGoalFinished = (res) => assert.ok(!res.goal.startsWith('steps'), 'cancelled goal must not report a result');
ex.setGoal(long);
await new Promise((r2) => setTimeout(r2, 300));
ex.setGoal({ type: 'idle', seconds: 0 });
assert.equal(await ex.waitFor(long, 800), null);

console.log('skills.test: all assertions passed');
process.exit(0);
