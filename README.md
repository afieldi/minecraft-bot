# Minecraft bot

A Mineflayer bot for multiplayer survival servers with three layers:

| Layer | What it does | How often |
|---|---|---|
| **Brain** (DeepSeek Flash via OpenRouter, `src/brain.js`) | Sets goals, plans, chats with players, decides who to trust and what to remember | When something happens (chat, a player arrives, you get hit, a goal finishes) plus a slow heartbeat |
| **Reflexes** (Jev via OpenRouter, `src/reflexes.js`) | Picks one immediate action each tick: keep working, flee, fight, defend, eat, or face a player. Also scores how threatening each nearby player is and whether to wake the brain | Every second, but only calls Jev when there is a real choice |
| **Body** (`src/actions.js`, `src/skills.js`) | Runs built-in goals (walking, mining, crafting, smelting, chests, building, shelters, combat, sleeping) and skills the brain wrote itself | Continuously |

Both layers use one OpenRouter key. If Jev is unavailable, or you set `JEV_DISABLED=1`, the reflex layer falls back to a built-in utility scorer, so the bot still works.

## Skills the bot writes itself

The brain isn't limited to the built-in goals. It also has small general actions: dig, place, use an item on a block, plant, find blocks, look around, open chests, craft, wait and so on. It combines them into step lists, for example "find ripe wheat, harvest it, replant".

- `run_steps` runs a step list straight away and shows the brain the result or the error, so it can fix and retry.
- `save_skill` stores a step list that works under a name in `data/<bot>/skills/`. Later it runs in one call as a goal, so the brain doesn't think through every step again.
- Skills carry over to new brain instances along with the rest of the memory, with a record of how often each has worked and its last error.
- Two starter skills, `start_wheat_field` and `tend_wheat` (in `src/starter-skills/`), are written in the same format and show the brain the pattern.

Skills are JSON data, not code. A small interpreter runs them and can only call the bot's own actions, so nothing the brain writes can touch the rest of your computer. Runs stop when the goal changes, when a reflex takes over, or when they hit their time or step limit.

See `SKILL_DOCS` in `src/skills.js` for the format.

## Memory

Everything lives in `data/<bot name>/` and survives restarts:

- `state.json`: brain generation, current goal and plan (the goal resumes after a restart)
- `knowledge.json`: facts and lessons the brain chose to `remember`
- `players.json`: everyone met, with relation (friend / neutral / wary / hostile), notes, recent chat and how often they hit the bot
- `locations.json`: named places
- `skills/`: saved skills and their success records
- `chests.json`: chests the bot knows, who owns each one, whether it may use it, and what was inside last time it looked
- `handoffs.md`: the note each brain instance writes for the next one
- `journal.jsonl`: an event log

**Short-term memory.** The brain sees only its last few wake-ups (`BRAIN_HISTORY_WAKES`, default 6). Its briefing (lessons, places, people, rules, skills, recent events) is rebuilt from these files on every wake, so cost per call stays flat and anything it learns applies at once.

**Generations.** Waking from a bed ends a generation: the brain merges and pins its lessons, fixes or drops rules and skills with bad records, writes a handoff note, and its short-term history is cleared. Restarting the process also starts a new generation.

**Reflection.** After a death (and after a failed goal that cost health) the brain is shown what happened decision by decision, with the record of every rule, skill and lesson involved, and asked what would have prevented it.

## Playing nicely with others

- The bot only takes from chests it placed itself, or ones the brain has marked as shared after a player said so. Unknown chests are treated as someone else's.
- While walking or mining it won't dig through blocks that are usually player-made (planks, glass, doors, bricks, wool, chests and so on). Its own shelters use dirt or cobblestone so it can dig back out.
- The brain is told not to mine other players' builds or attack players unless attacked first.

## Setup

Requires Node 20+ and a Java Edition server (Mineflayer supports 1.8 to 1.21.x).

```bash
npm install
cp .env.example .env   # fill in MC_HOST and OPENROUTER_API_KEY
npm start
```

For an online-mode server, set `MC_AUTH=microsoft` and the bot's Microsoft account email as `MC_USERNAME`; you'll be prompted to sign in once. Put your own name in `TRUSTED_PLAYERS` so the bot treats you as a friend from the start.

Get a key at [openrouter.ai/keys](https://openrouter.ai/keys). The brain defaults to `deepseek/deepseek-v4.1-flash` at `medium` effort. `BRAIN_MODEL` can be any OpenRouter model that supports tool calling, for example `anthropic/claude-opus-5.5` for stronger planning at a higher cost. Jev defaults to `~typesafe/jev-latest`. To call TypeSafe directly instead of through OpenRouter, set `JEV_API_KEY` and `JEV_BASE_URL=https://api.typesafe.ai`.

## Tests

- `npm test` runs offline tests with a simulated bot: player tracking, attack attribution, the Jev request and fallback, chest storage and ownership rules, smelting, the skill interpreter and the starter farming skill.
- `test/goals.sim.mjs` runs the shelter and build goals, a step list and a saved skill on a local server.
- `test/sim.mjs` runs the whole bot against a local server with mock OpenRouter endpoints for the brain and Jev, and checks goals run, memory files are written and the brain hands off between instances. It was run against a [flying-squid](https://github.com/PrismarineJS/flying-squid) 1.16.5 server.

## Known limits

- Damage is attributed to the nearest player who swung in the last moment, since Minecraft does not tell the victim who hit it.
- Shelters are sealed boxes with no door. The bot digs out when its next goal moves it.
- Farming and other skills were tested with a simulated bot only. The local test server has no crops.
- Smelting and chests were tested against a simulated bot only, because the local test server doesn't implement furnaces or chest inventories.
- Jev only sees text, not the screen. All game state passed to it comes from `src/perception.js`.
