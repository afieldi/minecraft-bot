// Persistent memory on disk. Everything the bot knows across restarts and
// brain instances lives in one folder per bot:
//
//   state.json      generation counter, current goal and plan
//   knowledge.json  facts and lessons the brain chose to remember
//   players.json    everyone the bot has met (owned by PlayerTracker)
//   locations.json  named places
//   chests.json     chests the bot knows, who owns them and what was in them
//   handoffs.md     notes each brain instance leaves for the next one
//   journal.jsonl   append-only event log
import fs from 'node:fs';
import path from 'node:path';

const MAX_KNOWLEDGE = 300;

export class Memory {
  constructor(rootDir, botName) {
    this.dir = path.resolve(rootDir, botName);
    fs.mkdirSync(this.dir, { recursive: true });
    this.state = this.#readJson('state.json', {
      generation: 0,
      goal: null,
      plan: [],
      createdAt: new Date().toISOString(),
    });
    this.knowledge = this.#readJson('knowledge.json', { nextId: 1, items: [] });
    this.locations = this.#readJson('locations.json', {});
    this.chests = this.#readJson('chests.json', {});
  }

  #file(name) {
    return path.join(this.dir, name);
  }

  #readJson(name, fallback) {
    try {
      return JSON.parse(fs.readFileSync(this.#file(name), 'utf8'));
    } catch {
      return fallback;
    }
  }

  // Write to a temp file then rename so a crash never leaves half a file.
  writeJson(name, data) {
    const tmp = this.#file(name + '.tmp');
    fs.writeFileSync(tmp, JSON.stringify(data, null, 2));
    fs.renameSync(tmp, this.#file(name));
  }

  readJson(name, fallback) {
    return this.#readJson(name, fallback);
  }

  saveState() {
    this.writeJson('state.json', this.state);
  }

  appendJsonl(name, entry) {
    fs.appendFileSync(this.#file(name), JSON.stringify(entry) + '\n');
  }

  // ---- journal -----------------------------------------------------------
  log(kind, data = {}) {
    const entry = { t: new Date().toISOString(), kind, ...data };
    fs.appendFileSync(this.#file('journal.jsonl'), JSON.stringify(entry) + '\n');
    return entry;
  }

  recentJournal(n = 25) {
    try {
      const lines = fs.readFileSync(this.#file('journal.jsonl'), 'utf8').trim().split('\n');
      return lines.slice(-n).map((l) => JSON.parse(l));
    } catch {
      return [];
    }
  }

  // ---- knowledge ---------------------------------------------------------
  remember(category, text) {
    const item = { id: this.knowledge.nextId++, category, text, t: new Date().toISOString() };
    this.knowledge.items.push(item);
    if (this.knowledge.items.length > MAX_KNOWLEDGE) {
      this.knowledge.items.splice(0, this.knowledge.items.length - MAX_KNOWLEDGE);
    }
    this.writeJson('knowledge.json', this.knowledge);
    return item;
  }

  forget(id) {
    const before = this.knowledge.items.length;
    this.knowledge.items = this.knowledge.items.filter((k) => k.id !== id);
    this.writeJson('knowledge.json', this.knowledge);
    return before !== this.knowledge.items.length;
  }

  // ---- locations ---------------------------------------------------------
  saveLocation(name, pos, dimension, note = '') {
    this.locations[name] = {
      x: Math.round(pos.x), y: Math.round(pos.y), z: Math.round(pos.z),
      dimension, note, t: new Date().toISOString(),
    };
    this.writeJson('locations.json', this.locations);
  }

  // ---- chests ------------------------------------------------------------
  // owner is 'me' for chests the bot placed, a player name, or 'unknown'.
  // The bot only takes from chests that are its own or marked shared.
  static chestKey(pos) {
    return `${Math.floor(pos.x)},${Math.floor(pos.y)},${Math.floor(pos.z)}`;
  }

  chestAt(pos) {
    return this.chests[Memory.chestKey(pos)] ?? null;
  }

  updateChest(pos, fields) {
    const key = Memory.chestKey(pos);
    const rec = this.chests[key] ?? { x: Math.floor(pos.x), y: Math.floor(pos.y), z: Math.floor(pos.z), owner: 'unknown', shared: false };
    this.chests[key] = { ...rec, ...fields, t: new Date().toISOString() };
    this.writeJson('chests.json', this.chests);
    return this.chests[key];
  }

  usableChests() {
    return Object.values(this.chests).filter((c) => c.owner === 'me' || c.shared);
  }

  // ---- handoffs between brain instances ----------------------------------
  writeHandoff(generation, reason, text) {
    const block = `\n## Generation ${generation} handoff (${reason}, ${new Date().toISOString()})\n\n${text.trim()}\n`;
    fs.appendFileSync(this.#file('handoffs.md'), block);
  }

  lastHandoffs(n = 2) {
    try {
      const parts = fs.readFileSync(this.#file('handoffs.md'), 'utf8').split(/\n(?=## Generation )/);
      return parts.filter((p) => p.trim()).slice(-n).join('\n').trim();
    } catch {
      return '';
    }
  }

  chestSummary() {
    return Object.values(this.chests)
      .map((c) => {
        const items = Object.entries(c.contents ?? {}).map(([n, k]) => `${k} ${n}`).join(', ');
        const access = c.owner === 'me' ? 'mine' : c.shared ? `${c.owner}'s, shared with me` : `${c.owner}'s, do not take`;
        return `- ${c.x} ${c.y} ${c.z} (${access})${items ? ': ' + items : ''}`;
      })
      .join('\n');
  }

  // The briefing a fresh brain instance starts with.
  digest(playerSummary, skillSummary) {
    const knowledge = this.knowledge.items
      .slice(-120)
      .map((k) => `- [#${k.id} ${k.category}] ${k.text}`)
      .join('\n');
    const locations = Object.entries(this.locations)
      .map(([n, l]) => `- ${n}: ${l.x} ${l.y} ${l.z} (${l.dimension})${l.note ? ' - ' + l.note : ''}`)
      .join('\n');
    const journal = this.recentJournal(30)
      .map((e) => `- ${e.t.slice(11, 19)} ${e.kind}: ${e.text ?? JSON.stringify(omit(e, ['t', 'kind']))}`)
      .join('\n');
    return [
      `You are generation ${this.state.generation} of this bot's mind.`,
      this.lastHandoffs() ? `# Notes from your previous self\n${this.lastHandoffs()}` : '# Notes from your previous self\n(none, this is your first life)',
      `# Current goal\n${this.state.goal ? JSON.stringify(this.state.goal) : '(none)'}`,
      `# Plan\n${this.state.plan?.length ? this.state.plan.map((s, i) => `${i + 1}. ${s}`).join('\n') : '(none)'}`,
      `# Things you remember\n${knowledge || '(nothing yet)'}`,
      `# Known places\n${locations || '(none saved)'}`,
      `# Chests\n${this.chestSummary() || '(none known)'}`,
      `# People you know\n${playerSummary || '(nobody yet)'}`,
      `# Your saved skills\n${skillSummary || '(none yet)'}`,
      `# Recent events\n${journal || '(none)'}`,
    ].join('\n\n');
  }
}

function omit(obj, keys) {
  const out = { ...obj };
  for (const k of keys) delete out[k];
  return out;
}
