// Offline tests for the chest and furnace goals, using a fake bot. The local
// flying-squid server doesn't implement furnaces or chest inventories fully.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Memory } from '../src/memory.js';
import { Executor } from '../src/actions.js';

const dir = '/tmp/claude-0/mcgoaltest';
fs.rmSync(dir, { recursive: true, force: true });

const ITEMS = ['dirt', 'cobblestone', 'iron_sword', 'bread', 'coal', 'oak_planks', 'iron_ore', 'iron_ingot', 'chest', 'diamond'];
const itemsByName = Object.fromEntries(ITEMS.map((n, i) => [n, { id: i + 1, name: n }]));
const blocksByName = { chest: { id: 100, name: 'chest' }, barrel: { id: 101, name: 'barrel' }, furnace: { id: 102, name: 'furnace' } };

function makeBot(inv) {
  let slots = Object.entries(inv).map(([name, count]) => ({ name, count, type: itemsByName[name].id }));
  const take = (type, n) => {
    const s = slots.find((x) => x.type === type);
    if (!s || s.count < n) throw new Error('not enough');
    s.count -= n;
    slots = slots.filter((x) => x.count > 0);
  };
  const add = (type, n) => {
    const name = ITEMS[type - 1];
    const s = slots.find((x) => x.type === type);
    if (s) s.count += n; else slots.push({ name, count: n, type });
  };
  const world = new Map(); // "x,y,z" -> block
  const chestStore = new Map(); // key -> [{name,count,type}]
  const bot = {
    entity: { position: new Vec3(0, 64, 0) },
    game: { dimension: 'overworld' },
    registry: { itemsByName, blocksByName, foodsByName: { bread: { foodPoints: 5 } } },
    inventory: { items: () => slots },
    pathfinder: { goto: async () => {}, stop() {}, setGoal() {} },
    pvp: { stop() {} },
    collectBlock: {},
    clearControlStates() {},
    blockAt: (p) => world.get(`${p.x},${p.y},${p.z}`) ?? { name: 'air', boundingBox: 'empty', position: p },
    findBlock: ({ matching }) => [...world.values()].find((b) => b.type === matching) ?? null,
    async openContainer(block) {
      const key = `${block.position.x},${block.position.y},${block.position.z}`;
      const store = chestStore.get(key) ?? [];
      chestStore.set(key, store);
      return {
        containerItems: () => store,
        async deposit(type, _m, n) { take(type, n); const s = store.find((x) => x.type === type); if (s) s.count += n; else store.push({ name: ITEMS[type - 1], count: n, type }); },
        async withdraw(type, _m, n) { const s = store.find((x) => x.type === type); s.count -= n; if (!s.count) store.splice(store.indexOf(s), 1); add(type, n); },
        close() {},
      };
    },
    furnaceLog: [],
    async openFurnace() {
      let input = null, fuel = null, output = null;
      const f = {
        fuelItem: () => fuel,
        inputItem: () => input,
        outputItem: () => output,
        async putFuel(type, _m, n) { take(type, n); fuel = { type, count: n }; bot.furnaceLog.push(['fuel', ITEMS[type - 1], n]); },
        async putInput(type, _m, n) { take(type, n); input = { type, count: n }; bot.furnaceLog.push(['input', ITEMS[type - 1], n]);
          setTimeout(() => { output = { name: 'iron_ingot', count: n, type: itemsByName.iron_ingot.id }; input = null; }, 50); },
        async takeOutput() { add(output.type, output.count); output = null; },
        close() {},
      };
      return f;
    },
    _world: world, _chests: chestStore,
  };
  return bot;
}

function run(executor, goal) {
  return new Promise((resolve) => {
    executor.onGoalFinished = resolve;
    executor.setGoal(goal);
  });
}
const inv = (bot) => Object.fromEntries(bot.inventory.items().map((i) => [i.name, i.count]));

// --- store into my own chest: keeps tools, food and named items
const memory = new Memory(dir, 'T');
const bot = makeBot({ dirt: 30, cobblestone: 12, iron_sword: 1, bread: 4, diamond: 2 });
const myChest = { name: 'chest', type: 100, boundingBox: 'block', position: new Vec3(3, 64, 0) };
bot._world.set('3,64,0', myChest);
memory.updateChest(myChest.position, { owner: 'me', shared: false });
const ex = new Executor(bot, memory);
let r = await run(ex, { type: 'store', keep: ['diamond'] });
assert.ok(r.ok, r.message);
assert.deepEqual(inv(bot), { iron_sword: 1, bread: 4, diamond: 2 });
assert.deepEqual(memory.chestAt(myChest.position).contents, { dirt: 30, cobblestone: 12 });

// --- retrieve uses the recorded contents
r = await run(ex, { type: 'retrieve', item: 'dirt', count: 5 });
assert.ok(r.ok, r.message);
assert.equal(inv(bot).dirt, 5);
assert.equal(memory.chestAt(myChest.position).contents.dirt, 25);

// --- someone else's chest is never used, even if it holds the item
const theirs = { name: 'chest', type: 100, boundingBox: 'block', position: new Vec3(-4, 64, 0) };
bot._world.set('-4,64,0', theirs);
bot._chests.set('-4,64,0', [{ name: 'diamond', count: 9, type: itemsByName.diamond.id }]);
memory.updateChest(theirs.position, { owner: 'Steve', shared: false, contents: { diamond: 9 } });
r = await run(ex, { type: 'retrieve', item: 'diamond', count: 3 });
assert.equal(r.ok, false);
assert.equal(inv(bot).diamond, 2);

// ...until Steve shares it
memory.updateChest(theirs.position, { shared: true });
r = await run(ex, { type: 'retrieve', item: 'diamond', count: 3 });
assert.ok(r.ok, r.message);
assert.equal(inv(bot).diamond, 5);
assert.match(memory.chestSummary(), /Steve's, shared with me\): 6 diamond/);

// --- smelting picks the best fuel and only as much as needed
const bot2 = makeBot({ iron_ore: 5, coal: 3, oak_planks: 10 });
bot2._world.set('1,64,1', { name: 'furnace', type: 102, boundingBox: 'block', position: new Vec3(1, 64, 1) });
const ex2 = new Executor(bot2, new Memory(dir, 'T2'));
r = await run(ex2, { type: 'smelt', input: 'iron_ore', count: 5 });
assert.ok(r.ok, r.message);
assert.deepEqual(bot2.furnaceLog, [['fuel', 'coal', 1], ['input', 'iron_ore', 5]]);
assert.deepEqual(inv(bot2), { coal: 2, oak_planks: 10, iron_ingot: 5 });

r = await run(ex2, { type: 'smelt', input: 'iron_ore', count: 1 });
assert.equal(r.ok, false);
assert.match(r.message, /no iron_ore/);

// --- collect won't go below y=20 without armor and food
const bot3 = makeBot({ bread: 1 });
bot3.registry.blocksByName.diamond_ore = { id: 103, name: 'diamond_ore' };
bot3.registry.blocks = { 103: { name: 'diamond_ore', drops: [] } };
bot3.inventory.slots = [];
bot3.findBlocks = () => [new Vec3(3, 12, 3)];
r = await run(new Executor(bot3, new Memory(dir, 'T3')), { type: 'collect', block: 'diamond_ore', count: 1 });
assert.equal(r.ok, false);
assert.match(r.message, /below y=20/);

console.log('goals.test: all assertions passed');
