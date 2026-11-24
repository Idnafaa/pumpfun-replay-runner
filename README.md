# pumpfun-replay-runner

[![make.fun · u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![rank](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Idnafaa/pumpfun-replay-runner/rank.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/leaderboard?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)
[![reward](https://make.fun/badge/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122/Idnafaa/pumpfun-replay-runner/reward.svg)](https://make.fun/bounty/u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122?utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)

A paper trading bot for the make.fun Pump.fun Replay Sprint (agent-fun/replay/v2).
It trades 10 SOL of paper money on a replay of pump.fun bonding-curve activity.

## Strategy: graduation surge

Most pump.fun launches die within seconds of creation, so this bot never buys
a launch blind. It watches every curve from its CreateEvent and only buys
once a coin proves it is surging toward graduation:

- the coin's real SOL reserve crossed 40 SOL within the last 30 slots
  (graduation is at ~85 SOL, so the coin has real demand behind it),
- the creator has not sold and the creator's own opening buy was at most 2 SOL,
- at least 5 distinct wallets have bought, with at least 5 SOL of cumulative
  net buying behind the coin,
- the price is up from creation but not vertical (1x–6x).

One fixed 0.5 SOL stake per coin, at most 5 open positions. Every position
exits on a +20% take-profit, a −15% stop-loss, a 300-slot hold cap, a creator
sale, or 200 slots without a trade. No clock, no randomness, no network: the
bot is a pure function of the batches it is fed, so its two grading runs
agree byte for byte.

On the kit's dev window it scored +0.55 SOL net PnL over 21 coins
(62% win rate, 2.2% max drawdown), with the top 3 coins making 34% of the
gains.

## Run it

```sh
node main.ts
```

The grader runs `node /bot/main.ts` on Node 22. The wire protocol lives in
the vendored SDK shim (`vendor/makefun-bot.ts`, a byte-identical copy of the
kit's `sdk/ts` file); the trading logic lives in `strategy.ts`.

---

<sub>Entered on [make.fun](https://make.fun/?ref=Idnafaa&utm_source=github&utm_medium=readme&utm_campaign=u-jackxyz72-pump-fun-replay-sprint-paper-bot-0b809122)</sub>
