// End-to-end smoke test against a local server (e.g. flying-squid) with mock
// OpenRouter (brain + Jev) endpoints. Usage: MC_PORT=25599 MC_VERSION=1.21.4 node test/sim.mjs
import http from 'node:http';
import fs from 'node:fs';
import mineflayer from 'mineflayer';
import pf from 'mineflayer-pathfinder';

const MEM = '/tmp/claude-0/mcsim';
fs.rmSync(MEM, { recursive: true, force: true });
const calls = { claude: [], jev: [], toolResults: [] };

function reply(res, body) { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(body)); }
let n = 0;
// OpenRouter (OpenAI-style) chat completion with tool calls.
const msg = (toolCalls, text = '') => ({
  id: 'gen_' + n++, model: 'mock',
  choices: [{ finish_reason: toolCalls.length ? 'tool_calls' : 'stop', message: { role: 'assistant', content: text, tool_calls: toolCalls.length ? toolCalls : undefined, reasoning_details: [{ type: 'reasoning.text', text: 'thinking', id: 'r' + n }] } }],
  usage: { prompt_tokens: 1000 * (globalThis.__len ?? 1), completion_tokens: 50 },
});
const tool = (name, input) => ({ id: 'call_' + n++, type: 'function', function: { name, arguments: JSON.stringify(input) } });

const mock = http.createServer((req, res) => {
  let data = '';
  req.on('data', (c) => (data += c));
  req.on('end', () => {
    const body = data ? JSON.parse(data) : {};
    if (req.url === '/v1/chat/completions') {
      calls.claude.push(body); globalThis.__len = body.messages.length;
      const last = body.messages.at(-1);
      if (last.role === 'tool') {
        for (const m of body.messages.slice().reverse()) { if (m.role !== 'tool') break; calls.toolResults.unshift(m.content); }
        return reply(res, msg([], 'done'));
      }
      const texts = last.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n');
      if (texts.includes('instance is ending')) return reply(res, msg([tool('write_handoff', { notes: 'I was idling. Steve said hi and later hit me.' })]));
      if (texts.includes('first time')) return reply(res, msg([
        tool('run_steps', { steps: [{ do: 'position', as: 'p' }, { do: 'wait', args: { seconds: 1 } }, { return: '$p.y' }] }),
        tool('save_skill', { name: 'whereami', description: 'Return my height', steps: [{ do: 'position', as: 'p' }, { return: '$p.y' }] }),
      ]));
      if (texts.includes('said: "')) return reply(res, msg([tool('say', { message: 'hey Steve!' }), tool('note_player', { name: 'Steve', relation: 'neutral', note: 'greeted me' })]));
      if (texts.includes('hit you')) return reply(res, msg([tool('note_player', { name: 'Steve', relation: 'hostile', note: 'attacked me' })]));
      return reply(res, msg([tool('set_goal', { type: 'explore', args: { distance: 8 }, reason: 'test' }), tool('remember', { category: 'fact', text: 'spawned in a test world' }), tool('save_location', { name: 'spawn' })]));
    }
    if (req.url === '/v1/systemone') {
      calls.jev.push(body);
      const opts = Object.keys(body.questions.action.criteria);
      const answers = { action: { type: 'choice', choice: opts.includes('defend') ? 'defend' : 'continue_goal', confidence: 0.9, probabilities: {} }, escalate: { type: 'noul', noul: 0.1 } };
      for (const k of Object.keys(body.questions)) if (k.startsWith('threat_')) answers[k] = { type: 'noul', noul: 0.3 };
      return reply(res, { model: 'jev-mock', answers, usage: { input_tokens: 1, output_tokens: 1 } });
    }
    res.writeHead(404); res.end();
  });
});
await new Promise((r) => mock.listen(18080, r));

Object.assign(process.env, {
  OPENROUTER_API_KEY: 'test', OPENROUTER_BASE_URL: 'http://127.0.0.1:18080',
  MC_USERNAME: 'TestBot', MEMORY_DIR: MEM, BRAIN_CONTEXT_LIMIT: '12000', BRAIN_HEARTBEAT_SECONDS: '5',
});
const { config } = await import('../src/config.js');
const { Agent } = await import('../src/agent.js');
const agent = new Agent(config);
agent.start();

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
await sleep(5000);
const steve = mineflayer.createBot({ host: config.mc.host, port: config.mc.port, username: 'Steve', version: config.mc.version, auth: 'offline' });
await new Promise((r) => steve.once('spawn', r));
await sleep(2000);
steve.loadPlugin(pf.pathfinder);
steve.pathfinder.setMovements(new pf.Movements(steve));
const tp = agent.bot.entity.position;
steve.chat(`/teleport Steve ${Math.floor(tp.x) + 2} ${Math.floor(tp.y)} ${Math.floor(tp.z)}`);
await sleep(3000);
const victim = () => steve.nearestEntity((e) => e.type === 'player');
steve.chat('hi TestBot');
console.log('DIST', steve.entity.position.distanceTo(agent.bot.entity.position), 'TestBot sees Steve entity:', !!agent.bot.players.Steve?.entity);
await sleep(6000);
for (let i = 0; i < 3; i++) {
  const t = victim();
  if (t) { await steve.lookAt(t.position.offset(0, 1.6, 0)); steve.attack(t); }
  await sleep(700);
}
console.log('HEALTH', agent.bot.health);
await sleep(8000);

const dir = `${MEM}/TestBot`;
const players = JSON.parse(fs.readFileSync(`${dir}/players.json`, 'utf8'));
const state = JSON.parse(fs.readFileSync(`${dir}/state.json`, 'utf8'));
const report = {
  claudeCalls: calls.claude.length,
  firstToolResults: calls.toolResults.slice(0, 2),
  skillsInDigest: calls.claude.filter((b) => b.messages.length === 2).some((b) => JSON.stringify(b.messages[1]).includes('whereami')),
  jevCalls: calls.jev.length,
  jevQuestionKeys: [...new Set(calls.jev.flatMap((b) => Object.keys(b.questions)))],
  jevOptionsSeen: [...new Set(calls.jev.flatMap((b) => Object.keys(b.questions.action.criteria)))],
  generation: state.generation,
  steve: players.Steve && { relation: players.Steve.relation, attacksOnMe: players.Steve.attacksOnMe, chat: players.Steve.chat.map((c) => c.message), notes: players.Steve.notes },
  files: fs.readdirSync(dir),
  handoffs: fs.existsSync(`${dir}/handoffs.md`) ? fs.readFileSync(`${dir}/handoffs.md`, 'utf8').trim() : null,
  journalKinds: fs.readFileSync(`${dir}/journal.jsonl`, 'utf8').trim().split('\n').map((l) => JSON.parse(l).kind),
  freshInstanceHadDigest: calls.claude.filter((b) => b.messages.length === 2).length,
  requestShape: { model: calls.claude[0]?.model, reasoning: calls.claude[0]?.reasoning, tools: calls.claude[0]?.tools?.length, systemCached: !!calls.claude[0]?.messages[0].content[0].cache_control, jevModel: calls.jev[0]?.model },
  reasoningKept: calls.claude.some((b) => b.messages.some((m) => m.role === 'assistant' && m.reasoning_details)),
};
console.log(JSON.stringify(report, null, 2));
agent.stop(); steve.quit(); mock.close();
setTimeout(() => process.exit(0), 500);
