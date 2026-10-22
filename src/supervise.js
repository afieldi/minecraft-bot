// Runs the bot and restarts it if it crashes. Memory lives on disk, so a
// restart costs a reconnect, not progress. A rare pathfinding blow-up used to
// take the process out of memory and end the session.
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const entry = fileURLToPath(new URL('./index.js', import.meta.url));
const HEAP_MB = 2048;
const MAX_RESTARTS_PER_HOUR = 20;
const restarts = [];
let child = null;
let stopping = false;

function run() {
  child = spawn(process.execPath, [`--max-old-space-size=${HEAP_MB}`, entry], { stdio: 'inherit' });
  child.on('exit', (code, signal) => {
    if (stopping || code === 0) process.exit(code ?? 0);
    const now = Date.now();
    while (restarts.length && now - restarts[0] > 3600000) restarts.shift();
    if (restarts.length >= MAX_RESTARTS_PER_HOUR) {
      console.log(`[supervisor] bot crashed ${restarts.length} times in an hour; giving up`);
      process.exit(1);
    }
    restarts.push(now);
    console.log(`[supervisor] bot exited (${signal ?? `code ${code}`}); restarting in 5s`);
    setTimeout(run, 5000);
  });
}

const stop = () => {
  stopping = true;
  child?.kill('SIGTERM');
};
process.on('SIGINT', stop);
process.on('SIGTERM', stop);
run();
