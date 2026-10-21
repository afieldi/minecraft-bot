import { config } from './config.js';
import { Agent } from './agent.js';

const agent = new Agent(config);
agent.start();

const shutdown = () => {
  agent.log('shutting down');
  agent.stop();
  setTimeout(() => process.exit(0), 500);
};
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);
