// Session-aware D1 bar normalization.
//
// The Dukascopy D1 feed emits the week open as its own Sunday row: a short
// (~2h) partial session. That row is not a daily bar. Its range is roughly a
// third of a normal session, so a structural stop placed at its high/low is
// about 3x tighter and the resulting R multiples are about 3x larger for the
// same price move. Left unhandled, this single row type dominates portfolio
// PnL even though it cannot be reproduced on a feed that builds sessions
// differently.
//
// Modes:
//   raw           - untouched feed (legacy / frozen behaviour)
//   merge-sunday  - fold the Sunday row into the next trading day, so every
//                   remaining bar covers one full session
//   drop-sunday   - remove Sunday rows entirely (keeps Monday open, loses the
//                   Sunday 22:00-24:00 move)
//
// The merged bar keeps the next trading day's timestamp and OHLC is aggregated
// in chronological order: open from Sunday, high/low from both, close from the
// full session.

export function weekdayAt(bars, index) {
    return new Date(bars.time[index] * 1000).getUTCDay();
}

export function setupWeekday(bars, index) {
    return weekdayAt(bars, index);
}

export function normalizeSessions(bars, mode = 'raw') {
    if (mode === 'raw' || mode === undefined || mode === null) return bars;
    if (mode !== 'merge-sunday' && mode !== 'drop-sunday') {
        throw new Error(`Unknown session mode "${mode}" (expected raw, merge-sunday or drop-sunday)`);
    }

    const time = [];
    const open = [];
    const high = [];
    const low = [];
    const close = [];
    const volume = [];
    let pending = null;

    const push = (t, o, h, l, c, v) => {
        time.push(t);
        open.push(o);
        high.push(h);
        low.push(l);
        close.push(c);
        volume.push(v);
    };

    for (let i = 0; i < bars.n; i++) {
        const isSunday = weekdayAt(bars, i) === 0;

        if (isSunday && mode === 'drop-sunday') continue;

        if (isSunday) {
            pending = pending
                ? {
                    open: pending.open,
                    high: Math.max(pending.high, bars.high[i]),
                    low: Math.min(pending.low, bars.low[i]),
                    close: bars.close[i],
                    volume: pending.volume + (bars.volume?.[i] ?? 0)
                }
                : {
                    open: bars.open[i],
                    high: bars.high[i],
                    low: bars.low[i],
                    close: bars.close[i],
                    volume: bars.volume?.[i] ?? 0
                };
            continue;
        }

        if (pending) {
            push(
                bars.time[i],
                pending.open,
                Math.max(pending.high, bars.high[i]),
                Math.min(pending.low, bars.low[i]),
                bars.close[i],
                pending.volume + (bars.volume?.[i] ?? 0)
            );
            pending = null;
            continue;
        }

        push(bars.time[i], bars.open[i], bars.high[i], bars.low[i], bars.close[i], bars.volume?.[i] ?? 0);
    }

    // A feed that ends on a Sunday leaves a partial bar with no following
    // session. Keep it rather than silently dropping data; callers can filter
    // it with --exclude-setup-dow 0.
    if (pending) push(bars.time[bars.n - 1], pending.open, pending.high, pending.low, pending.close, pending.volume);

    return {
        ...bars,
        time,
        open,
        high,
        low,
        close,
        volume,
        n: time.length
    };
}
