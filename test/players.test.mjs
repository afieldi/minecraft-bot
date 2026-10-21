// Offline test of the multiplayer path: player tracking, attack attribution,
// and the Jev decision request. Uses a fake bot, no server needed.
import { EventEmitter } from 'node:events';
import http from 'node:http';
import fs from 'node:fs';
import assert from 'node:assert/strict';
import { Vec3 } from 'vec3';
import { Memory } from '../src/memory.js';
import { PlayerTracker } from '../src/players.js';
import { Reflexes } from '../src/reflexes.js';
import { JevClient } from '../src/jev.js';
import { reflexState } from '../src/perception.js';

const dir = '/tmp/claude-0/mcunit';
fs.rmSync(dir, { recursive: true, force: true });

const bot = new EventEmitter();
Object.assign(bot, {
  username: 'TestBot', health: 20, food: 20, isRaining: false,
  time: { timeOfDay: 14000 }, entity: { position: new Vec3(0, 64, 0), isInWater: false },
  entities: {}, players: {}, inventory: { items: () => [{ name: 'bread', count: 3 }], slots: [] },
  registry: { foodsByName: { bread: { foodPoints: 5 } } },
});
const steveEnt = { type: 'player', username: 'Steve', position: new Vec3(2, 64, 0), heldItem: { name: 'iron_sword' }, isValid: true };
const zombie = { type: 'hostile', name: 'zombie', position: new Vec3(0, 64, 6), isValid: true };
bot.entities = { 1: steveEnt, 2: zombie };
bot.players = { TestBot: { entity: bot.entity }, Steve: { username: 'Steve', entity: steveEnt } };

const memory = new Memory(dir, 'TestBot');
const players = new PlayerTracker(bot, memory, ['Alex']);
const events = [];
players.onEvent((e) => events.push(e));

bot.emit('chat', 'Steve', 'hey TestBot, got any food?');
bot.emit('entitySwingArm', steveEnt);
bot.health = 16; bot.emit('health');
bot.emit('entityHurt', bot.entity); // same hit reported twice; must count once

assert.equal(events[0].type, 'chat');
assert.equal(events[0].addressed, true);
assert.equal(events.filter((e) => e.type === 'attacked').length, 1, 'one attack attributed');
assert.equal(players.players.Steve.attacksOnMe, 1);
assert.equal(players.players.Alex.relation, 'friend', 'trusted players start as friends');
assert.ok(players.recentlyAttackedBy('Steve'));

// Jev mock records the request and answers "defend".
let jevBody;
const srv = http.createServer((req, res) => {
  let d = ''; req.on('data', (c) => (d += c)); req.on('end', () => {
    jevBody = JSON.parse(d);
    res.end(JSON.stringify({ model: 'jev-mock', answers: {
      action: { type: 'choice', choice: 'defend', confidence: 0.8, probabilities: {} },
      escalate: { type: 'noul', noul: 0.92 },
      threat_Steve: { type: 'noul', noul: 0.88 },
    } }));
  });
});
await new Promise((r) => srv.listen(18081, r));
const jev = new JevClient({ apiKey: 'x', model: 'jev-latest', baseUrl: 'http://127.0.0.1:18081', timeoutMs: 2000 });
const reflexes = new Reflexes(bot, players, jev);
const executor = { describe: () => 'collect {"block":"log","count":5}' };

bot.food = 12;
const state = reflexState(bot, players, executor);
assert.deepEqual(state.hostiles, [{ name: 'zombie', distance: 6 }]);
assert.equal(state.players[0].name, 'Steve');
assert.equal(state.players[0].attackedMeRecently, true);

const d = await reflexes.decide(state);
assert.equal(d.source, 'jev');
assert.equal(d.action, 'defend');
assert.equal(d.threats.Steve, 0.88);
assert.ok(d.escalate > 0.7);
assert.equal(jevBody.model, 'jev-latest');
assert.equal(jevBody.questions.action.type, 'choice');
assert.deepEqual(Object.keys(jevBody.questions.action.criteria).sort(), ['continue_goal', 'defend', 'eat', 'face_player', 'fight', 'flee']);
assert.equal(jevBody.questions.threat_Steve.type, 'noul');

// Without a key, the utility scorer makes the same kind of call.
const offline = new Reflexes(bot, players, new JevClient({ apiKey: '', model: 'x', baseUrl: 'http://x', timeoutMs: 1 }));
const d2 = await offline.decide(state);
assert.equal(d2.source, 'utility');
assert.equal(d2.action, 'defend');
assert.ok(d2.threats.Steve > 0.7);

// Quiet tick: nothing nearby, no Jev call at all.
bot.entities = {}; bot.players = { TestBot: { entity: bot.entity } }; jevBody = null; bot.food = 20;
const d3 = await reflexes.decide(reflexState(bot, players, executor));
assert.equal(d3.action, 'continue_goal');
assert.equal(jevBody, null);

// Memory survives a restart.
players.setRelation('Steve', 'hostile', 'hit me while I was gathering wood');
const memory2 = new Memory(dir, 'TestBot');
assert.match(memory2.digest(new PlayerTracker(new EventEmitter(), memory2).summary()), /Steve \(hostile\).*hit me 1x/);

srv.close();
console.log('players.test: all assertions passed');
