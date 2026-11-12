// One-command validation for the session-clean core.
//
// Runs the frozen baseline and the recommended core side by side, over the
// full history and the 2014-2026 out-of-sample window, then reports the
// metrics that actually matter for this strategy: portfolio Sharpe, drawdown,
// profit factor, and tail concentration. Win rate is intentionally absent.

import { join } from 'node:path';
import { readFileSync } from 'node:fs';
import { shSeries, deflatedSharpeSeries } from './stats.js';
import { trialSharpes as registeredTrialSharpes } from './trials.js';

const ROOT = join(import.meta.dir, '..');
const RESULTS = join(ROOT, 'results');
const PAIRS = 'EURUSD,GBPUSD,USDJPY,AUDUSD,USDCAD,USDCHF,NZDUSD,EURGBP,EURJPY,GBPJPY,EURCHF,EURAUD,EURCAD,AUDJPY,CADJPY,CHFJPY';

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
const pairs = String(args.pairs ?? PAIRS);
const volTarget = Number(args['vol-target'] ?? 0.10);

const VARIANTS = [
    { key: 'legacy', label: 'legacy look-ahead', flags: ['--ambiguous', 'skip'] },
    { key: 'honest', label: 'honest D1 bound', flags: ['--ambiguous', 'stop'] },
    { key: 'core', label: 'core honest', flags: ['--preset', 'core', '--ambiguous', 'stop'] },
    { key: 'core-vol', label: 'core + vol honest', flags: ['--preset', 'core', '--ambiguous', 'stop', '--vol-target', String(volTarget)] }
];

const WINDOWS = [
    { key: 'full', label: 'Full history 2008-2026', start: '2008-01-01', end: '2026-10-29' },
    { key: 'oos', label: 'Out-of-sample 2014-2026', start: '2014-01-01', end: '2026-10-29' }
];

function runPortfolio(variant, window) {
    const tag = `val_${variant.key}_${window.key}`;
    const command = [
        'bun', 'run', 'src/portfolio.js',
        '--data-dir', 'data/broker',
        '--template', '{pair}.csv',
        '--symbol-csv',
        '--pairs', pairs,
        '--start', window.start,
        '--end', window.end,
        '--tag', tag,
        ...variant.flags
    ];
    const result = Bun.spawnSync(command, { cwd: ROOT, stdout: 'pipe', stderr: 'pipe' });
    if (result.exitCode !== 0) {
        throw new Error(`${variant.key}/${window.key} failed: ${result.stderr.toString().split('\n')[0]}`);
    }
    return JSON.parse(readFileSync(join(RESULTS, `portfolio_${tag}.json`), 'utf8'));
}

// Multiple-testing penalty from the pre-registered variants plus every trial
// recorded in results/trials.json. Reusing one trial set for every config keeps
// the comparison honest rather than tuning the penalty per strategy.
let trialSharpes = registeredTrialSharpes();
try {
    const robustness = JSON.parse(readFileSync(join(RESULTS, 'portfolio_robustness.json'), 'utf8'));
    trialSharpes = [...new Set([...trialSharpes, ...(robustness.trialSharpes ?? [])])];
} catch {
    // No pre-registered trial file; the registry alone is the trial set.
}
if (trialSharpes.length === 0) trialSharpes = null;

const rows = [];
for (const window of WINDOWS) {
    console.log(`\n=== ${window.label} (${window.start} .. ${window.end}) ===`);
    console.log('config'.padEnd(22), 'trades'.padStart(7), 'CAGR'.padStart(8), 'vol'.padStart(7), 'Sharpe'.padStart(7), 'maxDD'.padStart(8), 'PF'.padStart(6), 'top5%'.padStart(7), 'DSR'.padStart(6));
    for (const variant of VARIANTS) {
        const output = runPortfolio(variant, window);
        const values = output.monthlyReturns.map(row => row.value);
        const dsr = trialSharpes
            ? deflatedSharpeSeries(values, trialSharpes)
            : { dsr: null, sr: shSeries(values) };
        const row = {
            window: window.key,
            variant: variant.key,
            label: variant.label,
            trades: Object.values(output.pairTrades ?? {}).reduce((sum, count) => sum + count, 0),
            cagr: output.metrics.cagr,
            vol: output.metrics.vol,
            sharpe: output.metrics.sharpe,
            maxDD: output.metrics.maxDD,
            profitFactor: output.tails?.profitFactor ?? null,
            top5Share: output.tails?.top5Share ?? null,
            dsr: dsr.dsr,
            monthlySharpe: dsr.sr,
            exposure: output.exposure
        };
        rows.push(row);
        console.log(
            variant.label.padEnd(22),
            String(row.trades ?? '').padStart(7),
            `${(row.cagr * 100).toFixed(2)}%`.padStart(8),
            `${(row.vol * 100).toFixed(1)}%`.padStart(7),
            row.sharpe.toFixed(2).padStart(7),
            `${(row.maxDD * 100).toFixed(2)}%`.padStart(8),
            (row.profitFactor === null ? 'n/a' : row.profitFactor.toFixed(2)).padStart(6),
            row.top5Share === null ? 'n/a' : `${(row.top5Share * 100).toFixed(0)}%`.padStart(7),
            (dsr.dsr === null ? 'n/a' : dsr.dsr.toFixed(3)).padStart(6)
        );
    }
}

const oosCore = rows.find(row => row.window === 'oos' && row.variant === 'core');
const oosHonest = rows.find(row => row.window === 'oos' && row.variant === 'honest');
const oosLegacy = rows.find(row => row.window === 'oos' && row.variant === 'legacy');
const dsrPass = oosCore?.dsr !== null && oosCore?.dsr >= 0.95;
const beatsLegacy = oosCore && oosLegacy ? oosCore.sharpe >= oosLegacy.sharpe * 0.95 : false;

console.log('\n=== Verdict ===');
console.log(`OOS core deflated Sharpe: ${oosCore?.dsr === null ? 'n/a' : oosCore?.dsr.toFixed(3)} (gate 0.95)`);
console.log(`OOS core Sharpe vs legacy: ${oosCore?.sharpe.toFixed(2)} vs ${oosLegacy?.sharpe.toFixed(2)} (legacy is look-ahead, not a benchmark)`);
console.log(`OOS honest bound (ambiguous stop): CAGR ${(oosHonest.cagr * 100).toFixed(2)}%, Sharpe ${oosHonest.sharpe.toFixed(2)}, PF ${oosHonest.profitFactor === null ? 'n/a' : oosHonest.profitFactor.toFixed(2)}`);
console.log(`DSR gate: ${dsrPass ? 'PASS' : 'FAIL'}`);
console.log(`Honest status: ${dsrPass && beatsLegacy ? 'candidate for paper trading' : 'research prototype, paper trading only'}`);

await Bun.write(join(RESULTS, 'validation_summary.json'), JSON.stringify({
    generated: new Date().toISOString(),
    pairs: pairs.split(','),
    volTarget,
    trialSharpes,
    rows,
    verdict: { dsrPass, beatsLegacy }
}, null, 2));
console.log('\nWrote results/validation_summary.json');
