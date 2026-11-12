// ICT model 3: fair-value-gap continuation.
//
// 1. Define bias with a slow EMA on the execution timeframe.
// 2. Find an unfilled three-candle FVG in the bias direction.
// 3. Enter on a retest of the gap midpoint, stop beyond the far edge,
//    target `rMultiple` R.
// 4. One trade per gap.

import { atr, ema, findRecentFvg, inKillzone } from './primitives.js';
import { simulateLimit } from './simulate.js';

export const id = 'ict-fvg';
export const label = 'ICT: fair-value-gap continuation';
export const defaults = { session: 'raw' };

export function configure(args, info) {
    return {
        emaPeriod: Number(args['ema-period'] ?? 200),
        fvgLookback: Number(args['fvg-lookback'] ?? 30),
        validBars: Number(args['valid-bars'] ?? 10),
        maxHold: Number(args['max-hold'] ?? 48),
        rMultiple: Number(args['r-multiple'] ?? 2),
        bufferAtr: Number(args['buffer-atr'] ?? 0.1),
        minRiskAtr: Number(args['min-risk-atr'] ?? 0.25),
        killzones: String(args['killzones'] ?? 'london,ny').split(',').map(v => v.trim()).filter(Boolean),
        useKillzone: args['no-killzone'] !== true && info.tf !== 'D1'
    };
}

export function run(ctx) {
    const { bars, config, start, end } = ctx;
    const trend = ema(Array.from(bars.close), config.emaPeriod);
    const trades = [];
    const used = new Set();
    let blockedUntil = -1;

    for (let i = Math.max(config.emaPeriod + 2, start); i < end - 2; i++) {
        if (i <= blockedUntil) continue;
        if (config.useKillzone && !inKillzone(bars.time?.[i] * 1000, config.killzones)) continue;

        const close = bars.close[i];
        const direction = close > trend[i] ? 1 : close < trend[i] ? -1 : 0;
        if (!direction) continue;

        const fvg = findRecentFvg(bars, i, direction, config.fvgLookback);
        if (!fvg || used.has(fvg.index)) continue;

        const buffer = atr(bars, i, 14) * config.bufferAtr;
        const entry = fvg.mid;
        const stop = direction > 0 ? fvg.low - buffer : fvg.high + buffer;
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
            setup: 'fvg'
        });
        if (!trade) continue;
        used.add(fvg.index);
        trades.push(trade);
        blockedUntil = trade.exitIndex;
    }

    return trades;
}
