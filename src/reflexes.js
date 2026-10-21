// The fast decision layer. Every tick it looks at the immediate situation and
// picks one bounded action: keep working on the brain's goal, or handle
// something urgent (flee, fight, eat, defend, ...). It also decides whether
// the situation is worth waking the brain for.
//
// Jev makes the call when a key is configured; otherwise a small utility
// scorer does. Jev is only queried when there is a real choice to make, so a
// quiet tick costs nothing.

import { hostilesNear, foodItems, bestWeapon } from './perception.js';

export const ACTIONS = {
  continue_goal: 'Keep working on the current goal from the planner. Right when nothing urgent is happening.',
  flee: 'Run away from nearby threats. Right when outmatched: low health, no weapon, several hostiles, or a dangerous player.',
  fight: 'Attack the nearest hostile mob. Right when it is close, the bot is healthy enough and fleeing would be worse.',
  defend: 'Fight back against a player who is actively attacking the bot.',
  eat: 'Eat food from the inventory. Right when hunger is low or health needs to regenerate and no enemy is in striking distance.',
  face_player: 'Stop and look at a nearby player who is talking to the bot or approaching, so the planner can respond socially.',
};

export class Reflexes {
  constructor(bot, players, jev, log = () => {}) {
    this.bot = bot;
    this.players = players;
    this.jev = jev;
    this.log = log;
    this.lastJevError = 0;
  }

  // Which actions are even possible right now.
  candidates(state) {
    const c = ['continue_goal'];
    const hostiles = hostilesNear(this.bot, 12);
    const attackers = this.players.nearby(10).filter((p) => p.attackedMeRecently);
    if (hostiles.length || attackers.length || this.players.nearby(16).some((p) => p.relation === 'hostile')) c.push('flee');
    if (hostiles.some((h) => h.distance < 8)) c.push('fight');
    if (attackers.length) c.push('defend');
    if (this.bot.food < 18 && foodItems(this.bot).length) c.push('eat');
    if (this.players.nearby(6).some((p) => p.relation !== 'hostile')) c.push('face_player');
    return c;
  }

  async decide(state) {
    const options = this.candidates(state);
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
    const questions = {
      action: {
        type: 'choice',
        instructions:
          'You control the reflexes of a Minecraft survival bot in a multiplayer world. Given `health` (0-20), `food` (0-20), `hostiles`, `players` and `currentGoal`, choose the single best immediate action. Prefer continue_goal unless something needs handling now.',
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
