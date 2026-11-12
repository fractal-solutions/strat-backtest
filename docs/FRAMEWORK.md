# Strategy framework

The backtester is split into two halves:

- **`src/engine.js`** owns everything that is not strategy logic: data loading,
  session normalization, spread/commission/slippage, financing, date windows,
  stats, result files.
- **`src/strategies/<name>.js`** owns signals, entries, stops, and targets.

`portfolio.js`, `walkforward.js`, `robustness.js`, `sweep.js`, and `validate.js`
consume the trade list, so a new strategy gets the same portfolio, walk-forward,
bootstrap, and deflated-Sharpe machinery without changes.

## Trade contract

A strategy returns an array of trades. The engine validates and summarizes them.

```js
{
  entryIndex, exitIndex,      // bar indices
  entryDate, exitDate,        // YYYY-MM-DD
  direction,                  // +1 long, -1 short
  entry, exit, stop, target,  // prices
  risk,                       // price distance from entry to stop
  grossR, netR, costR,        // R multiples
  barsHeld, reason,           // reason: stop | target | time | eod | ...
  setup,                      // free-form label, e.g. "sweep-ob"
  setupWeekday,               // optional
  htf,                        // optional array of higher-timeframe colours
  strategy                    // filled by the engine if missing
}
```

The engine's `ctx.makeTrade(position, exitPrice, reason, exitIndex)` fills the
cost, carry, and R fields correctly. Prefer it over hand-computing `netR`.

## Adding a strategy

Create `src/strategies/breakout.js`:

```js
export const id = 'breakout';
export const label = '20-bar breakout';
export const defaults = { session: 'raw' };

export function configure(args) {
    return { lookback: Number(args.lookback ?? 20), rMultiple: Number(args.r ?? 2) };
}

export function run(ctx) {
    const { bars, config, start, end } = ctx;
    const trades = [];
    let position = null;

    for (let i = start; i < end; i++) {
        // ... manage/exit position, then look for a new signal ...
        // When you close, use ctx.makeTrade(position, exitPrice, reason, i)
    }
    return trades;
}
```

Register it in `src/strategies/index.js`:

```js
import * as breakout from './breakout.js';
export const STRATEGIES = { strat, breakout, ... };
```

Run it:

```bash
bun run backtest --strategy breakout --data data/broker/EURUSD.csv --symbol EURUSD --tf D1
bun run portfolio --strategy breakout --data-dir data/broker --template "{pair}.csv" --tf D1 ...
```

## Optional hooks

| Export | Purpose |
|---|---|
| `defaults` | Default session and config values |
| `resolveSession(args)` | Choose `raw`, `merge-sunday`, or `drop-sunday` before bars load |
| `configure(args, info)` | Parse strategy flags; `info` has `tf`, `tfDefaults`, `start`, `end` |

`ctx` also provides `ctx.dateOf(index)`, `ctx.rateContext`, `ctx.ratesUsable`,
`ctx.friction`, `ctx.barsPerDay`, `ctx.barsPerYear`, `ctx.riskFraction`, and
`ctx.tfDefaults`.

## Shared ICT helpers

`src/strategies/ict/primitives.js` has mechanical definitions for:

- swing highs/lows,
- liquidity sweeps,
- bullish/bearish fair-value gaps,
- order blocks,
- killzones,
- daily bars and daily bias,
- OTE (62%-79% retracement),
- displacement candles.

`src/strategies/ict/simulate.js` has `simulateLimit` and `simulateMarket`, which
turn a signal into a filled trade with a stop, target, validity window, and time
limit.

## Multiple testing

Every serious trial should be recorded:

```bash
bun run portfolio ... --record-trial "my-strategy-v1"
```

This appends the monthly Sharpe to `results/trials.json`. `validate.js` merges
that registry with the original pre-registered five variants and feeds the full
list to `deflatedSharpeSeries`. If you test twenty strategies and report the
best, the deflated Sharpe must see twenty trials.

## What the framework does not do yet

- Portfolio-level correlation/currency exposure caps.
- Partial exits, trailing stops, and pyramiding as first-class engine features.
  A strategy can implement them internally and still return the final trade, but
  the stats will see one trade per position.
- Tick-level fill ordering. Bar-based simulators are conservative on the fill
  bar (stop first) but cannot resolve every intrabar path.
- A GUI or database. Strategies are plain ES modules, which is enough.

## Honest default

The original Strat strategy now defaults to `--ambiguous stop`. Its old `skip`
behaviour is look-ahead and is kept only as a regression fixture:

```bash
bun run backtest --strategy strat --ambiguous skip ...   # reproduces the old 14.46% / 1.38 headline
bun run backtest --strategy strat ...                    # honest default
```

Do not quote the old headline as achievable. See the README's session-integrity
section for the eligible/engulfed split.
