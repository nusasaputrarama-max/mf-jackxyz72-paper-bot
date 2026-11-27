# Pump.fun Replay Sprint (jackxyz72) — Fresh-Coin Momentum Sniper

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/nusasaputrarama-max/mf-jackxyz72-paper-bot/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/nusasaputrarama-max/mf-jackxyz72-paper-bot/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A make.fun bounty entry for
[Pump.fun Replay Sprint — Paper Bot, Real Ranking](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122):
a bot that paper-trades 10 SOL on a 24-hour replay of real pump.fun
bonding-curve activity. Best net PnL takes a paid place ($1.00 / $0.60 /
$0.40). No real money, no entry fee, no API keys, no LLM at runtime.

## What it does

`main.ts` (Node 22, standard library only) runs a momentum strategy over the
`agent-fun/replay/v2` harness (`vendor/makefun-bot.ts`, the kit's SDK shim,
vendored byte for byte). The strategy in `strategy.ts` watches every curve's
trade tape and only buys a coin that survived its first minutes and then shows
fresh, accelerating buy pressure over a 60-slot window: real SOL flowing in,
several distinct buyers, price climbing and sitting near its short-window
high. One buy per coin, no pyramiding. A position is sold whole on the first
of a stop loss, a trailing stop, a take-profit, a fade in flow, a whale dump,
or a time limit. Two rules on top of the plain sniper shape:

- **Exit cooldown:** after any exit on a coin, that coin is not re-entered
  for 300 slots, so the bot never buys straight back into a coin that just
  stopped it out.
- **Conviction stake:** a very strong tape (new-half inflow at least twice
  the old half, with at least 12 distinct buyers) earns a 1.0 SOL stake,
  capped by the harness's 1% of real reserve; everything else gets 0.1 SOL.
  The high-conviction tapes are where this market pays, so they get the size.

A pacing probe keeps the run above the guardrail floor (20 coins with a round
trip each) when momentum entries alone fall behind.

Everything is deterministic: no clock, no randomness, so the grader's two
executions produce identical action logs.

## Backtest (kit's dev window, local simulator)

Tuned over ~25 parameter sets on the kit's frozen 24h dev window. Final
settings: **-0.300 SOL** net over the full window (264 fills, 104 coins,
24 wins / 80 losses, max drawdown 0.044). Four consecutive 6h slices:
-0.046 / -0.173 / -0.125 / -0.014. Honest read: no variant tested was
positive on the dev window — this market bleeds momentum — but this is the
least-negative of the variants tried and beats the kit's own sniper pilot
(-0.490 SOL) on the same data. The final window is different data; slice 4
(-0.014) shows the bot can nearly break even on a 6h stretch.

## Run it

The bot speaks the replay protocol on stdin/stdout; the kit grades it with:

```sh
node cli/makefun.mjs grade-local --kit <kit> --bot <this repo> --driver docker --bundle <transcripts.tar.gz>
```

## License

MIT — see [LICENSE](LICENSE).
