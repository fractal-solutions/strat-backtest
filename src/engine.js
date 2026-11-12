// Generic backtest engine.
//
// A strategy is a module that exports:
//   id       - short unique name
//   label    - human label
//   defaults - optional default config (session, blocks, maxHold, ...)
//   configure(args, info) - optional, returns the strategy config
//   run(ctx) - returns an array of trades
//
// The engine owns everything that is not strategy logic: data loading, session
// normalization, spread/commission/slippage, financing, date windows, stats,
// and result files. The strategy owns signals, entries, stops, and targets.
//
// Trade contract (all fields required unless marked):
//   entryIndex, exitIndex, entryDate, exitDate, direction,
//   entry, exit, stop, target, risk, grossR, netR, costR,
//   barsHeld, reason, setup,   // setup is a free-form label
//   setupWeekday (optional), htf (optional array)

import { join } from 'node:path';
import { loadBars, timeframeDefaults } from './data.js';
import { normalizeSessions } from './session.js';
import { loadRateContext } from './carry.js';
import { summarize } from './stats.js';

const ROOT = join(import.meta.dir, '..');
const RESULTS = join(ROOT, 'results');

export function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        if (key === 'no-save' || key === 'list-strategies' || key === 'force') {
            options[key] = true;
            continue;
        }
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) {
            options[key] = true;
            continue;
        }
        options[key] = value;
        i++;
    }
    return options;
}

export function dateOf(bars, index) {
    if (Array.isArray(bars.time) && Number.isFinite(bars.time[index]) && bars.time[index] > 315532800) {
        return new Date(bars.time[index] * 1000).toISOString().slice(0, 10);
    }
    return String(index);
}

function buildWindow(bars, args) {
    let start = Math.max(2, Math.floor(bars.n * Number(args.start ?? 0)));
    let end = Math.min(bars.n, Math.floor(bars.n * Number(args.end ?? 1)));
    if (args['start-date'] || args['end-date']) {
        if (!(Array.isArray(bars.time) && bars.time[2] > 315532800)) {
            throw new Error('Date filters require valid Unix timestamps in the data');
        }
        const seconds = value => Math.floor(new Date(`${value}T00:00:00Z`).getTime() / 1000);
        const findFirst = target => {
            let low = 0;
            let high = bars.n;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (bars.time[mid] < target) low = mid + 1;
                else high = mid;
            }
            return low;
        };
        const findLast = target => {
            let low = 0;
            let high = bars.n;
            while (low < high) {
                const mid = (low + high) >> 1;
                if (bars.time[mid] <= target) low = mid + 1;
                else high = mid;
            }
            return low;
        };
        if (args['start-date']) start = Math.max(start, findFirst(seconds(args['start-date'])));
        if (args['end-date']) end = Math.min(end, findLast(seconds(args['end-date'])));
    }
    if (end <= start + 2) throw new Error('Empty backtest window');
    return { start, end };
}

function makeTrade(ctx, position, exitPrice, reason, exitIndex) {
    const { bars, barsPerDay, barsPerYear, swapMode, rateContext, swapSpreadBp, flatSwapBp } = ctx;
    const direction = position.direction;
    const barsHeld = exitIndex - position.entryIndex + 1;
    const daysHeld = barsHeld / barsPerDay;
    const exitCost = bars.spreadPrice / 2 + exitPrice * ctx.friction;
    const exitNet = direction > 0 ? exitPrice - exitCost : exitPrice + exitCost;
    const grossPrice = direction * (exitPrice - position.entryRaw);
    const useRateCarry = swapMode !== 'none' && rateContext !== null && position.carryAnnual !== null;
    const carryPrice = useRateCarry
        ? direction * position.entryRaw * position.carryAnnual * barsHeld / barsPerYear
        : 0;
    const swapBp = swapMode === 'none' ? 0 : (useRateCarry ? swapSpreadBp : flatSwapBp);
    const swapPrice = swapMode === 'none' ? 0 : position.entryRaw * (swapBp / 10000) * daysHeld;
    const netPrice = direction * (exitNet - position.entryNet) + carryPrice - swapPrice;
    const grossR = grossPrice / position.risk;
    const netR = netPrice / position.risk;

    return {
        strategy: position.strategy ?? ctx.strategy.id,
        setup: position.setup ?? 'trade',
        direction,
        entryIndex: position.entryIndex,
        exitIndex,
        entryDate: dateOf(bars, position.entryIndex),
        exitDate: dateOf(bars, exitIndex),
        setupWeekday: position.setupWeekday ?? null,
        entry: position.entryRaw,
        exit: exitPrice,
        stop: position.stopRaw,
        target: position.targetRaw,
        risk: position.risk,
        grossR,
        netR,
        costR: grossR - netR,
        carryR: carryPrice / position.risk,
        swapR: swapPrice / position.risk,
        barsHeld,
        reason,
        htf: position.htf ?? []
    };
}

export async function prepareContext(args, strategy) {
    const defaults = strategy.defaults ?? {};
    const requestedTf = args.tf ? String(args.tf).toUpperCase() : null;
    const dataPath = String(args.data ?? join(ROOT, 'data', requestedTf ? `EURUSD_${requestedTf}.json` : 'EURUSD_H1.json'));
    const rawBars = await loadBars(dataPath, {
        symbol: args.symbol ?? null,
        spread: Number(args['spread-points'] ?? 0),
        point: Number(args.point ?? 0.00001)
    });
    const sessionMode = String(
        strategy.resolveSession
            ? strategy.resolveSession(args)
            : (args.session ?? defaults.session ?? 'raw')
    ).toLowerCase();
    const bars = normalizeSessions(rawBars, sessionMode);
    const tf = String(requestedTf ?? bars.timeframe).toUpperCase();
    const tfDefaults = timeframeDefaults(tf);

    // Optional higher-timeframe series for strategies that separate structure
    // (HTF bias/range/sweep) from execution (LTF MSS/PD array/entry).
    let htfBars = null;
    if (args['htf-data']) {
        const htfRaw = await loadBars(String(args['htf-data']), {
            symbol: args.symbol ?? null,
            spread: Number(args['spread-points'] ?? 0),
            point: Number(args.point ?? 0.00001)
        });
        htfBars = normalizeSessions(htfRaw, sessionMode);
    }

    // Optional context series (the PDF's H1 tier) for daily bias.
    let contextBars = null;
    if (args['context-data']) {
        const contextRaw = await loadBars(String(args['context-data']), {
            symbol: args.symbol ?? null,
            spread: Number(args['spread-points'] ?? 0),
            point: Number(args.point ?? 0.00001)
        });
        contextBars = normalizeSessions(contextRaw, sessionMode);
    }

    const commissionBp = Number(args['commission-bp'] ?? 0.5);
    const slippageBp = Number(args['slippage-bp'] ?? 0.5);
    const frictionBp = Number(args['friction-bp'] ?? (commissionBp + slippageBp));
    const swapMode = String(args['swap-mode'] ?? 'rates').toLowerCase();
    const swapSpreadBp = Number(args['swap-spread-bp'] ?? 0.2);
    const flatSwapBp = Number(args['flat-swap-bp'] ?? 0.2);
    const barsPerDay = tf === 'M1' ? 1440
        : tf === 'M5' ? 288
        : tf === 'M15' ? 96
        : tf === 'M30' ? 48
        : tf === 'H1' ? 24
        : tf === 'H4' ? 6
        : 1;
    const barsPerYear = Number(args['bars-per-year'] ?? tfDefaults.barsPerYear);
    const riskFraction = Number(args.risk ?? 0.01);
    const timeValid = Array.isArray(bars.time) && bars.time.length > 0 && bars.time[2] > 315532800;

    let rateContext = swapMode === 'rates' ? await loadRateContext(bars.symbol) : null;
    let ratesUsable = Boolean(rateContext && timeValid);
    if (swapMode === 'rates' && !ratesUsable) {
        console.log('Rate carry unavailable for this feed; using flat swap cost.');
        rateContext = null;
        ratesUsable = false;
    }

    const { start, end } = buildWindow(bars, args);
    const info = { tf, tfDefaults, start, end, timeValid };
    const config = strategy.configure ? strategy.configure(args, info) : {};

    const ctx = {
        args,
        strategy,
        dataPath,
        rawBars,
        bars,
        tf,
        tfDefaults,
        htfBars,
        contextBars,
        sessionMode,
        config,
        start,
        end,
        totalBars: Math.max(1, end - start),
        spreadPrice: bars.spreadPrice,
        friction: frictionBp / 10000,
        commissionBp,
        slippageBp,
        frictionBp,
        swapMode,
        swapSpreadBp,
        flatSwapBp,
        barsPerDay,
        barsPerYear,
        riskFraction,
        rateContext,
        ratesUsable,
        timeValid
    };
    ctx.dateOf = index => dateOf(bars, index);
    ctx.makeTrade = (position, exitPrice, reason, exitIndex) => makeTrade(ctx, position, exitPrice, reason, exitIndex);
    return ctx;
}

const REQUIRED_TRADE_FIELDS = ['entryIndex', 'exitIndex', 'direction', 'entry', 'exit', 'risk', 'grossR', 'netR'];

export function runStrategy(strategy, ctx) {
    const trades = strategy.run(ctx);
    if (!Array.isArray(trades)) {
        throw new Error(`Strategy "${strategy.id}" did not return an array of trades`);
    }
    trades.forEach((trade, i) => {
        for (const field of REQUIRED_TRADE_FIELDS) {
            if (trade[field] === undefined) {
                throw new Error(`Strategy "${strategy.id}" trade ${i} is missing "${field}"`);
            }
        }
        if (trade.strategy === undefined) trade.strategy = strategy.id;
    });
    return trades;
}

function format(value, digits = 2) {
    if (value === Infinity) return 'inf';
    if (!Number.isFinite(value)) return 'n/a';
    return value.toFixed(digits);
}

export async function report(ctx, trades) {
    const { strategy, bars, tf, args } = ctx;
    const stats = summarize(trades, ctx.totalBars, ctx.barsPerYear, ctx.riskFraction);

    console.log(`${strategy.label}`);
    console.log(`Data: ${ctx.dataPath}`);
    console.log(`TF: ${tf}, bars: ${bars.n}${ctx.sessionMode === 'raw' ? '' : ` (${ctx.rawBars.n} raw, session ${ctx.sessionMode})`}`);
    console.log(`Strategy: ${strategy.id}, config: ${JSON.stringify(ctx.config)}`);
    console.log(`Spread: ${(bars.spreadPrice * 1e4).toFixed(2)}bps price, commission: ${ctx.commissionBp}bps, slippage: ${ctx.slippageBp}bps/side`);
    console.log(`Swap: ${ctx.swapMode}${ctx.swapMode === 'rates' && !ctx.ratesUsable ? ' (rates unavailable, flat fallback)' : ''}, spread: ${ctx.swapSpreadBp}bps/day, flat: ${ctx.flatSwapBp}bps/day, risk: ${(ctx.riskFraction * 100).toFixed(1)}%\n`);
    console.log(`Trades ${stats.trades}, win ${format(stats.winRate * 100, 1)}%, long/short ${stats.longs}/${stats.shorts}`);
    console.log(`Avg gross ${format(stats.avgGrossR, 2)}R, avg net ${format(stats.avgNetR, 2)}R, cost ${format(stats.costR, 2)}R, PF ${format(stats.profitFactor)}`);
    console.log(`CAGR ${format(stats.cagr * 100, 1)}%, maxDD ${format(stats.maxDrawdown * 100, 1)}%, Sharpe ${format(stats.sharpe)}, trades/yr ${format(stats.tradesPerYear, 1)}`);
    console.log(`Exposure ${format(stats.exposure * 100, 1)}%, avg bars held ${format(stats.avgBarsHeld, 1)}, exits ${JSON.stringify(stats.exits)}`);

    const label = String(args.label ?? `${bars.symbol}_${tf}_${strategy.id}`);
    if (!args['no-save']) {
        const output = {
            data: ctx.dataPath,
            timeframe: tf,
            strategy: strategy.id,
            strategyLabel: strategy.label,
            bars: bars.n,
            rawBars: ctx.rawBars.n,
            sessionMode: ctx.sessionMode,
            config: ctx.config,
            costs: {
                commissionBp: ctx.commissionBp,
                slippageBp: ctx.slippageBp,
                frictionBp: ctx.frictionBp,
                swapMode: ctx.swapMode,
                swapSpreadBp: ctx.swapSpreadBp,
                flatSwapBp: ctx.flatSwapBp,
                riskFraction: ctx.riskFraction,
                barsPerYear: ctx.barsPerYear
            },
            window: { start: ctx.start, end: ctx.end },
            stats,
            trades
        };
        await Bun.write(join(RESULTS, `${label}.json`), JSON.stringify(output, null, 2));

        const header = 'entryIndex,exitIndex,entryDate,exitDate,strategy,setup,setupWeekday,direction,entry,exit,stop,target,risk,grossR,netR,costR,carryR,swapR,barsHeld,reason,htf';
        const rows = trades.map(trade => [
            trade.entryIndex, trade.exitIndex, trade.entryDate, trade.exitDate, trade.strategy, trade.setup,
            trade.setupWeekday, trade.direction, trade.entry, trade.exit, trade.stop, trade.target, trade.risk,
            trade.grossR, trade.netR, trade.costR, trade.carryR, trade.swapR, trade.barsHeld, trade.reason,
            (trade.htf ?? []).join('/')
        ].join(','));
        await Bun.write(join(RESULTS, `${label}_trades.csv`), [header, ...rows].join('\n'));
        console.log(`\nWrote results/${label}.json and _trades.csv`);
    }

    if (ctx.signalLog?.length) {
        await Bun.write(join(RESULTS, `${label}_signals.json`), JSON.stringify(ctx.signalLog, null, 2));
        const signalHeader = 'stage,time,date,direction,price,entry,stop,target,rr,netR';
        const signalRows = ctx.signalLog.map(s => [
            s.stage ?? '', s.time ?? '', s.date ?? '', s.direction ?? '', s.price ?? '',
            s.entry ?? '', s.stop ?? '', s.target ?? '',
            Number.isFinite(s.rr) ? s.rr.toFixed(3) : '',
            Number.isFinite(s.netR) ? s.netR.toFixed(3) : ''
        ].join(','));
        await Bun.write(join(RESULTS, `${label}_signals.csv`), [signalHeader, ...signalRows].join('\n'));
        console.log(`Wrote results/${label}_signals.json and _signals.csv`);
    }
    return stats;
}
