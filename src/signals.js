// Live D1 signal sheet for the frozen Strat baseline.
// Fetches fresh Dukascopy daily bars, uses the last completed bar as the
// setup, and prints conditional orders for the next daily bar.

import { getHistoricalRates } from 'dukascopy-node';
import { join } from 'node:path';
import chalk from 'chalk';
import boxen from 'boxen';
import Table from 'cli-table3';
import { loadBars } from './data.js';
import { classifyCandles, setupAt, htfBias, htfAllows, structuralTarget } from './strat.js';

const ROOT = join(import.meta.dir, '..');
const DEFAULT_PAIRS = [
    'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP',
    'EURJPY', 'GBPJPY', 'EURCHF', 'EURAUD', 'EURCAD', 'AUDJPY', 'CADJPY', 'CHFJPY'
];
const SETUP_DESCRIPTION = {
    '2-1': '1 after 2U/2D',
    '3-1': '1 after outside',
    '1-2': '2U/2D after 1',
    '2-2': '2U/2D after 2U/2D',
    '3-2': '2U/2D after outside'
};

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) { options[key] = true; continue; }
        options[key] = value;
        i++;
    }
    return options;
}

const args = parseArgs(process.argv.slice(2));
const pairs = String(args.pairs ?? DEFAULT_PAIRS.join(',')).split(',').map(value => value.trim().toUpperCase());
const days = Math.max(90, Number(args.days ?? 220));
const htfMode = String(args.htf ?? 'continuity').toLowerCase();
const setups = new Set(String(args.setups ?? '2-1,3-1,1-2,2-2,3-2').split(',').map(value => value.trim()));
const offline = args.offline === true;
if (args['no-color'] || !process.stdout.isTTY) chalk.level = 0;

if (args.help) {
    const help = [
        `${chalk.bold('bun run signals')} ${chalk.dim('[options]')}`,
        '',
        `${chalk.cyan('--pairs')} EURUSD,GBPUSD   pairs to scan`,
        `${chalk.cyan('--days')} 220              D1 lookback calendar days`,
        `${chalk.cyan('--htf')} continuity        continuity | all | reversal | none`,
        `${chalk.cyan('--setups')} 2-1,3-1,...   setup names to include`,
        `${chalk.cyan('--offline')}               use local CSV snapshot`,
        `${chalk.cyan('--no-quote')}              skip H1 last-price status`,
        `${chalk.cyan('--cards')}                  full cards for triggered signals`,
        `${chalk.cyan('--no-color')}              disable ANSI color`
    ];
    console.log(boxen(help.join('\n'), {
        title: chalk.bgCyan.black.bold(' HELP '),
        titleAlignment: 'left',
        width: 64,
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderStyle: 'round',
        borderColor: 'cyan'
    }));
    process.exit(0);
}

const pad = (text, width) => String(text).padEnd(width).slice(0, width);

const dateOf = timestampMs => new Date(timestampMs).toISOString().slice(0, 10);
const barDate = timestampSeconds => new Date(timestampSeconds * 1000).toISOString().slice(0, 10);
const isoNow = () => new Date().toISOString().slice(0, 16).replace('T', ' ') + ' UTC';

function expectedLastBar(now = new Date()) {
    const d = new Date(Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()));
    if (now.getUTCHours() < 23) d.setUTCDate(d.getUTCDate() - 1);
    while (d.getUTCDay() === 0 || d.getUTCDay() === 6) d.setUTCDate(d.getUTCDate() - 1);
    return d.toISOString().slice(0, 10);
}

function nextSessionDate(date) {
    const d = new Date(`${date}T00:00:00Z`);
    do { d.setUTCDate(d.getUTCDate() + 1); } while (d.getUTCDay() === 0 || d.getUTCDay() === 6);
    return d.toISOString().slice(0, 10);
}

function barsFromRows(rows, symbol) {
    const byDate = new Map();
    for (const bar of rows) {
        if (![bar.open, bar.high, bar.low, bar.close].every(Number.isFinite)) continue;
        byDate.set(dateOf(bar.timestamp), bar);
    }
    const sorted = [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]));
    if (sorted.length > 0) {
        const now = new Date();
        const lastDate = sorted[sorted.length - 1][0];
        if (lastDate === dateOf(now.getTime()) && now.getUTCHours() < 23) sorted.pop();
    }
    return {
        symbol,
        source: 'Dukascopy live',
        time: sorted.map(([, bar]) => Math.floor(bar.timestamp / 1000)),
        open: sorted.map(([, bar]) => bar.open),
        high: sorted.map(([, bar]) => bar.high),
        low: sorted.map(([, bar]) => bar.low),
        close: sorted.map(([, bar]) => bar.close),
        n: sorted.length
    };
}

async function fetchPair(pair) {
    const to = new Date(Date.now() + 24 * 60 * 60 * 1000);
    const from = new Date(Date.now() - days * 24 * 60 * 60 * 1000);
    let lastError;
    for (let attempt = 0; attempt < 3; attempt++) {
        try {
            const rows = await getHistoricalRates({
                instrument: pair.toLowerCase(),
                dates: { from, to },
                timeframe: 'd1',
                format: 'json',
                priceType: 'bid'
            });
            const bars = barsFromRows(rows, pair);
            if (bars.n < 30) throw new Error(`only ${bars.n} bars`);
            return bars;
        } catch (error) {
            lastError = error;
            await Bun.sleep(700 * (attempt + 1));
        }
    }
    throw lastError;
}

async function fetchQuote(pair) {
    const to = new Date(Date.now() + 60 * 60 * 1000);
    const from = new Date(Date.now() - 3 * 24 * 60 * 60 * 1000);
    const rows = await getHistoricalRates({
        instrument: pair.toLowerCase(),
        dates: { from, to },
        timeframe: 'h1',
        format: 'json',
        priceType: 'bid'
    });
    const valid = rows.filter(bar => [bar.open, bar.high, bar.low, bar.close].every(Number.isFinite));
    if (!valid.length) return null;
    const last = valid[valid.length - 1];
    return {
        price: last.close,
        time: Math.floor(last.timestamp / 1000),
        ageMinutes: (Date.now() - last.timestamp) / 60000
    };
}

async function localPair(pair) {
    const dataFile = join(ROOT, 'data', 'broker', `${pair}.csv`);
    const bars = await loadBars(dataFile, {
        symbol: pair,
        spread: 10,
        point: pair.includes('JPY') ? 0.001 : 0.00001
    });
    return { ...bars, source: 'LOCAL SNAPSHOT' };
}

async function mapLimit(items, limit, fn) {
    const results = new Array(items.length);
    let next = 0;
    async function worker() {
        while (true) {
            const index = next++;
            if (index >= items.length) return;
            results[index] = await fn(items[index], index);
        }
    }
    await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
    return results;
}

function htfLabel(bias) {
    const arrow = value => value > 0 ? 'UP' : value < 0 ? 'DN' : 'FLAT';
    return `W ${arrow(bias[0])} / M ${arrow(bias[1])}`;
}

function directionLabel(direction) {
    return direction > 0 ? 'LONG' : 'SHORT';
}

function triggerState(signal) {
    if (!signal.quote) return { label: 'PRICE UNAVAILABLE', tone: 'dim' };
    const price = signal.quote.price;
    if (signal.direction > 0) {
        if (price <= signal.stop) return { label: 'INVALIDATED', tone: 'red' };
        if (price >= signal.target) return { label: 'TARGET REACHED', tone: 'green' };
        if (price >= signal.entry) return { label: 'TRIGGERED', tone: 'yellow' };
        return { label: 'WAITING', tone: 'dim' };
    }
    if (price >= signal.stop) return { label: 'INVALIDATED', tone: 'red' };
    if (price <= signal.target) return { label: 'TARGET REACHED', tone: 'green' };
    if (price <= signal.entry) return { label: 'TRIGGERED', tone: 'yellow' };
    return { label: 'WAITING', tone: 'dim' };
}

function ageLabel(minutes) {
    if (!Number.isFinite(minutes)) return 'n/a';
    if (minutes < 120) return `${Math.max(0, Math.round(minutes))}m ago`;
    if (minutes < 48 * 60) return `${(minutes / 60).toFixed(1)}h ago`;
    return `${(minutes / 1440).toFixed(1)}d ago`;
}

function analyze(bars, pair, quote) {
    const s = bars.n - 1;
    if (s < 30) {
        return { pair, status: 'error', reason: 'not enough bars', bars };
    }
    const types = classifyCandles(bars);
    const setup = setupAt(types, bars, s);
    const bias = htfBias(bars, s, [5, 21], true);
    const latest = barDate(bars.time[s]);
    if (!setup) return { pair, status: 'no-setup', lastBarType: types[s], bias, latest, bars };
    if (!setups.has(setup.name)) return { pair, status: 'filtered', setup: setup.name, bias, latest, bars };
    if (!htfAllows(bias, 1, htfMode) && !htfAllows(bias, -1, htfMode)) {
        return { pair, status: 'htf-blocked', setup: setup.name, bias, latest, bars };
    }

    const signals = [];
    for (const direction of [1, -1]) {
        if (!htfAllows(bias, direction, htfMode)) continue;
        const entry = direction > 0 ? setup.triggerHigh : setup.triggerLow;
        const stop = direction > 0 ? setup.stopLong : setup.stopShort;
        const risk = Math.abs(entry - stop);
        if (!(risk > 0) || !Number.isFinite(risk)) continue;
        const target = structuralTarget(bars, s, direction, entry, risk, 20);
        const pip = pair.includes('JPY') ? 0.01 : 0.0001;
        const decimals = pair.includes('JPY') ? 3 : 5;
        signals.push({
            pair,
            status: 'signal',
            direction,
            directionLabel: directionLabel(direction),
            setup: setup.name,
            setupDescription: SETUP_DESCRIPTION[setup.name] ?? setup.name,
            entry,
            stop,
            target,
            risk,
            riskPips: risk / pip,
            rr: Math.abs((target - entry) / (entry - stop)),
            decimals,
            htf: bias,
            latest,
            source: bars.source,
            quote
        });
    }
    return { pair, signals, bias, latest, bars, status: signals.length ? 'signal' : 'htf-blocked' };
}

function card(signal) {
    const long = signal.direction > 0;
    const dir = long ? chalk.green.bold('LONG') : chalk.red.bold('SHORT');
    const orderType = long ? 'BUY STOP' : 'SELL STOP';
    const state = triggerState(signal);
    const stateColor = state.tone === 'green' ? chalk.green.bold
        : state.tone === 'red' ? chalk.red.bold
            : state.tone === 'yellow' ? chalk.yellow.bold
                : chalk.dim;
    const label = text => chalk.dim(pad(text, 9));
    const quote = signal.quote
        ? `${signal.quote.price.toFixed(signal.decimals)}  ${chalk.dim(`(${ageLabel(signal.quote.ageMinutes)})`)}`
        : chalk.dim('n/a');
    const content = [
        `${dir}  ${chalk.bold(signal.setup)}  ${chalk.dim(signal.setupDescription)}`,
        chalk.gray('─'.repeat(40)),
        `${label('ENTRY')}${chalk.bold(orderType)}  ${chalk.white.bold(signal.entry.toFixed(signal.decimals))}`,
        `${label('STOP')}${chalk.white(signal.stop.toFixed(signal.decimals))}`,
        `${label('TARGET')}${chalk.white(signal.target.toFixed(signal.decimals))}`,
        `${label('RISK')}${signal.riskPips.toFixed(1)} pips  ${chalk.dim('R:R')} ${signal.rr.toFixed(2)}`,
        `${label('HTF')}${htfLabel(signal.htf)}`,
        `${label('LAST')}${quote}`,
        `${label('STATUS')}${stateColor(state.label)}`,
        `${label('BAR')}${chalk.dim(`${signal.latest} -> ${nextSessionDate(signal.latest)}`)}`
    ].join('\n');

    return boxen(content, {
        title: chalk.bold(signal.pair),
        titleAlignment: 'left',
        width: 46,
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        margin: { top: 0, bottom: 1, left: 0, right: 0 },
        borderStyle: 'round',
        borderColor: long ? 'green' : 'red'
    });
}

function renderHeader(info) {
    const badge = info.stale ? chalk.bgYellow.black.bold(' STALE ') : chalk.bgGreen.black.bold(' FRESH ');
    const unpriced = info.unknown ? `   ${info.unknown} unpriced` : '';
    const lines = [
        `${chalk.gray(info.now)}   ${chalk.dim('feed')} ${chalk.white(info.feedLabel)}`,
        `${chalk.dim('last bar')} ${chalk.bold(info.latest)}   ${chalk.dim('orders for')} ${chalk.bold(info.nextSession)}   ${badge}`,
        `${chalk.dim('expected')} ${info.expected}   ${info.pairs} pair${info.pairs === 1 ? '' : 's'}`,
        `${chalk.green.bold(`${info.longCount} long`)}   ${chalk.red.bold(`${info.shortCount} short`)}   ${chalk.dim('|')}   ${chalk.bold(`${info.signals} signal${info.signals === 1 ? '' : 's'}`)}`,
        `${info.pending} pending   ${info.triggered} triggered   ${info.closed} closed${unpriced}`,
        `${info.watch} stand down   ${info.errors} error${info.errors === 1 ? '' : 's'}`
    ];
    console.log(boxen(lines.join('\n'), {
        title: chalk.bgCyan.black.bold(' STRAT D1 SIGNALS '),
        titleAlignment: 'left',
        width: 74,
        padding: { top: 0, bottom: 0, left: 1, right: 1 },
        borderStyle: 'round',
        borderColor: info.stale ? 'yellow' : 'cyan'
    }));
    if (info.stale) {
        console.log(boxen(chalk.yellow('Latest bar is before the expected completed session. Treat these signals as stale.'), {
            padding: { top: 0, bottom: 0, left: 1, right: 1 },
            borderStyle: 'round',
            borderColor: 'yellow',
            width: 74
        }));
    }
}

function renderWatchTable(closed, watch) {
    if (!closed.length && !watch.length) return;
    const rows = [];
    for (const item of closed) {
        const signal = item.signal;
        const price = signal.quote ? signal.quote.price.toFixed(signal.decimals) : 'n/a';
        const color = item.state.label === 'TARGET REACHED' ? chalk.green : chalk.red;
        rows.push([
            chalk.bold(signal.pair),
            color(item.state.label),
            `${signal.directionLabel} ${signal.setup}`,
            chalk.dim(htfLabel(signal.htf)),
            price
        ]);
    }
    for (const result of watch) {
        const bias = result.bias ? chalk.dim(htfLabel(result.bias)) : '';
        if (result.status === 'no-setup') {
            rows.push([chalk.bold(result.pair), chalk.dim('no setup'), chalk.dim(`bar ${result.lastBarType ?? '?'}`), bias, '']);
        } else if (result.status === 'filtered') {
            rows.push([chalk.bold(result.pair), chalk.dim('filtered'), chalk.dim(`setup ${result.setup}`), bias, '']);
        } else if (result.status === 'htf-blocked') {
            rows.push([chalk.bold(result.pair), chalk.yellow('HTF blocked'), '', bias, '']);
        } else {
            rows.push([chalk.bold(result.pair), chalk.red('ERROR'), chalk.dim(String(result.reason).slice(0, 18)), bias, '']);
        }
    }
    const table = new Table({
        head: [chalk.bold('PAIR'), chalk.bold('STATE'), chalk.bold('DETAIL'), chalk.bold('HTF'), chalk.bold('LAST')],
        colWidths: [8, 16, 20, 17, 10],
        style: { head: [], border: [], compact: true },
        wordWrap: false
    });
    for (const row of rows) table.push(row);
    console.log('\n' + chalk.bold.cyan('STAND DOWN / CLOSED'));
    console.log(table.toString());
    console.log('');
}

function renderSignalTable(signals) {
    const table = new Table({
        head: [chalk.bold('PAIR'), chalk.bold('DIR'), chalk.bold('SETUP'), chalk.bold('ENTRY'), chalk.bold('STOP'), chalk.bold('TARGET'), chalk.bold('R:R'), chalk.bold('LAST'), chalk.bold('STATUS')],
        colWidths: [9, 7, 8, 10, 10, 10, 6, 10, 12],
        style: { head: [], border: [], compact: true },
        wordWrap: false
    });
    for (const signal of signals) {
        const last = signal.quote ? signal.quote.price.toFixed(signal.decimals) : 'n/a';
        table.push([
            chalk.bold(signal.pair),
            signal.direction > 0 ? chalk.green('LONG') : chalk.red('SHORT'),
            signal.setup,
            signal.entry.toFixed(signal.decimals),
            signal.stop.toFixed(signal.decimals),
            signal.target.toFixed(signal.decimals),
            signal.rr.toFixed(2),
            last,
            chalk.yellow.bold(triggerState(signal).label)
        ]);
    }
    console.log(table.toString());
    console.log('');
}

async function main() {
    const started = Date.now();
    const expected = expectedLastBar();
    const results = await mapLimit(pairs, 4, async pair => {
        if (offline) {
            try { return analyze(await localPair(pair), pair); }
            catch (error) { return { pair, status: 'error', reason: error.message }; }
        }
        try {
            const bars = await fetchPair(pair);
            let quote = null;
            if (args['no-quote'] !== true) {
                try { quote = await fetchQuote(pair); } catch { /* quote is optional */ }
            }
            return analyze(bars, pair, quote);
        } catch (error) {
            try {
                const result = analyze(await localPair(pair), pair);
                result.warning = `live fetch failed, using local snapshot: ${error.message}`;
                return result;
            } catch (fallbackError) {
                return { pair, status: 'error', reason: error.message };
            }
        }
    });

    const signals = results.flatMap(result => result.signals ?? []);
    const watch = results.filter(result => result.status !== 'signal');
    const errors = results.filter(result => result.status === 'error');
    const latestDates = results.filter(result => result.latest).map(result => result.latest).sort();
    const latest = latestDates.length ? latestDates[latestDates.length - 1] : 'n/a';
    const oldest = latestDates.length ? latestDates[0] : 'n/a';
    const stale = latestDates.length > 0 && latest < expected;
    const fallback = results.some(result => result.bars?.source === 'LOCAL SNAPSHOT');
    const longCount = signals.filter(signal => signal.direction > 0).length;
    const shortCount = signals.length - longCount;
    const scored = signals.map(signal => ({ signal, state: triggerState(signal) }));
    const pending = scored.filter(item => item.state.label === 'WAITING').map(item => item.signal);
    const triggered = scored.filter(item => item.state.label === 'TRIGGERED').map(item => item.signal);
    const unknown = scored.filter(item => item.state.label === 'PRICE UNAVAILABLE').map(item => item.signal);
    const closed = scored.filter(item => ['TARGET REACHED', 'INVALIDATED'].includes(item.state.label));
    const nextSession = latest !== 'n/a' ? nextSessionDate(latest) : 'n/a';
    const feedLabel = offline ? 'local snapshot (offline)' : `Dukascopy D1${fallback ? ' + local fallback' : ''}`;

    renderHeader({
        now: isoNow(),
        feedLabel,
        latest,
        nextSession,
        expected,
        pairs: pairs.length,
        signals: signals.length,
        longCount,
        shortCount,
        pending: pending.length,
        triggered: triggered.length,
        unknown: unknown.length,
        closed: closed.length,
        watch: watch.length,
        errors: errors.length,
        stale
    });

    if (pending.length) {
        console.log('\n' + chalk.bold.cyan('PENDING ORDERS'));
        for (const signal of pending) console.log(card(signal));
    }

    if (unknown.length) {
        console.log('\n' + chalk.bold.cyan('UNPRICED SIGNALS'));
        for (const signal of unknown) console.log(card(signal));
    }

    if (triggered.length) {
        console.log('\n' + chalk.bold.cyan('TRIGGERED / ACTIVE'));
        if (args.cards) {
            for (const signal of triggered) console.log(card(signal));
        } else {
            renderSignalTable(triggered);
        }
    }

    if (!pending.length && !triggered.length && !unknown.length && closed.length === 0) {
        console.log('\n' + chalk.dim('No qualifying signals on the latest completed bar.'));
    }

    renderWatchTable(closed, watch);

    console.log(chalk.dim('Orders are conditional: enter only if price breaks the trigger.'));
    console.log(chalk.dim('The setup bar is the last completed D1 bar; the order is for the next bar.'));
    console.log(chalk.dim('STATUS and LAST use the latest completed H1 bar, not a live tick.'));
    console.log(chalk.dim('WAITING = order pending. TRIGGERED = entry crossed. INVALIDATED = stop crossed.'));
    console.log(chalk.dim(`Generated in ${((Date.now() - started) / 1000).toFixed(1)}s.`));
}

await main();
