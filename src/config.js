import 'dotenv/config';

const num = (v, d) => (v === undefined || v === '' ? d : Number(v));
const list = (v) => (v ? v.split(',').map((s) => s.trim()).filter(Boolean) : []);

export const config = {
  mc: {
    host: process.env.MC_HOST || 'localhost',
    port: num(process.env.MC_PORT, 25565),
    username: process.env.MC_USERNAME || 'Claude',
    auth: process.env.MC_AUTH || 'offline',
    version: process.env.MC_VERSION || undefined,
  },
  brain: {
    apiKey: process.env.OPENROUTER_API_KEY || '',
    baseUrl: (process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api').replace(/\/$/, ''),
    model: process.env.BRAIN_MODEL || 'deepseek/deepseek-v4.1-flash',
    effort: process.env.BRAIN_EFFORT || 'medium',
    // How many recent wake-ups the brain sees; older ones live only in memory files.
    historyWakes: num(process.env.BRAIN_HISTORY_WAKES, 6),
    heartbeatMs: num(process.env.BRAIN_HEARTBEAT_SECONDS, 45) * 1000,
    maxToolRounds: 8,
    enabled: process.env.BRAIN_DISABLED !== '1',
  },
  // Jev goes through OpenRouter with the same key by default. To call
  // TypeSafe directly instead, set JEV_API_KEY and JEV_BASE_URL=https://api.typesafe.ai.
  jev: {
    apiKey: process.env.JEV_API_KEY || process.env.OPENROUTER_API_KEY || '',
    model: process.env.JEV_MODEL || '~typesafe/jev-latest',
    baseUrl: process.env.JEV_BASE_URL || process.env.OPENROUTER_BASE_URL || 'https://openrouter.ai/api',
    timeoutMs: num(process.env.JEV_TIMEOUT_MS, 4000),
    disabled: process.env.JEV_DISABLED === '1',
  },
  reflexIntervalMs: num(process.env.REFLEX_INTERVAL_MS, 1000),
  memoryDir: process.env.MEMORY_DIR || './data',
  trustedPlayers: list(process.env.TRUSTED_PLAYERS),
};
