// Tracks every other player the bot encounters: where they are, what they
// said, whether they hurt us, and how the brain feels about them. The record
// is persisted to players.json so relationships survive restarts.

const CHAT_KEEP = 20;
const SWING_WINDOW_MS = 1200;

export class PlayerTracker {
  constructor(bot, memory, trusted = []) {
    this.bot = bot;
    this.memory = memory;
    this.players = memory.readJson('players.json', {});
    this.lastSwing = new Map(); // username -> ms timestamp
    this.listeners = [];
    for (const name of trusted) {
      const rec = this.#get(name);
      if (rec.relation === 'unknown') rec.relation = 'friend';
    }
    this.#attach();
  }

  onEvent(fn) {
    this.listeners.push(fn);
  }

  #emit(ev) {
    for (const fn of this.listeners) fn(ev);
  }

  #get(name) {
    if (!this.players[name]) {
      this.players[name] = {
        name,
        relation: 'unknown', // friend | neutral | wary | hostile | unknown (set by the brain)
        notes: [],
        firstSeen: new Date().toISOString(),
        lastSeen: null,
        lastPos: null,
        encounters: 0,
        attacksOnMe: 0,
        lastAttackAt: null,
        chat: [],
      };
    }
    return this.players[name];
  }

  save() {
    this.memory.writeJson('players.json', this.players);
  }

  #attach() {
    const bot = this.bot;

    bot.on('playerJoined', (p) => {
      if (p.username === bot.username) return;
      const rec = this.#get(p.username);
      this.memory.log('player_joined', { player: p.username });
      this.#emit({ type: 'player_joined', player: p.username, known: rec.encounters > 0 });
    });

    bot.on('playerLeft', (p) => {
      if (p.username === bot.username) return;
      this.memory.log('player_left', { player: p.username });
      this.#emit({ type: 'player_left', player: p.username });
      this.save();
    });

    bot.on('entitySpawn', (e) => {
      if (e.type !== 'player' || e.username === bot.username) return;
      const rec = this.#get(e.username);
      rec.encounters++;
      rec.lastSeen = new Date().toISOString();
      this.#emit({ type: 'player_appeared', player: e.username, relation: rec.relation });
    });

    bot.on('entitySwingArm', (e) => {
      if (e.type === 'player' && e.username) this.lastSwing.set(e.username, Date.now());
    });

    // Mineflayer does not report who caused damage, so we attribute a hit to
    // the closest player who swung their arm within the last moment. Some
    // servers don't send a hurt event to the victim, so a health drop counts too.
    let lastHealth = bot.health;
    bot.on('health', () => {
      if (bot.health < lastHealth) this.#onHurt();
      lastHealth = bot.health;
    });
    bot.on('entityHurt', (e) => { if (e === bot.entity) this.#onHurt(); });

    bot.on('chat', (username, message) => this.#onChat(username, message, false));
    bot.on('whisper', (username, message) => this.#onChat(username, message, true));
  }

  #onHurt() {
    const bot = this.bot;
    const now = Date.now();
    if (now - (this.lastHurtAt ?? 0) < 400) return; // one hit can fire both events
    this.lastHurtAt = now;
    let attacker = null;
    let best = Infinity;
    for (const [name, t] of this.lastSwing) {
      if (now - t > SWING_WINDOW_MS) continue;
      const ent = bot.players[name]?.entity;
      if (!ent) continue;
      const d = ent.position.distanceTo(bot.entity.position);
      if (d < 6 && d < best) { best = d; attacker = name; }
    }
    if (!attacker) return;
    const rec = this.#get(attacker);
    rec.attacksOnMe++;
    rec.lastAttackAt = new Date().toISOString();
    this.memory.log('attacked_by_player', { player: attacker, health: bot.health });
    this.save();
    this.#emit({ type: 'attacked', player: attacker });
  }

  #onChat(username, message, whisper) {
    if (username === this.bot.username) return;
    const rec = this.#get(username);
    rec.chat.push({ t: new Date().toISOString(), message, whisper });
    if (rec.chat.length > CHAT_KEEP) rec.chat.shift();
    this.memory.log('chat', { player: username, text: message, whisper });
    const me = this.bot.username.toLowerCase();
    const ent = this.bot.players[username]?.entity;
    const near = ent && ent.position.distanceTo(this.bot.entity.position) < 24;
    const addressed = whisper || message.toLowerCase().includes(me) || near;
    this.#emit({ type: 'chat', player: username, message, whisper, addressed });
  }

  // Called by the brain.
  setRelation(name, relation, note) {
    const rec = this.#get(name);
    if (relation) rec.relation = relation;
    if (note) {
      rec.notes.push(note);
      if (rec.notes.length > 15) rec.notes.shift();
    }
    this.save();
    return rec;
  }

  // Refresh positions; called on every reflex tick.
  update() {
    for (const [name, p] of Object.entries(this.bot.players)) {
      if (name === this.bot.username || !p.entity) continue;
      const rec = this.#get(name);
      rec.lastSeen = new Date().toISOString();
      rec.lastPos = { x: Math.round(p.entity.position.x), y: Math.round(p.entity.position.y), z: Math.round(p.entity.position.z) };
    }
  }

  recentlyAttackedBy(name, withinMs = 30000) {
    const rec = this.players[name];
    return !!rec?.lastAttackAt && Date.now() - Date.parse(rec.lastAttackAt) < withinMs;
  }

  // Compact view of players currently in render distance.
  nearby(maxDist = 48) {
    const out = [];
    const me = this.bot.entity.position;
    for (const [name, p] of Object.entries(this.bot.players)) {
      if (name === this.bot.username || !p.entity) continue;
      const d = p.entity.position.distanceTo(me);
      if (d > maxDist) continue;
      const rec = this.#get(name);
      out.push({
        name,
        distance: Math.round(d * 10) / 10,
        relation: rec.relation,
        holding: p.entity.heldItem?.name ?? null,
        attacksOnMe: rec.attacksOnMe,
        attackedMeRecently: this.recentlyAttackedBy(name),
        lastSaid: rec.chat.at(-1)?.message ?? null,
        entity: p.entity,
      });
    }
    return out.sort((a, b) => a.distance - b.distance);
  }

  online() {
    return Object.keys(this.bot.players).filter((n) => n !== this.bot.username);
  }

  summary() {
    return Object.values(this.players)
      .sort((a, b) => (b.lastSeen ?? '').localeCompare(a.lastSeen ?? ''))
      .slice(0, 40)
      .map((p) => {
        const bits = [`${p.name} (${p.relation})`, `met ${p.encounters}x`];
        if (p.attacksOnMe) bits.push(`hit me ${p.attacksOnMe}x`);
        if (p.notes.length) bits.push(`notes: ${p.notes.slice(-3).join('; ')}`);
        if (p.chat.length) bits.push(`last said "${p.chat.at(-1).message}"`);
        return '- ' + bits.join(', ');
      })
      .join('\n');
  }
}
