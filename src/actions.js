// Executes goals chosen by the brain and short reflex actions chosen by the
// decision layer. A reflex pauses the current goal and the goal restarts
// once the reflex finishes.
import pathfinderPkg from 'mineflayer-pathfinder';
import { Vec3 } from 'vec3';
import { hostilesNear, foodItems, bestWeapon } from './perception.js';

const { goals } = pathfinderPkg;

export const GOAL_TYPES = {
  idle: '{ seconds } - stand still (also good for waiting on someone)',
  goto: '{ x, y, z } or { location: "<saved place>" } or { player: "<name>" } - walk there',
  follow: '{ player, distance? } - keep following a player until the goal changes',
  explore: '{ distance? } - wander in a random direction to find new things',
  collect: '{ block, count } - mine/gather blocks, e.g. "oak_log", or "log" for any log',
  craft: '{ item, count? } - craft an item, placing a crafting table if needed',
  attack: '{ target } - attack a mob type (e.g. "zombie", "cow") or a player by name',
  give: '{ player, item, count? } - walk to a player and drop items for them',
  equip: '{ item } - hold an item, or wear it if it is armor',
  eat: '{} - eat something',
  sleep: '{} - find or place a bed and sleep (only works at night)',
  smelt: '{ input, count?, fuel? } - smelt or cook in a furnace, e.g. raw_iron, beef, sand; places a furnace if needed',
  store: '{ items?, keep? } - put items in one of your own chests (placing one if you carry it). items: names to store (default: everything except tools, weapons, armor, food and the names in keep)',
  retrieve: '{ item, count? } - take items back out of your own or shared chests',
  build: '{ blocks: [[dx, dy, dz, block], ...], origin? } - place blocks relative to origin {x,y,z} (default: where you stand). Max 200 blocks',
  skill: '{ name, args?, timeoutSeconds? } - run one of your saved skills',
  steps: '{ steps, args?, timeoutSeconds? } - run a one-off step list (run_steps does this and shows you the result)',
  shelter: '{ block? } - seal yourself in a small hut (5x5 with roof, needs 50 blocks) or a 1x1 pod (9 blocks). You dig out when the next goal moves you',
};

class Cancelled extends Error {}

export class Executor {
  constructor(bot, memory, log = () => {}) {
    this.bot = bot;
    this.memory = memory;
    this.log = log;
    this.goal = null;
    this.token = null;
    this.running = null;
    this.reflexRunning = false;
    this.lastResult = null;
    this.onGoalFinished = () => {};
    this.waiters = [];
  }

  // Resolves with the goal's result, or null if it is still running after ms.
  waitFor(goal, ms) {
    return new Promise((resolve) => {
      const w = { goal, resolve };
      this.waiters.push(w);
      setTimeout(() => {
        this.waiters = this.waiters.filter((x) => x !== w);
        resolve(null);
      }, ms);
    });
  }

  describe() {
    if (!this.goal) return 'none';
    const { type, ...args } = this.goal;
    return `${type} ${JSON.stringify(args)}`;
  }

  setGoal(goal) {
    this.#stopMotion();
    if (this.token) this.token.cancelled = true;
    this.goal = goal;
    this.memory.state.goal = goal;
    this.memory.saveState();
    if (!this.reflexRunning) this.#start();
  }

  #start() {
    if (!this.goal) return;
    const goal = this.goal;
    const token = { cancelled: false };
    this.token = token;
    this.running = this.#run(goal, token)
      .then((message) => ({ ok: true, message }))
      .catch((err) => (err instanceof Cancelled || token.cancelled ? null : { ok: false, message: err.message }))
      .then((result) => {
        if (!result || token.cancelled || this.goal !== goal) return;
        this.lastResult = { goal: this.describe(), ...result };
        this.memory.log(result.ok ? 'goal_done' : 'goal_failed', { goal, text: result.message });
        this.goal = null;
        this.memory.state.goal = null;
        this.memory.saveState();
        this.onGoalFinished(this.lastResult);
        for (const w of this.waiters.filter((w) => w.goal === goal)) w.resolve(this.lastResult);
        this.waiters = this.waiters.filter((w) => w.goal !== goal);
      });
  }

  #stopMotion() {
    const bot = this.bot;
    try { bot.pathfinder.stop(); } catch {}
    try { bot.pathfinder.setGoal(null); } catch {}
    try { bot.pvp.stop(); } catch {}
    try { bot.collectBlock.cancelTask?.(); } catch {}
    bot.clearControlStates();
  }

  // Run a reflex action, pausing the goal around it.
  async reflex(action, ctx = {}) {
    if (this.reflexRunning || action === 'continue_goal') return;
    this.reflexRunning = true;
    if (this.token) this.token.cancelled = true;
    this.#stopMotion();
    try {
      await REFLEXES[action]?.(this.bot, ctx);
    } catch (err) {
      this.log(`reflex ${action} failed: ${err.message}`);
    } finally {
      this.#stopMotion();
      this.reflexRunning = false;
      this.#start(); // resume the goal
    }
  }

  async #run(goal, token) {
    const fn = GOALS[goal.type];
    if (!fn) throw new Error(`unknown goal type "${goal.type}". Valid: ${Object.keys(GOALS).join(', ')}`);
    const check = () => { if (token.cancelled) throw new Cancelled(); };
    return fn(this.bot, goal, { check, memory: this.memory, token, depth: 0 });
  }
}

// ---------------------------------------------------------------- helpers
export async function moveTo(bot, goal, check) {
  try {
    await bot.pathfinder.goto(goal);
  } catch (err) {
    check();
    throw new Error(`could not reach destination: ${err.message}`);
  }
  check();
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function countItem(bot, pred) {
  return bot.inventory.items().filter(pred).reduce((n, i) => n + i.count, 0);
}

export function matchBlockIds(bot, name) {
  const exact = bot.registry.blocksByName[name];
  if (exact) return [exact.id];
  const ids = Object.values(bot.registry.blocksByName).filter((b) => b.name.endsWith('_' + name) || b.name.includes(name)).map((b) => b.id);
  if (!ids.length) throw new Error(`no block called "${name}"`);
  return ids;
}

function findPlayer(bot, name) {
  const ent = bot.players[name]?.entity;
  if (!ent) throw new Error(`player ${name} is not in view`);
  return ent;
}

async function placeFromInventory(bot, itemName, check) {
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) throw new Error(`no ${itemName} in inventory`);
  const base = bot.entity.position.floored();
  for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1], [1, 1], [-1, -1], [2, 0], [0, 2]]) {
    const ground = bot.blockAt(base.offset(dx, -1, dz));
    const spot = bot.blockAt(base.offset(dx, 0, dz));
    const above = bot.blockAt(base.offset(dx, 1, dz));
    if (ground?.boundingBox === 'block' && spot?.name === 'air' && above?.name === 'air') {
      await bot.equip(item, 'hand');
      await bot.placeBlock(ground, new Vec3(0, 1, 0));
      check();
      return bot.blockAt(spot.position);
    }
  }
  throw new Error(`no free spot to place ${itemName}`);
}

const KEEP_DEFAULT = /(_sword|_pickaxe|_axe|_shovel|_hoe|_helmet|_chestplate|_leggings|_boots|shield|bow|crossbow|arrow|torch|_bed)$/;
// Only blocks the pathfinder is allowed to dig, so the bot can get out of its own shelter.
const BUILD_BLOCKS = ['cobblestone', 'cobbled_deepslate', 'dirt', 'stone', 'andesite', 'diorite', 'granite', 'netherrack', 'sandstone'];
const FUEL_VALUE = { coal: 8, charcoal: 8, coal_block: 80, blaze_rod: 12, lava_bucket: 100 };
const fuelValue = (name) => FUEL_VALUE[name] ?? (/_planks$/.test(name) || /_log$/.test(name) || /_wood$/.test(name) ? 1.5 : /stick$/.test(name) ? 0.5 : 0);

const isSolid = (b) => b && b.boundingBox === 'block';
const isAirLike = (b) => b && (b.name === 'air' || b.name === 'cave_air' || b.name === 'water' || b.boundingBox === 'empty');

// Place one block at an absolute position, walking within reach first.
export async function placeAt(bot, pos, itemName, check) {
  const current = bot.blockAt(pos);
  if (!current) throw new Error('target is not loaded');
  if (!isAirLike(current)) return false; // already filled
  // Can't place where our own body is (including while falling into a hole).
  const me = bot.entity.position;
  if (Math.abs(me.x - (pos.x + 0.5)) < 0.8 && Math.abs(me.z - (pos.z + 0.5)) < 0.8 && me.y < pos.y + 1 && me.y + 1.8 > pos.y) {
    throw new Error(`I'm standing in ${pos}; move away before placing there`);
  }
  let ref = null;
  let face = null;
  for (const d of [[0, -1, 0], [1, 0, 0], [-1, 0, 0], [0, 0, 1], [0, 0, -1], [0, 1, 0]]) {
    const b = bot.blockAt(pos.offset(...d));
    if (isSolid(b)) { ref = b; face = new Vec3(-d[0], -d[1], -d[2]); break; }
  }
  if (!ref) throw new Error(`nothing to attach to at ${pos}`);
  if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > 4.2) {
    await moveTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, 3), check);
  }
  const item = bot.inventory.items().find((i) => i.name === itemName);
  if (!item) throw new Error(`ran out of ${itemName}`);
  await bot.equip(item, 'hand');
  await bot.placeBlock(ref, face);
  check();
  return true;
}

function pickBuildBlock(bot, wanted) {
  const items = bot.inventory.items();
  if (wanted) return items.some((i) => i.name === wanted) ? wanted : null;
  let best = null;
  for (const name of BUILD_BLOCKS) {
    const n = countItem(bot, (i) => i.name === name);
    if (n && (!best || n > best.n)) best = { name, n };
  }
  return best?.name ?? null;
}

async function buildBlueprint(bot, origin, blocks, check, fallbackBlock) {
  let todo = blocks
    .map(([dx, dy, dz, block]) => ({ pos: origin.offset(dx, dy, dz), block: block ?? fallbackBlock }))
    .sort((a, b) => a.pos.y - b.pos.y || a.pos.distanceTo(bot.entity.position) - b.pos.distanceTo(bot.entity.position));
  let placed = 0;
  let failures = [];
  // Some blocks (like a roof's middle) only have something to attach to once
  // their neighbours exist, so keep making passes while progress is made.
  for (let pass = 0; pass < 4 && todo.length; pass++) {
    const retry = [];
    failures = [];
    let progress = 0;
    for (const t of todo) {
      try {
        if (await placeAt(bot, t.pos, t.block, check)) { placed++; progress++; }
      } catch (err) {
        check();
        if (/ran out/.test(err.message)) return { placed, failures: [err.message] };
        failures.push(err.message);
        retry.push(t);
      }
    }
    todo = retry;
    if (!progress) break;
  }
  return { placed, failures };
}

async function findOrPlace(bot, blockName, check) {
  const id = bot.registry.blocksByName[blockName].id;
  let block = bot.findBlock({ matching: id, maxDistance: 32 });
  let placedByMe = false;
  if (!block && countItem(bot, (i) => i.name === blockName)) {
    block = await placeFromInventory(bot, blockName, check);
    placedByMe = true;
  }
  if (!block) return { block: null };
  await moveTo(bot, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), check);
  return { block, placedByMe };
}

export function chestContents(container) {
  const out = {};
  for (const it of container.containerItems()) out[it.name] = (out[it.name] ?? 0) + it.count;
  return out;
}

// ---------------------------------------------------------------- goals
export const GOALS = {
  async idle(bot, { seconds = 10 }, { check }) {
    const end = Date.now() + seconds * 1000;
    while (Date.now() < end) { await sleep(500); check(); }
    return `waited ${seconds}s`;
  },

  async goto(bot, g, { check, memory }) {
    let target;
    if (g.location) {
      const loc = memory.locations[g.location];
      if (!loc) throw new Error(`no saved place named "${g.location}"`);
      target = loc;
    } else if (g.player) {
      const p = findPlayer(bot, g.player).position;
      await moveTo(bot, new goals.GoalNear(p.x, p.y, p.z, 2), check);
      return `reached ${g.player}`;
    } else {
      target = g;
    }
    if ([target.x, target.y, target.z].some((v) => typeof v !== 'number')) throw new Error('goto needs x, y, z');
    await moveTo(bot, new goals.GoalNear(target.x, target.y, target.z, 1), check);
    return `arrived at ${target.x} ${target.y} ${target.z}`;
  },

  async follow(bot, { player, distance = 3 }, { check }) {
    const ent = findPlayer(bot, player);
    bot.pathfinder.setGoal(new goals.GoalFollow(ent, distance), true);
    while (true) {
      await sleep(1000);
      check();
      if (!bot.players[player]?.entity) throw new Error(`lost sight of ${player}`);
    }
  },

  async explore(bot, { distance = 48 }, { check }) {
    const angle = Math.random() * Math.PI * 2;
    const p = bot.entity.position;
    const x = Math.round(p.x + Math.cos(angle) * distance);
    const z = Math.round(p.z + Math.sin(angle) * distance);
    await moveTo(bot, new goals.GoalXZ(x, z), check);
    return `explored to ${x} ${z}`;
  },

  async collect(bot, { block, count = 1 }, { check }) {
    const ids = matchBlockIds(bot, block);
    const dropNames = new Set();
    for (const id of ids) for (const d of bot.registry.blocks[id].drops ?? []) {
      const itemId = typeof d === 'number' ? d : d.drop?.id ?? d.drop;
      if (bot.registry.items[itemId]) dropNames.add(bot.registry.items[itemId].name);
    }
    const have = () => countItem(bot, (i) => dropNames.has(i.name) || i.name.includes(block));
    const start = have();
    for (let round = 0; round < 12 && have() - start < count; round++) {
      const positions = bot.findBlocks({ matching: ids, maxDistance: 64, count: Math.min(4, count - (have() - start)) });
      if (!positions.length) {
        if (round === 0) throw new Error(`no ${block} within 64 blocks; try exploring first`);
        break;
      }
      const targets = positions.map((p) => bot.blockAt(p)).filter(Boolean);
      try {
        await bot.collectBlock.collect(targets, { ignoreNoPath: true });
      } catch (err) {
        check();
        if (round > 3) throw err;
      }
      check();
    }
    const got = have() - start;
    if (got <= 0) throw new Error(`could not collect any ${block}`);
    return `collected ${got} ${block}`;
  },

  async craft(bot, { item, count = 1 }, { check }) {
    const target = bot.registry.itemsByName[item];
    if (!target) throw new Error(`no item called "${item}"`);
    const tableId = bot.registry.blocksByName.crafting_table.id;
    let recipe = bot.recipesFor(target.id, null, 1, null)[0];
    let table = null;
    if (!recipe) {
      table = bot.findBlock({ matching: tableId, maxDistance: 32 });
      if (!table && countItem(bot, (i) => i.name === 'crafting_table')) table = await placeFromInventory(bot, 'crafting_table', check);
      if (!table) {
        const anyTableRecipe = bot.recipesAll(target.id, null, true).length;
        throw new Error(anyTableRecipe ? `${item} needs a crafting table and I don't have one` : `missing ingredients for ${item}`);
      }
      await moveTo(bot, new goals.GoalNear(table.position.x, table.position.y, table.position.z, 2), check);
      recipe = bot.recipesFor(target.id, null, 1, table)[0];
    }
    if (!recipe) throw new Error(`missing ingredients for ${item}`);
    const times = Math.max(1, Math.ceil(count / recipe.result.count));
    await bot.craft(recipe, times, table ?? undefined);
    return `crafted ${times * recipe.result.count} ${item}`;
  },

  async attack(bot, { target }, { check }) {
    const ent = bot.players[target]?.entity ?? bot.nearestEntity((e) => e.name === target && e !== bot.entity);
    if (!ent) throw new Error(`no ${target} nearby`);
    const weapon = bestWeapon(bot);
    if (weapon) await bot.equip(weapon, 'hand');
    bot.pvp.attack(ent);
    const end = Date.now() + 45000;
    while (ent.isValid && Date.now() < end) { await sleep(500); check(); }
    bot.pvp.stop();
    return ent.isValid ? `gave up attacking ${target}` : `defeated ${target}`;
  },

  async give(bot, { player, item, count }, { check }) {
    const ent = findPlayer(bot, player);
    await moveTo(bot, new goals.GoalNear(ent.position.x, ent.position.y, ent.position.z, 2), check);
    const stack = bot.inventory.items().find((i) => i.name === item);
    if (!stack) throw new Error(`I have no ${item}`);
    await bot.lookAt(ent.position.offset(0, 1.6, 0));
    const n = Math.min(count ?? stack.count, countItem(bot, (i) => i.name === item));
    await bot.toss(stack.type, null, n);
    return `gave ${n} ${item} to ${player}`;
  },

  async equip(bot, { item }) {
    const stack = bot.inventory.items().find((i) => i.name === item);
    if (!stack) throw new Error(`I have no ${item}`);
    const dest = /helmet/.test(item) ? 'head' : /chestplate/.test(item) ? 'torso' : /leggings/.test(item) ? 'legs' : /boots/.test(item) ? 'feet' : 'hand';
    await bot.equip(stack, dest);
    return `equipped ${item}`;
  },

  async eat(bot) {
    await REFLEXES.eat(bot);
    return 'ate';
  },

  async sleep(bot, _g, { check, memory }) {
    let bed = bot.findBlock({ matching: (b) => bot.isABed(b), maxDistance: 48 });
    if (!bed) {
      const bedItem = bot.inventory.items().find((i) => i.name.endsWith('_bed'));
      if (!bedItem) throw new Error('no bed nearby and none in inventory');
      bed = await placeFromInventory(bot, bedItem.name, check);
    }
    await moveTo(bot, new goals.GoalNear(bed.position.x, bed.position.y, bed.position.z, 2), check);
    await bot.sleep(bed);
    memory.saveLocation('bed', bed.position, bot.game.dimension, 'last bed I slept in');
    while (bot.isSleeping) { await sleep(1000); check(); }
    return 'slept through the night';
  },

  async smelt(bot, { input, count = 1, fuel }, { check }) {
    const have = countItem(bot, (i) => i.name === input);
    if (!have) throw new Error(`I have no ${input}`);
    count = Math.min(count, have);
    const fuels = bot.inventory.items()
      .filter((i) => i.name !== input && (fuel ? i.name === fuel : fuelValue(i.name) > 0))
      .sort((a, b) => fuelValue(b.name) - fuelValue(a.name));
    if (!fuels.length) throw new Error(fuel ? `I have no ${fuel}` : 'no fuel (coal, charcoal, planks or logs)');
    const { block } = await findOrPlace(bot, 'furnace', check);
    if (!block) throw new Error('no furnace nearby and none in inventory; craft one from 8 cobblestone');
    const furnace = await bot.openFurnace(block);
    try {
      const fuelItem = fuels[0];
      const fuelNeeded = Math.min(fuelItem.count, Math.ceil(count / fuelValue(fuelItem.name)));
      if (!furnace.fuelItem()) await furnace.putFuel(fuelItem.type, null, fuelNeeded);
      await furnace.putInput(bot.registry.itemsByName[input].id, null, count);
      let collected = 0;
      const deadline = Date.now() + count * 11000 + 15000;
      while (collected < count && Date.now() < deadline) {
        await sleep(1000);
        check();
        const out = furnace.outputItem();
        if (out) {
          collected += out.count;
          await furnace.takeOutput();
        }
        if (!furnace.inputItem() && !furnace.outputItem()) break;
      }
      const out = furnace.outputItem();
      if (out) { collected += out.count; await furnace.takeOutput(); }
      if (!collected) throw new Error('furnace produced nothing (wrong input or ran out of fuel)');
      return `smelted ${collected} ${input}`;
    } finally {
      furnace.close();
    }
  },

  async store(bot, { items, keep = [] }, { check, memory }) {
    const ids = bot.registry.blocksByName;
    const chestIds = [ids.chest?.id, ids.barrel?.id].filter((v) => v !== undefined);
    // Prefer a chest we own; never fill someone else's.
    let block = null;
    for (const c of memory.usableChests().filter((c) => c.owner === 'me')) {
      const b = bot.blockAt(new Vec3(c.x, c.y, c.z));
      if (b && chestIds.includes(b.type) && b.position.distanceTo(bot.entity.position) < 48) { block = b; break; }
    }
    if (!block) {
      if (!countItem(bot, (i) => i.name === 'chest')) throw new Error('none of my chests are nearby and I carry no chest; craft one from 8 planks');
      block = await placeFromInventory(bot, 'chest', check);
      memory.updateChest(block.position, { owner: 'me', shared: false });
    }
    await moveTo(bot, new goals.GoalNear(block.position.x, block.position.y, block.position.z, 2), check);
    const container = await bot.openContainer(block);
    try {
      const keepSet = new Set(keep);
      const foods = bot.registry.foodsByName ?? {};
      const toStore = bot.inventory.items().filter((i) =>
        items?.length ? items.includes(i.name) : !keepSet.has(i.name) && !KEEP_DEFAULT.test(i.name) && !foods[i.name] && i.name !== 'chest');
      const stored = {};
      for (const it of toStore) {
        try {
          await container.deposit(it.type, null, it.count);
          stored[it.name] = (stored[it.name] ?? 0) + it.count;
        } catch (err) {
          if (/full|space/i.test(err.message)) break;
          throw err;
        }
        check();
      }
      memory.updateChest(block.position, { contents: chestContents(container) });
      const list = Object.entries(stored).map(([n, k]) => `${k} ${n}`).join(', ');
      return list ? `stored ${list} at ${block.position}` : 'nothing to store';
    } finally {
      container.close();
    }
  },

  async retrieve(bot, { item, count = 64 }, { check, memory }) {
    const candidates = memory.usableChests()
      .filter((c) => !c.contents || c.contents[item])
      .sort((a, b) => (b.contents?.[item] ?? 0) - (a.contents?.[item] ?? 0));
    if (!candidates.length) throw new Error(`no chest of mine (or shared with me) is known to hold ${item}`);
    let got = 0;
    for (const c of candidates) {
      if (got >= count) break;
      const pos = new Vec3(c.x, c.y, c.z);
      await moveTo(bot, new goals.GoalNear(c.x, c.y, c.z, 2), check);
      const block = bot.blockAt(pos);
      if (!block || !/chest|barrel/.test(block.name)) { memory.updateChest(pos, { contents: {} }); continue; }
      const container = await bot.openContainer(block);
      try {
        const available = container.containerItems().filter((i) => i.name === item).reduce((n, i) => n + i.count, 0);
        const take = Math.min(available, count - got);
        if (take > 0) {
          await container.withdraw(bot.registry.itemsByName[item].id, null, take);
          got += take;
        }
        memory.updateChest(pos, { contents: chestContents(container) });
      } finally {
        container.close();
      }
      check();
    }
    if (!got) throw new Error(`found no ${item} in my chests`);
    return `took ${got} ${item}`;
  },

  async build(bot, { blocks, origin }, { check }) {
    if (!Array.isArray(blocks) || !blocks.length) throw new Error('build needs a non-empty blocks list');
    if (blocks.length > 200) throw new Error('too many blocks (max 200); split the build into parts');
    const base = origin ? new Vec3(Math.floor(origin.x), Math.floor(origin.y), Math.floor(origin.z)) : bot.entity.position.floored();
    const { placed, failures } = await buildBlueprint(bot, base, blocks, check, pickBuildBlock(bot));
    if (!placed && failures.length) throw new Error(`placed nothing: ${failures[0]}`);
    return `placed ${placed} of ${blocks.length} blocks at ${base}` + (failures.length ? ` (${failures.length} failed, e.g. ${failures[0]})` : '');
  },

  async shelter(bot, { block }, { check, memory }) {
    const material = pickBuildBlock(bot, block);
    if (!material) throw new Error(block ? `I have no ${block}` : 'no building blocks (dirt, cobblestone or planks)');
    const have = countItem(bot, (i) => i.name === material);
    const base = bot.entity.position.floored();
    const blocks = [];
    if (have >= 50) {
      // Sealed 5x5 hut: 3x3 inside, walls 2 high, flat roof. The pathfinder
      // digs a way out when the next goal needs one.
      for (let dy = 0; dy < 2; dy++) {
        for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) {
          if (Math.abs(dx) === 2 || Math.abs(dz) === 2) blocks.push([dx, dy, dz, material]);
        }
      }
      for (let dx = -2; dx <= 2; dx++) for (let dz = -2; dz <= 2; dz++) blocks.push([dx, 2, dz, material]);
    } else if (have >= 9) {
      // Emergency pod: walls at feet and head height, plus a roof.
      for (const [dx, dz] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) blocks.push([dx, 0, dz, material], [dx, 1, dz, material]);
      blocks.push([0, 2, 0, material]);
    } else {
      throw new Error(`need at least 9 ${material} for a shelter, have ${have}`);
    }
    const { placed, failures } = await buildBlueprint(bot, base, blocks, check, material);
    memory.saveLocation('shelter', base, bot.game.dimension, `${have >= 50 ? '5x5 hut' : '1x1 pod'} of ${material}`);
    return `built a ${have >= 50 ? 'hut' : 'pod'} with ${placed} ${material}` + (failures.length ? ` (${failures.length} spots failed)` : '');
  },
};

// ---------------------------------------------------------------- reflexes
export const REFLEXES = {
  async flee(bot, { threats = [] }) {
    const sources = [...hostilesNear(bot, 16).map((h) => h.entity), ...threats].filter(Boolean);
    if (!sources.length) return;
    const me = bot.entity.position;
    const away = sources.reduce((v, e) => v.plus(me.minus(e.position).normalize()), new Vec3(0, 0, 0));
    const dir = away.norm() > 0 ? away.normalize() : new Vec3(1, 0, 0);
    const dest = me.plus(dir.scaled(20));
    bot.setControlState('sprint', true);
    await Promise.race([bot.pathfinder.goto(new goals.GoalXZ(Math.round(dest.x), Math.round(dest.z))).catch(() => {}), sleep(8000)]);
  },

  async fight(bot) {
    const target = hostilesNear(bot, 10)[0]?.entity;
    if (!target) return;
    const weapon = bestWeapon(bot);
    if (weapon) await bot.equip(weapon, 'hand');
    bot.pvp.attack(target);
    const end = Date.now() + 15000;
    while (target.isValid && Date.now() < end && bot.health > 6) await sleep(300);
  },

  async defend(bot, { attacker }) {
    if (!attacker) return;
    const weapon = bestWeapon(bot);
    if (weapon) await bot.equip(weapon, 'hand');
    bot.pvp.attack(attacker);
    const end = Date.now() + 10000;
    while (attacker.isValid && Date.now() < end && bot.health > 6) await sleep(300);
  },

  async eat(bot) {
    const foods = foodItems(bot);
    if (!foods.length) throw new Error('no food');
    const registry = bot.registry.foodsByName;
    foods.sort((a, b) => (registry[b.name]?.foodPoints ?? 0) - (registry[a.name]?.foodPoints ?? 0));
    await bot.equip(foods[0], 'hand');
    await bot.consume();
  },

  async face_player(bot, { player }) {
    if (!player) return;
    await bot.lookAt(player.position.offset(0, 1.6, 0));
    await sleep(1500);
  },
};
