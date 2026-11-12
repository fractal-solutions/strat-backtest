// ICT daily-bias + killzone scalping.
//
// This is the article's fifth model: establish the daily bias, then inside the
// London/New York killzone look for a micro liquidity sweep into a micro order
// block that agrees with the daily map. It is deliberately tighter than the
// generic sweep/OB model: smaller swing lookback, shorter hold, 1.5R target.
//
// Partial exits and trailing (the article's "scale at 1:1") are not modelled
// yet; this is a single-target approximation.

import { atr, ema, dailyBars, dailyBiasAt, sweepAt, orderBlockBefore, inKillzone } from './primitives.js';
import { simulateLimit } from './simulate.js';

export const id = 'ict-killzone';
export const label = 'ICT: daily bias + killzone scalp';
export const defaults = { session: 'raw' };

export function configure(args, info) {
    return {
        dailyEma: Number(args['daily-ema'] ?? 20),
        swingLookback: Number(args['swing-lookback'] ?? 8),
        obLookback: Number(args['ob-lookback'] ?? 5),
        validBars: Number(args['valid-bars'] ?? 4),
        maxHold: Number(args['max-hold'] ?? 12),
        rMultiple: Number(args['r-multiple'] ?? 1.5),
        bufferAtr: Number(args['buffer-atr'] ?? 0.1),
        minRiskAtr: Number(args['min-risk-atr'] ?? 0.15),
        killzones: String(args.killzones ?? 'london,ny').split(',').map(v => v.trim()).filter(Boolean),
        useKillzone: args['no-killzone'] !== true && info.tf !== 'D1'
    };
}

export function run(ctx) {
    const { bars, config, start, end } = ctx;
    const days = dailyBars(bars);
    const dailyEma = ema(days.map(day => day.close), config.dailyEma);
    const trades = [];
    let blockedUntil = -1;

    for (let i = Math.max(config.dailyEma + 2, start); i < end - 2; i++) {
        if (i <= blockedUntil) continue;
        if (config.useKillzone && !inKillzone(bars.time?.[i] * 1000, config.killzones)) continue;

        const bias = dailyBiasAt(days, dailyEma, i);
        if (!bias) continue;

        const sweep = sweepAt(bars, i, config.swingLookback);
        if (sweep.highSweep === sweep.lowSweep) continue;
        const direction = sweep.lowSweep ? 1 : -1;
        if (direction !== bias) continue;

        if (direction > 0 && bars.close[i] <= bars.open[i]) continue;
        if (direction < 0 && bars.close[i] >= bars.open[i]) continue;

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
            setup: 'killzone-scalp'
        });
        if (!trade) continue;
        trades.push(trade);
        blockedUntil = trade.exitIndex;
    }

    return trades;
}
