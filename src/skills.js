// General actions and a library of skills the brain writes for itself.
//
// The brain composes small actions (dig, place, use an item on a block, find
// blocks, open a chest...) into step lists. A step list that works can be
// saved as a named skill in data/<bot>/skills/ and rerun later in one call,
// by this instance or any future one.
//
// Skills are JSON data, not code: a small interpreter here walks the steps
// and can only call the actions listed in ACTIONS. That keeps whatever the
// brain writes from doing anything outside the game. Every action checks for
// cancellation and a deadline, and runs have a step budget, so a skill stops
// when the goal changes, a reflex takes over, or it runs too long.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Vec3 } from 'vec3';
import pathfinderPkg from 'mineflayer-pathfinder';
import { GOALS, REFLEXES, moveTo, placeAt, countItem, matchBlockIds, chestContents } from './actions.js';
import { inventorySummary } from './perception.js';

const { goals } = pathfinderPkg;
const NAME_RE = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_DEPTH = 3;
const MAX_STEPS = 5000;
const DEFAULT_TIMEOUT_S = 120;
const MAX_TIMEOUT_S = 1800;

// action name -> parameter names, in order. Args can be given as an object
// with these names or as an array in this order.
const ACTIONS = {
  position: [], health: [], food: [], timeOfDay: [], inventory: [],
  blockAt: ['pos'],
  findBlocks: ['name', 'maxDistance', 'count'],
  nearby: ['maxDistance'],
  moveTo: ['pos', 'range'],
  dig: ['pos'],
  place: ['item', 'pos'],
  useOn: ['item', 'pos'],
  plant: ['item', 'pos'],
  equip: ['item', 'slot'],
  craft: ['item', 'count'],
  attack: ['target'],
  eat: [],
  collectDrops: ['maxDistance'],
  chestItems: ['pos'],
  deposit: ['pos', 'item', 'count'],
  withdraw: ['pos', 'item', 'count'],
  goal: ['type', 'args'],
  skill: ['name', 'args'],
  say: ['message'],
  wait: ['seconds'],
};

export const SKILL_DOCS = `A skill (or a run_steps call) is a JSON list of steps. Values starting with "$" read variables: "$args.count", "$p.x", "$last" (result of the previous action).

Steps:
- {"do": "<action>", "args": {...}, "as": "var"}   call an action; its result goes in $var (and $last)
- {"set": "var", "value": <expr>}
- {"if": <cond>, "then": [steps], "else": [steps]}
- {"forEach": <list expr>, "as": "var", "steps": [steps]}
- {"repeat": <n>, "steps": [steps]}
- {"while": <cond>, "max": 100, "steps": [steps]}
- {"try": [steps], "catch": [steps]}   on failure the message is in $error and the skill carries on
- {"log": <expr>}, {"return": <expr>}, {"fail": <expr>}

Expressions: literals, "$refs", {"x": .., "y": .., "z": ..} objects with exprs inside, and operators:
{"offset": [pos, dx, dy, dz]}, {"add": [a, b]} (numbers, or joins two lists), {"sub": [a, b]}, {"len": list}, {"first": list}, {"inv": "item"} (count held),
{"filter": [list, "field.path", value]}, {"eq"|"ne"|"gt"|"gte"|"lt"|"lte": [a, b]}, {"not": c}, {"and": [..]}, {"or": [..]}

Actions (positions are {x,y,z}):
- position, health, food, timeOfDay (0-24000; night 13000-23000), inventory -> {item: count}
- blockAt {pos} -> {name, position, properties} (properties are block states, e.g. wheat age 0-7)
- findBlocks {name, maxDistance=32, count=20} -> positions nearest first; name can be partial ("log")
- nearby {maxDistance=16} -> [{name, type, username, position, distance}] incl. dropped items (type "dropped_item")
- moveTo {pos, range=1}; dig {pos}; place {item, pos}; equip {item, slot=hand}
- useOn {item, pos} right-click a block holding item (null = empty hand): till with a hoe, bonemeal, doors, levers
- plant {item, pos} put seeds/saplings on top of the soil block at pos
- craft {item, count}; attack {target}; eat; collectDrops {maxDistance=8}
- chestItems {pos}; deposit {pos, item, count}; withdraw {pos, item, count} (only your own or shared chests)
- goal {type, args} run a built-in goal; skill {name, args} run another saved skill
- say {message}; wait {seconds}

Example, harvest ripe wheat nearby and replant:
[{"do":"findBlocks","args":{"name":"wheat","maxDistance":24,"count":64},"as":"crops"},
 {"set":"done","value":0},
 {"forEach":"$crops","as":"p","steps":[
   {"do":"blockAt","args":{"pos":"$p"},"as":"b"},
   {"if":{"eq":["$b.properties.age",7]},"then":[
     {"try":[{"do":"dig","args":{"pos":"$p"}},
             {"do":"plant","args":{"item":"wheat_seeds","pos":{"offset":["$p",0,-1,0]}}},
             {"set":"done","value":{"add":["$done",1]}}],
      "catch":[{"log":"$error"}]}]}]},
 {"do":"collectDrops"},
 {"return":"$done"}]`;

export class SkillLibrary {
  constructor(memory) {
    this.dir = path.join(memory.dir, 'skills');
    fs.mkdirSync(this.dir, { recursive: true });
    this.indexFile = path.join(this.dir, 'index.json');
    this.index = readJson(this.indexFile, {});
    this.#seedStarters();
  }

  // Copy bundled starter skills in once; after that they belong to the bot.
  #seedStarters() {
    const starters = path.join(path.dirname(fileURLToPath(import.meta.url)), 'starter-skills');
    if (!fs.existsSync(starters)) return;
    for (const file of fs.readdirSync(starters).filter((f) => f.endsWith('.json'))) {
      const name = file.replace(/\.json$/, '');
      if (this.index[name]) continue;
      const skill = readJson(path.join(starters, file), null);
      if (skill) this.save(name, skill.description, skill.steps, 'starter');
    }
  }

  #persist() {
    fs.writeFileSync(this.indexFile, JSON.stringify(this.index, null, 2));
  }

  save(name, description, steps, author = 'brain') {
    if (!NAME_RE.test(name)) throw new Error('skill names are lowercase letters, digits and underscores, starting with a letter');
    validate(steps);
    const prev = this.index[name];
    this.index[name] = {
      description,
      author,
      version: (prev?.version ?? 0) + 1,
      savedAt: new Date().toISOString(),
      runs: prev?.runs ?? 0,
      successes: prev?.successes ?? 0,
      lastError: null,
    };
    fs.writeFileSync(path.join(this.dir, `${name}.json`), JSON.stringify({ description, steps }, null, 2));
    this.#persist();
    return this.index[name];
  }

  read(name) {
    if (!this.index[name]) throw new Error(`no skill called ${name}`);
    return readJson(path.join(this.dir, `${name}.json`), null)?.steps ?? [];
  }

  delete(name) {
    if (!this.index[name]) return false;
    delete this.index[name];
    fs.rmSync(path.join(this.dir, `${name}.json`), { force: true });
    this.#persist();
    return true;
  }

  record(name, ok, error) {
    const s = this.index[name];
    if (!s) return;
    s.runs++;
    if (ok) s.successes++;
    s.lastError = ok ? null : String(error).slice(0, 300);
    this.#persist();
  }

  summary() {
    return Object.entries(this.index)
      .map(([n, s]) => `- ${n}: ${s.description} (${s.successes}/${s.runs} runs ok${s.lastError ? `, last error: ${s.lastError}` : ''})`)
      .join('\n');
  }
}

function readJson(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return fallback;
  }
}

// Structural check before saving or running, so mistakes surface early.
export function validate(steps, where = 'steps') {
  if (!Array.isArray(steps)) throw new Error(`${where} must be a list`);
  steps.forEach((s, i) => {
    const at = `${where}[${i}]`;
    if (!s || typeof s !== 'object') throw new Error(`${at} must be an object`);
    if ('do' in s) {
      if (!ACTIONS[s.do]) throw new Error(`${at}: unknown action "${s.do}". Actions: ${Object.keys(ACTIONS).join(', ')}`);
    } else if ('if' in s) {
      validate(s.then ?? [], `${at}.then`);
      validate(s.else ?? [], `${at}.else`);
    } else if ('forEach' in s || 'repeat' in s || 'while' in s) {
      validate(s.steps, `${at}.steps`);
    } else if ('try' in s) {
      validate(s.try, `${at}.try`);
      validate(s.catch ?? [], `${at}.catch`);
    } else if (!('set' in s || 'log' in s || 'return' in s || 'fail' in s)) {
      throw new Error(`${at}: not a recognised step (${Object.keys(s).join(', ')})`);
    }
  });
}

// ---------------------------------------------------------------- interpreter
class Return {
  constructor(value) { this.value = value; }
}

function lookup(ref, vars) {
  const parts = ref.slice(1).split('.');
  let v = vars[parts[0]];
  for (const p of parts.slice(1)) v = v?.[p];
  return v;
}

function evaluate(e, vars) {
  if (typeof e === 'string') return e.startsWith('$') ? lookup(e, vars) : e;
  if (Array.isArray(e)) return e.map((x) => evaluate(x, vars));
  if (!e || typeof e !== 'object') return e;
  const keys = Object.keys(e);
  if (keys.length === 1) {
    const [op] = keys;
    const a = () => evaluate(e[op], vars);
    switch (op) {
      case 'offset': { const [p, dx, dy, dz] = a(); return { x: p.x + dx, y: p.y + dy, z: p.z + dz }; }
      case 'add': { const [x, y] = a(); return Array.isArray(x) && Array.isArray(y) ? [...x, ...y] : x + y; }
      case 'sub': { const [x, y] = a(); return x - y; }
      case 'len': return a()?.length ?? 0;
      case 'first': return a()?.[0] ?? null;
      case 'inv': return vars.__inv(a());
      case 'filter': {
        const [list, field, value] = a();
        return (list ?? []).filter((it) => lookup('$x.' + field, { x: it }) === value);
      }
      case 'eq': { const [x, y] = a(); return x === y; }
      case 'ne': { const [x, y] = a(); return x !== y; }
      case 'gt': { const [x, y] = a(); return x > y; }
      case 'gte': { const [x, y] = a(); return x >= y; }
      case 'lt': { const [x, y] = a(); return x < y; }
      case 'lte': { const [x, y] = a(); return x <= y; }
      case 'not': return !a();
      case 'and': return a().every(Boolean);
      case 'or': return a().some(Boolean);
    }
  }
  return Object.fromEntries(keys.map((k) => [k, evaluate(e[k], vars)]));
}

// Run a step list. Used for saved skills and one-off steps from the brain.
export async function runSteps(steps, args, ctx) {
  validate(steps);
  const deadline = Date.now() + Math.min(ctx.timeoutS ?? DEFAULT_TIMEOUT_S, MAX_TIMEOUT_S) * 1000;
  const logs = [];
  let budget = MAX_STEPS;
  const guard = () => {
    ctx.check();
    if (Date.now() > deadline) throw new Error('ran out of time');
  };
  const api = makeApi({ ...ctx, guard });
  const vars = { args: args ?? {}, last: null, __inv: (name) => countItem(ctx.bot, (i) => i.name === name) };

  const call = async (step) => {
    const params = ACTIONS[step.do];
    const raw = evaluate(step.args ?? {}, vars);
    const list = Array.isArray(raw) ? raw : params.map((p) => raw[p]);
    guard();
    // The deadline is otherwise only checked between steps, so a single action
    // that never settles (a move it can't finish) would hang the whole list.
    let timer;
    const overtime = new Promise((_, reject) => {
      timer = setTimeout(() => {
        try { ctx.bot.pathfinder?.setGoal(null); } catch {}
        reject(new Error('ran out of time'));
      }, Math.max(0, deadline - Date.now()));
    });
    try {
      return await Promise.race([api[step.do](...list), overtime]);
    } finally {
      clearTimeout(timer);
    }
  };

  const exec = async (list) => {
    for (const s of list) {
      if (--budget < 0) throw new Error(`step budget of ${MAX_STEPS} used up`);
      guard();
      if ('do' in s) {
        const out = await call(s);
        vars.last = out;
        if (s.as) vars[s.as] = out;
      } else if ('set' in s) {
        vars[s.set] = evaluate(s.value, vars);
      } else if ('if' in s) {
        await exec(evaluate(s.if, vars) ? s.then ?? [] : s.else ?? []);
      } else if ('forEach' in s) {
        for (const item of evaluate(s.forEach, vars) ?? []) {
          vars[s.as ?? 'item'] = item;
          await exec(s.steps);
        }
      } else if ('repeat' in s) {
        const n = evaluate(s.repeat, vars);
        for (let i = 0; i < n; i++) {
          vars.i = i;
          await exec(s.steps);
        }
      } else if ('while' in s) {
        for (let i = 0; i < (s.max ?? 100) && evaluate(s.while, vars); i++) await exec(s.steps);
      } else if ('try' in s) {
        try {
          await exec(s.try);
        } catch (err) {
          if (err instanceof Return) throw err;
          guard(); // a cancelled goal must not be swallowed
          vars.error = err.message;
          await exec(s.catch ?? []);
        }
      } else if ('log' in s) {
        logs.push(JSON.stringify(evaluate(s.log, vars)));
      } else if ('return' in s) {
        throw new Return(evaluate(s.return, vars));
      } else if ('fail' in s) {
        throw new Error(String(evaluate(s.fail, vars)));
      }
    }
  };

  let result = 'done';
  try {
    await exec(steps);
  } catch (err) {
    if (!(err instanceof Return)) {
      if (logs.length) err.message += `\nlog:\n${logs.slice(-20).join('\n')}`;
      throw err;
    }
    result = err.value;
  }
  const text = typeof result === 'string' ? result : JSON.stringify(result);
  return logs.length ? `${text}\nlog:\n${logs.slice(-20).join('\n')}` : text;
}

// ---------------------------------------------------------------- actions
const vec = (p) => {
  if (!p || [p.x, p.y, p.z].some((v) => typeof v !== 'number')) throw new Error('expected a position {x, y, z}');
  return new Vec3(Math.floor(p.x), Math.floor(p.y), Math.floor(p.z));
};
const plain = (v) => ({ x: Math.floor(v.x), y: Math.floor(v.y), z: Math.floor(v.z) });

function makeApi(ctx) {
  const { bot, memory, guard, library } = ctx;
  const sub = { ...ctx, check: guard, depth: (ctx.depth ?? 0) + 1 };

  const item = (name) => {
    const it = bot.inventory.items().find((i) => i.name === name);
    if (!it) throw new Error(`I have no ${name}`);
    return it;
  };
  const near = async (pos, range = 3) => {
    if (bot.entity.position.distanceTo(pos.offset(0.5, 0.5, 0.5)) > range + 1) {
      await moveTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), guard);
    }
  };
  const blockInfo = (pos) => {
    const b = bot.blockAt(pos);
    if (!b) return null;
    return { name: b.name, position: plain(b.position), properties: b.getProperties?.() ?? {} };
  };
  const withChest = async (p, fn) => {
    const pos = vec(p);
    const rec = memory.chestAt(pos);
    if (!rec || !(rec.owner === 'me' || rec.shared)) throw new Error(`the chest at ${pos} is not mine or shared with me`);
    await near(pos, 2);
    const container = await bot.openContainer(bot.blockAt(pos));
    try {
      const out = await fn(container);
      memory.updateChest(pos, { contents: chestContents(container) });
      return out;
    } finally {
      container.close();
    }
  };
  const goal = (type, args = {}) => {
    const fn = GOALS[type];
    if (!fn) throw new Error(`no built-in goal ${type}`);
    if (sub.depth > MAX_DEPTH) throw new Error('skills are nested too deeply');
    return fn(bot, { type, ...args }, sub);
  };

  return {
    position: () => plain(bot.entity.position),
    health: () => bot.health,
    food: () => bot.food,
    timeOfDay: () => bot.time.timeOfDay,
    inventory: () => inventorySummary(bot),
    blockAt: (p) => blockInfo(vec(p)),
    findBlocks: (name, maxDistance = 32, count = 20) =>
      bot.findBlocks({ matching: matchBlockIds(bot, name), maxDistance, count }).map(plain),
    nearby(maxDistance = 16) {
      const me = bot.entity.position;
      return Object.values(bot.entities)
        .filter((e) => e !== bot.entity && e.position.distanceTo(me) <= maxDistance)
        .map((e) => ({
          name: e.name === 'item' ? e.getDroppedItem?.()?.name ?? 'item' : e.name,
          type: e.name === 'item' ? 'dropped_item' : e.type,
          username: e.username,
          position: plain(e.position),
          distance: Math.round(e.position.distanceTo(me) * 10) / 10,
        }))
        .sort((a, b) => a.distance - b.distance);
    },
    async moveTo(p, range = 1) {
      const pos = vec(p);
      await moveTo(bot, new goals.GoalNear(pos.x, pos.y, pos.z, range), guard);
      return plain(bot.entity.position);
    },
    async dig(p) {
      const pos = vec(p);
      const block = bot.blockAt(pos);
      if (!block || block.name === 'air') return false;
      if (/chest|barrel|shulker_box/.test(block.name) && memory.chestAt(pos)?.owner !== 'me') {
        throw new Error('refusing to break a container that is not mine');
      }
      await near(pos);
      const tool = bot.pathfinder.bestHarvestTool(block);
      if (tool) await bot.equip(tool, 'hand');
      await bot.dig(block, true);
      guard();
      return true;
    },
    place: (name, p) => placeAt(bot, vec(p), name, guard),
    async useOn(name, p) {
      const pos = vec(p);
      await near(pos);
      if (name) await bot.equip(item(name), 'hand');
      else await bot.unequip('hand');
      await bot.lookAt(pos.offset(0.5, 0.5, 0.5));
      await bot.activateBlock(bot.blockAt(pos));
      guard();
      return blockInfo(pos);
    },
    async plant(name, p) {
      const pos = vec(p);
      const above = bot.blockAt(pos.offset(0, 1, 0));
      if (above && above.name !== 'air') return false;
      await near(pos);
      await bot.equip(item(name), 'hand');
      try {
        await bot.placeBlock(bot.blockAt(pos), new Vec3(0, 1, 0));
      } catch {
        await bot.activateBlock(bot.blockAt(pos), new Vec3(0, 1, 0));
      }
      guard();
      return bot.blockAt(pos.offset(0, 1, 0))?.name !== 'air';
    },
    async equip(name, slot = 'hand') {
      await bot.equip(item(name), slot);
      return true;
    },
    craft: (name, count = 1) => goal('craft', { item: name, count }),
    attack: (target) => goal('attack', { target }),
    async eat() {
      await REFLEXES.eat(bot);
      return true;
    },
    async collectDrops(maxDistance = 8) {
      const drops = Object.values(bot.entities).filter((e) => e.name === 'item' && e.position.distanceTo(bot.entity.position) <= maxDistance);
      for (const d of drops) {
        if (d.isValid) await moveTo(bot, new goals.GoalNear(d.position.x, d.position.y, d.position.z, 0), guard).catch(() => {});
      }
      return drops.length;
    },
    chestItems: (p) => withChest(p, async (c) => chestContents(c)),
    deposit: (p, name, count) => withChest(p, async (c) => {
      const n = Math.min(count ?? Infinity, countItem(bot, (i) => i.name === name));
      if (!n) throw new Error(`I have no ${name}`);
      await c.deposit(item(name).type, null, n);
      return n;
    }),
    withdraw: (p, name, count = 64) => withChest(p, async (c) => {
      const have = c.containerItems().filter((i) => i.name === name).reduce((n, i) => n + i.count, 0);
      const n = Math.min(count, have);
      if (n) await c.withdraw(bot.registry.itemsByName[name].id, null, n);
      return n;
    }),
    goal,
    skill(name, args = {}) {
      if (sub.depth > MAX_DEPTH) throw new Error('skills are nested too deeply');
      return runSteps(library.read(name), args, sub);
    },
    say(message) {
      bot.chat(String(message));
      return true;
    },
    async wait(seconds) {
      const end = Date.now() + seconds * 1000;
      while (Date.now() < end) {
        await new Promise((r) => setTimeout(r, Math.min(500, end - Date.now())));
        guard();
      }
      return true;
    },
  };
}

// Back the "skill" and "steps" goal types with the library.
export function registerSkillGoals(library) {
  GOALS.skill = async (bot, g, ctx) => {
    const steps = library.read(g.name);
    try {
      const out = await runSteps(steps, g.args, { ...ctx, bot, library, timeoutS: g.timeoutSeconds });
      library.record(g.name, true);
      return out;
    } catch (err) {
      if (!ctx.token?.cancelled) library.record(g.name, false, err.message);
      throw err;
    }
  };
  GOALS.steps = (bot, g, ctx) => runSteps(g.steps, g.args, { ...ctx, bot, library, timeoutS: g.timeoutSeconds });
}
