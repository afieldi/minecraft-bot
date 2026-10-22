// The fast decision layer, consulted every tick when none of the bot's own
// reflex rules fired. It picks one bounded action: keep working on the brain's
// goal, or handle something (flee, fight, eat, ...), and says whether the
// situation is worth waking the brain for.
//
// Jev makes the call when a key is configured, guided by the bot's best
// lessons; otherwise a small utility scorer does. Which actions are offered
// depends only on what is possible right now, not on what we think is wise:
// the bot's rules and lessons carry the strategy, and every choice made here
// is recorded and scored like any other.

import { hostilesNear, foodItems, bestWeapon } from './perception.js';

export const ACTIONS = {
  continue_goal: 'Keep working on the current goal from the planner.',
  flee: 'Sprint away from nearby hostile mobs and hostile players for a few seconds.',
  fight: 'Attack the nearest hostile mob with the best weapon (raising a shield against archers if the bot has one).',
  defend: 'Fight back against a player who recently hit the bot.',
  eat: 'Eat the most filling food in the inventory.',
  face_player: 'Stop and look at the nearest player, e.g. one who is talking to the bot.',
  surface: 'Swim or dig straight up for air.',
  retreat: 'Get away from close mobs, fight if cornered, eat, and wall in with dirt or cobblestone if it has some.',
  wall_in: 'Build a 1x1 pod of dirt or cobblestone around the bot right where it stands.',
};

export class Reflexes {
  constructor(bot, players, jev, log = () => {}, lessons = () => []) {
    this.bot = bot;
    this.players = players;
    this.jev = jev;
    this.log = log;
    this.lessons = lessons;
    this.lastJevError = 0;
  }

  // Which actions are possible right now.
  candidates() {
    const bot = this.bot;
    const c = ['continue_goal'];
    const hostiles = hostilesNear(bot, 16);
    const attackers = this.players.nearby(10).filter((p) => p.attackedMeRecently);
    const hostilePlayers = this.players.nearby(16).some((p) => p.relation === 'hostile');
    if (hostiles.length || attackers.length || hostilePlayers) c.push('flee', 'retreat');
    if (hostiles.length) c.push('fight');
    if (attackers.length) c.push('defend');
    if (bot.food < 20 && foodItems(bot).length) c.push('eat');
    if (this.players.nearby(6).some((p) => p.relation !== 'hostile')) c.push('face_player');
    if (bot.entity.isInWater && (bot.oxygenLevel ?? 20) < 20) c.push('surface');
    if (hostiles.length && bot.inventory.items().some((i) => /^(dirt|cobblestone|cobbled_deepslate)$/.test(i.name) && i.count >= 10)) c.push('wall_in');
    return c;
  }

  async decide(state) {
    const options = this.candidates();
    if (options.length === 1) return { action: 'continue_goal', escalate: 0, threats: {}, source: 'trivial' };

    if (this.jev.enabled) {
      try {
        return await this.#decideWithJev(state, options);
      } catch (err) {
        if (Date.now() - this.lastJevError > 30000) {
          this.log(`Jev unavailable (${err.message}); using utility fallback`);
          this.lastJevError = Date.now();
        }
      }
    }
    return this.#decideWithUtility(state, options);
  }

  async #decideWithJev(state, options) {
    const lessons = this.lessons();
    const questions = {
      action: {
        type: 'choice',
        instructions:
          'You control the reflexes of a Minecraft survival bot in a multiplayer world. Given `health` (0-20), `food` (0-20), `hostiles`, `players` and `currentGoal`, choose the single best immediate action. Prefer continue_goal unless something needs handling now.' +
          (lessons.length ? ` The bot has learned: ${lessons.map((l) => `- ${l}`).join(' ')}` : ''),
        criteria: Object.fromEntries(options.map((o) => [o, ACTIONS[o]])),
      },
      escalate: {
        type: 'noul',
        instructions:
          'Probability that this situation needs the slower high-level planner to rethink the bot\'s goal now (for example: a new player is close, someone is hostile, health is critical, or the current goal no longer makes sense).',
      },
    };
    // Ask Jev to judge the intent of up to three nearby players we don't already trust.
    const judged = state.players.filter((p) => p.relation !== 'friend').slice(0, 3);
    for (const p of judged) {
      questions[`threat_${p.name}`] = {
        type: 'noul',
        instructions: `Probability that player ${p.name} (see \`players\`) intends to harm the bot or steal from it right now, given their distance, held item, relation and attack history.`,
      };
    }
    const answers = await this.jev.decide(state, questions);
    const action = answers.action?.choice;
    const threats = Object.fromEntries(judged.map((p) => [p.name, answers[`threat_${p.name}`]?.noul ?? 0]));
    return {
      action: options.includes(action) ? action : 'continue_goal',
      confidence: answers.action?.confidence,
      escalate: answers.escalate?.noul ?? 0,
      threats,
      source: 'jev',
    };
  }

  #decideWithUtility(state, options) {
    const bot = this.bot;
    const hostiles = hostilesNear(bot, 12);
    const nearest = hostiles[0]?.distance ?? Infinity;
    const armed = !!bestWeapon(bot);
    const score = {
      continue_goal: 0.3,
      flee: 0,
      fight: 0,
      defend: 0,
      eat: 0,
      face_player: 0,
      surface: 0,
      retreat: 0,
      wall_in: 0,
    };
    if (options.includes('flee')) {
      const danger = hostiles.length * 0.2 + (hostiles.some((h) => h.name === 'creeper' && h.distance < 6) ? 0.6 : 0);
      score.flee = danger + (bot.health < 8 ? 0.6 : 0) + (armed ? 0 : 0.2);
      if (this.players.nearby(16).some((p) => p.relation === 'hostile')) score.flee += 0.5;
    }
    if (options.includes('fight')) {
      score.fight = (nearest < 4 ? 0.7 : 0.4) + (armed ? 0.2 : 0) - (bot.health < 8 ? 0.6 : 0) - (hostiles.length > 2 ? 0.3 : 0);
      if (hostiles[0]?.name === 'creeper') score.fight -= 0.4;
    }
    if (options.includes('defend')) score.defend = bot.health > 8 ? 0.8 : 0.2;
    if (options.includes('eat')) score.eat = (20 - bot.food) / 20 + (bot.health < 14 ? 0.2 : 0) - (nearest < 6 ? 0.5 : 0);
    if (options.includes('face_player')) score.face_player = state.players.some((p) => p.lastSaid) ? 0.35 : 0.2;

    const action = options.reduce((a, b) => (score[b] > score[a] ? b : a), 'continue_goal');
    const threats = {};
    for (const p of state.players) {
      threats[p.name] = p.relation === 'hostile' ? 0.9 : p.attackedMeRecently ? 0.85 : p.relation === 'friend' ? 0.05 : p.holding?.includes('sword') && p.distance < 5 ? 0.4 : 0.15;
    }
    const escalate = bot.health < 6 || Object.values(threats).some((t) => t > 0.7) ? 0.9 : 0.1;
    return { action, escalate, threats, source: 'utility' };
  }
}
