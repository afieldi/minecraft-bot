// Offline tests for learned reflex rules: the starter rules reproduce the old
// hard-coded survival checks, the brain's rules are validated, and broken
// rules switch themselves off.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Memory } from '../src/memory.js';
import { RuleBook } from '../src/rules.js';
import { Arbiter } from '../src/arbiter.js';
import { evaluate } from '../src/skills.js';

const dir = '/tmp/claude-0/mcrulestest';
fs.rmSync(dir, { recursive: true, force: true });

const base = {
  health: 20, food: 20, air: 20, inWater: false, y: 64, timeOfDay: 1000, time: 'day', raining: false,
  hurtSecondsAgo: 9999, hostiles: [], players: [], attackers: [], weapon: null, hasShield: false,
  armorPieces: 0, foodCount: 0, canEat: false, buildBlocks: 0, goal: null,
};
const st = (o) => ({ ...base, ...o });
const skeleton = { name: 'skeleton', distance: 10, ranged: true, dy: 0 };
const zombie = { name: 'zombie', distance: 4, ranged: false, dy: 0 };

// New list operators.
assert.equal(evaluate({ any: ['$hostiles', '$it.ranged'] }, st({ hostiles: [zombie, skeleton] })), true);
assert.equal(evaluate({ count: ['$hostiles', { lt: ['$it.distance', 5] }] }, st({ hostiles: [zombie, skeleton] })), 1);
assert.deepEqual(evaluate({ where: ['$hostiles', { eq: ['$it.name', 'zombie'] }] }, st({ hostiles: [zombie, skeleton] })), [zombie]);
assert.equal(evaluate({ all: [[], false] }, base), true);
assert.equal(evaluate({ in: ['dusk', ['dusk', 'night']] }, base), true);

const memory = new Memory(dir, 'T');
const logs = [];
const book = new RuleBook(memory, { log: (m) => logs.push(m) });
assert.deepEqual(book.list().map((r) => r.id).sort(), ['archer_engage', 'archer_retreat', 'low_health', 'surface']);

const arb = new Arbiter();
arb.addProvider(() => book.behaviours());
const pick = (o) => arb.choose(st(o))?.source ?? null;

assert.equal(pick({}), null, 'nothing fires when all is well');
assert.equal(pick({ inWater: true, air: 10 }), 'rule:surface');
assert.equal(pick({ inWater: true, air: 18 }), null);
assert.equal(pick({ hurtSecondsAgo: 0.5, hostiles: [skeleton], weapon: 'stone_sword', hasShield: true }), 'rule:archer_engage');
assert.equal(pick({ hurtSecondsAgo: 0.5, hostiles: [skeleton], weapon: null }), 'rule:archer_retreat');
assert.equal(pick({ hurtSecondsAgo: 5, hostiles: [skeleton], weapon: null }), null, 'not being shot');
const low = arb.choose(st({ health: 6, hostiles: [zombie] }));
assert.equal(low.source, 'rule:low_health');
assert.equal(low.holdSeconds, 30);
assert.match(low.wake, /health is low/);
assert.equal(pick({ health: 6, hostiles: [zombie] }), null, 'low_health is cooling down');
assert.equal(pick({ inWater: true, air: 5, health: 6, hostiles: [zombie] }), 'rule:surface', 'priority order');

// Saving: validated, tested on a live state, versioned.
assert.throws(() => book.save({ id: 'Bad Id', when: true, do: 'flee' }), /lowercase/);
assert.throws(() => book.save({ id: 'x1', when: true, do: 'dance' }), /must be one of/);
assert.throws(() => book.save({ id: 'x1', when: { offset: ['$nothing', 0, 0, 0] }, do: 'flee' }, base), /current situation/);
const r = book.save({ id: 'flee_creeper', description: 'run', when: { any: ['$hostiles', { and: [{ eq: ['$it.name', 'creeper'] }, { lt: ['$it.distance', 5] }] }] }, do: 'flee', priority: 95 }, base);
assert.equal(r.version, 1);
assert.equal(pick({ hostiles: [{ name: 'creeper', distance: 3 }] }), 'rule:flee_creeper');
assert.equal(book.save({ ...r, priority: 60 }, base).version, 2);
assert.equal(book.save({ ...book.get('surface'), priority: 99 }, base).author, 'starter, revised');

// A deleted starter stays deleted after a restart.
assert.ok(book.delete('archer_retreat'));
const again = new RuleBook(memory);
assert.ok(!again.get('archer_retreat'));
assert.ok(again.get('flee_creeper'));

// A rule that throws is skipped, and switched off after enough errors.
book.save({ id: 'broken', description: 'b', when: { offset: ['$hostiles.0', 0, 0, 0] }, do: 'flee', priority: 100 });
for (let i = 0; i < 25; i++) pick({ hostiles: [zombie] });
assert.equal(book.get('broken').enabled, false);
assert.ok(logs.some((l) => /broken disabled/.test(l)));
assert.match(book.summary(), /broken .*DISABLED/);

console.log('rules.test: all assertions passed');
