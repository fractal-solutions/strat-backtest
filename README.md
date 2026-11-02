# The Strat backtester

A dependency-free (plus `dukascopy-node` for data) backtest harness for a
mechanical subset of **The Strat** price-action framework (Rob Smith). It
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

## Info cards

### Command cards

> **BACKTEST**  `bun run backtest --tf D1`
>
> Runs the frozen mechanical Strat rule on one pair/timeframe. Simulates
> breakout entries, stops, targets, costs, and swap with one position per pair.
>
> **Reads:** `data/*.json`, `data/broker/*.csv`, `data/rates/*.json`  
> **Writes:** `results/<label>.json`, `results/<label>_trades.csv`  
> **Use when:** Testing one pair, one timeframe, or a pre-specified variant.  
> **Key flags:** `--data`, `--tf`, `--setups`, `--htf`, `--entry`, `--target`

> **WALK-FORWARD**  `bun run walkforward ...`
>
> Splits the date range into contiguous folds, runs the frozen rule on each
> pair and fold, and aggregates the out-of-sample trades. No parameters are
> fitted per fold; this is stability testing, not optimization.
>
> **Reads:** CSV/JSON files from `--data-dir`  
> **Writes:** `results/wf_<PAIR>_<fold>.json`, `results/walkforward_summary.json`  
> **Use when:** You need period-by-period evidence instead of one full-sample
> number, or you need to see whether one regime carries the result.

> **SWEEP**  `bun run sweep`
>
> Runs the D1 backtest across every D1 file and prints one comparison table.
> Variants can be selected with `--variants default,all,reversal,2r,close`.
>
> **Reads:** `data/*_D1.json`  
> **Writes:** nothing by default (it uses `--no-save`)  
> **Use when:** Screening pairs or variants before a full walk-forward.

> **ROBUSTNESS**  `bun run robustness --data ... --tf D1`
>
> Runs the five pre-specified variants on one pair, computes trade-level
> bootstrap confidence intervals, and computes monthly deflated Sharpe using
> the variants as multiple-testing trials.
>
> **Writes:** `results/rb_*.json`, `results/robustness_summary.json`  
> **Use when:** You want to know whether one pair's result survives
> multiple-testing correction. This is per-pair, not portfolio-level.

> **PORTFOLIO**  `bun run portfolio --data-dir data/broker ...`
>
> Runs the frozen strategy on all pairs, combines overlapping trades under a
> fixed risk budget, and marks the book to market daily.
>
> **Settings:** 0.25% risk/trade, max 2% open risk, max 8 positions  
> **Writes:** `results/portfolio_<tag>.json`  
> **Use when:** Evaluating the actual target: a multi-pair D1 portfolio.

> **PORTFOLIO ROBUSTNESS**  `bun run portfolio-robustness ...`
>
> Runs the portfolio engine for the five pre-specified variants and computes
> portfolio-level monthly deflated Sharpe using those variants as trials.
>
> **Writes:** `results/portfolio_pf_*.json`, `results/portfolio_robustness.json`  
> **Use when:** Applying the multiple-testing gate to the portfolio, not to a
> single pair.

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
STRATEGY.md              # exact mechanical rules
data/                    # inputs (gitignored)
results/                 # outputs (gitignored)
```

See `STRATEGY.md` before changing any rule. The rule is frozen for the current
validation cycle.
