// Offline tests for the arbiter and for suspending a goal around a reflex:
// the goal must come back afterwards, after its hold, and a step list must
// carry on from its last finished step instead of repeating side effects.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Memory } from '../src/memory.js';
import { Executor } from '../src/actions.js';
import { Arbiter } from '../src/arbiter.js';
import { SkillLibrary, registerSkillGoals } from '../src/skills.js';

const dir = '/tmp/claude-0/mcarbitertest';
fs.rmSync(dir, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Arbiter: priority order, cooldowns, a throwing behaviour is skipped.
{
  const arb = new Arbiter();
  let errors = 0;
  arb.addProvider(() => [
    { name: 'low', priority: 1, applies: () => ({ action: 'eat' }) },
    { name: 'broken', priority: 50, applies: () => { throw new Error('bad'); }, onError: () => errors++ },
    { name: 'high', priority: 10, cooldownSeconds: 60, applies: (s) => (s.danger ? { action: 'flee' } : null) },
  ]);
  assert.equal(arb.choose({ danger: true }).action, 'flee');
  assert.equal(arb.choose({ danger: true }).action, 'eat', 'high is cooling down');
  assert.equal(arb.choose({}).source, 'behaviour:low');
  assert.equal(errors, 3);
}

const said = [];
const bot = {
  entity: { position: new Vec3(0, 64, 0) }, entities: {}, game: { dimension: 'overworld' },
  registry: { blocksByName: {}, itemsByName: {}, foodsByName: {} },
  inventory: { items: () => [] },
  pathfinder: { goto: async () => {}, stop() {}, setGoal() {} }, pvp: { stop() {} }, collectBlock: {},
  clearControlStates() {},
  chat: (m) => said.push(m),
};
const memory = new Memory(dir, 'T');
registerSkillGoals(new SkillLibrary(memory));
const ex = new Executor(bot, memory);
const finished = [];
ex.onGoalFinished = (r) => finished.push(r);

// A step list interrupted mid-way resumes after the finished steps.
const goal = { type: 'steps', steps: [
  { do: 'say', args: { message: 'one' } },
  { set: 'n', value: 41 },
  { do: 'wait', args: { seconds: 0.4 } },
  { do: 'say', args: { message: { add: ['two ', { add: ['$n', 1] }] } } },
] };
ex.setGoal(goal);
await sleep(150);
assert.deepEqual(said, ['one']);
const r = await ex.reflex('noop', {}, { holdSeconds: 0.3 });
assert.equal(r.ok, true);
assert.equal(ex.goal, goal, 'goal kept through the reflex');
assert.ok(ex.suspended, 'held after the reflex');
assert.match(ex.describe(), /paused, resumes in/);
await sleep(150);
assert.deepEqual(said, ['one'], 'nothing runs during the hold');
await sleep(800);
assert.deepEqual(said, ['one', 'two 42'], 'resumed after the first steps, variables intact');
assert.equal(finished.length, 1);
assert.equal(finished[0].ok, true);

// A new goal from the brain cancels a hold.
ex.setGoal({ type: 'idle', seconds: 5 });
await ex.reflex('noop', {}, { holdSeconds: 30 });
assert.ok(ex.suspended);
ex.setGoal({ type: 'idle', seconds: 0.1 });
assert.ok(!ex.suspended, 'setGoal clears the hold');
await sleep(400);
assert.equal(finished.at(-1).ok, true);

console.log('arbiter.test: all assertions passed');
process.exit(0);
