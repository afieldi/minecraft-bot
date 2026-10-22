// Records what the bot decided, what made the decision, and what happened
// next, so the bot can learn from outcomes instead of us adding code after
// every death.
//
// Every decision is tagged with its source: a learned rule ("rule:<id>"), a
// built-in behaviour, Jev, the utility scorer, a brain goal, or a skill
// ("skill:<name>"). Reflex decisions are judged on the next WINDOW_MS (did we
// take damage, did we die); goals are judged when they end (finished, failed,
// replaced) plus any damage or death on the way. The verdict is added to that
// source's running score in scores.json, and the full record goes to
// experience.jsonl. Reflection reads both.
import fs from 'node:fs';
import path from 'node:path';

const WINDOW_MS = 20000;
const HURT_DAMAGE = 4; // two hearts or more inside the window counts against a decision
const RECENT_KEEP = 300;
const CONTINUE_LOG_MS = 5000; // "carry on" choices are frequent; keep one per source per 5s

export class Experience {
  constructor(memory, { windowMs = WINDOW_MS } = {}) {
    this.memory = memory;
    this.windowMs = windowMs;
    this.file = path.join(memory.dir, 'experience.jsonl');
    this.scores = memory.readJson('scores.json', {});
    this.open = new Map(); // id -> record still being judged
    this.recentList = [];
    this.nextId = 1;
    this.lastContinue = new Map();
    this.goalRecords = new WeakMap();
    // Counters for the current process, for per-run reports.
    this.run = { startedAt: new Date().toISOString(), decisions: 0, deaths: 0, damage: 0, brainCalls: 0, brainCostUsd: 0, brainTokens: 0, jevCalls: 0 };
  }

  // Attach to the bot's health and death events. Separate from the
  // constructor so the recorder survives reconnects (a new bot each time).
  attach(bot) {
    let last = bot.health ?? 20;
    bot.on('health', () => {
      const h = bot.health;
      if (h < last) this.#damage(last - h);
      last = h;
    });
    bot.on('death', () => this.#death());
    bot.on('spawn', () => { last = bot.health ?? 20; });
  }

  count(name, n = 1) {
    this.run[name] = (this.run[name] ?? 0) + n;
  }

  // Start judging a decision. `state` is a small snapshot of the situation.
  record({ source, action, reason, confidence, state, kind = 'reflex', cites = [] }) {
    if (action === 'continue_goal') {
      const last = this.lastContinue.get(source) ?? 0;
      if (Date.now() - last < CONTINUE_LOG_MS) return null;
      this.lastContinue.set(source, Date.now());
    }
    const rec = {
      id: this.nextId++, t: new Date().toISOString(), kind, source, action,
      reason, confidence, state, cites, damage: 0, died: false,
    };
    this.open.set(rec.id, rec);
    this.run.decisions++;
    if (kind === 'reflex') rec.timer = setTimeout(() => this.#close(rec), this.windowMs);
    return rec;
  }

  // Goals are judged when they end rather than after a fixed window.
  goalStarted(goal, { source, reason, cites = [], state }) {
    const rec = this.record({ source, action: goal.type, reason, state, kind: 'goal', cites });
    rec.goal = summarizeGoal(goal);
    this.goalRecords.set(goal, rec);
    return rec;
  }

  goalEnded(goal, result) {
    const rec = this.goalRecords.get(goal);
    if (!rec || !this.open.has(rec.id)) return;
    rec.result = result ? (result.ok ? 'finished' : 'failed') : 'replaced';
    rec.message = result?.message?.slice(0, 300);
    this.#close(rec);
  }

  #damage(amount) {
    this.run.damage += amount;
    for (const rec of this.open.values()) rec.damage += amount;
  }

  #death() {
    this.run.deaths++;
    for (const rec of [...this.open.values()]) {
      rec.died = true;
      this.#close(rec);
    }
  }

  #close(rec) {
    if (!this.open.delete(rec.id)) return;
    clearTimeout(rec.timer);
    delete rec.timer;
    rec.verdict = verdict(rec);
    rec.closedAt = new Date().toISOString();
    for (const key of [rec.source, ...rec.cites]) this.#score(key, rec);
    this.recentList.push(rec);
    if (this.recentList.length > RECENT_KEEP) this.recentList.shift();
    try {
      fs.appendFileSync(this.file, JSON.stringify(rec) + '\n');
    } catch {}
  }

  #score(key, rec) {
    if (!key) return;
    const s = (this.scores[key] ??= { uses: 0, helped: 0, hurt: 0, deaths: 0 });
    s.uses++;
    if (rec.verdict === 'helped') s.helped++;
    if (rec.verdict === 'hurt') s.hurt++;
    if (rec.died) s.deaths++;
    s.lastUsed = rec.closedAt;
    s.lastVerdict = rec.verdict;
    this.memory.writeJson('scores.json', this.scores);
  }

  score(key) {
    return this.scores[key] ?? null;
  }

  // Closed records from the last `ms`, newest last, for reflection.
  recent(ms = 120000) {
    const since = Date.now() - ms;
    return this.recentList.filter((r) => Date.parse(r.closedAt) >= since);
  }

  // Close everything still open, e.g. on shutdown.
  flush() {
    for (const rec of [...this.open.values()]) this.#close(rec);
  }
}

// helped: no death and little damage (and, for goals, it finished).
// hurt: died, took real damage, or the goal failed. neutral: a goal that
// was replaced before it ended, without harm.
export function verdict(rec) {
  if (rec.died || rec.damage >= HURT_DAMAGE) return 'hurt';
  if (rec.kind === 'goal') return rec.result === 'finished' ? 'helped' : rec.result === 'failed' ? 'hurt' : 'neutral';
  return 'helped';
}

function summarizeGoal(goal) {
  const { progress, steps, ...rest } = goal;
  return steps ? { ...rest, steps: `${steps.length} steps` } : rest;
}

// One line per record, for the brain.
export function describeRecord(r) {
  const what = r.kind === 'goal' ? `goal ${JSON.stringify(r.goal)}` : r.action;
  const outcome = [r.result, r.damage ? `took ${r.damage.toFixed(1)} damage` : null, r.died ? 'DIED' : null].filter(Boolean).join(', ');
  const st = r.state ? ` | health ${r.state.health}, hostiles ${(r.state.hostiles ?? []).map((h) => `${h.name}@${h.distance}`).join(' ') || 'none'}` : '';
  return `${r.t.slice(11, 19)} [${r.source}] ${what}${r.reason ? ` (${r.reason})` : ''} -> ${r.verdict}${outcome ? `: ${outcome}` : ''}${st}`;
}
