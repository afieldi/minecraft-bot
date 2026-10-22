// Does the bot learn? Runs the same scenarios several times on a local server,
// keeping the bot's learned data (rules, lessons, skills, scores) between runs
// and changing no code, then reports whether later generations do better.
//
// Setup, once: a server you can op on (e.g. the local Paper server), and an
// op'd "Director" account that sets scenes with commands:
//   ./cmd.sh "op Director"
// Then: node scripts/generations.mjs [--generations 3] [--only night_skeletons,flooded_pit]
//
// Learned data lives in GEN_MEMORY_DIR (default ./data-generations), apart
// from the bot's normal memory. Delete that folder to start from scratch.
// Each scenario has a time cap, so a full generation takes about 13 minutes
// and spends brain and Jev credit.
import fs from 'node:fs';
import path from 'node:path';
import mineflayer from 'mineflayer';

const argv = process.argv.slice(2);
const arg = (name, d) => {
  const i = argv.indexOf(`--${name}`);
  return i >= 0 ? argv[i + 1] : d;
};
const GENERATIONS = Number(arg('generations', 3));
const ONLY = arg('only', '')?.split(',').filter(Boolean);
const BOT = process.env.GEN_BOT_NAME || 'Learner';
const DIRECTOR = process.env.GEN_DIRECTOR_NAME || 'Director';
const MEM = path.resolve(process.env.GEN_MEMORY_DIR || './data-generations');
const BASE_X = Number(process.env.GEN_ORIGIN_X ?? 0);
const BASE_Z = Number(process.env.GEN_ORIGIN_Z ?? 0);

Object.assign(process.env, { MC_USERNAME: BOT, MEMORY_DIR: MEM });
const { config } = await import('../src/config.js');
const { Agent } = await import('../src/agent.js');

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const inv = (bot) => Object.fromEntries(bot.inventory.items().map((i) => [i.name, i.count]));

// Each scenario: where it happens (offset from the origin, so built
// structures don't overlap), commands that set the scene once the bot is
// there, how long it runs, and how to judge it. `@` stands for the bot.
const SCENARIOS = [
  {
    name: 'night_skeletons',
    offset: [0, 0],
    minutes: 3,
    setup: [
      'time set 13500', 'weather clear', 'give @ stone_sword', 'give @ bread 4', 'give @ dirt 16',
      'execute at @ run summon skeleton ~8 ~ ~', 'execute at @ run summon skeleton ~-8 ~ ~3', 'execute at @ run summon skeleton ~2 ~ ~-9',
    ],
    judge: ({ died }) => ({ success: !died }),
  },
  {
    name: 'flooded_pit',
    offset: [300, 0],
    minutes: 2,
    // A sealed, flooded shaft: the bot starts at the bottom under a stone cap.
    setup: [
      'time set 6000', 'give @ stone_pickaxe', 'give @ bread 4',
      'execute at @ run fill ~-2 ~-10 ~-2 ~2 ~-1 ~2 stone',
      'execute at @ run fill ~-1 ~-9 ~-1 ~1 ~-2 ~1 water',
      'execute at @ run tp @ ~ ~-8 ~',
    ],
    judge: ({ died, bot }) => ({ success: !died && !bot.entity.isInWater }),
  },
  {
    name: 'hurt_with_zombies',
    offset: [0, 300],
    minutes: 2,
    setup: [
      'time set 18000', 'weather clear', 'give @ wooden_sword', 'give @ bread 4', 'give @ dirt 16', 'damage @ 12',
      'execute at @ run summon zombie ~5 ~ ~', 'execute at @ run summon zombie ~-4 ~ ~4',
    ],
    judge: ({ died }) => ({ success: !died }),
  },
  {
    name: 'first_day',
    offset: [300, 300],
    minutes: 5,
    setup: ['time set 0', 'weather clear'],
    judge: ({ died, bot }) => {
      const items = Object.keys(inv(bot));
      return { success: !died && items.some((n) => n.endsWith('_pickaxe')), tools: items.filter((n) => /_(pickaxe|axe|sword|shovel)$/.test(n)).join(' ') || 'none' };
    },
  },
].filter((s) => !ONLY.length || ONLY.includes(s.name));

// ---------------------------------------------------------------- director
async function connectDirector() {
  const d = mineflayer.createBot({ host: config.mc.host, port: config.mc.port, username: DIRECTOR, version: config.mc.version, auth: 'offline' });
  await new Promise((resolve, reject) => {
    d.once('spawn', resolve);
    d.once('kicked', (r) => reject(new Error(`director kicked: ${JSON.stringify(r)}`)));
    d.once('error', reject);
  });
  await sleep(1500);
  const denied = await new Promise((resolve) => {
    const onMsg = (m) => {
      const t = m.toString();
      if (/permission|Unknown or incomplete command/i.test(t)) resolve(t);
    };
    d.on('message', onMsg);
    d.chat('/gamemode spectator');
    setTimeout(() => { d.off('message', onMsg); resolve(null); }, 2000);
  });
  if (denied) throw new Error(`${DIRECTOR} is not an operator (${denied}). Run: ./cmd.sh "op ${DIRECTOR}"`);
  return d;
}

async function run(director, cmds) {
  for (const c of cmds) {
    director.chat('/' + c.replaceAll('@', BOT));
    await sleep(300);
  }
}

// Fresh body for every scenario: healed, fed, empty-handed, no mobs around.
async function reset(director, s) {
  const x = BASE_X + s.offset[0];
  const z = BASE_Z + s.offset[1];
  await run(director, [
    `spreadplayers ${x} ${z} 0 1 false @`,
    'clear @', 'effect clear @',
    'effect give @ instant_health 1 10 true', 'effect give @ saturation 1 10 true',
    `kill @e[type=!player,x=${x},z=${z},distance=..48]`,
    `tp ${DIRECTOR} ${x} 120 ${z}`,
  ]);
  await sleep(1500);
}

// ---------------------------------------------------------------- runs
async function runScenario(director, s, generation) {
  const agent = new Agent(config);
  agent.log = (m) => console.log(`  [${s.name}] ${m}`);
  agent.start();
  const started = Date.now();
  while (!agent.bot?.entity || !agent.experience.run || !agent.rules) {
    if (Date.now() - started > 60000) throw new Error('bot did not spawn within 60s');
    await sleep(500);
  }
  await sleep(3000);
  // The previous scenario's goal must not carry over into this one.
  agent.executor.setGoal({ type: 'idle', seconds: 3 });
  await reset(director, s);
  await run(director, s.setup);
  const before = { ...agent.experience.run };
  const t0 = Date.now();
  let died = false;
  agent.bot.on('death', () => { died = true; });
  while (Date.now() - t0 < s.minutes * 60000) await sleep(1000);
  const r = agent.experience.run;
  const result = {
    generation,
    scenario: s.name,
    seconds: Math.round((Date.now() - t0) / 1000),
    died,
    deaths: r.deaths - before.deaths,
    damage: Math.round((r.damage - before.damage) * 10) / 10,
    brainCalls: r.brainCalls - before.brainCalls,
    brainCostUsd: Math.round((r.brainCostUsd - before.brainCostUsd) * 10000) / 10000,
    jevCalls: r.jevCalls - before.jevCalls,
    ...s.judge({ died, bot: agent.bot }),
    rules: agent.rules.list().length,
    brainRules: agent.rules.list().filter((x) => x.author !== 'starter').length,
    lessons: agent.memory.knowledge.items.length,
  };
  agent.stop();
  await sleep(3000);
  return result;
}

function report(results) {
  const names = [...new Set(results.map((r) => r.scenario))];
  const cell = (r) => (r ? `${r.success ? 'ok' : 'FAIL'}, ${r.deaths} deaths, ${r.damage} dmg, $${r.brainCostUsd}` : '');
  const lines = [
    `# Generations report (${new Date().toISOString()})`,
    '',
    `| Generation | ${names.join(' | ')} | Rules (by the bot) | Lessons |`,
    `| --- | ${names.map(() => '---').join(' | ')} | --- | --- |`,
  ];
  for (const g of [...new Set(results.map((r) => r.generation))]) {
    const row = results.filter((r) => r.generation === g);
    const last = row.at(-1);
    lines.push(`| ${g} | ${names.map((n) => cell(row.find((r) => r.scenario === n))).join(' | ')} | ${last.rules} (${last.brainRules}) | ${last.lessons} |`);
  }
  const first = results.filter((r) => r.generation === 1);
  const final = results.filter((r) => r.generation === GENERATIONS);
  const sum = (rs, k) => rs.reduce((n, r) => n + (r[k] ?? 0), 0);
  if (first.length && final.length && GENERATIONS > 1) {
    lines.push('', `Generation 1: ${sum(first, 'deaths')} deaths, ${first.filter((r) => r.success).length}/${first.length} passed. ` +
      `Generation ${GENERATIONS}: ${sum(final, 'deaths')} deaths, ${final.filter((r) => r.success).length}/${final.length} passed.`);
  }
  return lines.join('\n');
}

fs.mkdirSync(MEM, { recursive: true });
const director = await connectDirector();
console.log(`director ready; ${GENERATIONS} generations of ${SCENARIOS.map((s) => s.name).join(', ')}; learned data in ${MEM}`);
const results = [];
try {
  for (let g = 1; g <= GENERATIONS; g++) {
    for (const s of SCENARIOS) {
      console.log(`generation ${g}: ${s.name} (${s.minutes} min)`);
      const r = await runScenario(director, s, g);
      console.log(`  -> ${JSON.stringify(r)}`);
      results.push(r);
      fs.appendFileSync(path.join(MEM, 'generations.jsonl'), JSON.stringify({ t: new Date().toISOString(), ...r }) + '\n');
    }
  }
} finally {
  const md = report(results);
  fs.writeFileSync(path.join(MEM, 'generations-report.md'), md + '\n');
  console.log('\n' + md);
  director.quit();
  setTimeout(() => process.exit(0), 1000);
}
