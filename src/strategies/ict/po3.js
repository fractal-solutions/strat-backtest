// ICT model 4: power-of-three day model.
//
// 1. Build the Asian range (00:00-07:00 UTC).
// 2. During the London killzone, wait for a sweep of the Asian high/low.
// 3. Enter on the close back inside the Asian range.
// 4. Stop beyond the sweep extreme, target the opposite side of the Asian
//    range or `rMultiple` R, whichever is farther.
// 5. One trade per day.

import { atr, ema, asianRange } from './primitives.js';
import { simulateMarket } from './simulate.js';

export const id = 'ict-po3';
export const label = 'ICT: power-of-three day model';
export const defaults = { session: 'raw' };

export function configure(args) {
    return {
        londonStart: Number(args['london-start'] ?? 7),
        londonEnd: Number(args['london-end'] ?? 10),
        rMultiple: Number(args['r-multiple'] ?? 2),
        maxHold: Number(args['max-hold'] ?? 24),
        bufferAtr: Number(args['buffer-atr'] ?? 0.1),
        minRiskAtr: Number(args['min-risk-atr'] ?? 0.25),
        useBias: args['no-bias'] !== true,
        emaPeriod: Number(args['ema-period'] ?? 200)
    };
}

export function run(ctx) {
    const { bars, config, start, end } = ctx;
    if (!Array.isArray(bars.time)) return [];
    const trend = ema(Array.from(bars.close), config.emaPeriod);
    const trades = [];
    let blockedDay = null;

    for (let i = Math.max(config.emaPeriod + 2, start); i < end - 2; i++) {
        const date = new Date(bars.time[i] * 1000).toISOString().slice(0, 10);
        if (blockedDay === date) continue;
        const hour = new Date(bars.time[i] * 1000).getUTCHours();
        if (hour < config.londonStart || hour >= config.londonEnd) continue;

        const range = asianRange(bars, i);
        if (!range) continue;

        const sweptHigh = bars.high[i] > range.high && bars.close[i] < range.high;
        const sweptLow = bars.low[i] < range.low && bars.close[i] > range.low;
        if (sweptHigh === sweptLow) continue;
        const direction = sweptLow ? 1 : -1;

        if (config.useBias) {
            if (direction > 0 && bars.close[i] < trend[i]) continue;
            if (direction < 0 && bars.close[i] > trend[i]) continue;
        }

        const buffer = atr(bars, i, 14) * config.bufferAtr;
        const entry = bars.close[i];
        const stop = direction > 0 ? bars.low[i] - buffer : bars.high[i] + buffer;
        const risk = Math.abs(entry - stop);
        if (!(risk > 0) || risk < atr(bars, i, 14) * config.minRiskAtr) continue;

        const target = direction > 0
            ? Math.max(entry + config.rMultiple * risk, range.high)
            : Math.min(entry - config.rMultiple * risk, range.low);

        const trade = simulateMarket(ctx, {
            signalIndex: i,
            direction,
            stop,
            target,
            maxHold: config.maxHold,
            setup: 'po3'
        });
        if (!trade) continue;
        trades.push(trade);
        blockedDay = date;
    }

    return trades;
}
