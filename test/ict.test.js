import { describe, expect, test } from 'bun:test';
import {
    bullishFvgAt, bearishFvgAt, orderBlockBefore, sweepAt,
    oteZone, isDisplacement, dailyBars, dailyBiasAt, rangeForDate
} from '../src/strategies/ict/primitives.js';

function bars(open, high, low, close, start = '2024-01-01T00:00:00Z') {
    const t0 = Math.floor(new Date(start).getTime() / 1000);
    return {
        n: open.length,
        open, high, low, close,
        time: open.map((_, i) => t0 + i * 3600)
    };
}

describe('fair-value gaps', () => {
    test('detects a bullish three-candle imbalance', () => {
        const b = bars([100, 101, 104], [101, 103, 106], [99, 100, 104.5], [100.5, 102, 105.5]);
        const fvg = bullishFvgAt(b, 2);
        expect(fvg).not.toBeNull();
        expect(fvg.low).toBe(101);
        expect(fvg.high).toBe(104.5);
        expect(fvg.mid).toBe(102.75);
    });

    test('detects a bearish three-candle imbalance', () => {
        const b = bars([105, 104, 101], [106, 105, 101.5], [104.5, 102, 100], [105, 103, 100.5]);
        const fvg = bearishFvgAt(b, 2);
        expect(fvg).not.toBeNull();
        expect(fvg.high).toBe(104.5);
        expect(fvg.low).toBe(101.5);
    });

    test('rejects a normal candle sequence', () => {
        const b = bars([100, 100.5, 101], [101, 101.5, 102], [99.5, 100, 100.5], [100.5, 101, 101.5]);
        expect(bullishFvgAt(b, 2)).toBeNull();
        expect(bearishFvgAt(b, 2)).toBeNull();
    });
});

describe('order blocks', () => {
    test('finds the last down candle before a bullish move', () => {
        const b = bars(
            [100, 101, 99, 102, 104],
            [101, 102, 100, 103, 105],
            [99, 100, 98, 101, 103],
            [100.5, 101.5, 98.5, 102.5, 104.5]
        );
        const ob = orderBlockBefore(b, 4, 1, 5);
        expect(ob).not.toBeNull();
        expect(ob.index).toBe(2);
        expect(ob.low).toBe(98);
        expect(ob.high).toBe(100);
    });
});

describe('liquidity sweeps', () => {
    test('detects a sweep of a swing high that closes back inside', () => {
        const b = bars(
            [100, 101, 102, 101, 100, 102, 103],
            [101, 102, 103, 102, 101, 104, 103.5],
            [99, 100, 101, 100, 99, 101, 101],
            [100.5, 101.5, 102, 101, 100, 102.5, 102]
        );
        const sweep = sweepAt(b, 5, 6);
        expect(sweep.highSweep).toBe(true);
        expect(sweep.lowSweep).toBe(false);
    });
});

describe('ICT geometry', () => {
    test('OTE is the 62%-79% retracement', () => {
        const long = oteZone(100, 200, 1);
        expect(long.low).toBeCloseTo(121, 6);
        expect(long.high).toBeCloseTo(138, 6);
        const short = oteZone(100, 200, -1);
        expect(short.low).toBeCloseTo(162, 6);
        expect(short.high).toBeCloseTo(179, 6);
    });

    test('displacement needs a directional body and an above-normal range', () => {
        const b = bars([100, 100, 100], [101, 105, 101], [99, 100, 99], [100.5, 104, 100.5]);
        expect(isDisplacement(b, 1, 1, 1)).toBe(true);
        expect(isDisplacement(b, 0, 1, 1)).toBe(false);
    });
});

describe('daily bias and range windows', () => {
    test('daily bars aggregate by UTC date', () => {
        const b = bars(
            [100, 101, 102, 103, 104, 105],
            [101, 102, 103, 104, 105, 106],
            [99, 100, 101, 102, 103, 104],
            [100.5, 101.5, 102.5, 103.5, 104.5, 105.5]
        );
        // Force two calendar days at the midpoint.
        b.time[3] += 86400; b.time[4] += 86400; b.time[5] += 86400;
        const days = dailyBars(b);
        expect(days.length).toBe(2);
        expect(days[0].close).toBe(102.5);
        expect(days[1].close).toBe(105.5);
    });

    test('daily bias uses the last completed day vs its EMA', () => {
        const days = [
            { endIndex: 2, close: 105 },
            { endIndex: 5, close: 110 },
            { endIndex: 8, close: 115 }
        ];
        const dailyEma = [100, 102, 104];
        expect(dailyBiasAt(days, dailyEma, 7)).toBe(1);
        expect(dailyBiasAt(days, [110, 112, 114], 7)).toBe(-1);
    });

    test('rangeForDate isolates the requested UTC hours', () => {
        const b = bars(
            [100, 101, 102, 103],
            [101, 105, 103, 104],
            [99, 100, 101, 98],
            [100.5, 104, 102, 103],
            '2024-01-01T04:00:00Z'
        );
        const range = rangeForDate(b, '2024-01-01', 4, 6);
        expect(range.high).toBe(105);
        expect(range.low).toBe(99);
    });
});
