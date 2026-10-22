// Decides, each tick, whether something should take the body away from the
// brain's goal. Behaviours come from providers (today: built-in checks; later:
// rules the bot writes for itself) and are tried in priority order. The first
// one that applies wins; if none does, the reflex layer (Jev or the utility
// scorer) gets to choose.
//
// A behaviour is { name, priority, cooldownSeconds?, applies(state) -> null |
// decision }, where a
// decision is { action, ctx?, holdSeconds?, wake?, reason? }:
//   action       a reflex from REFLEXES
//   holdSeconds  stay put this long after the reflex before resuming the goal
//   wake         tell the brain this (rate-limited per behaviour)
export class Arbiter {
  constructor() {
    this.providers = [];
    this.lastFired = new Map(); // behaviour name -> ms
  }

  addProvider(fn) {
    this.providers.push(fn);
  }

  behaviours() {
    return this.providers.flatMap((p) => p()).sort((a, b) => (b.priority ?? 0) - (a.priority ?? 0));
  }

  choose(state) {
    const now = Date.now();
    for (const b of this.behaviours()) {
      if (b.cooldownSeconds && now - (this.lastFired.get(b.name) ?? 0) < b.cooldownSeconds * 1000) continue;
      let d;
      try {
        d = b.applies(state);
      } catch (err) {
        b.onError?.(err);
        continue;
      }
      if (d) {
        this.lastFired.set(b.name, now);
        return { ...d, behaviour: b.name, source: b.source ?? `behaviour:${b.name}` };
      }
    }
    return null;
  }
}
