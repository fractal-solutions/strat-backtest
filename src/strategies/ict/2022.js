// ICT 2022 model.
//
// London model:
//   1. Daily bias from the last completed day's close vs its 20-day EMA.
//   2. Mark the range from the NY midnight open (04:00 UTC) to London open
//      (07:00 UTC).
//   3. During the London killzone (07:00-10:00 UTC), wait for a sweep of the
//      range low (bullish bias) or high (bearish bias).
//   4. Require a market-structure shift with displacement.
//   5. Enter on a retest of the resulting PD array (FVG, else order block) in
//      the discount/premium half of the range.
//   6. Stop beyond the range extreme, target the opposite side of the range.
//
// New York model:
//   If London swept liquidity, wait for a retracement into the 62%-79% OTE of
//   the London leg during the NY killzone, then enter in the London direction
//   on a confirmation close. If London was range-bound, use the NY
//   midnight-to-NY-open range and run the same sweep -> MSS -> PD array model.
//
// Time-of-day defaults follow the PDF's GMT table: 04:00 range start, 07:00
// London open, 12:00 NY open. DST is not modelled; override the hours if you
// want the NY-local clock exactly.

import {
    atr, ema, dailyBars, dailyBiasAt, previousDayAt, bullishFvgAt, bearishFvgAt,
    orderBlockBefore, findSwingHigh, findSwingLow, oteZone, isDisplacement,
    isoDate, utcHour
} from './primitives.js';
import { simulateLimit, simulateMarket } from './simulate.js';

export const id = 'ict-2022';
export const label = 'ICT 2022 model (London + NY)';
export const defaults = { session: 'raw' };

export function configure(args) {
    return {
        model: String(args.model ?? 'both').toLowerCase(),
        biasMode: String(args['bias-mode'] ?? 'both').toLowerCase(),
        dailyEma: Number(args['daily-ema'] ?? 20),
        rangeStart: Number(args['range-start'] ?? 4),
        londonOpen: Number(args['london-open'] ?? 7),
        londonEnd: Number(args['london-end'] ?? 10),
        nyOpen: Number(args['ny-open'] ?? 12),
        nyEnd: Number(args['ny-end'] ?? 15),
        swingLookback: Number(args['swing-lookback'] ?? 10),
        mssBars: Number(args['mss-bars'] ?? 6),
        displacementAtr: Number(args['displacement-atr'] ?? 1),
        pdLookback: Number(args['pd-lookback'] ?? 8),
        validBars: Number(args['valid-bars'] ?? 6),
        maxHold: Number(args['max-hold'] ?? 24),
        minRR: Number(args['min-rr'] ?? 3),
        bufferAtr: Number(args['buffer-atr'] ?? 0.1),
        minRiskAtr: Number(args['min-risk-atr'] ?? 0.25),
        minRiskSpread: Number(args['min-risk-spread'] ?? 4),
        maxCostR: Number(args['max-cost-r'] ?? 0.35),
        premiumMax: Number(args['premium-max'] ?? 0.5),
        oteMin: Number(args['ote-min'] ?? 0.62),
        oteMax: Number(args['ote-max'] ?? 0.79),
        nyRangeModel: args['no-ny-range'] !== true
    };
}

function buildRanges(bars, startHour, endHour) {
    const ranges = new Map();
    for (let i = 0; i < bars.n; i++) {
        const hour = utcHour(bars.time[i] * 1000);
        if (hour < startHour || hour >= endHour) continue;
        const date = isoDate(bars.time[i] * 1000);
        const current = ranges.get(date);
        if (current) {
            current.high = Math.max(current.high, bars.high[i]);
            current.low = Math.min(current.low, bars.low[i]);
        } else {
            ranges.set(date, { high: bars.high[i], low: bars.low[i] });
        }
    }
    return ranges;
}

function findPdSetup(ctx, bars, sweepIndex, direction, range, sweepExtreme, config) {
    const swingIndex = direction > 0
        ? findSwingHigh(bars, sweepIndex, config.swingLookback)
        : findSwingLow(bars, sweepIndex, config.swingLookback);
    if (swingIndex < 0) return null;
    const level = direction > 0 ? bars.high[swingIndex] : bars.low[swingIndex];

    let mssIndex = -1;
    for (let j = sweepIndex + 1; j <= Math.min(ctx.end - 1, sweepIndex + config.mssBars); j++) {
        const broken = direction > 0 ? bars.close[j] > level : bars.close[j] < level;
        if (broken && isDisplacement(bars, j, atr(bars, j, 14), config.displacementAtr)) {
            mssIndex = j;
            break;
        }
    }
    if (mssIndex < 0) return null;

    let pd = null;
    for (let j = mssIndex - 1; j >= Math.max(2, mssIndex - config.pdLookback); j--) {
        pd = direction > 0 ? bullishFvgAt(bars, j) : bearishFvgAt(bars, j);
        if (pd) break;
    }
    if (!pd) {
        const ob = orderBlockBefore(bars, mssIndex, direction, config.pdLookback);
        if (ob) pd = { index: ob.index, low: ob.low, high: ob.high, mid: ob.mid };
    }
    if (!pd) return null;

    const span = range.high - range.low;
    const discountCut = range.low + config.premiumMax * span;
    const premiumCut = range.high - config.premiumMax * span;
    if (direction > 0 && pd.mid > discountCut) return null;
    if (direction < 0 && pd.mid < premiumCut) return null;

    const buffer = atr(bars, mssIndex, 14) * config.bufferAtr;
    const entry = pd.mid;
    // PDF: stop above the London high (the sweep extreme) for shorts, below
    // the London low for longs. The pre-London range is the target reference.
    const stop = direction > 0 ? sweepExtreme - buffer : sweepExtreme + buffer;
    const target = direction > 0 ? range.high : range.low;
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    if (!(risk > 0) || reward / risk < config.minRR) return null;
    if (risk < atr(bars, mssIndex, 14) * config.minRiskAtr) return null;
    if (risk < ctx.bars.spreadPrice * config.minRiskSpread) return null;
    const roundTrip = ctx.bars.spreadPrice + entry * ctx.friction * 2;
    if (roundTrip / risk > config.maxCostR) return null;

    return { signalIndex: mssIndex, direction, entry, stop, target, setup: 'ict-2022-pd' };
}

function findOteSetup(ctx, bars, index, direction, londonRange, config) {
    if (!londonRange) return null;
    const ote = oteZone(londonRange.low, londonRange.high, direction, config.oteMin, config.oteMax);
    if (!ote) return null;

    const touched = direction > 0
        ? bars.low[index] <= ote.high && bars.close[index] >= ote.low
        : bars.high[index] >= ote.low && bars.close[index] <= ote.high;
    if (!touched) return null;
    if (direction > 0 && bars.close[index] <= bars.open[index]) return null;
    if (direction < 0 && bars.close[index] >= bars.open[index]) return null;

    const buffer = atr(bars, index, 14) * config.bufferAtr;
    const entry = bars.close[index];
    const stop = direction > 0 ? londonRange.low - buffer : londonRange.high + buffer;
    const target = direction > 0 ? londonRange.high : londonRange.low;
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    if (!(risk > 0) || reward / risk < config.minRR) return null;
    if (risk < atr(bars, index, 14) * config.minRiskAtr) return null;
    if (risk < bars.spreadPrice * config.minRiskSpread) return null;
    const roundTrip = bars.spreadPrice + entry * ctx.friction * 2;
    if (roundTrip / risk > config.maxCostR) return null;

    return { signalIndex: index, direction, entry, stop, target, setup: 'ict-2022-ote' };
}

export function run(ctx) {
    const { bars, config, start, end } = ctx;
    if (!Array.isArray(bars.time)) return [];

    const days = dailyBars(bars);
    const dailyEma = ema(days.map(day => day.close), config.dailyEma);
    const openingRanges = buildRanges(bars, config.rangeStart, config.londonOpen);
    const londonRanges = buildRanges(bars, config.londonOpen, config.nyOpen);
    const nyRanges = buildRanges(bars, config.rangeStart, config.nyOpen);

    const trades = [];
    const londonSwept = new Set();
    const londonTraded = new Set();
    const nyTraded = new Set();
    const useLondon = config.model !== 'ny';
    const useNy = config.model !== 'london';

    for (let i = Math.max(config.dailyEma + 2, start); i < end - 2; i++) {
        const date = isoDate(bars.time[i] * 1000);
        const hour = utcHour(bars.time[i] * 1000);
        const emaBias = dailyBiasAt(days, dailyEma, i);
        const prevDay = previousDayAt(days, i);
        const prevDayBias = prevDay
            ? (prevDay.close > prevDay.open ? 1 : prevDay.close < prevDay.open ? -1 : 0)
            : 0;
        if (config.biasMode === 'both' && prevDayBias !== emaBias) continue;
        const bias = config.biasMode === 'prev-day' ? prevDayBias : emaBias;
        if (!bias) continue;

        if (useLondon && hour >= config.londonOpen && hour < config.londonEnd && !londonTraded.has(date)) {
            const range = openingRanges.get(date);
            if (!range) continue;
            const swept = bias > 0
                ? bars.low[i] < range.low && bars.close[i] > range.low
                : bars.high[i] > range.high && bars.close[i] < range.high;
            if (!swept) continue;
            londonSwept.add(date);

            const sweepExtreme = bias > 0 ? bars.low[i] : bars.high[i];
            const setup = findPdSetup(ctx, bars, i, bias, range, sweepExtreme, config);
            if (!setup) continue;
            const trade = simulateLimit(ctx, {
                ...setup,
                validBars: config.validBars,
                maxHold: config.maxHold,
                setup: setup.setup
            });
            if (!trade) continue;
            trades.push(trade);
            londonTraded.add(date);
        }

        if (useNy && hour >= config.nyOpen && hour < config.nyEnd && !nyTraded.has(date)) {
            if (londonSwept.has(date) || londonTraded.has(date)) {
                const londonRange = londonRanges.get(date);
                const setup = findOteSetup(ctx, bars, i, bias, londonRange, config);
                if (!setup) continue;
                const trade = simulateMarket(ctx, {
                    signalIndex: setup.signalIndex,
                    direction: setup.direction,
                    stop: setup.stop,
                    target: setup.target,
                    maxHold: config.maxHold,
                    setup: setup.setup
                });
                if (!trade) continue;
                trades.push(trade);
                nyTraded.add(date);
            } else if (config.nyRangeModel) {
                const range = nyRanges.get(date);
                if (!range) continue;
                const swept = bias > 0
                    ? bars.low[i] < range.low && bars.close[i] > range.low
                    : bars.high[i] > range.high && bars.close[i] < range.high;
                if (!swept) continue;
                const sweepExtreme = bias > 0 ? bars.low[i] : bars.high[i];
                const setup = findPdSetup(ctx, bars, i, bias, range, sweepExtreme, config);
                if (!setup) continue;
                const trade = simulateLimit(ctx, {
                    ...setup,
                    validBars: config.validBars,
                    maxHold: config.maxHold,
                    setup: setup.setup
                });
                if (!trade) continue;
                trades.push(trade);
                nyTraded.add(date);
            }
        }
    }

    return trades;
}
