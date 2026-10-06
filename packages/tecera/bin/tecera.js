#!/usr/bin/env node
import { main } from '@tecera/runtime';

// Cancellation bridge: the first SIGINT/SIGTERM aborts the run (the Loop stops dispatching, verify process
// groups are killed, run.interrupted is recorded, exit 130); a second signal exits immediately.
const ac = new AbortController();
let signals = 0;
const onSignal = (sig) => {
  signals++;
  if (signals > 1) process.exit(130);
  process.stderr.write(`tecera: ${sig} received; stopping (send again to exit now)\n`);
  ac.abort(new Error(`interrupted by ${sig}`));
};
process.on('SIGINT', onSignal);
process.on('SIGTERM', onSignal);

process.exitCode = await main(process.argv.slice(2), { signal: ac.signal });
process.off('SIGINT', onSignal);
process.off('SIGTERM', onSignal);
