// Offline tests for the experience recorder: decisions are judged by what
// happened next and scored against the source that made them.
import fs from 'node:fs';
import { EventEmitter } from 'node:events';
import assert from 'node:assert/strict';
import { Memory } from '../src/memory.js';
import { Experience, describeRecord } from '../src/experience.js';

const dir = '/tmp/claude-0/mcexptest';
fs.rmSync(dir, { recursive: true, force: true });
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const memory = new Memory(dir, 'T');
const exp = new Experience(memory, { windowMs: 100 });
const bot = new EventEmitter();
bot.health = 20;
exp.attach(bot);
const hurt = (to) => { bot.health = to; bot.emit('health'); };

// A reflex that was followed by real damage counts against its source.
exp.record({ source: 'rule:r1', action: 'flee', state: { health: 20, hostiles: [{ name: 'zombie', distance: 3 }] } });
hurt(14);
// One with no harm counts for it.
await sleep(150);
exp.record({ source: 'jev', action: 'fight' });
await sleep(150);
assert.deepEqual([exp.score('rule:r1').hurt, exp.score('rule:r1').helped], [1, 0]);
assert.deepEqual([exp.score('jev').helped, exp.score('jev').hurt], [1, 0]);

// "Carry on" choices are throttled per source.
assert.ok(exp.record({ source: 'jev', action: 'continue_goal' }));
assert.equal(exp.record({ source: 'jev', action: 'continue_goal' }), null);

// Goals are judged when they end, and cited lessons share the verdict.
const g1 = { type: 'collect', block: 'log', count: 4 };
exp.goalStarted(g1, { source: 'brain', cites: ['lesson:7'] });
exp.goalEnded(g1, { ok: true, message: 'collected 4 log' });
const g2 = { type: 'skill', name: 'tend_wheat' };
exp.goalStarted(g2, { source: 'skill:tend_wheat' });
exp.goalEnded(g2, { ok: false, message: 'no wheat' });
const g3 = { type: 'idle' };
exp.goalStarted(g3, { source: 'brain' });
exp.goalEnded(g3, null);
assert.equal(exp.score('lesson:7').helped, 1);
assert.equal(exp.score('skill:tend_wheat').hurt, 1);
assert.equal(exp.score('brain').uses, 2);
assert.equal(exp.recent().at(-1).verdict, 'neutral', 'a replaced goal is neutral');

// Death closes everything open and marks it.
const g4 = { type: 'collect', block: 'iron_ore' };
exp.goalStarted(g4, { source: 'brain' });
exp.record({ source: 'utility', action: 'eat' });
hurt(0);
bot.emit('death');
assert.equal(exp.run.deaths, 1);
assert.equal(exp.score('utility').deaths, 1);
assert.equal(exp.score('brain').deaths, 1);
exp.goalEnded(g4, { ok: false, message: 'late' }); // already closed; ignored
assert.equal(exp.score('brain').uses, 3);

const lines = fs.readFileSync(`${dir}/T/experience.jsonl`, 'utf8').trim().split('\n');
assert.equal(lines.length, exp.recent(60000).length);
assert.match(describeRecord(exp.recent().at(-1)), /DIED/);
assert.ok(JSON.parse(fs.readFileSync(`${dir}/T/scores.json`, 'utf8'))['lesson:7']);

console.log('experience.test: all assertions passed');
