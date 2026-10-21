// Runs the shelter, build, store and retrieve goals on a local server
// (flying-squid 1.16.5). Usage: MC_PORT=25599 MC_VERSION=1.16.5 node test/goals.sim.mjs
import fs from 'node:fs';
const MEM = '/tmp/claude-0/mcgoals';
fs.rmSync(MEM, { recursive: true, force: true });
Object.assign(process.env, { MC_USERNAME: 'Builder', MEMORY_DIR: MEM, BRAIN_DISABLED: '1' });
const { config } = await import('../src/config.js');
const { Agent } = await import('../src/agent.js');
const agent = new Agent(config);
agent.start();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(6000);
const bot = agent.bot;
for (const cmd of ['/gamemode survival Builder', '/give Builder dirt 64', '/give Builder chest 1', '/give Builder cobblestone 20', '/give Builder iron_sword 1']) { bot.chat(cmd); await sleep(400); }
await sleep(1500);
const inv = () => Object.fromEntries(bot.inventory.items().map((i) => [i.name, i.count]));
console.log('inventory', inv());

async function run(goal) {
  const result = await new Promise((resolve) => {
    agent.executor.onGoalFinished = resolve;
    agent.executor.setGoal(goal);
    setTimeout(() => resolve({ ok: false, message: 'timeout' }), 60000);
  });
  console.log(goal.type, '->', JSON.stringify(result), 'inv', JSON.stringify(inv()), 'pos', bot.entity.position.floored().toString());
  return result;
}

const start = bot.entity.position.floored();
const shelter = await run({ type: 'shelter' });
const around = [[2, 0, 0], [-2, 1, 0], [0, 0, 2], [0, 2, 0], [1, 2, 1], [0, 1, -2]].map(([x, y, z]) => bot.blockAt(start.offset(x, y, z))?.name);
console.log('shelter blocks sample', around);
await run({ type: 'explore', distance: 10 }); // must dig out of the hut
await run({ type: 'build', blocks: [[2, 0, 0, 'cobblestone'], [2, 1, 0, 'cobblestone'], [2, 2, 0, 'cobblestone'], [2, 0, 1, 'cobblestone']] });
await run({ type: 'steps', steps: [
  { do: 'position', as: 'me' },
  { set: 'p', value: { offset: ['$me', -2, -1, 0] } },
  { do: 'blockAt', args: { pos: '$p' }, as: 'before' },
  { do: 'dig', args: { pos: '$p' } },
  { do: 'collectDrops' },
  { do: 'blockAt', args: { pos: '$p' }, as: 'after' },
  { do: 'place', args: { item: 'dirt', pos: '$p' } },
  { do: 'blockAt', args: { pos: '$p' }, as: 'refilled' },
  { return: { before: '$before.name', dug: '$after.name', refilled: '$refilled.name' } },
] });
agent.skills.save('stand_on_pillar', 'Pillar up 2 blocks with dirt', [
  { do: 'position', as: 'p' },
  { do: 'place', args: { item: 'dirt', pos: { offset: ['$p', 2, 0, 0] } } },
  { do: 'place', args: { item: 'dirt', pos: { offset: ['$p', 2, 1, 0] } } },
  { return: 'built' },
]);
await run({ type: 'skill', name: 'stand_on_pillar' });
console.log('skill stats', JSON.stringify(agent.skills.index.stand_on_pillar));
agent.stop();
setTimeout(() => process.exit(0), 500);
