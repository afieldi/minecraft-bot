// Wires the pieces together: Mineflayer body, reflex loop, brain wake-ups,
// memory and brain rotation on sleep.
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import pvpPkg from 'mineflayer-pvp';
import collectBlockPkg from 'mineflayer-collectblock';
import { Memory } from './memory.js';
import { PlayerTracker } from './players.js';
import { Executor, equipShield } from './actions.js';
import { Reflexes } from './reflexes.js';
import { JevClient } from './jev.js';
import { Brain } from './brain.js';
import { Arbiter } from './arbiter.js';
import { Experience, describeRecord } from './experience.js';
import { RuleBook } from './rules.js';
import { SkillLibrary, registerSkillGoals } from './skills.js';
import { briefState, ruleState, reflexState, worldSnapshot, trackOwnAir } from './perception.js';

const { pathfinder, Movements } = pathfinderPkg;
const ESCALATE_COOLDOWN_MS = 20000;
const THREAT_ALERT = 0.75;
// Jev sometimes picks flee/fight with very low confidence; acting on those
// makes the bot abandon its goal over nothing.
const MIN_REFLEX_CONFIDENCE = 0.3;
const BEHAVIOUR_WAKE_COOLDOWN_MS = 30000;
// Pathfinding inside collectBlock can run away (e.g. a tool breaks mid-goal)
// and take the process out of memory; abort the goal well before that.
const HEAP_LIMIT_BYTES = 1.5e9;
// The server's player hitbox is 0.6 wide as a float (0.60000002), so a body
// that stops exactly flush with a block (as prismarine-physics does at 0.3
// half-width) overlaps it by ~1e-8 there. Paper treats that as clipping into
// the block and snaps every move back. A hair wider keeps us just clear.
const HALF_WIDTH = 0.3 + 1e-5;
const SNAPBACK_LIMIT = 5; // server corrections within SNAPBACK_WINDOW_MS before we re-center
const SNAPBACK_WINDOW_MS = 2000;
const PLAYER_MADE =/(_planks|_door|_trapdoor|glass|glass_pane|_wool|_carpet|bricks|_slab|_stairs|_fence|_fence_gate|_wall|chest|barrel|furnace|smoker|crafting_table|_bed|torch|lantern|sign|bookshelf|concrete|terracotta|rail|hopper|anvil|enchanting_table|beacon|smooth_stone|polished_|chiseled_)/;

export class Agent {
  constructor(config) {
    this.cfg = config;
    this.memory = new Memory(config.memoryDir, config.mc.username);
    this.jev = new JevClient(config.jev);
    this.experience = new Experience(this.memory);
    this.stopped = false;
  }

  log(msg) {
    console.log(`[${new Date().toISOString().slice(11, 19)}] ${msg}`);
  }

  start() {
    if (this.cfg.brain.enabled && !this.cfg.brain.apiKey) {
      this.log('OPENROUTER_API_KEY is not set: the brain cannot think. Add it to .env (or set BRAIN_DISABLED=1).');
    }
    const bot = mineflayer.createBot({ ...this.cfg.mc, checkTimeoutInterval: 60000 });
    this.bot = bot;
    bot.loadPlugin(pathfinder);
    bot.loadPlugin(pvpPkg.plugin);
    bot.loadPlugin(collectBlockPkg.plugin);

    bot.once('spawn', () => this.#onSpawn().catch((err) => this.log(`spawn error: ${err.message}`)));
    bot.on('kicked', (reason) => this.log(`kicked: ${typeof reason === 'string' ? reason : JSON.stringify(reason)}`));
    bot.on('error', (err) => this.log(`error: ${err.message}`));
    bot.on('end', (reason) => {
      this.log(`disconnected (${reason})`);
      this.#teardown();
      if (!this.stopped) setTimeout(() => this.start(), 10000);
    });
  }

  async #onSpawn() {
    const bot = this.bot;
    const log = (m) => this.log(m);
    bot.physics.playerHalfWidth = HALF_WIDTH;
    this.#watchSnapbacks();
    trackOwnAir(bot);
    const movements = new Movements(bot);
    movements.allowSprinting = true;
    // Swimming through water got the bot trapped and drowned in flooded caves;
    // only path through it when there's no reasonable dry route.
    movements.liquidCost = 20;
    // Don't tunnel through things other players build while walking or mining.
    for (const b of Object.values(bot.registry.blocksByName)) {
      if (PLAYER_MADE.test(b.name)) movements.blocksCantBreak.add(b.id);
    }
    bot.pathfinder.setMovements(movements);
    bot.collectBlock.movements = movements; // otherwise collectBlock swaps in its own

    this.players = new PlayerTracker(bot, this.memory, this.cfg.trustedPlayers);
    this.executor = new Executor(bot, this.memory, log);
    this.reflexes = new Reflexes(bot, this.players, this.jev, log, () => this.#jevLessons());
    this.skills = new SkillLibrary(this.memory);
    registerSkillGoals(this.skills);
    this.rules = new RuleBook(this.memory, { experience: this.experience, log });
    this.brain = new Brain({ bot, memory: this.memory, players: this.players, executor: this.executor, skills: this.skills, rules: this.rules, experience: this.experience, config: this.cfg.brain, log });
    this.experience.attach(bot);
    this.executor.onGoalEnded = (goal, result) => this.experience.goalEnded(goal, result);
    this.arbiter = new Arbiter();
    this.arbiter.addProvider(() => this.rules.behaviours());
    this.lastEscalation = 0;
    // holdFirstWake: whoever started us wakes the brain itself (the
    // generations harness does, once the scene is set).
    this.lastWake = this.holdFirstWake ? Date.now() : 0;
    this.threatAlerted = new Map();
    this.behaviourWoke = new Map();

    // Every process start is a new brain instance.
    this.memory.state.generation++;
    this.memory.saveState();
    this.memory.log('spawned', { generation: this.memory.state.generation, pos: bot.entity.position });
    this.log(`spawned as ${bot.username} (brain generation ${this.memory.state.generation}, decisions by ${this.jev.enabled ? 'Jev' : 'utility fallback'})`);

    this.executor.onGoalFinished = (r) => {
      if (r.ok) return this.wake(`goal finished: ${r.message}`);
      // A failure is worth learning from when it cost something.
      const costly = this.experience.recent(60000).some((x) => x.verdict === 'hurt' && x.kind === 'reflex');
      this.wake(`goal failed: ${r.message}` + (costly ? `\n${this.#episode(60000, 'If this failure teaches something general, save it as a lesson, or fix the skill or rule involved.')}` : ''));
    };
    this.players.onEvent((ev) => this.#onPlayerEvent(ev));

    bot.on('death', () => {
      this.memory.log('died', { pos: bot.entity.position });
      this.wake(`you died and respawned; your inventory was dropped where you died.\n${this.#episode(120000,
        'Reflect before doing anything else: what would have prevented this death? Add or fix a reflex rule (save_rule) if a quicker reaction would have saved you, ' +
        'save a lesson (remember, category lesson) if a different plan would have, and delete or fix any rule or skill above that made it worse.')}`);
    });
    bot.on('sleep', () => this.memory.log('fell_asleep'));
    bot.on('wake', () => {
      this.memory.log('woke_up');
      this.brain.requestRotation('slept');
      this.wake('you woke up after sleeping; this is a fresh start for your mind');
    });

    // Block searches and the brain's first look around need the nearby world.
    await Promise.race([bot.waitForChunksToLoad(), new Promise((r) => setTimeout(r, 15000))]);

    // Resume whatever the previous instance was doing.
    if (this.memory.state.goal) {
      const goal = this.memory.state.goal;
      this.experience.goalStarted(goal, { source: goal.type === 'skill' ? `skill:${goal.name}` : 'brain', reason: 'resumed after reconnecting', state: briefState(bot) });
      this.executor.setGoal(goal);
    }
    if (!this.holdFirstWake) this.wake(this.memory.state.generation === 1 ? 'you just joined the world for the first time' : 'you just reconnected');

    this.reflexTimer = setInterval(() => this.#tick(), this.cfg.reflexIntervalMs);
    this.statsTimer = setInterval(() => {
      const r = this.experience.run;
      this.log(`stats: heap ${(process.memoryUsage().heapUsed / 1e6).toFixed(0)} MB, goal ${this.executor.describe()}, deaths ${r.deaths}, brain ${r.brainCalls} calls $${r.brainCostUsd.toFixed(3)}, jev ${r.jevCalls} calls`);
    }, 60000);
    this.heartbeatTimer = setInterval(() => {
      // Keep a shield in the off-hand whenever we own one.
      if (!this.executor.reflexRunning && bot.inventory.slots[45]?.name !== 'shield') equipShield(bot).catch(() => {});
      if (process.memoryUsage().heapUsed > HEAP_LIMIT_BYTES && this.executor.goal && Date.now() - (this.lastHeapAbort ?? 0) > 30000) {
        this.lastHeapAbort = Date.now();
        const goal = this.executor.describe();
        this.log(`memory runaway during ${goal}; aborting it`);
        try { bot.pathfinder.setGoal(null); } catch {}
        this.executor.setGoal({ type: 'idle', seconds: 5 });
        this.wake(`your goal (${goal}) was aborted because pathfinding ran away; try something else or check your tools`);
        return;
      }
      const quiet = Date.now() - this.lastWake;
      if (!this.executor.goal && quiet > this.cfg.brain.heartbeatMs) this.wake('no current goal');
      else if (quiet > this.cfg.brain.heartbeatMs * 4) this.wake('routine check-in');
    }, 5000);
  }

  // If we're already pressed into a wall (e.g. spawned or teleported there),
  // every move gets corrected. Step to the middle of our own block to get out.
  #watchSnapbacks() {
    const bot = this.bot;
    let recent = [];
    bot.on('forcedMove', () => {
      const now = Date.now();
      recent = recent.filter((t) => now - t < SNAPBACK_WINDOW_MS);
      recent.push(now);
      if (recent.length < SNAPBACK_LIMIT) return;
      recent = [];
      const p = bot.entity.position;
      p.x = Math.floor(p.x) + 0.5;
      p.z = Math.floor(p.z) + 0.5;
      this.log('server kept correcting our position; re-centred in our block');
    });
  }

  #teardown() {
    // The brain belongs to this connection; a reconnect makes a new one.
    this.brain?.stop();
    clearInterval(this.reflexTimer);
    clearInterval(this.heartbeatTimer);
    clearInterval(this.statsTimer);
    this.players?.save();
    this.memory.saveState();
  }

  stop() {
    this.stopped = true;
    this.experience.flush();
    this.memory.appendJsonl('runs.jsonl', { ...this.experience.run, endedAt: new Date().toISOString() });
    this.#teardown();
    this.bot?.quit();
  }

  wake(reason) {
    if (!this.brain || !this.cfg.brain.enabled) {
      this.log(`(brain disabled) wake: ${reason}`);
      return;
    }
    this.lastWake = Date.now();
    // Snapshot lazily: a queued wake-up must see the world when the brain thinks.
    this.brain.wake(reason, () => worldSnapshot(this.bot, this.players, this.executor));
  }

  #onPlayerEvent(ev) {
    switch (ev.type) {
      case 'chat':
        if (ev.addressed) this.wake(`${ev.player} ${ev.whisper ? 'whispered' : 'said'}: "${ev.message}"`);
        break;
      case 'player_joined':
        this.wake(`${ev.player} joined the server${ev.known ? '' : ' (never met before)'}`);
        break;
      case 'player_appeared':
        if (ev.relation === 'unknown' || ev.relation === 'hostile') this.wake(`${ev.player} came into view (relation: ${ev.relation})`);
        break;
      case 'attacked':
        this.wake(`${ev.player} hit you`);
        break;
    }
  }

  async #tick() {
    if (this.ticking || !this.bot?.entity) return;
    this.ticking = true;
    try {
      this.players.update();
      if (!this.executor.reflexRunning) {
        const pick = this.arbiter.choose(ruleState(this.bot, this.players, this.executor));
        if (pick) {
          this.#act(pick);
          return;
        }
      }
      const state = reflexState(this.bot, this.players, this.executor);
      const d = await this.reflexes.decide(state);

      for (const [name, p] of Object.entries(d.threats ?? {})) {
        const last = this.threatAlerted.get(name) ?? 0;
        if (p >= THREAT_ALERT && Date.now() - last > 60000) {
          this.threatAlerted.set(name, Date.now());
          this.memory.log('threat', { player: name, p });
          this.wake(`${name} looks threatening (threat ${p.toFixed(2)})`);
        }
      }

      if (d.source === 'jev') this.experience.count('jevCalls');
      // A choice to carry on only matters when there was something to react to.
      const acting = d.action !== 'continue_goal' && !this.executor.reflexRunning && (d.confidence ?? 1) >= MIN_REFLEX_CONFIDENCE;
      if (acting || (d.source !== 'trivial' && state.hostiles.length)) {
        this.experience.record({ source: d.source, action: acting ? d.action : 'continue_goal', confidence: d.confidence, state: briefState(this.bot) });
      }
      if (acting) {
        this.log(`reflex: ${d.action} (${d.source}${d.confidence ? ' ' + d.confidence.toFixed(2) : ''})`);
        this.executor.reflex(d.action, this.#reflexContext(d));
      }

      if (d.escalate > 0.7 && Date.now() - this.lastEscalation > ESCALATE_COOLDOWN_MS) {
        this.lastEscalation = Date.now();
        this.wake(`the situation changed (reflex layer chose ${d.action})`);
      }
    } catch (err) {
      this.log(`tick error: ${err.message}`);
    } finally {
      this.ticking = false;
    }
  }

  // Hand the body to a behaviour the arbiter picked. The brain's goal is
  // suspended, not replaced, and resumes after the reflex and its hold.
  #act(pick) {
    this.log(`reflex: ${pick.action} (${pick.source}${pick.reason ? ': ' + pick.reason : ''})`);
    this.experience.record({ source: pick.source, action: pick.action, reason: pick.reason, state: briefState(this.bot) });
    this.executor.reflex(pick.action, { memory: this.memory, ...this.#reflexContext({}) }, { holdSeconds: pick.holdSeconds ?? 0 });
    if (pick.wake && Date.now() - (this.behaviourWoke.get(pick.behaviour) ?? 0) > BEHAVIOUR_WAKE_COOLDOWN_MS) {
      this.behaviourWoke.set(pick.behaviour, Date.now());
      this.wake(pick.wake);
    }
  }

  // What happened recently, decision by decision, with the record of each
  // rule, skill or lesson involved: the material for reflection.
  #episode(ms, ask) {
    const recs = this.experience.recent(ms).slice(-25);
    if (!recs.length) return ask;
    const sources = [...new Set(recs.flatMap((r) => [r.source, ...r.cites]))].filter((k) => /^(rule|skill|lesson):/.test(k));
    const records = sources.map((k) => {
      const s = this.experience.score(k);
      return `- ${k}: used ${s.uses}x, ${s.helped} helped, ${s.hurt} hurt, ${s.deaths} deaths`;
    });
    return [
      `What happened (last ${Math.round(ms / 1000)}s, oldest first; [source] decision -> verdict):`,
      ...recs.map((r) => '- ' + describeRecord(r)),
      ...(records.length ? ['Records of the rules, skills and lessons involved:', ...records] : []),
      ask,
    ].join('\n');
  }

  // The lessons Jev is given: pinned ones first, then those that have helped
  // most when followed, then the newest. Lessons improve, so Jev does too.
  #jevLessons(n = 8) {
    const net = (k) => {
      const s = this.experience.score(`lesson:${k.id}`);
      return s ? s.helped - s.hurt : 0;
    };
    return this.memory.knowledge.items
      .filter((k) => k.pinned || /lesson|danger/.test(k.category))
      .map((k, i) => ({ k, i }))
      .sort((a, b) => (b.k.pinned ? 1 : 0) - (a.k.pinned ? 1 : 0) || net(b.k) - net(a.k) || b.i - a.i)
      .slice(0, n)
      .map(({ k }) => k.text);
  }

  #reflexContext(d) {
    const near = this.players.nearby(16);
    const attacker = near.find((p) => p.attackedMeRecently)?.entity;
    const hostilePlayers = near.filter((p) => p.relation === 'hostile' || (d.threats?.[p.name] ?? 0) >= THREAT_ALERT).map((p) => p.entity);
    return { attacker, threats: hostilePlayers, player: near[0]?.entity };
  }
}
