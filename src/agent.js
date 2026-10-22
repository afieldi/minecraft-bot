// Wires the pieces together: Mineflayer body, reflex loop, brain wake-ups,
// memory and brain rotation on sleep.
import mineflayer from 'mineflayer';
import pathfinderPkg from 'mineflayer-pathfinder';
import pvpPkg from 'mineflayer-pvp';
import collectBlockPkg from 'mineflayer-collectblock';
import { Memory } from './memory.js';
import { PlayerTracker } from './players.js';
import { Executor } from './actions.js';
import { Reflexes } from './reflexes.js';
import { JevClient } from './jev.js';
import { Brain } from './brain.js';
import { SkillLibrary, registerSkillGoals } from './skills.js';
import { reflexState, worldSnapshot, hostilesNear, foodItems } from './perception.js';

const { pathfinder, Movements } = pathfinderPkg;
const ESCALATE_COOLDOWN_MS = 20000;
const THREAT_ALERT = 0.75;
// Jev sometimes picks flee/fight with very low confidence; acting on those
// makes the bot abandon its goal over nothing.
const MIN_REFLEX_CONFIDENCE = 0.3;
// Below this the body retreats on its own; the brain is too slow to react in time.
const LOW_HEALTH = 8;
const RETREAT_COOLDOWN_MS = 20000;
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
    const movements = new Movements(bot);
    movements.allowSprinting = true;
    // Don't tunnel through things other players build while walking or mining.
    for (const b of Object.values(bot.registry.blocksByName)) {
      if (PLAYER_MADE.test(b.name)) movements.blocksCantBreak.add(b.id);
    }
    bot.pathfinder.setMovements(movements);
    bot.collectBlock.movements = movements; // otherwise collectBlock swaps in its own

    this.players = new PlayerTracker(bot, this.memory, this.cfg.trustedPlayers);
    this.executor = new Executor(bot, this.memory, log);
    this.reflexes = new Reflexes(bot, this.players, this.jev, log);
    this.skills = new SkillLibrary(this.memory);
    registerSkillGoals(this.skills);
    this.brain = new Brain({ bot, memory: this.memory, players: this.players, executor: this.executor, skills: this.skills, config: this.cfg.brain, log });
    this.lastEscalation = 0;
    this.lastWake = 0;
    this.threatAlerted = new Map();

    // Every process start is a new brain instance.
    this.memory.state.generation++;
    this.memory.saveState();
    this.memory.log('spawned', { generation: this.memory.state.generation, pos: bot.entity.position });
    this.log(`spawned as ${bot.username} (brain generation ${this.memory.state.generation}, decisions by ${this.jev.enabled ? 'Jev' : 'utility fallback'})`);

    this.executor.onGoalFinished = (r) => this.wake(`goal ${r.ok ? 'finished' : 'failed'}: ${r.message}`);
    this.players.onEvent((ev) => this.#onPlayerEvent(ev));

    bot.on('death', () => {
      this.memory.log('died', { pos: bot.entity.position });
      this.wake('you died and respawned; your inventory was dropped where you died');
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
    if (this.memory.state.goal) this.executor.setGoal(this.memory.state.goal);
    this.wake(this.memory.state.generation === 1 ? 'you just joined the world for the first time' : 'you just reconnected');

    this.reflexTimer = setInterval(() => this.#tick(), this.cfg.reflexIntervalMs);
    this.heartbeatTimer = setInterval(() => {
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
    clearInterval(this.reflexTimer);
    clearInterval(this.heartbeatTimer);
    this.players?.save();
    this.memory.saveState();
  }

  stop() {
    this.stopped = true;
    this.#teardown();
    this.bot?.quit();
  }

  wake(reason) {
    if (!this.brain || !this.cfg.brain.enabled) {
      this.log(`(brain disabled) wake: ${reason}`);
      return;
    }
    this.lastWake = Date.now();
    this.brain.wake(reason, worldSnapshot(this.bot, this.players, this.executor));
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
      // Only take over when retreating helps: something is near, or there's food
      // to eat. Low health with neither means the brain needs to go hunt.
      const canHelp = hostilesNear(this.bot, 12).length > 0 || (this.bot.food < 20 && foodItems(this.bot).length > 0);
      if (this.bot.health <= LOW_HEALTH && canHelp && !this.executor.reflexRunning && Date.now() - (this.lastRetreat ?? 0) > RETREAT_COOLDOWN_MS) {
        this.lastRetreat = Date.now();
        this.log(`reflex: retreat (health ${this.bot.health.toFixed(1)})`);
        this.executor.reflex('retreat', { memory: this.memory });
        // Don't resume whatever got us hurt (e.g. a deep mine) once the reflex ends.
        this.executor.setGoal({ type: 'idle', seconds: 30 });
        this.wake(`your health is low (${this.bot.health.toFixed(1)}/20); your body is retreating, walling in and eating. Recover before doing anything risky`);
        return;
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

      if (d.action !== 'continue_goal' && !this.executor.reflexRunning && (d.confidence ?? 1) >= MIN_REFLEX_CONFIDENCE) {
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

  #reflexContext(d) {
    const near = this.players.nearby(16);
    const attacker = near.find((p) => p.attackedMeRecently)?.entity;
    const hostilePlayers = near.filter((p) => p.relation === 'hostile' || (d.threats?.[p.name] ?? 0) >= THREAT_ALERT).map((p) => p.entity);
    return { attacker, threats: hostilePlayers, player: near[0]?.entity };
  }
}
