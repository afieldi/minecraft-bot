// The LLM "brain": a model on OpenRouter that sets goals, talks to players,
// writes its own reflex rules and skills, and decides what to remember. It is
// woken by events (chat, damage, a goal finishing, a new player, a death) and
// by a slow heartbeat, never every tick.
//
// The prompt is rebuilt on every wake from the memory files plus the last few
// wake-ups, so cost per call stays flat and anything the bot learned is in
// effect at once. Waking from a bed ends a "generation": the brain
// consolidates its lessons and writes a handoff note before its short-term
// history is cleared.
import { GOAL_TYPES } from './actions.js';
import { inventorySummary, briefState } from './perception.js';
import { SKILL_DOCS } from './skills.js';
import { RULE_DOCS } from './rules.js';
import { ruleState } from './perception.js';

const SYSTEM = `You are the mind of a Minecraft player bot on a multiplayer survival server. You see the world through text observations and act through tools. A fast reflex layer handles combat, fleeing and eating on its own; you decide what the bot is trying to achieve and how it treats other people.

How you work:
- Each observation tells you why you were woken. Respond with tool calls, then stop. Keep visible text short; nobody reads it.
- Use set_goal to give the body one concrete goal at a time. Goals run until they finish or fail, and you will be told the result. Break big ambitions into a plan with set_plan and work through it.
- You only see your last few wake-ups. Your memory files (lessons, places, people, rules, skills) are re-read every time you wake. Anything worth knowing later (where things are, what worked, what failed, promises you made, who is trustworthy) must be saved with remember, note_player or save_location, or it is gone in a few minutes.
- You learn from outcomes. Your rules, skills and lessons each carry a record of how they turned out. After a death or a failure you are shown what happened; turn it into a better rule, skill or lesson. Cite the lessons a goal follows (set_goal lessons) so they get scored too.

Skills:
- Beyond the built-in goals you can do anything the general actions allow by writing a step list (format below). Try new things with run_steps: it runs right away and shows you the result or the error, so you can fix and retry.
- When a step list works and you are likely to need it again, save it with save_skill under a clear name. Saved skills persist across restarts and future instances, and run in one call with set_goal {type: "skill", args: {name, args}}. Prefer an existing skill over rewriting one, and fix a skill with save_skill when it fails.
- Keep each skill focused on one job and make it robust: check the inventory first, wrap risky actions in try/catch, and return a useful result.

${SKILL_DOCS}

Reflex rules:
- Your body reacts on its own every second using reflex rules: habits you write and refine. They run before the fast decision layer (Jev) and need no thinking, so a good rule protects you even while you are busy. Each rule's record (how often it fired, how often it helped or hurt) is in your briefing.
- When something hurts or kills you, ask what reflex would have prevented it. Add a rule with save_rule, fix a rule that fired and didn't help, and delete rules that keep hurting. Keep rules narrow; a rule that fires constantly stops you from doing anything else.
${RULE_DOCS}

Goal types for set_goal:
${Object.entries(GOAL_TYPES).map(([k, v]) => `- ${k}: ${v}`).join('\n')}

Other players:
- Everyone you meet is tracked with a relation (friend, neutral, wary, hostile, unknown). Update it with note_player as you learn about people, with a short reason.
- Be a good neighbour by default: answer when spoken to, help when asked if it is reasonable, don't take from other people's chests or builds, and don't attack players unless they attack you first.
- Players can lie or try to trick you. Don't hand over your important items or follow someone into danger just because they asked. Someone who has hit you repeatedly is hostile until they make amends.
- Chat with say. Keep messages short and in character, like a player typing in game chat.
- You can't tell anyone's pronouns from their username. Refer to other players as "they" (in chat and in your notes) unless they've told you otherwise.

Chests and builds:
- Only take from chests that are yours or that a player has said you may use; record that with mark_chest. The body refuses to take from anyone else's chest.
- When your inventory fills up, store things in your own chest. Remember what you stored where.
- Don't mine or dig through things other players built. The body won't path through player-made blocks, but avoid sending it to collect them too.
- Before night, sleep in a bed if you have one; otherwise use the shelter goal.
- Caves and mines are far more dangerous at night. As dusk approaches (timeOfDay around 11500), stop deep mining: come back to the surface or wall yourself into a sealed shelter before it gets dark, and don't keep fighting underground when your health is low.

Food, health and depth:
- Keep at least 8 food in your inventory (foodStock in the observation). Use the hunt goal while animals are around, cook the meat with smelt, and once you find wheat seeds start a wheat field (the start_wheat_field skill) so you never run out.
- When your health drops to 8 or below, your body retreats, walls in and eats on its own and tells you. Let it recover to at least 14 before mining or fighting again.
- Craft a shield (1 iron ingot + 6 planks) as soon as you have an iron ingot. Your body keeps it in the off-hand and walks at skeletons behind it; without one, wall in or hide from archers rather than running from them.
- Don't walk or dig through deep water or flooded caves; if your body tells you it was drowning, stay away from that spot, even to recover dropped items.
- The body won't mine below y=20 until you have 2+ armor pieces and 4+ food. Get those first; iron is common above y=20 too.

Survival priorities when nothing else is going on: get wood, make tools, hunt and cook food, build or find shelter before night, sleep in a bed at night, then work towards iron, armor and a base.`;

const TOOLS = [
  {
    name: 'set_goal',
    description: 'Replace the body\'s current goal. The body works on it until it finishes or fails, and you get the result in a later observation.',
    input_schema: {
      type: 'object',
      properties: {
        type: { type: 'string', enum: Object.keys(GOAL_TYPES) },
        args: { type: 'object', description: 'Arguments for the goal type, as listed in the system prompt.' },
        reason: { type: 'string' },
        lessons: { type: 'array', items: { type: 'integer' }, description: 'Ids (#n) of remembered lessons this goal follows, if any. They are scored by how the goal turns out.' },
      },
      required: ['type', 'args'],
    },
  },
  {
    name: 'set_plan',
    description: 'Save your current multi-step plan so you and future instances can follow it.',
    input_schema: { type: 'object', properties: { steps: { type: 'array', items: { type: 'string' } } }, required: ['steps'] },
  },
  {
    name: 'say',
    description: 'Send a chat message. Give "to" to whisper to one player instead of the whole server.',
    input_schema: { type: 'object', properties: { message: { type: 'string' }, to: { type: 'string' } }, required: ['message'] },
  },
  {
    name: 'remember',
    description: 'Save a fact or lesson to long-term memory. It survives restarts and new instances.',
    input_schema: {
      type: 'object',
      properties: {
        category: { type: 'string', description: 'e.g. lesson, fact, promise, danger, resource' },
        text: { type: 'string' },
      },
      required: ['category', 'text'],
    },
  },
  {
    name: 'update_lesson',
    description: 'Rewrite a remembered item by its #id, or pin it so it is always in your briefing and never dropped.',
    input_schema: {
      type: 'object',
      properties: { id: { type: 'integer' }, text: { type: 'string' }, category: { type: 'string' }, pinned: { type: 'boolean' } },
      required: ['id'],
    },
  },
  {
    name: 'forget',
    description: 'Delete a remembered item by its #id when it is wrong or outdated.',
    input_schema: { type: 'object', properties: { id: { type: 'integer' } }, required: ['id'] },
  },
  {
    name: 'note_player',
    description: 'Update what you know about a player: their relation to you and/or a note.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string' },
        relation: { type: 'string', enum: ['friend', 'neutral', 'wary', 'hostile', 'unknown'] },
        note: { type: 'string' },
      },
      required: ['name'],
    },
  },
  {
    name: 'save_location',
    description: 'Name your current position so you can return later with goto { location }.',
    input_schema: { type: 'object', properties: { name: { type: 'string' }, note: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'mark_chest',
    description: 'Record who owns a chest and whether you may use it, e.g. when a player says "you can use my chest at 10 64 -3".',
    input_schema: {
      type: 'object',
      properties: {
        x: { type: 'integer' }, y: { type: 'integer' }, z: { type: 'integer' },
        owner: { type: 'string', description: '"me" or the player\'s name' },
        shared: { type: 'boolean', description: 'true if you are allowed to take from it' },
      },
      required: ['x', 'y', 'z', 'owner', 'shared'],
    },
  },
  {
    name: 'inspect',
    description: 'Look something up: full inventory, what can be crafted now, everything known about a player, known chests and their last-seen contents, your reflex rules (give name for one rule in full), or the current values of the rule variables (rule_state).',
    input_schema: {
      type: 'object',
      properties: { what: { type: 'string', enum: ['inventory', 'craftable', 'player', 'chests', 'rules', 'rule_state'] }, name: { type: 'string' } },
      required: ['what'],
    },
  },
  {
    name: 'run_steps',
    description: 'Run a step list now (replacing the current goal) and see its result. If it takes longer than wait_seconds you are told it is still running and get the result later as a goal result.',
    input_schema: {
      type: 'object',
      properties: {
        steps: { type: 'array', items: { type: 'object' } },
        args: { type: 'object' },
        timeout_seconds: { type: 'integer', description: 'Hard limit, default 120, max 1800.' },
        wait_seconds: { type: 'integer', description: 'How long to wait for the result here, default 30, max 60.' },
      },
      required: ['steps'],
    },
  },
  {
    name: 'save_skill',
    description: 'Save (or replace) a named skill so you and future instances can run it with set_goal {type: "skill"}.',
    input_schema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'lowercase_with_underscores' },
        description: { type: 'string', description: 'What it does, what it needs, what args it takes and what it returns.' },
        steps: { type: 'array', items: { type: 'object' } },
      },
      required: ['name', 'description', 'steps'],
    },
  },
  {
    name: 'read_skill',
    description: 'Show the steps of a saved skill, e.g. to fix or extend it.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'delete_skill',
    description: 'Delete a saved skill that is wrong or no longer useful.',
    input_schema: { type: 'object', properties: { name: { type: 'string' } }, required: ['name'] },
  },
  {
    name: 'save_rule',
    description: 'Save (or replace, by id) a reflex rule. The condition is tested on your current situation before saving.',
    input_schema: {
      type: 'object',
      properties: {
        id: { type: 'string', description: 'lowercase_with_underscores' },
        description: { type: 'string', description: 'What situation it handles and why this reflex.' },
        when: { description: 'Condition in the expression language, over the rule variables.' },
        do: { type: 'string', description: 'The reflex to run.' },
        priority: { type: 'integer', description: '0-100, higher is checked first' },
        holdSeconds: { type: 'number' },
        cooldownSeconds: { type: 'number' },
        tell: { type: 'string' },
      },
      required: ['id', 'description', 'when', 'do', 'priority'],
    },
  },
  {
    name: 'delete_rule',
    description: 'Delete a reflex rule that is wrong or keeps hurting you.',
    input_schema: { type: 'object', properties: { id: { type: 'string' } }, required: ['id'] },
  },
  {
    name: 'write_handoff',
    description: 'Write the note your next instance will read first. Only call this when asked to hand off.',
    input_schema: { type: 'object', properties: { notes: { type: 'string' } }, required: ['notes'] },
  },
];

const OPENAI_TOOLS = TOOLS.map((t) => ({
  type: 'function',
  function: { name: t.name, description: t.description, parameters: t.input_schema },
}));

export class Brain {
  constructor({ bot, memory, players, executor, skills, rules, experience, config, log }) {
    this.bot = bot;
    this.rules = rules;
    this.experience = experience;
    this.skills = skills;
    this.memory = memory;
    this.players = players;
    this.executor = executor;
    this.cfg = config;
    this.log = log;
    // Short-term memory: one entry per wake-up, each the list of messages it
    // produced. Only the last historyWakes are sent.
    this.history = [];
    this.busy = false;
    this.pending = null;
    this.contextTokens = 0;
    this.handoffWritten = false;
  }

  // For good: the bot this brain drives has gone. Calls already in flight
  // finish, but no further tool runs, model calls or wake-ups happen.
  stop() {
    this.stopped = true;
    this.pending = null;
  }

  // Queue a wake-up. If the brain is busy, wake-ups collapse into one.
  wake(reason, snapshot) {
    if (this.stopped) return;
    if (this.busy) {
      this.pending = { reasons: [...(this.pending?.reasons ?? []), reason], snapshot };
      return;
    }
    this.#think([reason], snapshot);
  }

  async #think(reasons, snapshot) {
    this.busy = true;
    try {
      const view = typeof snapshot === 'function' ? snapshot() : snapshot;
      const text = `[${new Date().toISOString().slice(11, 19)}] Woken because: ${reasons.join('; ')}\nObservation: ${JSON.stringify(view)}`;
      this.history.push([{ role: 'user', content: [{ type: 'text', text }] }]);
      if (this.history.length > this.cfg.historyWakes) this.history.splice(0, this.history.length - this.cfg.historyWakes);
      await this.#loop();
      await this.#maybeRotate();
    } catch (err) {
      this.log(`brain error: ${err.message}`);
    } finally {
      this.#release();
    }
  }

  // Ask for a fresh instance (e.g. after sleeping). Runs once the brain is idle.
  requestRotation(reason) {
    this.rotateRequested = reason;
    if (this.busy || this.stopped) return;
    this.busy = true;
    this.#maybeRotate()
      .catch((err) => this.log(`brain error: ${err.message}`))
      .finally(() => this.#release());
  }

  async #maybeRotate() {
    if (this.rotateRequested && !this.stopped) {
      const reason = this.rotateRequested;
      this.rotateRequested = null;
      await this.rotate(reason);
    }
  }

  #release() {
    this.busy = false;
    if (this.pending) {
      const { reasons, snapshot } = this.pending;
      this.pending = null;
      setImmediate(() => this.#think(reasons, snapshot));
    }
  }

  // Messages of the wake-up in progress.
  get #turn() {
    if (!this.history.length) this.history.push([]);
    return this.history.at(-1);
  }

  #appendUser(text) {
    const turn = this.#turn;
    const last = turn.at(-1);
    if (last?.role === 'user') last.content.push({ type: 'text', text });
    else turn.push({ role: 'user', content: [{ type: 'text', text }] });
  }

  // What is sent: the memory briefing, freshly built, in front of the recent
  // wake-ups. Each wake-up starts with a user message and keeps its tool calls
  // and results together, so trimming whole wake-ups keeps the history valid.
  #prompt() {
    const flat = this.history.flat();
    const digest = this.memory.digest(this.players.summary(), this.skills.summary(), this.rules?.summary(), (key) => this.experience?.score(key));
    const first = flat[0];
    const briefing = { type: 'text', text: `${digest}\n\n# Your recent wake-ups (oldest first)` };
    return [{ ...first, content: [briefing, ...first.content] }, ...flat.slice(1)];
  }

  // OpenRouter chat completions. Anthropic models need explicit cache
  // breakpoints, so the system prompt and the newest message are marked on a
  // copy of the history (the stored history is never edited). Other
  // providers, like DeepSeek, cache automatically.
  async #call() {
    const mark = this.cfg.model.startsWith('anthropic/');
    const cache = mark ? { cache_control: { type: 'ephemeral' } } : {};
    const prompt = this.#prompt();
    const messages = prompt.map((m, i) => {
      if (!mark || i !== prompt.length - 1 || !Array.isArray(m.content) || !m.content.length) return m;
      const content = m.content.map((b, j) => (j === m.content.length - 1 ? { ...b, cache_control: { type: 'ephemeral' } } : b));
      return { ...m, content };
    });
    const res = await fetch(`${this.cfg.baseUrl}/v1/chat/completions`, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${this.cfg.apiKey}`,
        'Content-Type': 'application/json',
        'X-Title': 'Minecraft bot',
      },
      body: JSON.stringify({
        model: this.cfg.model,
        max_tokens: 16000,
        reasoning: { effort: this.cfg.effort },
        usage: { include: true },
        tools: OPENAI_TOOLS,
        messages: [{ role: 'system', content: [{ type: 'text', text: SYSTEM, ...cache }] }, ...messages],
      }),
      signal: AbortSignal.timeout(180000),
    });
    if (!res.ok) throw new Error(`OpenRouter ${res.status}: ${(await res.text()).slice(0, 300)}`);
    const body = await res.json();
    if (body.error) throw new Error(`OpenRouter: ${body.error.message ?? JSON.stringify(body.error)}`);
    const u = body.usage ?? {};
    this.contextTokens = (u.prompt_tokens ?? 0) + (u.completion_tokens ?? 0);
    this.experience?.count('brainCalls');
    this.experience?.count('brainTokens', this.contextTokens);
    if (typeof u.cost === 'number') this.experience?.count('brainCostUsd', u.cost);
    return body.choices[0];
  }

  async #loop() {
    for (let round = 0; round < this.cfg.maxToolRounds; round++) {
      if (this.stopped) return;
      const choice = await this.#call();
      if (this.stopped) return;
      const msg = choice.message ?? {};
      if (choice.finish_reason === 'content_filter') {
        this.log('brain: request declined, skipping this wake-up');
        this.#turn.push({ role: 'assistant', content: '(no response)' });
        return;
      }
      // Keep reasoning_details unmodified so reasoning carries across tool calls.
      const turn = { role: 'assistant', content: msg.content ?? '' };
      if (msg.tool_calls?.length) turn.tool_calls = msg.tool_calls;
      if (msg.reasoning_details) turn.reasoning_details = msg.reasoning_details;
      this.#turn.push(turn);
      if (typeof msg.content === 'string' && msg.content.trim()) this.log(`brain: ${msg.content.trim()}`);
      const calls = msg.tool_calls ?? [];
      if (!calls.length) return;
      for (const call of calls) {
        if (this.stopped) return;
        const name = call.function?.name;
        let input = {};
        let out;
        let isError = false;
        try {
          input = JSON.parse(call.function?.arguments || '{}');
          out = await this.#runTool(name, input);
        } catch (err) {
          out = `error: ${err.message}`;
          isError = true;
        }
        if (this.stopped) return; // the bot left while this tool ran
        this.log(`brain -> ${name} ${JSON.stringify(input)}${isError ? ' (' + out + ')' : ''}`);
        this.#turn.push({ role: 'tool', tool_call_id: call.id, content: String(out) });
      }
    }
  }

  async #runTool(name, input) {
    const { bot, memory, players, executor } = this;
    switch (name) {
      case 'set_goal': {
        const goal = { type: input.type, ...(input.args ?? {}) };
        this.#track(goal, input.reason, input.lessons);
        executor.setGoal(goal);
        memory.log('goal_set', { goal, text: input.reason });
        return `goal set: ${executor.describe()}`;
      }
      case 'set_plan':
        memory.state.plan = input.steps;
        memory.saveState();
        return 'plan saved';
      case 'say':
        if (input.to) bot.whisper(input.to, input.message);
        else bot.chat(input.message);
        memory.log('said', { text: input.message, to: input.to });
        return 'sent';
      case 'remember':
        return `remembered as #${memory.remember(input.category, input.text).id}`;
      case 'update_lesson': {
        const item = memory.updateKnowledge(input.id, { text: input.text, category: input.category, pinned: input.pinned });
        return item ? `updated #${item.id}${item.pinned ? ' (pinned)' : ''}` : `no memory #${input.id}`;
      }
      case 'forget':
        return memory.forget(input.id) ? 'forgotten' : `no memory #${input.id}`;
      case 'note_player': {
        const rec = players.setRelation(input.name, input.relation, input.note);
        memory.log('player_note', { player: input.name, relation: rec.relation, text: input.note });
        return `${input.name} is now ${rec.relation}`;
      }
      case 'save_location':
        memory.saveLocation(input.name, bot.entity.position, bot.game.dimension, input.note);
        return `saved ${input.name}`;
      case 'mark_chest': {
        const c = memory.updateChest({ x: input.x, y: input.y, z: input.z }, { owner: input.owner, shared: input.owner === 'me' || input.shared });
        memory.log('chest_marked', { chest: c });
        return `chest at ${c.x} ${c.y} ${c.z}: owner ${c.owner}, ${c.owner === 'me' || c.shared ? 'usable' : 'off limits'}`;
      }
      case 'inspect':
        if (input.what === 'inventory') return JSON.stringify(inventorySummary(bot));
        if (input.what === 'chests') return memory.chestSummary() || 'no chests known';
        if (input.what === 'rules') {
          if (input.name) return JSON.stringify(this.rules.get(input.name) ?? `no rule called ${input.name}`);
          return this.rules.summary() || 'no rules';
        }
        if (input.what === 'rule_state') return JSON.stringify(ruleState(bot, players, executor));
        if (input.what === 'player') {
          const rec = players.players[input.name];
          if (!rec) return `never met ${input.name}`;
          return JSON.stringify(rec);
        }
        if (input.what === 'craftable') {
          const table = bot.findBlock({ matching: bot.registry.blocksByName.crafting_table.id, maxDistance: 32 });
          const names = Object.values(bot.registry.items)
            .filter((it) => bot.recipesFor(it.id, null, 1, table ?? null).length)
            .map((it) => it.name);
          return names.length ? names.join(', ') + (table ? '' : ' (no crafting table nearby)') : 'nothing craftable right now';
        }
        return 'unknown inspect target';
      case 'run_steps': {
        // A trial run borrows the body; the goal it interrupts comes back
        // afterwards, so a failed experiment doesn't silently drop it.
        const prev = executor.goal;
        const goal = { type: 'steps', steps: input.steps, args: input.args, timeoutSeconds: input.timeout_seconds };
        this.#track(goal, 'run_steps');
        executor.setGoal(goal);
        memory.log('goal_set', { goal: { type: 'steps', count: input.steps?.length } });
        const wait = Math.min(input.wait_seconds ?? 30, 60) * 1000;
        const result = await executor.waitFor(goal, wait);
        if (!result) {
          if (executor.goal !== goal) return 'interrupted before it finished';
          return 'still running; you will get the result when it finishes' + (prev ? `. It replaced your goal ${JSON.stringify(prev.type)}; set it again afterwards if you still want it` : '');
        }
        let resumed = '';
        if (prev && !executor.goal && !this.stopped) {
          this.#track(prev, 'resumed after run_steps');
          executor.setGoal(prev);
          resumed = ` (resumed your previous goal: ${executor.describe()})`;
        }
        if (!result.ok) throw new Error(result.message + resumed);
        return result.message + resumed;
      }
      case 'save_skill': {
        const s = this.skills.save(input.name, input.description, input.steps);
        memory.log('skill_saved', { text: `${input.name} v${s.version}: ${input.description}` });
        return `saved skill ${input.name} (version ${s.version})`;
      }
      case 'save_rule': {
        const r = this.rules.save(input, ruleState(bot, players, executor));
        memory.log('rule_saved', { text: `${r.id} v${r.version}: ${r.description}` });
        return `saved rule ${r.id} (version ${r.version})`;
      }
      case 'delete_rule':
        if (!this.rules.delete(input.id)) return `no rule called ${input.id}`;
        memory.log('rule_deleted', { text: input.id });
        return `deleted rule ${input.id}`;
      case 'read_skill':
        return JSON.stringify(this.skills.read(input.name));
      case 'delete_skill':
        return this.skills.delete(input.name) ? `deleted ${input.name}` : `no skill called ${input.name}`;
      case 'write_handoff':
        memory.writeHandoff(memory.state.generation, this.rotatingFor ?? 'requested', input.notes);
        this.handoffWritten = true;
        return 'handoff saved; your next instance will read it';
      default:
        throw new Error(`unknown tool ${name}`);
    }
  }

  // File the goal with the experience recorder so its outcome is scored
  // against the brain (or the skill it runs) and any lessons it cites.
  #track(goal, reason, lessons = []) {
    this.experience?.goalStarted(goal, {
      source: goal.type === 'skill' ? `skill:${goal.name}` : 'brain',
      reason,
      cites: (lessons ?? []).map((id) => `lesson:${id}`),
      state: briefState(this.bot),
    });
  }

  // End a generation (after sleeping): consolidate what was learned, write a
  // handoff note, and clear the short-term history.
  async rotate(reason) {
    if (!this.history.length) return;
    this.log(`brain: ending generation ${this.memory.state.generation} (${reason})`);
    this.rotatingFor = reason;
    this.handoffWritten = false;
    this.history.push([]);
    this.#appendUser(
      `Your generation is ending (${reason}). Your short-term history will be cleared. Before that, consolidate what you know:\n` +
        '- Merge duplicate or overlapping remembered items into one (update_lesson the keeper, forget the rest), drop ones that turned out wrong, and pin the few that must never be lost (your base, key dangers, promises).\n' +
        '- Look at your rules\' and skills\' records: fix or delete the ones that keep hurting you.\n' +
        '- Then call write_handoff with what you were doing and why, your plan, open promises to players, and what you learned this generation.',
    );
    try {
      await this.#loop();
    } catch (err) {
      this.log(`brain: handoff failed: ${err.message}`);
    }
    if (!this.handoffWritten) {
      writeFallbackHandoff(this.memory, reason);
    }
    this.memory.state.generation++;
    this.memory.saveState();
    this.memory.log('brain_rotated', { reason, generation: this.memory.state.generation });
    this.history = [];
    this.contextTokens = 0;
    this.rotatingFor = null;
  }
}

function writeFallbackHandoff(memory, reason) {
  const goal = memory.state.goal ? JSON.stringify(memory.state.goal) : 'none';
  memory.writeHandoff(memory.state.generation, reason, `(automatic) Previous instance ended without writing notes. Last goal: ${goal}. Plan: ${(memory.state.plan ?? []).join(' / ') || 'none'}.`);
}
