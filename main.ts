// Pump.fun Replay Sprint (jackxyz72) — a fresh-coin momentum sniper with
// exit-cooldown and conviction-scaled stake. The grader runs `node
// /bot/main.ts`; the strategy lives in strategy.ts and the SDK shim is the
// kit's sdk/ts/makefun-bot.ts, vendored byte for byte.

import { runBot } from './vendor/makefun-bot.ts';
import { createStrategy, DEFAULT_PARAMS } from './strategy.ts';

await runBot(createStrategy(DEFAULT_PARAMS));
