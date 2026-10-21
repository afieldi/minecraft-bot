// Turns raw Mineflayer state into compact snapshots for the decision layer
// (every tick) and the brain (on wake-ups).

const HOSTILE = new Set([
  'zombie', 'husk', 'drowned', 'skeleton', 'stray', 'bogged', 'creeper', 'spider', 'cave_spider',
  'enderman', 'witch', 'slime', 'magma_cube', 'phantom', 'pillager', 'vindicator', 'evoker',
  'ravager', 'vex', 'blaze', 'ghast', 'wither_skeleton', 'piglin_brute', 'hoglin', 'zoglin',
  'silverfish', 'endermite', 'guardian', 'elder_guardian', 'warden', 'breeze', 'creaking', 'zombie_villager',
]);
const VALUABLE_BLOCKS = [
  'diamond_ore', 'deepslate_diamond_ore', 'iron_ore', 'deepslate_iron_ore', 'coal_ore', 'gold_ore',
  'copper_ore', 'chest', 'crafting_table', 'furnace',
];

export function isHostile(entity) {
  if (!entity || entity.type === 'player') return false;
  return entity.type === 'hostile' || HOSTILE.has(entity.name);
}

// Mobs more than this far above or below are usually in a cave under us or on
// a cliff: not an immediate threat, and fleeing from them just loops.
const MAX_THREAT_DY = 5;

export function hostilesNear(bot, maxDist = 16) {
  const me = bot.entity.position;
  return Object.values(bot.entities)
    .filter((e) => e !== bot.entity && isHostile(e) && e.position.distanceTo(me) <= maxDist && Math.abs(e.position.y - me.y) <= MAX_THREAT_DY)
    .map((e) => ({ name: e.name, distance: Math.round(e.position.distanceTo(me) * 10) / 10, entity: e }))
    .sort((a, b) => a.distance - b.distance);
}

export function foodItems(bot) {
  const foods = bot.registry.foodsByName ?? {};
  return bot.inventory.items().filter((i) => foods[i.name] && !['rotten_flesh', 'spider_eye', 'poisonous_potato', 'pufferfish'].includes(i.name));
}

export function bestWeapon(bot) {
  const order = ['netherite_sword', 'diamond_sword', 'iron_sword', 'stone_sword', 'golden_sword', 'wooden_sword',
    'netherite_axe', 'diamond_axe', 'iron_axe', 'stone_axe', 'wooden_axe'];
  const items = bot.inventory.items();
  for (const name of order) {
    const it = items.find((i) => i.name === name);
    if (it) return it;
  }
  return null;
}

export function inventorySummary(bot) {
  const counts = {};
  for (const it of bot.inventory.items()) counts[it.name] = (counts[it.name] ?? 0) + it.count;
  return counts;
}

function timeLabel(t) {
  if (t < 12000) return 'day';
  if (t < 13000) return 'dusk';
  if (t < 23000) return 'night';
  return 'dawn';
}

// Small, fast snapshot for the reflex/decision layer.
export function reflexState(bot, players, executor) {
  const hostiles = hostilesNear(bot);
  const nearPlayers = players.nearby(24);
  return {
    health: bot.health,
    food: bot.food,
    time: timeLabel(bot.time.timeOfDay),
    isRaining: bot.isRaining,
    inWater: bot.entity.isInWater,
    hasFood: foodItems(bot).length > 0,
    weapon: bestWeapon(bot)?.name ?? 'none',
    armorPieces: [5, 6, 7, 8].filter((s) => bot.inventory.slots[s]).length,
    currentGoal: executor.describe(),
    hostiles: hostiles.slice(0, 5).map(({ name, distance }) => ({ name, distance })),
    players: nearPlayers.slice(0, 5).map(({ entity, ...rest }) => rest),
  };
}

// Richer snapshot for the brain.
export function worldSnapshot(bot, players, executor) {
  const pos = bot.entity.position;
  const valuable = [];
  for (const name of VALUABLE_BLOCKS) {
    const id = bot.registry.blocksByName[name]?.id;
    if (id === undefined) continue;
    const found = bot.findBlock({ matching: id, maxDistance: 24 });
    if (!found) continue;
    const entry = { block: name, at: fmt(found.position), distance: Math.round(found.position.distanceTo(pos)) };
    if (name === 'chest') {
      const rec = executor.memory?.chestAt(found.position);
      entry.owner = rec ? rec.owner : 'unknown (treat as someone else\'s)';
    }
    valuable.push(entry);
  }
  const animals = Object.values(bot.entities)
    .filter((e) => e !== bot.entity && e.type !== 'player' && !isHostile(e) && e.position.distanceTo(pos) < 24 && (e.type === 'animal' || e.type === 'passive' || e.type === 'mob'))
    .slice(0, 8)
    .map((e) => e.name);
  return {
    position: fmt(pos),
    dimension: bot.game.dimension,
    biome: bot.blockAt(pos)?.biome?.name ?? 'unknown',
    health: bot.health,
    food: bot.food,
    timeOfDay: bot.time.timeOfDay,
    time: timeLabel(bot.time.timeOfDay),
    raining: bot.isRaining,
    holding: bot.heldItem?.name ?? null,
    inventory: inventorySummary(bot),
    currentGoal: executor.describe(),
    lastGoalResult: executor.lastResult,
    hostilesNearby: hostilesNear(bot, 24).slice(0, 8).map(({ name, distance }) => ({ name, distance })),
    playersNearby: players.nearby(64).map(({ entity, ...rest }) => rest),
    playersOnline: players.online(),
    animalsNearby: [...new Set(animals)],
    notableBlocksNearby: valuable,
    standingOn: bot.blockAt(pos.offset(0, -1, 0))?.name ?? null,
  };
}

export function fmt(v) {
  return { x: Math.round(v.x), y: Math.round(v.y), z: Math.round(v.z) };
}
