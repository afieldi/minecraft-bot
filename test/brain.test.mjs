// Offline test of the brain loop against a fake OpenRouter: the briefing is
// rebuilt on every wake, history is bounded, the brain can write rules and
// pin lessons, and the end of a generation consolidates and clears history.
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Memory } from '../src/memory.js';
import { Executor } from '../src/actions.js';
import { SkillLibrary, registerSkillGoals } from '../src/skills.js';
import { RuleBook } from '../src/rules.js';
import { Experience } from '../src/experience.js';
import { Brain } from '../src/brain.js';

const dir = '/tmp/claude-0/mcbraintest';
fs.rmSync(dir, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const bot = {
  username: 'T', health: 20, food: 20, oxygenLevel: 20, isRaining: false, time: { timeOfDay: 1000 },
  entity: { position: new Vec3(0, 64, 0), isInWater: false }, entities: {}, players: {}, game: { dimension: 'overworld' },
  registry: { blocksByName: {}, itemsByName: {}, foodsByName: {} }, inventory: { items: () => [], slots: [] },
  pathfinder: { goto: async () => {}, stop() {}, setGoal() {} }, pvp: { stop() {} }, collectBlock: {}, clearControlStates() {},
  chat() {},
};
const memory = new Memory(dir, 'T');
const experience = new Experience(memory);
const skills = new SkillLibrary(memory);
registerSkillGoals(skills);
const rules = new RuleBook(memory, { experience });
const executor = new Executor(bot, memory);
executor.onGoalEnded = (g, r) => experience.goalEnded(g, r);
const players = { summary: () => '', players: {}, nearby: () => [] };
const brain = new Brain({ bot, memory, players, executor, skills, rules, experience, log: () => {},
  config: { apiKey: 'k', baseUrl: 'http://fake', model: 'deepseek/x', effort: 'low', maxToolRounds: 4, historyWakes: 3 } });

// Fake OpenRouter: answers each request from a script of tool calls.
const requests = [];
let script = [];
globalThis.fetch = async (url, opts) => {
  const body = JSON.parse(opts.body);
  requests.push(body);
  const calls = script.shift() ?? [];
  const message = { content: '', tool_calls: calls.map(([name, args], i) => ({ id: `c${requests.length}_${i}`, type: 'function', function: { name, arguments: JSON.stringify(args) } })) };
  return new Response(JSON.stringify({ choices: [{ message, finish_reason: calls.length ? 'tool_calls' : 'stop' }], usage: { prompt_tokens: 100, completion_tokens: 10, cost: 0.001 } }));
};
const idle = async () => { while (brain.busy) await sleep(5); };

memory.remember('lesson', 'creepers explode when close');
script = [[
  ['save_rule', { id: 'flee_creeper', description: 'run from close creepers', when: { any: ['$hostiles', { eq: ['$it.name', 'creeper'] }] }, do: 'flee', priority: 95 }],
  ['update_lesson', { id: 1, pinned: true }],
  ['set_goal', { type: 'idle', args: { seconds: 1 }, lessons: [1] }],
], []];
brain.wake('first wake', { pos: 1 });
await idle();
assert.ok(rules.get('flee_creeper'), 'brain saved a rule');
assert.equal(memory.knowledge.items[0].pinned, true);
const first = requests[0].messages[1];
assert.equal(first.role, 'user');
assert.match(first.content[0].text, /# Your reflex rules/);
assert.match(first.content[0].text, /low_health/, 'starter rules in the briefing');
assert.ok(requests[0].usage?.include, 'asks for cost');
assert.equal(experience.run.brainCalls, 2);
assert.ok(Math.abs(experience.run.brainCostUsd - 0.002) < 1e-9);
// The second call of a wake still carries the whole wake (tool results included).
assert.equal(requests[1].messages.filter((m) => m.role === 'tool').length, 3);
// The briefing is rebuilt: the next wake sees the new rule and the pin.
script = [[]];
brain.wake('second wake', {});
await idle();
assert.match(requests[2].messages[1].content[0].text, /flee_creeper/);
assert.match(requests[2].messages[1].content[0].text, /#1 lesson, pinned/);
// History is bounded to the last 3 wake-ups.
for (let i = 0; i < 4; i++) { script = [[]]; brain.wake(`wake ${i}`, {}); await idle(); }
const last = requests.at(-1).messages;
assert.equal(last.filter((m) => m.role === 'user').length, 3);
assert.ok(!JSON.stringify(last).includes('first wake'));
assert.equal(brain.history.length, 3);

// Lessons cited by a goal share its score.
await sleep(1300);
assert.equal(experience.score('lesson:1')?.helped, 1);

// End of a generation: consolidation prompt, handoff, history cleared.
const gen = memory.state.generation;
script = [[['write_handoff', { notes: 'was idling; learned to flee creepers' }]], []];
brain.requestRotation('slept');
await idle();
assert.match(JSON.stringify(requests.at(-2).messages.at(-1)), /consolidate/);
assert.equal(memory.state.generation, gen + 1);
assert.equal(brain.history.length, 0);
assert.match(fs.readFileSync(`${dir}/T/handoffs.md`, 'utf8'), /flee creepers/);

// A failed trial run gives the body back to the goal it interrupted.
executor.setGoal({ type: 'idle', seconds: 30 });
script = [[['run_steps', { steps: [{ do: 'no_such_action' }] }]], []];
brain.wake('try something', {});
await idle();
assert.match(requests.at(-1).messages.at(-1).content, /resumed your previous goal: idle/);
assert.equal(executor.goal?.type, 'idle');

// A stopped brain (its bot disconnected) makes no more calls.
const before = requests.length;
script = [[['set_goal', { type: 'idle', args: { seconds: 1 } }]], []];
brain.stop();
brain.wake('after the bot left', {});
await idle();
assert.equal(requests.length, before);

console.log('brain.test: all assertions passed');
process.exit(0);
