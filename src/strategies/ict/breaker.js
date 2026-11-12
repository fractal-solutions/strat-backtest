// ICT breaker-block reversal.
//
// A breaker is an order block that fails. A bearish order block (last up candle
// before a down move) fails when price closes above it; it then acts as a
// bullish breaker on the retest. A bullish order block fails when price closes
// below it and acts as a bearish breaker.
//
// Entry: retest of the original candle body midpoint.
// Stop: behind the breaker. Target: `rMultiple` R.

import { atr, orderBlockBefore, inKillzone } from './primitives.js';
import { simulateLimit } from './simulate.js';

export const id = 'ict-breaker';
export const label = 'ICT: breaker-block reversal';
export const defaults = { session: 'raw' };

export function configure(args, info) {
    return {
        lookback: Number(args['ob-lookback'] ?? 50),
        validBars: Number(args['valid-bars'] ?? 8),
        maxHold: Number(args['max-hold'] ?? 48),
        rMultiple: Number(args['r-multiple'] ?? 2),
        bufferAtr: Number(args['buffer-atr'] ?? 0.1),
        minRiskAtr: Number(args['min-risk-atr'] ?? 0.25),
        killzones: String(args.killzones ?? 'london,ny').split(',').map(v => v.trim()).filter(Boolean),
        useKillzone: args['no-killzone'] !== true && info.tf !== 'D1'
    };
}

export function run(ctx) {
    const { bars, config, start, end } = ctx;
    const trades = [];
    const used = new Set();
    let blockedUntil = -1;

    for (let i = Math.max(30, start); i < end - 2; i++) {
        if (i <= blockedUntil) continue;
        if (config.useKillzone && !inKillzone(bars.time?.[i] * 1000, config.killzones)) continue;

        for (const obDirection of [-1, 1]) {
            const ob = orderBlockBefore(bars, i, obDirection, config.lookback);
            if (!ob || used.has(ob.index)) continue;

            const bullishBreaker = obDirection === -1 && bars.close[i] > ob.high;
            const bearishBreaker = obDirection === 1 && bars.close[i] < ob.low;
            if (!bullishBreaker && !bearishBreaker) continue;

            const direction = bullishBreaker ? 1 : -1;
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
                setup: 'breaker'
            });
            if (!trade) continue;
            used.add(ob.index);
            trades.push(trade);
            blockedUntil = trade.exitIndex;
            break;
        }
    }

    return trades;
}
