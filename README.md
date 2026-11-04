# The Strat backtester

A dependency-light backtest harness for a mechanical subset of **The Strat**
price-action framework (Rob Smith). Data comes from `dukascopy-node`; the live
signal UI uses `chalk`, `boxen`, and `cli-table3`. It
classifies candles as 1 / 2U / 2D / 3, detects the common combos, applies a
higher-timeframe continuity filter, and trades breakout triggers with structural
stops and targets.

The target is a **multi-pair D1 portfolio**, not a single EURUSD model. This repo
now contains per-pair backtests, date-based walk-forward validation, trade
bootstrap, deflated Sharpe, and a portfolio engine with daily mark-to-market.

> **Status: research prototype. Not validated for live trading.** The strict
> pre-registered gate is a narrow NO-GO (portfolio monthly DSR 0.930 vs 0.95).
> The full-history check passes (0.992), but it was run after the near miss and
> is not a pristine confirmation. Do not risk real capital.

## TL;DR

| Item | Result |
|---|---|
| Rule | Mechanical Strat, D1, frozen |
| Timeframes | H1/H4 fail after costs; D1 is the only viable timeframe |
| Broker-feed walk-forward | 4/4 folds positive, +0.148R, PF 1.29 |
| Portfolio 2014-2026 | CAGR 14.46%, Sharpe 1.38, maxDD -13.24%, DSR 0.930 **FAIL** |
| Portfolio 2008-2026 | CAGR 15.20%, Sharpe 1.44, maxDD -13.24%, DSR 0.992 **PASS** |
| Decision | No live capital; paper trading is the only justified next step |

## Live D1 signal generator

Run the full scan with one command:

```bash
bun run signals
```

It fetches fresh Dukascopy D1 bars for the 16-pair universe, uses the last
completed daily bar as the setup, and prints conditional orders for the next
session. It also fetches the latest H1 bar so each signal can be marked:

- `WAITING`: trigger not reached.
- `TRIGGERED`: H1 close is already beyond the entry.
- `INVALIDATED`: H1 close is already beyond the stop.
- `TARGET REACHED`: target already reached.

Recommended daily run time: around **02:00 GMT+3**, after the New York daily
close and the Dukascopy feed update. New York closes at 00:00 GMT+3 during US
summer time and 01:00 GMT+3 during US winter time, so 02:00 GMT+3 is a safe
year-round recommendation. This is a recommendation, not a rule; the generator
always uses the last completed bar regardless of when it is run.

Each card and table row also carries a subtle A/B/C rating:

- A: `2-1` and `3-1`
- B: `1-2`
- C: `2-2` and `3-2`

The rating is historical 2014-2026 setup expectancy, not a probability or
position-sizing instruction. It is only a prioritization label.

The terminal UI has four parts:

1. Header: run time, feed, last bar, next session, freshness, and counts.
2. Pending orders: full cards with entry, stop, target, risk, R:R, HTF, and last price.
3. Triggered/active: compact table with the same key levels.
4. Stand down/closed: no setup, filtered setup, HTF conflict, invalidated, or target reached.

Example header:

```text
last bar 2026-11-03   orders for 2026-11-04   FRESH
4 pending   7 triggered   3 closed
```

Options:

| Flag | Meaning |
|---|---|
| `--pairs EURUSD,GBPUSD` | Restrict the scan |
| `--days 220` | D1 lookback in calendar days |
| `--htf continuity` | `continuity`, `all`, `reversal`, or `none` |
| `--setups 2-1,3-1,...` | Limit setup names |
| `--cards` | Full cards for already-triggered signals |
| `--offline` | Use the local CSV snapshot and mark it stale |
| `--no-quote` | Skip the H1 last-price status |
| `--no-color` | Disable ANSI color |
| `--help` | Show usage |

The bot does not place orders. It uses the last completed D1 bar and the latest
completed H1 bar, not a live tick stream. If run during the session, some
triggers may already have fired; the status column makes that visible.

### Debug / troubleshooting

**`Cannot find module './rules/string'` from `fastest-validator`**

This is an incomplete install, not a missing repo file. `fastest-validator`
normally ships `lib/rules/string.js`. It is common on Acode/Android because
Bun's default hardlink install can leave partial packages on shared storage.

Reinstall with the copyfile backend:

```bash
rm -rf node_modules
bun pm cache rm
bun install --backend=copyfile
bun run signals
```

If `bun pm cache rm` is unavailable:

```bash
rm -rf ~/.bun/install/cache
bun install --backend=copyfile
```

If Bun still fails, install with npm and run with Bun:

```bash
rm -rf node_modules
npm install
bun run signals
```

Verify the package file exists:

```bash
ls node_modules/fastest-validator/lib/rules/string.js
```

## What is actually working on D1

These are all **signal-level** results across the 16-pair Dukascopy broker feed,
2014-2026. The portfolio applies risk caps, so its trade count differs; this
table shows which Strat setups carry the edge before portfolio sizing.

| Setup | Trades | Win rate | Avg net R | PF | Total net R |
|---|---|---|---|---|---|
| `2-1` | 798 | 47.1% | +0.464 | 1.80 | +370.1 |
| `3-1` | 293 | 48.8% | +0.447 | 1.86 | +131.1 |
| `1-2` | 854 | 47.5% | +0.151 | 1.30 | +129.1 |
| `2-2` | 2,809 | 44.9% | +0.071 | 1.14 | +199.1 |
| `3-2` | 1,962 | 45.7% | +0.081 | 1.16 | +158.5 |
| All | 6,716 | 45.9% | +0.147 | 1.28 | +987.9 |

`Total net R` sums each trade at 1R risk; it is not portfolio PnL. The edge is
concentrated in **inside-bar-after-directional/outside breakouts** (`2-1`,
`3-1`). `2-2` and `3-2` trade often but are only marginally profitable.

### Direction split

| Side | Trades | Win rate | Avg net R | PF | Total net R |
|---|---|---|---|---|---|
| Long | 3,567 | 46.5% | +0.202 | 1.39 | +719.0 |
| Short | 3,149 | 45.2% | +0.085 | 1.16 | +268.9 |

The long side carried most of the edge in this sample.

### Pair composition (portfolio contribution, 2014-2026)

Contribution is `risk amount * net R` summed over the portfolio, in percentage
points of initial equity. Bars are relative to the largest absolute contribution.

| Pair | Trades | Win rate | Avg net R | PF | Contribution | Bar |
|---|---|---|---|---|---|---|
| AUDJPY | 450 | 48.0% | +0.358 | 1.72 | +110.02% | `##########` |
| USDCAD | 419 | 48.2% | +0.210 | 1.41 | +83.22% | `########` |
| EURAUD | 417 | 47.7% | +0.222 | 1.46 | +71.87% | `#######` |
| GBPJPY | 418 | 46.4% | +0.191 | 1.38 | +67.23% | `######` |
| NZDUSD | 458 | 46.5% | +0.175 | 1.34 | +60.48% | `#####` |
| EURUSD | 405 | 51.1% | +0.236 | 1.49 | +58.94% | `#####` |
| CHFJPY | 438 | 44.5% | +0.076 | 1.14 | +57.28% | `#####` |
| AUDUSD | 419 | 43.2% | +0.111 | 1.22 | +54.53% | `#####` |
| CADJPY | 420 | 49.0% | +0.227 | 1.45 | +52.07% | `#####` |
| USDJPY | 422 | 45.5% | +0.190 | 1.36 | +41.11% | `####` |
| GBPUSD | 396 | 47.2% | +0.131 | 1.26 | +35.43% | `###` |
| EURCHF | 405 | 44.2% | +0.056 | 1.10 | +34.85% | `###` |
| EURJPY | 416 | 44.7% | +0.099 | 1.19 | +32.62% | `###` |
| EURCAD | 404 | 43.3% | +0.059 | 1.11 | +15.29% | `#` |
| USDCHF | 408 | 47.3% | +0.107 | 1.22 | +9.89% | `#` |
| EURGBP | 421 | 37.1% | -0.116 | 0.81 | -26.93% | `--` |

The portfolio is not carried by one pair. It is broad, with JPY crosses and
commodity crosses leading. EURGBP is the clear negative outlier; it was **not**
removed after the fact.

## Yearly results

### Portfolio variants by year (2008-2026, frozen rule and costs)

Each cell is that variant's portfolio return for the calendar year.

| Year | default (frozen) | all | reversal | 2R | close |
|---|---|---|---|---|---|
| 2008 | +29.0% | +20.3% | -10.7% | +21.4% | +2.9% |
| 2009 | +7.8% | +37.4% | +33.5% | +9.0% | -3.4% |
| 2010 | +23.6% | +23.3% | +3.4% | +18.0% | -0.8% |
| 2011 | +31.6% | +33.2% | +64.5% | +30.5% | -3.3% |
| 2012 | +22.6% | +37.0% | +0.9% | +15.8% | +4.2% |
| 2013 | +15.2% | +39.6% | +35.4% | +13.1% | -3.0% |
| 2014 | -2.8% | +9.8% | +38.2% | +1.7% | -9.6% |
| 2015 | +28.3% | +62.2% | +54.4% | +28.4% | +2.5% |
| 2016 | +18.9% | +21.8% | +58.6% | +16.6% | -5.3% |
| 2017 | +6.2% | +25.1% | +50.6% | +10.4% | -10.4% |
| 2018 | +21.2% | +27.2% | +35.8% | +29.2% | -3.9% |
| 2019 | +18.1% | +33.4% | +48.7% | +15.2% | -3.9% |
| 2020 | +10.4% | +26.7% | +56.7% | +11.8% | -5.6% |
| 2021 | +19.1% | +30.1% | +16.2% | +12.7% | -5.2% |
| 2022 | +32.9% | +31.6% | +47.3% | +23.0% | -2.9% |
| 2023 | +10.7% | +23.2% | +26.8% | +8.1% | -6.1% |
| 2024 | +40.9% | +43.0% | +25.2% | +37.5% | +15.3% |
| 2025 | +7.5% | +2.5% | +16.6% | +1.7% | -12.9% |
| 2026 | +29.5% | +19.6% | +4.8% | +24.9% | +1.6% |

The frozen default is positive in 18 of 19 years; the only negative year is
2014. The "all" and "reversal" variants look stronger in many years, but they
were not selected ex ante; do not switch to them after seeing this table.

### Setup contribution by year (net R, 2014-2026)

| Year | 2-1 | 3-1 | 1-2 | 2-2 | 3-2 | Total |
|---|---|---|---|---|---|---|
| 2014 | -7.6 | +0.3 | -12.8 | -7.2 | +30.2 | +2.8 |
| 2015 | +10.2 | +17.8 | +5.7 | +44.3 | +28.1 | +106.1 |
| 2016 | +17.2 | +6.7 | +37.1 | +33.1 | +3.0 | +97.0 |
| 2017 | +8.4 | +5.8 | +7.4 | +10.3 | -7.5 | +24.4 |
| 2018 | +65.0 | -3.3 | +20.0 | -0.9 | +12.0 | +92.7 |
| 2019 | +32.9 | +28.6 | -2.0 | +22.0 | -18.3 | +63.2 |
| 2020 | +29.2 | +8.9 | +30.8 | -10.9 | +11.0 | +69.0 |
| 2021 | +27.0 | +1.2 | +18.3 | +2.0 | +17.5 | +65.8 |
| 2022 | +40.5 | +12.1 | -2.2 | +55.1 | +4.4 | +109.9 |
| 2023 | +16.6 | +12.6 | +26.7 | -4.8 | +1.8 | +52.8 |
| 2024 | +61.7 | +12.4 | +5.1 | +47.7 | +55.0 | +181.9 |
| 2025 | +34.8 | +16.9 | -0.8 | -37.7 | +6.4 | +19.7 |
| 2026 | +34.3 | +11.0 | -4.2 | +46.2 | +15.2 | +102.5 |

`2-1` and `3-1` are the most reliable year to year. `2-2` is large but volatile
(+55.1 in 2022, -37.7 in 2025). This supports focusing on compression breakouts.

## Timeframe continuity: what the experiments actually show

The Strat doctrine treats HTF continuity as the main edge. In these mechanical
tests it is **not** the source of the edge:

| Experiment | Continuity (frozen) | HTF all | Reversal | 2R | Close entry |
|---|---|---|---|---|---|
| EURUSD D1 Sharpe | 0.59 | 0.85 | 0.66 | 0.71 | 0.07 |
| Portfolio 2014-2026 CAGR | +14.46% | +21.50% | +28.36% | +13.36% | -3.02% |
| Portfolio 2014-2026 Sharpe | 1.38 | 1.61 | 1.87 | 1.38 | -0.49 |
| Portfolio 2008-2026 CAGR | +15.20% | +22.37% | +23.85% | +13.55% | -2.28% |

Removing the filter, or trading against it, improves almost every aggregate.
This is evidence that the **candle-color implementation of continuity is noisy**,
not evidence that multi-timeframe context is useless. The current HTF uses the
current partial HTF candle's close vs open, with fixed/calendar blocks; it does
not use higher-timeframe 2U/2D structure or pivots. Do not conclude "MTFA does
not work" from this; conclude "this mechanical color filter does not add value."

What the evidence does support:

- **Working:** D1 candle classification; **compression followed by a breakout**;
  specifically `2-1` and `3-1`. Broad cross-pair diversification; long side
  stronger than short; structural target; intrabar trigger.
- **Marginal:** `1-2`, `2-2`, `3-2`; they produce most of the trades but much
  less edge per trade.
- **Not working:** the HTF color filter as implemented; H1/H4 after costs; close
  entry.
- **To investigate, not yet validated:** structural HTF continuity using 2U/2D
  sequences instead of candle color; volatility/session regime filters;
  per-setup risk allocation; currency-exposure/correlation caps; exact broker
  feed; forward paper trading.

## Info cards

### Command cards

<table>
<tr>
<td width="50%" valign="top">

<b>BACKTEST</b><br>
<code>bun run backtest --tf D1</code><br><br>
Runs the frozen rule on one pair/timeframe: breakout entry, stop, target, costs,
swap, one position per pair.<br><br>
<b>Reads:</b> <code>data/*.json</code>, <code>data/broker/*.csv</code>,
<code>data/rates/*.json</code><br>
<b>Writes:</b> <code>results/&lt;label&gt;.json</code>,
<code>results/&lt;label&gt;_trades.csv</code><br>
<b>Use when:</b> testing one pair, timeframe, or pre-specified variant.<br>
<b>Key flags:</b> <code>--data --tf --setups --htf --entry --target</code>

</td>
<td width="50%" valign="top">

<b>WALK-FORWARD</b><br>
<code>bun run walkforward ...</code><br><br>
Splits dates into contiguous folds, runs the frozen rule on each pair/fold, and
aggregates out-of-sample trades. No per-fold fitting.<br><br>
<b>Reads:</b> files from <code>--data-dir</code><br>
<b>Writes:</b> <code>results/wf_&lt;PAIR&gt;_&lt;fold&gt;.json</code>,
<code>results/walkforward_summary.json</code><br>
<b>Use when:</b> you need period-by-period evidence, not one full-sample number.<br>
<b>Key flags:</b> <code>--pairs --folds --start --end --data-dir --template</code>

</td>
</tr>
<tr>
<td width="50%" valign="top">

<b>SWEEP</b><br>
<code>bun run sweep</code><br><br>
Runs the D1 backtest across every D1 file and prints one comparison table.<br><br>
<b>Reads:</b> <code>data/*_D1.json</code><br>
<b>Writes:</b> nothing by default (uses <code>--no-save</code>)<br>
<b>Use when:</b> screening pairs or variants before a walk-forward.<br>
<b>Key flags:</b> <code>--variants default,all,reversal,2r,close</code>

</td>
<td width="50%" valign="top">

<b>ROBUSTNESS</b><br>
<code>bun run robustness --data ... --tf D1</code><br><br>
Runs the five pre-specified variants on one pair, computes trade bootstrap
intervals and monthly deflated Sharpe using the variants as trials.<br><br>
<b>Writes:</b> <code>results/rb_*.json</code>,
<code>results/robustness_summary.json</code><br>
<b>Use when:</b> testing one pair under multiple-testing correction.<br>
<b>Key flags:</b> <code>--data --symbol --spread-points --point</code>

</td>
</tr>
<tr>
<td width="50%" valign="top">

<b>PORTFOLIO</b><br>
<code>bun run portfolio --data-dir data/broker ...</code><br><br>
Runs all pairs, combines overlapping trades under a fixed risk budget, and marks
the book to market daily.<br><br>
<b>Settings:</b> 0.25% risk/trade, max 2% open risk, max 8 positions<br>
<b>Writes:</b> <code>results/portfolio_&lt;tag&gt;.json</code><br>
<b>Use when:</b> evaluating the actual multi-pair D1 target.<br>
<b>Key flags:</b> <code>--pairs --risk-per-trade --max-open-risk --max-positions</code>

</td>
<td width="50%" valign="top">

<b>PORTFOLIO ROBUSTNESS</b><br>
<code>bun run portfolio-robustness ...</code><br><br>
Runs the portfolio engine for the five variants and computes portfolio-level
monthly deflated Sharpe using those variants as trials.<br><br>
<b>Writes:</b> <code>results/portfolio_pf_*.json</code>,
<code>results/portfolio_robustness.json</code><br>
<b>Use when:</b> applying the multiple-testing gate to the portfolio.<br>
<b>Key flags:</b> same as portfolio

</td>
</tr>
</table>
### Metric cards: returns and risk

| Abbrev. | Full name | Meaning |
|---|---|---|
| `R` | Risk unit | Price distance from entry to the initial stop. 1R = that distance. |
| `Gross R` | Gross risk multiple | Directional price PnL divided by initial risk, before costs. |
| `Net R` | Net risk multiple | Gross R after spread, commission, slippage, carry, and swap. |
| `Cost R` | Cost in R | `Gross R - Net R`; average cost drag per trade. |
| `Expectancy` | Expected net R | Mean `Net R` per trade. Positive is the basic edge test. |
| `Win rate` | Winning trade rate | Fraction of trades with positive net PnL. |
| `Hit rate` | Positive-period rate | Fraction of months (or trades) with positive returns. |
| `PF` | Profit factor | Gross winning PnL divided by gross losing PnL. Above 1 is profitable. |
| `PnL` | Profit and loss | Account-currency change, realized plus unrealized. |
| `Total return` | Cumulative return | Compounded equity change over the test window. |
| `Ann.` | Annualized | Scaled to a one-year basis (252 trading days). |
| `MTM` | Mark-to-market | Revaluing open positions at each daily close. |
| `CAGR` | Compound annual growth rate | Annualized compounded return. |
| `Vol` | Annualized volatility | Standard deviation of returns times sqrt(252). |
| `Sharpe` | Sharpe ratio | Annualized mean return divided by annualized volatility. |
| `MaxDD` | Maximum drawdown | Worst peak-to-trough decline of the equity curve. |
| `Turnover` | Annual turnover | Sum of absolute position-weight changes per year. |
| `Exposure` | Time in market | Fraction of days with at least one open position. |
| `Trades/yr` | Trade frequency | Number of trades per year. |
| `Avg bars held` | Holding period | Mean bars from entry to exit. |
| `Boot 5-95%` | Bootstrap interval | 5th to 95th percentile from resampling trades or months. |
| `CI` | Confidence interval | Range containing the estimate at a stated confidence. |
| `DSR` | Deflated Sharpe ratio | Probability that the Sharpe is real after accounting for trials. |
| `Trade Sharpe` | Per-trade Sharpe | Mean `Net R` / std of `Net R`, scaled by sqrt(trades). |
| `Monthly Sharpe` | Monthly Sharpe | Mean / std of monthly returns, scaled by sqrt(12) when annualized. |
| `N` | Number of trials | Variants/hypotheses used in the DSR correction. |
| `T` | Observations | Number of trades or months used in a statistic. |
| `IS` | In-sample | Data seen while designing the rule. |
| `OOS` | Out-of-sample | Data not used while designing the rule. |
| `Fold` | Walk-forward block | One contiguous out-of-sample date block. |

### Metric cards: strategy and data terms

| Term | Meaning |
|---|---|
| `D1 / H4 / H1` | Daily, 4-hour, 1-hour bars. Only D1 survives costs here. |
| `OHLC` | Open, High, Low, Close of a bar. |
| `1` | Inside bar: high <= prior high and low >= prior low. |
| `2U` | Up directional bar: breaks prior high, not prior low. |
| `2D` | Down directional bar: breaks prior low, not prior high. |
| `3` | Outside bar: breaks both prior high and prior low. |
| `2-1`, `3-1`, `1-2`, `2-2`, `3-2` | Two-bar context labels used to select breakout setups. |
| `HTF` | Higher timeframe. H1 uses H4/D1; H4 uses D1/W1; D1 uses W1/M1. |
| `FTC` | Full timeframe continuity: all referenced timeframes same color. |
| `Continuity` | Trade only in the direction of both HTF candles. |
| `Reversal` | Trade against both HTF candles. |
| `All` | Ignore the HTF filter. |
| `Trigger` | The setup bar high (long) or low (short) that the next bar must break. |
| `Stop` | Opposite side of the setup bar. |
| `Structural target` | Prior 20-bar swing high/low; falls back to 2R if too close. |
| `2R target` | Fixed target at entry +/- 2 times the initial risk. |
| `Intrabar entry` | Fill when the trigger is touched, at the trigger or the open on a gap. |
| `Close entry` | Fill at the close of the trigger bar only if it closes beyond the trigger. |
| `Spread` | Bid/ask cost from the data file, half at entry and half at exit. |
| `Commission` | Broker fee per side, default 0.5 bp. |
| `Slippage` | Execution slippage per side, default 0.5 bp. |
| `Swap / financing` | Overnight rate-differential carry plus a 0.2 bp/day swap spread. |
| `Risk/trade` | Fraction of equity risked to the stop, default 1% single-pair / 0.25% portfolio. |
| `Max open risk` | Cap on the sum of open position risk, default 2% of equity. |
| `Max positions` | Cap on simultaneous open pairs, default 8. |
| `Broker feed` | The exact bars your broker would trade; here approximated by Dukascopy D1. |
| `Frozen rule` | No parameter changes after seeing results. |

## Quick start

```bash
cd C:\dev\strat-backtest
bun install

# 1. Download the Dukascopy D1 broker-style feed (16 pairs, 2008-2026)
bun run fetch-broker

# 2. Single-pair D1 backtest
bun run backtest --tf D1

# 3. Broker-feed walk-forward
bun run walkforward --data-dir data/broker --template "{pair}.csv" --symbol-csv \
  --pairs EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURGBP,EURJPY,GBPJPY,EURCHF,EURAUD,EURCAD,AUDJPY,CADJPY,CHFJPY \
  --folds 4 --start 2014-01-01 --end 2026-10-29

# 4. Multi-pair portfolio
bun run portfolio --data-dir data/broker --template "{pair}.csv" --symbol-csv \
  --pairs EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURGBP,EURJPY,GBPJPY,EURCHF,EURAUD,EURCAD,AUDJPY,CADJPY,CHFJPY \
  --start 2014-01-01 --end 2026-10-29 \
  --risk-per-trade 0.0025 --max-open-risk 0.02 --max-positions 8

# 5. Portfolio variants + monthly deflated Sharpe
bun run portfolio-robustness --data-dir data/broker --template "{pair}.csv" \
  --start 2014-01-01 --end 2026-10-29 \
  --risk-per-trade 0.0025 --max-open-risk 0.02 --max-positions 8

# 6. Fresh per-pair signal sheet (recommended around 02:00 GMT+3)
bun run signals
```

## What the strategy is

The Strat is a discretionary framework. The exact mechanical rules implemented
here are documented in `STRATEGY.md`. Summary:

- Candle types: `1` inside, `2U` up, `2D` down, `3` outside, high/low based.
- Setups: `2-1`, `3-1`, `1-2`, `2-2`, `3-2`.
- Trigger: next bar breaks the setup bar high/low.
- Stop: opposite side of the setup bar.
- Target: prior 20-bar swing (structural) or fixed 2R.
- HTF filter: two higher timeframes in `continuity`, `reversal`, or `all` mode.
- One position per pair; 1% risk per trade in single-pair mode.

## What is implemented

- Candle classification, combos, HTF continuity.
- Intrabar or close entry; structural or 2R target.
- Spread + commission + slippage + rate-based carry/swap.
- Date-based walk-forward folds.
- Per-pair trade bootstrap.
- Monthly deflated Sharpe using the five pre-registered variants as trials.
- Multi-pair portfolio with:
  - 0.25% risk per trade by default
  - max 2% total open risk
  - max 8 concurrent positions
  - daily mark-to-market
  - per-pair contribution reporting
  - date-fold portfolio slices.
- MySQL-free, dependency-light: Bun + plain JS, plus `dukascopy-node` for data.

## Data

- `data/broker/<PAIR>.csv`: Dukascopy D1 broker-style feed, downloaded with
  `bun run fetch-broker` (2008-2026, 16 pairs, Unix timestamps).
- `data/Y_<PAIR>_D1.json`: Yahoo daily pairs (older research).
- `data/EURUSD_H1/H4/D1.json`: Dukascopy intraday/daily files (older research).
- `data/rates/*.json`: 3-month interbank rates for carry/swap.

CSV format expected by the loader:

```csv
date,open,high,low,close
2024-01-02,1.10432,1.10651,1.10318,1.10577
```

Any broker export can be used with:

```bash
bun run backtest --data mybroker.csv --tf D1 --symbol EURUSD \
  --spread-points 10 --point 0.00001
```

## Costs and financing

- Spread: from the data file, half applied at entry and half at exit.
- Commission: 0.5 bp per side (default).
- Slippage: 0.5 bp per side (default).
- Swap/financing:
  - Rate-based carry when timestamps are valid: base 3m rate minus quote 3m
    rate, previous month, plus 0.2 bp/day swap spread.
  - Flat 0.2 bp/day fallback when dates are unavailable.
- Single-pair backtests use 1% risk per trade. The portfolio uses 0.25% risk per
  trade with a 2% total open-risk cap.

## Results

### Timeframes, EURUSD (spread + commission + slippage + swap)

| TF | Trades | Win% | Avg net R | PF | CAGR | MaxDD | Sharpe |
|---|---|---|---|---|---|---|---|
| H1 | 8,848 | 39.7 | -0.15 | 0.80 | -57.2% | -100.0% | -2.20 |
| H4 | 2,661 | 42.5 | -0.01 | 0.98 | -3.5% | -67.7% | -0.11 |
| D1 | 511 | 49.3 | +0.16 | 1.33 | +4.0% | -17.0% | 0.59 |

H1 and H4 do not survive costs. D1 is the only credible timeframe in this
mechanical version.

### D1 variants, EURUSD Dukascopy

| Variant | Trades | Avg net R | PF | CAGR | MaxDD | Sharpe |
|---|---|---|---|---|---|---|
| Default (continuity) | 511 | +0.16 | 1.33 | +4.0% | -17.0% | 0.59 |
| HTF all | 695 | +0.43 | 1.82 | +14.5% | -9.5% | 0.85 |
| HTF reversal | 362 | +0.66 | 2.04 | +11.2% | -16.9% | 0.66 |
| Target 2R | 496 | +0.20 | 1.40 | +4.8% | -14.5% | 0.71 |
| Entry at close | 338 | +0.02 | 1.04 | +0.2% | -19.7% | 0.07 |
| Default, second half | 256 | +0.21 | 1.46 | +5.3% | -11.4% | 0.83 |

Removing the HTF filter improved EURUSD D1, which contradicts the idea that
mechanical HTF continuity adds value here. The edge is mostly the breakout
pattern plus structural target, not the filter.

### D1 cross-pair, default rules (Yahoo, after swap)

Across 17 D1 files (Dukascopy EURUSD plus 16 Yahoo pairs):

- 15/17 pairs positive full-sample; 14/17 positive in the second half.
- Average net R about +0.10; median Sharpe about 0.36 full and 0.29 second half.
- EURGBP is negative; EURCHF is roughly flat.

### Data-vendor sensitivity

- Dukascopy EURUSD D1: +0.16R, Sharpe 0.59 (default).
- Yahoo EURUSD D1: +0.05R, Sharpe 0.17 (default).

Daily candle boundaries, vendor, and history coverage change the results. The
broker-feed section below uses a Dukascopy export; your exact broker still needs
to be checked with the CSV loader.

## Broker-feed walk-forward (Dukascopy D1)

16 pairs, frozen D1 default rule, 2014-2026:

| Fold | Dates | Trades | Avg net R | PF | Pairs positive | Bootstrap mean 5-95% |
|---|---|---|---|---|---|---|
| 1 | 2014-01-01..2017-03-16 | 1,617 | +0.133 | 1.26 | 13/16 | [+0.074, +0.189] |
| 2 | 2017-03-17..2020-05-30 | 1,688 | +0.125 | 1.23 | 15/16 | [+0.061, +0.191] |
| 3 | 2020-05-31..2023-08-14 | 1,729 | +0.151 | 1.30 | 14/16 | [+0.097, +0.207] |
| 4 | 2023-08-15..2026-10-29 | 1,694 | +0.182 | 1.35 | 15/16 | [+0.122, +0.245] |

Overall: 6,728 trades, +0.148R, PF 1.29. Trade bootstrap mean netR 5-95%
[+0.118, +0.178], PF [1.23, 1.35]. All four folds are positive.

Per-pair monthly deflated Sharpe on the broker feed (5 variants as trials):

| Pair | Monthly DSR | Result |
|---|---|---|
| EURUSD | 0.983 | PASS |
| GBPUSD | 0.052 | FAIL |
| USDJPY | 0.403 | FAIL |

The walk-forward breadth passes; individual pair significance is mixed, so the
portfolio is the relevant object.

## Portfolio: 16 D1 pairs

Settings: 0.25% risk per trade, maximum 2% open risk, maximum 8 concurrent
positions, one position per pair, daily mark-to-market.

### 2014-2026 (pre-registered window)

| Metric | Value |
|---|---|
| CAGR | +14.46% |
| Volatility | 10.14% |
| Sharpe | 1.38 |
| Max drawdown | -13.24% |
| Exposure | 99.7% |
| Avg open positions | 6.07 |
| Max open risk | 2.02% of equity |
| Monthly bootstrap Sharpe 5-95% | [1.25, 2.14] |
| Monthly DSR (5 variants) | **0.930 -> FAIL** (needs >= 0.95) |

Date-fold portfolio slices (2014 run): CAGR 11.30% / 11.90% / 16.17% / 17.71%,
Sharpe 1.20 / 1.11 / 1.43 / 1.72, maxDD -10.24% / -10.09% / -10.22% / -13.24%.

### Full broker history: 2008-2026 (post-hoc robustness)

| Metric | Value |
|---|---|
| CAGR | +15.20% |
| Volatility | 10.19% |
| Sharpe | 1.44 |
| Max drawdown | -13.24% |
| Monthly bootstrap Sharpe 5-95% | [1.36, 2.01] |
| Monthly DSR | **0.992 -> PASS** |

The full-history run was executed after observing the 2014-2026 near miss, so it
is a robustness check, not a pristine pre-registered test.

## Decision

The strict pre-registered gate fails by 0.02: 2014-2026 portfolio monthly DSR is
0.930 against a 0.95 threshold. Per the rule, **do not go live.**

The evidence is strong enough to justify a **prospective paper-trading test** on
forward data with the frozen rule and portfolio settings. It does not justify
live capital. Do not tune parameters to push DSR over the line.

## Commands

| Command | Purpose |
|---|---|
| `bun run fetch-broker` | Download Dukascopy D1 feed |
| `bun run backtest --tf D1` | Single-pair backtest |
| `bun run sweep` | D1 cross-pair table |
| `bun run walkforward ...` | Date-based walk-forward |
| `bun run robustness --data ...` | Trade bootstrap + per-pair monthly DSR |
| `bun run portfolio ...` | Multi-pair portfolio simulation |
| `bun run portfolio-robustness ...` | Portfolio variants + monthly DSR |
| `bun run signals` | Fresh per-pair D1 signal sheet |

Common backtest flags:

| Flag | Meaning |
|---|---|
| `--data` | JSON or CSV bars |
| `--tf` | H1, H4, D1 |
| `--setups` | Comma list of setups |
| `--htf` | continuity, reversal, all |
| `--entry` | intrabar, close |
| `--target` | structural, 2r |
| `--blocks` | HTF block sizes, e.g. `4,24` |
| `--max-hold` | Time exit in bars |
| `--lookback` | Structural target lookback |
| `--risk` | Risk fraction per trade |
| `--commission-bp`, `--slippage-bp` | Per-side costs |
| `--swap-mode` | rates, flat, none |
| `--swap-spread-bp`, `--flat-swap-bp` | Swap/financing cost |
| `--start-date`, `--end-date` | Date slice |
| `--start`, `--end` | Fractional slice |
| `--symbol`, `--spread-points`, `--point` | CSV metadata |
| `--label` | Result tag |

Portfolio flags:

| Flag | Meaning |
|---|---|
| `--data-dir`, `--template`, `--symbol-csv` | Source files |
| `--pairs` | Comma list of pairs |
| `--risk-per-trade` | Fraction of equity risked per trade (default 0.0025) |
| `--max-open-risk` | Total open risk cap (default 0.02) |
| `--max-positions` | Concurrent position cap (default 8) |
| `--tag` | Portfolio result tag |

## Caveats

- The rule is a mechanical interpretation of a discretionary framework: no PMG
  management, partials, trailing, news/session filters.
- H1/H4 fail after costs. Do not revive them without a new pre-registration.
- The broker feed is a Dukascopy export, not the user's broker.
- HTF uses calendar weeks/months when timestamps exist; otherwise fixed blocks.
- No correlation/currency-exposure cap, vol targeting, bid/ask, market impact,
  or live execution layer.
- Deflated Sharpe uses five variants as trials; the trial set is small.
- The full-history pass is post-hoc; the pre-registered window fails.
- No pristine holdout remains on this dataset. Forward data is the clean test.

## Next steps

1. Paper trade the frozen portfolio on forward data; no parameter changes.
2. Validate on your exact broker D1 feed via the CSV loader.
3. Recompute the monthly DSR prospectively after enough forward months.
4. Only if both pass, consider live capital.
5. Portfolio improvements (currency exposure, correlation, vol targeting) are
   new hypotheses and need their own validation.

## File layout

```
src/fetchBroker.js       # Dukascopy D1 feed download
src/data.js              # JSON/CSV bar loader
src/carry.js             # lagged rate/carry lookup
src/strat.js             # candle types, setups, HTF, targets
src/stats.js             # metrics, bootstrap, deflated Sharpe
src/backtest.js          # single-pair backtest engine
src/sweep.js             # D1 cross-pair sweep
src/walkforward.js       # date-fold walk-forward
src/robustness.js        # per-pair bootstrap/DSR
src/portfolio.js         # multi-pair portfolio engine
src/portfolioRobustness.js # portfolio variants + monthly DSR
src/signals.js           # fresh D1 signal sheet + terminal UI
STRATEGY.md              # exact mechanical rules
data/                    # inputs (gitignored)
results/                 # outputs (gitignored)
```

See `STRATEGY.md` before changing any rule. The rule is frozen for the current
validation cycle.
