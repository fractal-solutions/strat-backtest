// Statistical validation for a saved backtest result.
//
// Reports:
//   - trade-level mean R, PF, win rate
//   - bootstrap 5-95% CI for mean R
//   - monthly Sharpe and deflated Sharpe against the trial registry
//   - block-bootstrap 5-95% CI for monthly Sharpe
//   - sign-flip permutation test for a positive edge
//   - first-half / second-half OOS split
//
// Usage:
//   bun run src/statValidate.js --trades results/<label>.json

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { shSeries, deflatedSharpeSeries } from './stats.js';
import { trialSharpes } from './trials.js';

const ROOT = join(import.meta.dir, '..');
const RESULTS = join(ROOT, 'results');

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
const path = String(args.trades ?? join(RESULTS, 'ict_2022_mtf_m5_h4_d1_final.json'));
const data = JSON.parse(readFileSync(path, 'utf8'));
const trades = data.trades;
const riskPct = Number(args.risk ?? 1);

// Deterministic RNG so the validation is reproducible.
let seed = 987654321;
function rand() {
    seed = (1103515245 * seed + 12345) & 0x7fffffff;
    return seed / 0x7fffffff;
}

function mean(values) {
    return values.length ? values.reduce((a, b) => a + b, 0) / values.length : 0;
}
function percentile(sorted, p) {
    if (!sorted.length) return 0;
    const index = Math.min(sorted.length - 1, Math.max(0, Math.floor(p * (sorted.length - 1))));
    return sorted[index];
}
function profitFactor(values) {
    let gp = 0, gl = 0;
    for (const v of values) {
        if (v > 0) gp += v;
        else gl += -v;
    }
    return gl > 0 ? gp / gl : (gp > 0 ? Infinity : 0);
}
function winRate(values) {
    return values.length ? values.filter(v => v > 0).length / values.length : 0;
}
function monthlyReturns(rows) {
    const months = new Map();
    for (const trade of rows) {
        const month = String(trade.exitDate).slice(0, 7);
        if (!months.has(month)) months.set(month, []);
        months.get(month).push(trade.netR);
    }
    return [...months.entries()]
        .sort(([a], [b]) => a.localeCompare(b))
        .map(([month, rs]) => ({
            month,
            value: rs.reduce((acc, r) => acc * (1 + (riskPct / 100) * r), 1) - 1
        }));
}
function bootstrapMean(values, draws = 5000) {
    const n = values.length;
    const out = [];
    for (let d = 0; d < draws; d++) {
        let sum = 0;
        for (let i = 0; i < n; i++) sum += values[Math.floor(rand() * n)];
        out.push(sum / n);
    }
    out.sort((a, b) => a - b);
    return { mean: mean(values), lo: percentile(out, 0.05), hi: percentile(out, 0.95) };
}
function blockBootstrapSharpe(values, block = 6, draws = 5000) {
    const n = values.length;
    if (n < block) return { sharpe: shSeries(values), lo: 0, hi: 0 };
    const out = [];
    const blocks = Math.ceil(n / block);
    for (let d = 0; d < draws; d++) {
        const sample = [];
        for (let b = 0; b < blocks && sample.length < n; b++) {
            const start = Math.floor(rand() * (n - block + 1));
            for (let i = 0; i < block && sample.length < n; i++) sample.push(values[start + i]);
        }
        out.push(shSeries(sample));
    }
    out.sort((a, b) => a - b);
    return { sharpe: shSeries(values), lo: percentile(out, 0.05), hi: percentile(out, 0.95) };
}
function signFlip(values, draws = 5000) {
    const observed = mean(values);
    let positive = 0;
    let twoSided = 0;
    for (let d = 0; d < draws; d++) {
        let sum = 0;
        for (const v of values) sum += rand() < 0.5 ? -v : v;
        const m = sum / values.length;
        if (m >= observed) positive++;
        if (Math.abs(m) >= Math.abs(observed)) twoSided++;
    }
    return { observed, pPositive: positive / draws, pTwoSided: twoSided / draws };
}
function summarizeRows(rows) {
    const values = rows.map(t => t.netR);
    const months = monthlyReturns(rows);
    return {
        trades: rows.length,
        win: winRate(values),
        meanR: mean(values),
        pf: profitFactor(values),
        monthlySharpe: shSeries(months.map(m => m.value)),
        totalR: values.reduce((a, b) => a + b, 0)
    };
}
const f = (x, d = 3) => Number.isFinite(x) ? x.toFixed(d) : 'n/a';

const values = trades.map(t => t.netR);
const months = monthlyReturns(trades);
const monthlyValues = months.map(m => m.value);
const boot = bootstrapMean(values);
const blockBoot = blockBootstrapSharpe(monthlyValues, 6);
const flip = signFlip(values);
const trials = trialSharpes();
const dsr = deflatedSharpeSeries(monthlyValues, [...trials, shSeries(monthlyValues)]);
const full = summarizeRows(trades);

const years = [...new Set(trades.map(t => String(t.exitDate).slice(0, 4)))].sort();
const cut = Math.max(1, Math.floor(years.length / 2));
const firstYears = new Set(years.slice(0, cut));
const secondYears = new Set(years.slice(cut));
const first = summarizeRows(trades.filter(t => firstYears.has(String(t.exitDate).slice(0, 4))));
const second = summarizeRows(trades.filter(t => secondYears.has(String(t.exitDate).slice(0, 4))));

console.log(`Validation: ${path}`);
console.log(`Trades: ${full.trades}, win ${f(full.win * 100, 1)}%, mean ${f(full.meanR)}R, PF ${f(full.pf)}, total ${f(full.totalR, 0)}R`);
console.log(`Mean R bootstrap 5-95%: [${f(boot.lo)}, ${f(boot.hi)}]`);
console.log(`Monthly Sharpe ${f(full.monthlySharpe)}; block bootstrap 5-95% [${f(blockBoot.lo)}, ${f(blockBoot.hi)}]`);
console.log(`Deflated Sharpe: ${f(dsr.dsr)} (${trials.length + 1} trials)`);
console.log(`Sign-flip: observed ${f(flip.observed)}R, P(mean >= observed) ${f(flip.pPositive)}, two-sided ${f(flip.pTwoSided)}`);
console.log(`OOS split: ${[...firstYears].join(',')} -> ${first.trades} trades, mean ${f(first.meanR)}R, PF ${f(first.pf)}, monthly Sharpe ${f(first.monthlySharpe)}`);
console.log(`           ${[...secondYears].join(',')} -> ${second.trades} trades, mean ${f(second.meanR)}R, PF ${f(second.pf)}, monthly Sharpe ${f(second.monthlySharpe)}`);
