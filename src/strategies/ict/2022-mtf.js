// ICT 2022 model with true multi-timeframe execution.
//
// HTF (H1 or M15): daily bias, NY-midnight-to-London range, liquidity sweep.
// LTF (M5 or M1): market-structure shift with displacement, PD-array
// (FVG/order block) retest, entry.
//
// This is the PDF's actual workflow. The single-timeframe `ict-2022` model is
// kept for comparison; it cannot see the 5m/1m MSS.
//
// Usage:
//   bun run backtest --strategy ict-2022-mtf \
//     --data data/m5/EURUSD.csv --tf M5 \
//     --htf-data data/m15/EURUSD.csv --symbol EURUSD ...

import {
    atr, ema, dailyBars,
    bullishFvgAt, bearishFvgAt, orderBlockBefore,
    findSwingHigh, findSwingLow, oteZone, isDisplacement,
    isoDate, utcHour
} from './primitives.js';
import { simulateLimit, simulateMarket } from './simulate.js';

export const id = 'ict-2022-mtf';
export const label = 'ICT 2022 model (HTF structure, LTF PD-array execution)';
export const defaults = { session: 'raw' };

export function configure(args) {
    return {
        model: String(args.model ?? 'both').toLowerCase(),
        // 'ltf' builds the range/sweep on the execution series (needed for a
        // precise 04:00-07:00 range); 'htf' uses the higher timeframe.
        structureSource: String(args['structure-source'] ?? 'htf').toLowerCase(),
        htfFilter: String(args['htf-filter'] ?? 'ema').toLowerCase(),
        biasMode: String(args['bias-mode'] ?? 'prev-day').toLowerCase(),
        dailyEma: Number(args['daily-ema'] ?? 20),
        rangeStart: Number(args['range-start'] ?? 4),
        londonOpen: Number(args['london-open'] ?? 7),
        londonEnd: Number(args['london-end'] ?? 12),
        nyOpen: Number(args['ny-open'] ?? 12),
        nyEnd: Number(args['ny-end'] ?? 16),
        windowHours: Number(args['window-hours'] ?? 4),
        swingLookbackLtf: Number(args['swing-lookback'] ?? 8),
        swingLeft: Number(args['swing-left'] ?? 2),
        swingRight: Number(args['swing-right'] ?? 2),
        mssBarsLtf: Number(args['mss-bars'] ?? 24),
        displacementAtr: Number(args['displacement-atr'] ?? 0.5),
        displacementBody: Number(args['displacement-body'] ?? 0.4),
        pdLookbackLtf: Number(args['pd-lookback'] ?? 12),
        validBarsLtf: Number(args['valid-bars'] ?? 12),
        maxHoldLtf: Number(args['max-hold'] ?? 96),
        minRR: Number(args['min-rr'] ?? 2),
        bufferAtr: Number(args['buffer-atr'] ?? 0.1),
        minRiskAtr: Number(args['min-risk-atr'] ?? 0.2),
        minRiskSpread: Number(args['min-risk-spread'] ?? 4),
        maxCostR: Number(args['max-cost-r'] ?? 0.35),
        premiumMax: Number(args['premium-max'] ?? 0.5),
        zoneMode: String(args['zone-mode'] ?? 'range').toLowerCase(),
        oteMin: Number(args['ote-min'] ?? 0.62),
        oteMax: Number(args['ote-max'] ?? 0.79),
        nyRangeModel: args['no-ny-range'] !== true,
        // Signal generation follows the PDF. RR/cost/ATR floors are execution
        // filters; enable them with --strict to get the tradable subset.
        strict: args.strict === true,
        // PDF trade management: the 2022 model uses a single range target.
        // 'partial' takes half at 1R and moves to breakeven; 'trail' also
        // trails the runner behind the previous bar (the article's breaker
        // management).
        management: String(args['trade-management'] ?? 'pdf').toLowerCase(),
        partialAt: Number(args['partial-at'] ?? 1),
        partialFraction: Number(args['partial-fraction'] ?? 0.5),
        breakeven: args['no-breakeven'] !== true,
        trail: args['trail'] === true,
        logSignals: args.signals === true,
        debug: args.debug === true
    };
}

function lowerBound(arr, target, n) {
    let low = 0;
    let high = n;
    while (low < high) {
        const mid = (low + high) >> 1;
        if (arr[mid] < target) low = mid + 1;
        else high = mid;
    }
    return low;
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

function passCostFilters(ctx, entry, risk, config) {
    const bars = ctx.bars;
    if (!(risk > 0)) return false;
    if (risk < bars.spreadPrice * config.minRiskSpread) return false;
    const roundTrip = bars.spreadPrice + entry * ctx.friction * 2;
    return roundTrip / risk <= config.maxCostR;
}

function sessionExtreme(bars, h, startHour, direction) {
    const date = isoDate(bars.time[h] * 1000);
    let extreme = direction > 0 ? Infinity : -Infinity;
    for (let i = h; i >= 0; i--) {
        const t = new Date(bars.time[i] * 1000);
        if (t.toISOString().slice(0, 10) !== date) break;
        const hour = t.getUTCHours();
        if (hour < startHour) break;
        if (direction > 0) extreme = Math.min(extreme, bars.low[i]);
        else extreme = Math.max(extreme, bars.high[i]);
    }
    return Number.isFinite(extreme) ? extreme : (direction > 0 ? bars.low[h] : bars.high[h]);
}

function findBreaker(ltf, direction, start, mssIndex, config) {
    // A breaker is an order block that failed and is retested from the other
    // side. For a long: a prior up candle whose high the MSS close broke.
    for (let i = mssIndex - 1; i >= Math.max(1, mssIndex - config.pdLookbackLtf); i--) {
        if (direction > 0) {
            const isUp = ltf.close[i] > ltf.open[i];
            if (isUp && ltf.close[mssIndex] > ltf.high[i]) {
                return { index: i, low: ltf.low[i], high: ltf.high[i], mid: (ltf.low[i] + ltf.high[i]) / 2, type: 'breaker' };
            }
        } else {
            const isDown = ltf.close[i] < ltf.open[i];
            if (isDown && ltf.close[mssIndex] < ltf.low[i]) {
                return { index: i, low: ltf.low[i], high: ltf.high[i], mid: (ltf.low[i] + ltf.high[i]) / 2, type: 'breaker' };
            }
        }
    }
    return null;
}

function findPdArray(ltf, direction, start, mssIndex, config, priority = 'fvg') {
    const findFvg = () => {
        for (let i = mssIndex; i >= start; i--) {
            const fvg = direction > 0 ? bullishFvgAt(ltf, i) : bearishFvgAt(ltf, i);
            if (fvg) return { ...fvg, type: 'fvg' };
        }
        return null;
    };
    const findOb = () => {
        const ob = orderBlockBefore(ltf, mssIndex, direction, config.pdLookbackLtf);
        return ob ? { ...ob, type: 'ob' } : null;
    };
    const findInverse = () => {
        for (let i = mssIndex - 1; i >= Math.max(2, mssIndex - config.pdLookbackLtf); i--) {
            const inv = direction > 0 ? bearishFvgAt(ltf, i) : bullishFvgAt(ltf, i);
            if (!inv) continue;
            const broken = direction > 0 ? ltf.close[mssIndex] > inv.high : ltf.close[mssIndex] < inv.low;
            if (broken) return { ...inv, type: 'inverse-fvg' };
        }
        return null;
    };
    const findBrk = () => findBreaker(ltf, direction, start, mssIndex, config);
    const orders = {
        fvg: [findFvg, findBrk, findOb, findInverse],
        breaker: [findBrk, findFvg, findOb, findInverse],
        ob: [findOb, findFvg, findBrk, findInverse],
        inverse: [findInverse, findFvg, findBrk, findOb]
    };
    for (const find of (orders[priority] ?? orders.fvg)) {
        const pd = find();
        if (pd) return pd;
    }
    return null;
}

function managementArgs(config) {
    return {
        management: config.management,
        partialAt: config.partialAt,
        partialFraction: config.partialFraction,
        breakeven: config.breakeven,
        trail: config.trail
    };
}

function findLtfSetup(ctx, direction, htfRange, sweepExtreme, start, end, config, funnel, stopMode = 'session', sessionStartHour = 7, pdPriority = 'fvg') {
    const ltf = ctx.bars;
    if (end <= start + 2) return null;

    const swingIndex = direction > 0
        ? findSwingHigh(ltf, start, config.swingLookbackLtf, config.swingLeft, config.swingRight)
        : findSwingLow(ltf, start, config.swingLookbackLtf, config.swingLeft, config.swingRight);
    if (swingIndex < 0) return null;
    funnel.swing++;
    const level = direction > 0 ? ltf.high[swingIndex] : ltf.low[swingIndex];

    let mssIndex = -1;
    const mssEnd = Math.min(end, start + config.mssBarsLtf);
    for (let i = start; i < mssEnd; i++) {
        const broken = direction > 0 ? ltf.close[i] > level : ltf.close[i] < level;
        if (broken && isDisplacement(ltf, i, atr(ltf, i, 14), config.displacementAtr, config.displacementBody)) {
            mssIndex = i;
            break;
        }
    }
    if (mssIndex < 0) return null;
    funnel.mss++;
    if (config.logSignals) {
        ctx.signalLog.push({ stage: 'mss', time: ltf.time[mssIndex] * 1000, date: isoDate(ltf.time[mssIndex] * 1000), direction, level });
    }

    // PD array: FVG, order block, or inverse FVG created by the displacement.
    const pd = findPdArray(ltf, direction, start, mssIndex, config, pdPriority);
    if (!pd) return null;
    funnel.pd++;
    if (config.logSignals) {
        ctx.signalLog.push({ stage: 'pd', time: ltf.time[mssIndex] * 1000, date: isoDate(ltf.time[mssIndex] * 1000), direction, type: pd.type, mid: pd.mid, low: pd.low, high: pd.high });
    }

    // Premium/discount zone. The PDF uses the dealing range; `leg` is an
    // alternative that measures only the sweep-to-MSS displacement.
    let zoneLow;
    let zoneHigh;
    if (config.zoneMode === 'leg') {
        zoneLow = direction > 0
            ? sweepExtreme
            : (() => { let low = Infinity; for (let i = start; i <= mssIndex; i++) low = Math.min(low, ltf.low[i]); return low; })();
        zoneHigh = direction > 0
            ? (() => { let high = -Infinity; for (let i = start; i <= mssIndex; i++) high = Math.max(high, ltf.high[i]); return high; })()
            : sweepExtreme;
    } else {
        zoneLow = htfRange.low;
        zoneHigh = htfRange.high;
    }
    const zoneMid = (zoneLow + zoneHigh) / 2;
    const zoneSpan = zoneHigh - zoneLow;
    const discountCut = zoneLow + config.premiumMax * zoneSpan;
    const premiumCut = zoneHigh - config.premiumMax * zoneSpan;
    if (direction > 0 && pd.mid > Math.min(zoneMid, discountCut)) return null;
    if (direction < 0 && pd.mid < Math.max(zoneMid, premiumCut)) return null;
    funnel.zone++;

    const buffer = atr(ltf, mssIndex, 14) * config.bufferAtr;
    const entry = pd.mid;
    // PDF: stop beyond the London session extreme at the time of the entry
    // (not just the first sweep bar). NY range-bound: beyond the PD/OB extreme.
    const stopExtreme = stopMode === 'pd'
        ? (direction > 0 ? pd.low : pd.high)
        : sessionExtreme(ltf, mssIndex, sessionStartHour, direction);
    const stop = direction > 0 ? stopExtreme - buffer : stopExtreme + buffer;
    const target = direction > 0 ? htfRange.high : htfRange.low;
    const risk = Math.abs(entry - stop);
    const reward = Math.abs(target - entry);
    if (!(risk > 0)) return null;
    // Execution filters are opt-in so signal generation follows the PDF.
    if (config.strict) {
        if (reward / risk < config.minRR) return null;
        funnel.rr++;
        if (risk < atr(ltf, mssIndex, 14) * config.minRiskAtr) return null;
        funnel.risk++;
        if (!passCostFilters(ctx, entry, risk, config)) return null;
        funnel.cost++;
    }

    if (config.logSignals) {
        ctx.signalLog.push({
            stage: 'setup',
            time: ltf.time[mssIndex] * 1000,
            date: isoDate(ltf.time[mssIndex] * 1000),
            direction,
            type: pd.type,
            stopMode,
            zoneMode: config.zoneMode,
            entry,
            stop,
            target,
            rr: reward / risk
        });
    }

    return { signalIndex: mssIndex, direction, entry, stop, target, setup: `ict-2022-mtf-${pd.type}` };
}

function findLtfOte(ctx, direction, londonRange, start, end, config) {
    const ltf = ctx.bars;
    const ote = oteZone(londonRange.low, londonRange.high, direction, config.oteMin, config.oteMax);
    if (!ote) return null;

    let touched = false;
    for (let i = start; i < end; i++) {
        if (!touched) {
            const inZone = direction > 0
                ? ltf.low[i] <= ote.high && ltf.close[i] >= ote.low
                : ltf.high[i] >= ote.low && ltf.close[i] <= ote.high;
            if (inZone) touched = true;
            continue;
        }

        // PDF: after the OTE tap, wait for an MSS confirmation on the LTF.
        const swingIndex = direction > 0
            ? findSwingHigh(ltf, i, 5, 1, 1)
            : findSwingLow(ltf, i, 5, 1, 1);
        if (swingIndex < 0) continue;
        const level = direction > 0 ? ltf.high[swingIndex] : ltf.low[swingIndex];
        const broken = direction > 0 ? ltf.close[i] > level : ltf.close[i] < level;
        if (!broken || !isDisplacement(ltf, i, atr(ltf, i, 14), config.displacementAtr, config.displacementBody)) continue;

        const buffer = atr(ltf, i, 14) * config.bufferAtr;
        const entry = ltf.close[i];
        const stop = direction > 0 ? londonRange.low - buffer : londonRange.high + buffer;
        const target = direction > 0 ? londonRange.high : londonRange.low;
        const risk = Math.abs(entry - stop);
        const reward = Math.abs(target - entry);
        if (!(risk > 0)) continue;
        if (config.strict) {
            if (reward / risk < config.minRR) continue;
            if (risk < atr(ltf, i, 14) * config.minRiskAtr) continue;
            if (!passCostFilters(ctx, entry, risk, config)) continue;
        }

        if (config.logSignals) {
            ctx.signalLog.push({
                stage: 'setup',
                time: ltf.time[i] * 1000,
                date: isoDate(ltf.time[i] * 1000),
                direction,
                entry,
                stop,
                target,
                rr: reward / risk,
                session: 'ny-ote'
            });
        }

        return { signalIndex: i, direction, entry, stop, target, setup: 'ict-2022-mtf-ote', market: true };
    }
    return null;
}

export function run(ctx) {
    const ltf = ctx.bars;
    const htf = ctx.htfBars;
    if (!htf) {
        throw new Error('ict-2022-mtf needs --htf-data <path> (and optionally --htf-tf)');
    }
    if (!Array.isArray(ltf.time) || !Array.isArray(htf.time)) return [];

    // 'ltf' builds the range/sweep on the execution series (needed for a
    // precise 04:00-07:00 range); 'htf' uses the higher timeframe.
    const structure = ctx.config.structureSource === 'ltf' ? ltf : htf;
    const htfEma = ctx.htfBars ? ema(Array.from(ctx.htfBars.close), 20) : null;
    const htfStep = ctx.htfBars && ctx.htfBars.time.length > 1 ? ctx.htfBars.time[1] - ctx.htfBars.time[0] : 3600;
    const htfTrendAt = timeSec => {
        if (!ctx.htfBars || !htfEma || ctx.config.htfFilter === 'none') return 0;
        // Use the last H4 bar that has actually closed before this instant.
        const idx = lowerBound(ctx.htfBars.time, timeSec - htfStep, ctx.htfBars.n) - 1;
        if (idx < 1) return 0;
        return ctx.htfBars.close[idx] > htfEma[idx] ? 1 : -1;
    };

    const biasBars = ctx.contextBars ?? htf;
    // Drop the Sunday week-open bucket from the daily bias; it is a partial
    // session, not a daily bar.
    const days = dailyBars(biasBars).filter(day => new Date(`${day.date}T00:00:00Z`).getUTCDay() !== 0);
    const dailyEma = ema(days.map(day => day.close), ctx.config.dailyEma);
    const dayDates = days.map(day => day.date);
    const dayIndexForDate = date => {
        // Last completed day strictly before `date`.
        let low = 0;
        let high = dayDates.length;
        while (low < high) {
            const mid = (low + high) >> 1;
            if (dayDates[mid] < date) low = mid + 1;
            else high = mid;
        }
        return low - 1;
    };
    const openingRanges = buildRanges(structure, ctx.config.rangeStart, ctx.config.londonOpen);
    const londonRanges = buildRanges(structure, ctx.config.londonOpen, ctx.config.nyOpen);
    const nyRanges = buildRanges(structure, ctx.config.rangeStart, ctx.config.nyOpen);

    const trades = [];
    if (ctx.config.logSignals) ctx.signalLog = [];
    const logEvent = event => { if (ctx.config.logSignals) ctx.signalLog.push(event); };
    const funnel = { bias: 0, londonWindow: 0, sweep: 0, swing: 0, mss: 0, pd: 0, zone: 0, rr: 0, risk: 0, cost: 0, setup: 0, fill: 0 };
    const londonSwept = new Set();
    const londonTraded = new Set();
    const nyTraded = new Set();
    const useLondon = ctx.config.model !== 'ny';
    const useNy = ctx.config.model !== 'london';
    const ltfStartMs = ltf.time[ctx.start] * 1000;
    const ltfEndMs = ltf.time[ctx.end - 1] * 1000;
    const structureStep = structure.time.length > 1 ? structure.time[1] - structure.time[0] : 3600;
    const ltfStep = ltf.time.length > 1 ? ltf.time[1] - ltf.time[0] : 300;

    for (let h = Math.max(ctx.config.dailyEma + 2, 0); h < structure.n - 1; h++) {
        const structureTime = structure.time[h] * 1000;
        if (structureTime < ltfStartMs || structureTime > ltfEndMs) continue;
        const date = isoDate(structureTime);
        const hour = utcHour(structureTime);
        const biasDayIndex = dayIndexForDate(date);
        if (biasDayIndex < 0) continue;
        const biasDay = days[biasDayIndex];
        const emaBias = biasDay.close > dailyEma[biasDayIndex]
            ? 1
            : biasDay.close < dailyEma[biasDayIndex] ? -1 : 0;
        const prevDayBias = biasDay.close > biasDay.open ? 1 : biasDay.close < biasDay.open ? -1 : 0;
        if (ctx.config.biasMode === 'both' && prevDayBias !== emaBias) continue;
        const bias = ctx.config.biasMode === 'prev-day' ? prevDayBias : emaBias;
        if (!bias) continue;
        funnel.bias++;

        // H4 context filter: only trade with the higher-timeframe EMA trend.
        const trend = htfTrendAt(structure.time[h]);
        if (trend !== 0 && trend !== bias) continue;

        // The sweep is confirmed on the structure bar close. The LTF scan
        // starts after that close, so no future information is used.
        const sweepConfirmSec = structure.time[h] + structureStep;
        let startLtf;
        let endLtf;
        if (structure === ltf) {
            startLtf = Math.max(ctx.start, h + 1);
            endLtf = Math.min(ctx.end, h + 1 + Math.round(ctx.config.windowHours * 3600 / ltfStep));
        } else {
            startLtf = Math.max(ctx.start, lowerBound(ltf.time, sweepConfirmSec, ltf.n));
            endLtf = Math.min(ctx.end, lowerBound(ltf.time, sweepConfirmSec + ctx.config.windowHours * 3600, ltf.n));
        }
        if (endLtf <= startLtf + 2) continue;

        if (useLondon && hour >= ctx.config.londonOpen && hour < ctx.config.londonEnd && !londonTraded.has(date)) {
            funnel.londonWindow++;
            const range = openingRanges.get(date);
            if (!range) continue;
            const swept = bias > 0
                ? structure.low[h] < range.low && structure.close[h] > range.low
                : structure.high[h] > range.high && structure.close[h] < range.high;
            if (!swept) continue;
            funnel.sweep++;
            londonSwept.add(date);

            const sweepExtreme = sessionExtreme(structure, h, ctx.config.londonOpen, bias);
            logEvent({ stage: 'sweep', time: sweepConfirmSec * 1000, date, direction: bias, price: sweepExtreme, rangeHigh: range.high, rangeLow: range.low });
            const setup = findLtfSetup(ctx, bias, range, sweepExtreme, startLtf, endLtf, ctx.config, funnel, 'session', ctx.config.londonOpen, 'fvg');
            if (!setup) continue;
            funnel.setup++;
            const trade = simulateLimit(ctx, {
                signalIndex: setup.signalIndex,
                direction: setup.direction,
                entry: setup.entry,
                stop: setup.stop,
                target: setup.target,
                validBars: ctx.config.validBarsLtf,
                maxHold: ctx.config.maxHoldLtf,
                ...managementArgs(ctx.config),
                setup: setup.setup
            });
            if (!trade) continue;
            funnel.fill++;
            logEvent({ stage: 'fill', time: ltf.time[trade.entryIndex] * 1000, date, direction: trade.direction, entry: trade.entry, exit: trade.exit, netR: trade.netR });
            trades.push(trade);
            londonTraded.add(date);
        }

        if (useNy && hour >= ctx.config.nyOpen && hour < ctx.config.nyEnd && !nyTraded.has(date)) {
            if (londonSwept.has(date)) {
                const londonRange = londonRanges.get(date);
                if (!londonRange) continue;
                const setup = findLtfOte(ctx, bias, londonRange, startLtf, endLtf, ctx.config);
                if (!setup) continue;
                funnel.setup++;
                const trade = simulateMarket(ctx, {
                    signalIndex: setup.signalIndex,
                    direction: setup.direction,
                    stop: setup.stop,
                    target: setup.target,
                    maxHold: ctx.config.maxHoldLtf,
                    ...managementArgs(ctx.config),
                    setup: setup.setup
                });
                if (!trade) continue;
                funnel.fill++;
                logEvent({ stage: 'fill', time: ltf.time[trade.entryIndex] * 1000, date, direction: trade.direction, entry: trade.entry, exit: trade.exit, netR: trade.netR });
                trades.push(trade);
                nyTraded.add(date);
            } else if (ctx.config.nyRangeModel) {
                const range = nyRanges.get(date);
                if (!range) continue;
                const swept = bias > 0
                    ? structure.low[h] < range.low && structure.close[h] > range.low
                    : structure.high[h] > range.high && structure.close[h] < range.high;
                if (!swept) continue;
                funnel.sweep++;
                const sweepExtreme = sessionExtreme(structure, h, ctx.config.nyOpen, bias);
                logEvent({ stage: 'sweep', time: sweepConfirmSec * 1000, date, direction: bias, price: sweepExtreme, rangeHigh: range.high, rangeLow: range.low, session: 'ny' });
                const setup = findLtfSetup(ctx, bias, range, sweepExtreme, startLtf, endLtf, ctx.config, funnel, 'pd', ctx.config.nyOpen, 'breaker');
                if (!setup) continue;
                funnel.setup++;
                const trade = simulateLimit(ctx, {
                    signalIndex: setup.signalIndex,
                    direction: setup.direction,
                    entry: setup.entry,
                    stop: setup.stop,
                    target: setup.target,
                    validBars: ctx.config.validBarsLtf,
                    maxHold: ctx.config.maxHoldLtf,
                    ...managementArgs(ctx.config),
                    setup: setup.setup
                });
                if (!trade) continue;
                funnel.fill++;
                logEvent({ stage: 'fill', time: ltf.time[trade.entryIndex] * 1000, date, direction: trade.direction, entry: trade.entry, exit: trade.exit, netR: trade.netR });
                trades.push(trade);
                nyTraded.add(date);
            }
        }
    }

    if (ctx.config.debug) console.log('2022-mtf funnel', funnel);
    return trades;
}
