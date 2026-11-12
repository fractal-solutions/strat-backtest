import { describe, expect, test } from 'bun:test';
import { normalizeSessions, weekdayAt, setupWeekday } from '../src/session.js';

function bar(date, open, high, low, close) {
    return {
        time: Math.floor(new Date(`${date}T00:00:00Z`).getTime() / 1000),
        open, high, low, close
    };
}

function makeBars(rows) {
    return {
        symbol: 'TEST',
        timeframe: 'D1',
        path: 'test',
        spreadPrice: 0.0001,
        time: rows.map(row => row.time),
        open: rows.map(row => row.open),
        high: rows.map(row => row.high),
        low: rows.map(row => row.low),
        close: rows.map(row => row.close),
        volume: rows.map(() => 0),
        n: rows.length
    };
}

// Friday, short Sunday week-open, Monday, Tuesday.
const raw = makeBars([
    bar('2008-01-04', 10, 12, 9, 11),
    bar('2008-01-06', 11, 11.5, 10.8, 11.2),
    bar('2008-01-07', 11.2, 13, 10, 12.5),
    bar('2008-01-08', 12.5, 13.5, 12, 13)
]);

describe('weekdayAt', () => {
    test('identifies the Sunday partial bar', () => {
        expect(weekdayAt(raw, 0)).toBe(5);
        expect(weekdayAt(raw, 1)).toBe(0);
        expect(weekdayAt(raw, 2)).toBe(1);
        expect(setupWeekday(raw, 1)).toBe(0);
    });
});

describe('normalizeSessions', () => {
    test('raw is untouched', () => {
        const out = normalizeSessions(raw, 'raw');
        expect(out).toBe(raw);
    });

    test('merge-sunday folds the week open into the next session', () => {
        const out = normalizeSessions(raw, 'merge-sunday');
        expect(out.n).toBe(3);
        // Friday survives unchanged.
        expect([out.open[0], out.high[0], out.low[0], out.close[0]]).toEqual([10, 12, 9, 11]);
        // Monday opens at the Sunday open and closes at the Monday close.
        expect([out.open[1], out.high[1], out.low[1], out.close[1]]).toEqual([11, 13, 10, 12.5]);
        expect(new Date(out.time[1] * 1000).toISOString().slice(0, 10)).toBe('2008-01-07');
        // Tuesday is untouched.
        expect([out.open[2], out.high[2], out.low[2], out.close[2]]).toEqual([12.5, 13.5, 12, 13]);
    });

    test('merge-sunday widens a range that a Sunday bar would shrink', () => {
        const merged = normalizeSessions(raw, 'merge-sunday');
        const sundayRange = raw.high[1] - raw.low[1];
        const mondayRange = merged.high[1] - merged.low[1];
        expect(mondayRange).toBeGreaterThan(sundayRange * 2);
    });

    test('drop-sunday removes the partial bar', () => {
        const out = normalizeSessions(raw, 'drop-sunday');
        expect(out.n).toBe(3);
        expect(out.time.map(t => new Date(t * 1000).toISOString().slice(0, 10)))
            .toEqual(['2008-01-04', '2008-01-07', '2008-01-08']);
        expect(out.open[1]).toBe(11.2);
    });

    test('rejects unknown modes', () => {
        expect(() => normalizeSessions(raw, 'weekly')).toThrow();
    });

    test('preserves feed metadata', () => {
        const out = normalizeSessions(raw, 'merge-sunday');
        expect(out.symbol).toBe('TEST');
        expect(out.spreadPrice).toBe(0.0001);
        expect(out.timeframe).toBe('D1');
    });
});
