// Reflex rules the bot writes for itself. A rule is a condition over the
// current situation and one reflex to run when it holds, e.g. "when I'm in
// water with little air, surface". Rules are checked locally every tick,
// highest priority first, before Jev is asked, so a habit costs no network
// call. Every time a rule fires its outcome is scored (see experience.js), and
// the brain revises or deletes rules that don't work.
//
// Rules are JSON data evaluated with the same expression language as skills,
// so nothing the brain writes can run code.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { evaluate } from './skills.js';
import { REFLEXES } from './actions.js';

const ID_RE = /^[a-z][a-z0-9_]{1,40}$/;
const MAX_ERRORS = 20; // a rule that keeps throwing is switched off

export const RULE_DOCS = `A reflex rule: {"id", "description", "when": <condition>, "do": <reflex>, "priority": 0-100, "holdSeconds"?, "cooldownSeconds"?, "tell"?}
- "when" uses the step-list expression language over these variables (as "$name"):
  health, food (0-20), air (0-20, 20 = full), inWater, y, timeOfDay (0-24000), time ("day"|"dusk"|"night"|"dawn"), raining,
  hurtSecondsAgo (seconds since you last took damage), hostiles ([{name, distance, ranged, dy}] within 16 blocks, nearest first),
  players ([{name, distance, relation, holding, attackedMeRecently}]), attackers (names of players who hit you recently),
  weapon (best weapon name or null), hasShield, armorPieces, foodCount, canEat, buildBlocks (dirt/cobble etc. carried), goal (current goal type or null)
- "do" is one of: ${Object.keys(REFLEXES).join(', ')}
- priority: higher rules are checked first; the first rule whose condition holds runs, and Jev decides only when none does
- holdSeconds: after the reflex, wait this long before resuming the current goal (to recover)
- cooldownSeconds: don't fire this rule again for this long
- tell: a sentence you will be woken with when the rule fires (rate-limited)
Example: {"id": "flee_creeper", "description": "Creepers explode; get away from close ones", "when": {"any": ["$hostiles", {"and": [{"eq": ["$it.name", "creeper"]}, {"lt": ["$it.distance", 5]}]}]}, "do": "flee", "priority": 70}`;

export class RuleBook {
  constructor(memory, { experience, log = () => {} } = {}) {
    this.memory = memory;
    this.experience = experience;
    this.log = log;
    this.data = memory.readJson('rules.json', { rules: {}, retiredStarters: [] });
    this.#seedStarters();
  }

  // Bundled starter rules are copied in once. After that they belong to the
  // bot: it can rewrite or delete them, and a deleted one stays deleted.
  #seedStarters() {
    const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'starter-rules');
    if (!fs.existsSync(dir)) return;
    let added = false;
    for (const file of fs.readdirSync(dir).filter((f) => f.endsWith('.json'))) {
      const rule = JSON.parse(fs.readFileSync(path.join(dir, file), 'utf8'));
      if (this.data.rules[rule.id] || this.data.retiredStarters.includes(rule.id)) continue;
      this.data.rules[rule.id] = { ...rule, author: 'starter', version: 1, enabled: true, errors: 0, savedAt: new Date().toISOString() };
      added = true;
    }
    if (added) this.#persist();
  }

  #persist() {
    this.memory.writeJson('rules.json', this.data);
  }

  // Validate and store a rule. `sample` is a live state to test the condition on.
  save(input, sample) {
    const rule = normalize(input);
    if (sample) {
      try {
        evaluate(rule.when, sample);
      } catch (err) {
        throw new Error(`the condition fails on the current situation: ${err.message}`);
      }
    }
    const prev = this.data.rules[rule.id];
    this.data.rules[rule.id] = {
      ...rule,
      author: prev?.author === 'starter' ? 'starter, revised' : prev?.author ?? 'brain',
      version: (prev?.version ?? 0) + 1,
      enabled: true,
      errors: 0,
      savedAt: new Date().toISOString(),
    };
    this.#persist();
    return this.data.rules[rule.id];
  }

  delete(id) {
    const rule = this.data.rules[id];
    if (!rule) return false;
    delete this.data.rules[id];
    if (rule.author?.startsWith('starter') && !this.data.retiredStarters.includes(id)) this.data.retiredStarters.push(id);
    this.#persist();
    return true;
  }

  get(id) {
    return this.data.rules[id] ?? null;
  }

  list() {
    return Object.values(this.data.rules);
  }

  // Arbiter behaviours for the enabled rules.
  behaviours() {
    return this.list().filter((r) => r.enabled).map((rule) => ({
      name: `rule:${rule.id}`,
      source: `rule:${rule.id}`,
      priority: rule.priority,
      cooldownSeconds: rule.cooldownSeconds,
      applies: (state) => (evaluate(rule.when, state)
        ? { action: rule.do, holdSeconds: rule.holdSeconds, wake: rule.tell, reason: rule.description }
        : null),
      onError: (err) => this.#failed(rule, err),
    }));
  }

  #failed(rule, err) {
    rule.errors = (rule.errors ?? 0) + 1;
    rule.lastError = err.message.slice(0, 200);
    if (rule.errors >= MAX_ERRORS) {
      rule.enabled = false;
      this.log(`rule ${rule.id} disabled after ${MAX_ERRORS} errors: ${rule.lastError}`);
    }
    this.#persist();
  }

  // One line per rule with its score, for the brain.
  summary() {
    return this.list()
      .sort((a, b) => b.priority - a.priority)
      .map((r) => {
        const s = this.experience?.score(`rule:${r.id}`);
        const record = s ? `fired ${s.uses}x: ${s.helped} helped, ${s.hurt} hurt${s.deaths ? `, ${s.deaths} deaths` : ''}` : 'never fired';
        const flags = [r.enabled ? null : `DISABLED (${r.lastError})`, r.author].filter(Boolean).join(', ');
        return `- ${r.id} [p${r.priority}] ${r.do}: ${r.description} (${record}; ${flags})`;
      })
      .join('\n');
  }
}

function normalize(r) {
  if (!r || typeof r !== 'object') throw new Error('a rule must be an object');
  if (!ID_RE.test(r.id ?? '')) throw new Error('rule ids are lowercase letters, digits and underscores, starting with a letter');
  if (!REFLEXES[r.do]) throw new Error(`"do" must be one of: ${Object.keys(REFLEXES).join(', ')}`);
  if (r.when === undefined || r.when === null) throw new Error('a rule needs a "when" condition');
  // Models sometimes send the condition as JSON text; a plain string would
  // always be true.
  if (typeof r.when === 'string' && !r.when.startsWith('$')) {
    try {
      r = { ...r, when: JSON.parse(r.when) };
    } catch {
      throw new Error('"when" must be a condition object (or a "$variable"), not text');
    }
  }
  const priority = Number(r.priority ?? 50);
  if (!(priority >= 0 && priority <= 100)) throw new Error('priority must be between 0 and 100');
  const out = { id: r.id, description: String(r.description ?? ''), when: r.when, do: r.do, priority };
  for (const k of ['holdSeconds', 'cooldownSeconds']) {
    if (r[k] !== undefined) {
      const v = Number(r[k]);
      if (!(v >= 0 && v <= 600)) throw new Error(`${k} must be between 0 and 600`);
      out[k] = v;
    }
  }
  if (r.tell) out.tell = String(r.tell).slice(0, 300);
  return out;
}
