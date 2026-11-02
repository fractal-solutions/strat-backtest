// Downloads a broker-style D1 feed from Dukascopy into data/broker/<PAIR>.csv.
// Dukascopy timestamps are Unix milliseconds, so date-based walk-forward works.

import { getHistoricalRates } from 'dukascopy-node';
import { mkdir } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { join } from 'node:path';

const ROOT = join(import.meta.dir, '..');
const OUT = join(ROOT, 'data', 'broker');
const DEFAULT_PAIRS = [
    'EURUSD', 'GBPUSD', 'USDJPY', 'AUDUSD', 'USDCAD', 'USDCHF', 'NZDUSD', 'EURGBP',
    'EURJPY', 'GBPJPY', 'EURCHF', 'EURAUD', 'EURCAD', 'AUDJPY', 'CADJPY', 'CHFJPY'
];

function parseArgs(argv) {
    const options = {};
    for (let i = 0; i < argv.length; i++) {
        const arg = argv[i];
        if (!arg.startsWith('--')) continue;
        const key = arg.slice(2);
        if (key === 'force') { options.force = true; continue; }
        const value = argv[i + 1];
        if (value === undefined || value.startsWith('--')) { options[key] = true; continue; }
        options[key] = value;
        i++;
    }
    return options;
}

const args = parseArgs(process.argv.slice(2));
const pairs = String(args.pairs ?? DEFAULT_PAIRS.join(',')).split(',').map(value => value.trim().toUpperCase());
const from = new Date(String(args.from ?? '2008-01-01'));
const to = new Date(String(args.to ?? '2026-10-30'));

await mkdir(OUT, { recursive: true });

for (const pair of pairs) {
    const path = join(OUT, `${pair}.csv`);
    if (existsSync(path) && !args.force) {
        console.log(`${pair.padEnd(7)} exists (use --force to refresh)`);
        continue;
    }
    try {
        const data = await getHistoricalRates({
            instrument: pair.toLowerCase(),
            dates: { from, to },
            timeframe: 'd1',
            format: 'json',
            priceType: 'bid'
        });
        const byDate = new Map();
        for (const bar of data) {
            const date = new Date(bar.timestamp).toISOString().slice(0, 10);
            byDate.set(date, bar);
        }
        const rows = ['date,open,high,low,close'];
        for (const [date, bar] of [...byDate.entries()].sort((a, b) => a[0].localeCompare(b[0]))) {
            rows.push([date, bar.open, bar.high, bar.low, bar.close].join(','));
        }
        await Bun.write(path, rows.join('\n'));
        console.log(`${pair.padEnd(7)} ${String(rows.length - 1).padStart(5)} bars ${rows[1].slice(0, 10)} .. ${rows[rows.length - 1].slice(0, 10)}`);
    } catch (error) {
        console.error(`${pair.padEnd(7)} FAILED: ${error.message}`);
    }
    await Bun.sleep(250);
}
