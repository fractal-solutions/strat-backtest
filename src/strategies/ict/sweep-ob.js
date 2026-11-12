// ICT model 1: liquidity sweep -> order-block entry.
//
// 1. Price sweeps a recent swing high/low and closes back inside it.
// 2. The sweep bar must close in the reversal direction (displacement).
// 3. Mark the last opposite candle before the sweep as the order block.
// 4. Enter on a retest of the block midpoint, stop beyond the block,
//    target `rMultiple` R.
// 5. Optional killzone filter (London / New York).

import { atr, sweepAt, orderBlockBefore, inKillzone } from './primitives.js';
import { simulateLimit } from './simulate.js';

export const id = 'ict-sweep-ob';
export const label = 'ICT: liquidity sweep -> order block';
export const defaults = { session: 'raw' };

export function configure(args, info) {
    return {
        swingLookback: Number(args['swing-lookback'] ?? 20),
        obLookback: Number(args['ob-lookback'] ?? 10),
        validBars: Number(args['valid-bars'] ?? 8),
        maxHold: Number(args['max-hold'] ?? 48),
        rMultiple: Number(args['r-multiple'] ?? 2),
        bufferAtr: Number(args['buffer-atr'] ?? 0.1),
        minRiskAtr: Number(args['min-risk-atr'] ?? 0.25),
        killzones: String(args['killzones'] ?? 'london,ny').split(',').map(v => v.trim()).filter(Boolean),
        useKillzone: args['no-killzone'] !== true && info.tf !== 'D1',
        requireDisplacement: args['no-displacement'] !== true
    };
}

export function run(ctx) {
    const { bars, config, start, end } = ctx;
    const trades = [];
    let blockedUntil = -1;

    for (let i = Math.max(30, start); i < end - 2; i++) {
        if (i <= blockedUntil) continue;
        if (config.useKillzone && !inKillzone(bars.time?.[i] * 1000, config.killzones)) continue;

        const sweep = sweepAt(bars, i, config.swingLookback);
        if (sweep.highSweep === sweep.lowSweep) continue;
        const direction = sweep.lowSweep ? 1 : -1;

        if (config.requireDisplacement) {
            if (direction > 0 && bars.close[i] <= bars.open[i]) continue;
            if (direction < 0 && bars.close[i] >= bars.open[i]) continue;
        }

        const ob = orderBlockBefore(bars, i, direction, config.obLookback);
        if (!ob) continue;

        const buffer = atr(bars, i, 14) * config.bufferAtr;
        const entry = ob.mid;
        const stop = direction > 0 ? ob.low - buffer : ob.high + buffer;
        const risk = Math.abs(entry - stop);
        if (!(risk > 0) || risk < atr(bars, i, 14) * config.minRiskAtr) continue;
        const target = direction > 0 ? entry + config.rMultiple * risk : entry - config.rMultiple * risk;

        const trade = simulateLimit(ctx, {
            signalIndex: i,
            direction,
            entry,
            stop,
            target,
            validBars: config.validBars,
            maxHold: config.maxHold,
            setup: 'sweep-ob'
        });
        if (!trade) continue;
        trades.push(trade);
        blockedUntil = trade.exitIndex;
    }

    return trades;
}
