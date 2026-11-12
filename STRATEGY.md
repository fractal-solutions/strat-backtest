# The Strat: mechanical implementation rules

The Strat is a discretionary framework, not a fully specified algorithm. This
document defines the exact subset implemented here. It is not a claim to
replicate every trader's Strat execution.

This file describes the **`strat` strategy only**. It is one plug-in in the
strategy registry (`src/strategies/strat.js`). The engine and the contract for
new strategies are documented in `docs/FRAMEWORK.md`; the ICT 2022 model is in
`docs/ICT_2022.md`. The original headline is now a look-ahead regression
fixture; the honest default is `--ambiguous stop`.

## 1. Candle classification

Compare current bar `C` to the previous bar `P` using high/low only:

| Type | Condition |
|---|---|
| `3` (outside) | `C.high > P.high` and `C.low < P.low` |
| `2U` (up) | `C.high > P.high` and `C.low >= P.low` |
| `2D` (down) | `C.high <= P.high` and `C.low < P.low` |
| `1` (inside) | otherwise (both sides contained/equal) |

Equality is handled as shown, matching the Alaric glossary's inclusive inside
bar definition. All signals use completed bars only.

## 2. Setups and triggers

After a completed setup bar `s`, the next bar can trigger a breakout of
`s.high` (long) or `s.low` (short). Stop is the opposite side of `s`.

| Setup label | Setup bar context | Canonical pattern it approximates |
|---|---|---|
| `2-1` | `1` after `2U/2D` | 2-1-2 |
| `3-1` | `1` after `3` | 3-1-2 |
| `1-2` | `2U/2D` after `1` | 1-2-2 |
| `2-2` | `2U/2D` after `2U/2D` | 2-2 continuation/reversal |
| `3-2` | `2U/2D` after `3` | 3-2 |
| `1-1` | `1` after `1` | compression (not canonical) |
| `3` | any bar after `3` | 3-bar breakout |
| `2` | any bar after `2` | 2-bar breakout |

Default: `2-1,3-1,1-2,2-2,3-2`.

The trigger bar's final type is not required at entry; the breakout itself is
the trigger. This is how a stop/breakout order is placed after the setup bar.

## 3. Higher-timeframe continuity (HTF filter)

At the setup bar close, compute the current higher-timeframe candle color from
fixed blocks of execution bars:

- H1 execution: 4 bars (H4) and 24 bars (D1)
- H4 execution: 6 bars (D1) and 30 bars (W1)
- D1 execution: 5 bars (W1) and 21 bars (M1)

A block is bullish if its current close > its opening price, bearish if the
reverse, flat otherwise. When bar timestamps are valid (Yahoo D1), the two HTFs
are calendar-aligned weeks and months; otherwise fixed blocks are used, which is
an approximation for FX session and holiday calendars.

Modes:

- `continuity`: long only if both HTFs are up; short only if both are down.
- `reversal`: long only if both HTFs are down; short only if both are up.
- `all`: ignore HTF.
- `none`: same as all (alias).

If the two HTFs conflict or one is flat, continuity/reversal modes skip the
setup.

## 4. Entry

At bar `i` (the bar after setup `s`), place OCO breakout orders at
`s.high` / `s.low`.

- `intrabar` (default): fill at `max(open, s.high)` for long or
  `min(open, s.low)` for short when the bar trades through the level.
- `close`: fill at the close of `i` only if the close is beyond the trigger.

If both trigger levels are touched in the same bar, the trade is skipped
(ambiguous intrabar path).

## 5. Stop and target

- Stop: setup bar low (long) or high (short).
- Risk `R = |entry - stop|`.
- Target `structural` (default): prior swing high/low over the last 20 bars
  before the setup bar. If that target is less than 0.5R away, use a 2R target.
- Target `2r`: entry +/- 2R.

Exits are checked conservatively:

- Stop is checked before target if both are touched in the same bar.
- Gap through stop/target fills at the open.
- Time exit after `max-hold` bars (default 24 H1 / 12 H4 / 10 D1).
- A target print on the same bar as an intrabar entry is not credited; the trade
  is managed from the next bar because the trigger/target ordering is unknown.

## 6. Costs and sizing

- Spread from the data file, half applied at entry and half at exit.
- Commission 0.5 bp and slippage 0.5 bp per side by default; configurable.
- Swap/financing: rate-based carry (base 3m rate minus quote 3m rate, previous
  month) when valid timestamps exist, plus a 0.2 bp/day swap spread. Feeds
  without valid dates fall back to a flat 0.2 bp/day financing cost.
- Risk 1% of equity per trade. Equity is compounded per trade by
  `1 + risk * netR`.

## 7. Known limitations

- Entry and target rules are mechanical interpretations of discretionary Strat
  guidance.
- Stop/target intrabar ordering is assumed (stop first), not modeled from ticks.
- **Ambiguous entry days are look-ahead by default.** If a day trades through
  both sides of the setup, the engine skips it. In live trading you enter on the
  first touch and cannot know the other side will also trade. Use
  `--ambiguous stop` for an honest bound, or replay on H1/M1. This bias is
  largest on the Sunday partial bar (58% of setups engulfed), but it affects
  every weekday (~20% of signals).
- HTF grouping uses calendar weeks/months when timestamps are valid; otherwise
  fixed bar blocks are used.
- **D1 session definition matters.** The Dukascopy feed emits a short Sunday
  partial bar. Traded as a daily bar it produces a stop ~3x too tight and R
  multiples ~3x too large. `--session merge-sunday` folds it into Monday; this
  is the recommended measurement basis. The rule itself is unchanged.
- No news filter, partials, trailing, or pyramiding. `--exclude-setup-dow` and
  `--preset core` are execution/session filters, not new signal rules.
- No news filter, partials, trailing, or pyramiding. `--exclude-setup-dow` and
  `--preset core` are execution/session filters, not new signal rules.
- Portfolio risk limits exist, and `--vol-target` adds causal vol scaling, but
  neither is a validated edge; they are sizing overlays.
- Broker-feed validation is still pending.
- A date-based walk-forward was run, but the rule is not validated; see README.
  Treat this as a research harness, not a validated strategy.
