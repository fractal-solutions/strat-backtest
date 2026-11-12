// Compare strategies across pairs and print one table.
//
// This is signal-level: it concatenates each strategy's per-pair trades and
// summarizes them at a common risk fraction. For portfolio-level risk caps use
// portfolio.js instead.

import { join } from 'node:path';
import { readFileSync, existsSync } from 'node:fs';
import { summarize } from './stats.js';
import { timeframeDefaults } from './data.js';
import { listStrategies } from './strategies/index.js';
import { recordTrial } from './trials.js';
import { shSeries } from './stats.js';

const ROOT = join(import.meta.dir, '..');
const RESULTS = join(ROOT, 'results');

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        if (key === 'no-save' || key === 'record') { options[key] = true; continue; }
        if (key === 'flags') {
            options[key] = argv[++i];
            continue;
        }
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) { options[key] = true; continue; }
        options[key] = value;
        i++;
    }
    return options;
}

const args = parseArgs(process.argv.slice(2));
const available = listStrategies().map(strategy => strategy.id);
const strategies = String(args.strategies ?? available.join(','))
    .split(',').map(value => value.trim()).filter(Boolean);
const pairs = String(args.pairs ?? 'EURUSD,GBPUSD')
    .split(',').map(value => value.trim().toUpperCase()).filter(Boolean);
const dataDir = String(args['data-dir'] ?? 'data/broker');
const template = String(args.template ?? '{pair}.csv');
const tf = String(args.tf ?? 'D1').toUpperCase();
const startDate = String(args.start ?? '2014-01-01');
const endDate = String(args.end ?? '2026-10-29');
const spreadPoints = String(args['spread-points'] ?? 10);
const riskFraction = Number(args.risk ?? 0.01);
const extra = args.flags ? String(args.flags).match(/(?:[^\s"]+|"[^"]*")+/g).map(v => v.replace(/^"|"$/g, '')) : [];
const barsPerYear = timeframeDefaults(tf).barsPerYear;

const rows = [];
for (const strategy of strategies) {
    const trades = [];
    let windowBars = 0;
    let sourceBars = 0;
    for (const pair of pairs) {
        const dataFile = join(dataDir, template.replace('{pair}', pair));
        if (!existsSync(join(ROOT, dataFile))) continue;
        const label = `cmp_${strategy}_${pair}_${tf}`;
        const command = [
            'bun', 'run', 'src/backtest.js',
            '--strategy', strategy,
            '--data', dataFile,
            '--symbol', pair,
            '--spread-points', spreadPoints,
            '--point', pair.includes('JPY') ? '0.001' : '0.00001',
            '--tf', tf,
            '--start-date', startDate,
            '--end-date', endDate,
            '--label', label,
            ...extra
        ];
        const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
        if (result.exitCode !== 0) {
            console.error(`${strategy}/${pair} failed: ${result.stderr.toString().split('\n')[0]}`);
            continue;
        }
        const output = JSON.parse(readFileSync(join(RESULTS, `${label}.json`), 'utf8'));
        for (const trade of output.trades) trades.push(trade);
        windowBars = Math.max(windowBars, output.window.end - output.window.start);
        sourceBars += output.bars;
    }
    if (trades.length === 0) {
        rows.push({ strategy, trades: 0, win: 0, avg: 0, pf: 0, cagr: 0, maxDD: 0, sharpe: 0 });
        continue;
    }
    const stats = summarize(trades, Math.max(1, windowBars), barsPerYear, riskFraction);
    const monthly = new Map();
    for (const trade of trades) {
        const month = String(trade.exitDate).slice(0, 7);
        if (!monthly.has(month)) monthly.set(month, []);
        monthly.get(month).push(trade.netR);
    }
    const monthlyReturns = [...monthly.entries()].sort().map(([month, values]) => ({
        month,
        value: values.reduce((acc, r) => acc * (1 + riskFraction * r), 1) - 1
    }));
    const monthlySharpe = shSeries(monthlyReturns.map(row => row.value));
    rows.push({
        strategy,
        trades: stats.trades,
        win: stats.winRate,
        avg: stats.avgNetR,
        gross: stats.avgGrossR,
        cost: stats.costR,
        pf: stats.profitFactor,
        cagr: stats.cagr,
        maxDD: stats.maxDrawdown,
        sharpe: stats.sharpe,
        monthlySharpe
    });
    if (args.record) {
        recordTrial({
            id: `${strategy}-${tf}-record`,
            strategy,
            sharpe: monthlySharpe,
            source: 'compare',
            note: `${pairs.join(',')} ${startDate}..${endDate} ${extra.join(' ')}`.trim()
        });
    }
}

const fmt = (value, digits = 2) => Number.isFinite(value) ? value.toFixed(digits) : 'n/a';
console.log(`\nStrategies: ${strategies.join(', ')}`);
console.log(`Pairs: ${pairs.join(',')}, TF: ${tf}, ${startDate}..${endDate}, spread ${spreadPoints} points\n`);
console.log('strategy'.padEnd(18), 'trades'.padStart(7), 'win%'.padStart(7), 'grossR'.padStart(7), 'costR'.padStart(7), 'netR'.padStart(7), 'PF'.padStart(6), 'CAGR'.padStart(8), 'maxDD'.padStart(8), 'Sharpe'.padStart(7));
for (const row of rows) {
    console.log(
        row.strategy.padEnd(18),
        String(row.trades).padStart(7),
        `${fmt(row.win * 100, 1)}%`.padStart(7),
        fmt(row.gross ?? 0, 3).padStart(7),
        fmt(row.cost ?? 0, 3).padStart(7),
        fmt(row.avg, 3).padStart(7),
        fmt(row.pf).padStart(6),
        `${fmt(row.cagr * 100, 1)}%`.padStart(8),
        `${fmt(row.maxDD * 100, 1)}%`.padStart(8),
        fmt(row.sharpe).padStart(7)
    );
}

if (!args['no-save']) {
    await Bun.write(join(RESULTS, `compare_${tf}.json`), JSON.stringify({
        generated: new Date().toISOString(),
        strategies, pairs, tf, startDate, endDate, spreadPoints, extra,
        rows
    }, null, 2));
    console.log(`\nWrote results/compare_${tf}.json`);
}
