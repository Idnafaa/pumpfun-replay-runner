// Replay Runner — pump.fun replay paper bot (agent-fun/replay/v2).
//
// Run by the grader as `node /bot/main.ts`. The wire protocol lives in the
// vendored SDK shim (vendor/makefun-bot.ts, a byte-identical copy of the kit's
// sdk/ts file); the trading logic lives in strategy.ts.

import { runBot } from './vendor/makefun-bot.ts';
import { createRunner, DEFAULT_PARAMS } from './strategy.ts';

const runner = createRunner(DEFAULT_PARAMS);

await runBot({
  onBatch: (state, batch) => runner.onBatch(state, batch),
});
