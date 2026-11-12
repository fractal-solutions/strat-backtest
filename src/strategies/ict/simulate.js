// Trade simulators shared by the ICT strategies.
//
// The engine only summarizes trades; these helpers turn an ICT signal into a
// filled trade using a limit or market entry, a stop, a target, and a time
// limit. They are conservative on the fill bar: if the bar that fills the
// limit also trades through the stop, the stop is assumed first.

function positionFor(ctx, { direction, entryIndex, entry, stop, target, risk, setup, htf }) {
    const entryCost = ctx.bars.spreadPrice / 2 + entry * ctx.friction;
    return {
        strategy: ctx.strategy.id,
        setup: setup ?? 'ict',
        direction,
        entryIndex,
        entryRaw: entry,
        entryNet: direction > 0 ? entry + entryCost : entry - entryCost,
        stopRaw: stop,
        targetRaw: target,
        risk,
        htf: htf ?? [],
        setupWeekday: null,
        carryAnnual: ctx.ratesUsable ? ctx.rateContext.carryAnnual(ctx.dateOf(entryIndex)) : null
    };
}

export function simulateLimit(ctx, {
    signalIndex,
    direction,
    entry,
    stop,
    target,
    validBars = 8,
    maxHold = 48,
    setup = 'ict',
    htf = []
}) {
    const { bars, end } = ctx;
    if (![entry, stop, target].every(v => Number.isFinite(v) && v > 0)) return null;
    if (direction > 0 && !(stop < entry && entry < target)) return null;
    if (direction < 0 && !(target < entry && entry < stop)) return null;
    // A retest limit must sit on the pullback side of the signal close.
    if (direction > 0 && entry >= bars.close[signalIndex]) return null;
    if (direction < 0 && entry <= bars.close[signalIndex]) return null;

    let fillIndex = -1;
    const lastSearch = Math.min(end - 1, signalIndex + validBars);
    for (let i = signalIndex + 1; i <= lastSearch; i++) {
        if (direction > 0) {
            if (bars.low[i] <= stop) return null;
            if (bars.low[i] <= entry) { fillIndex = i; break; }
        } else {
            if (bars.high[i] >= stop) return null;
            if (bars.high[i] >= entry) { fillIndex = i; break; }
        }
    }
    if (fillIndex < 0) return null;

    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return null;
    const position = positionFor(ctx, { direction, entryIndex: fillIndex, entry, stop, target, risk, setup, htf });

    // Conservative fill-bar handling: if the fill bar also reaches the stop,
    // assume the stop was hit after the fill.
    if (direction > 0 && bars.low[fillIndex] <= stop) return ctx.makeTrade(position, stop, 'stop', fillIndex);
    if (direction < 0 && bars.high[fillIndex] >= stop) return ctx.makeTrade(position, stop, 'stop', fillIndex);

    const holdEnd = Math.min(end - 1, fillIndex + maxHold);
    for (let j = fillIndex + 1; j <= holdEnd; j++) {
        if (direction > 0) {
            if (bars.low[j] <= stop) return ctx.makeTrade(position, stop, 'stop', j);
            if (bars.high[j] >= target) return ctx.makeTrade(position, target, 'target', j);
        } else {
            if (bars.high[j] >= stop) return ctx.makeTrade(position, stop, 'stop', j);
            if (bars.low[j] <= target) return ctx.makeTrade(position, target, 'target', j);
        }
    }
    return ctx.makeTrade(position, bars.close[holdEnd], 'time', holdEnd);
}

export function simulateMarket(ctx, {
    signalIndex,
    direction,
    stop,
    target,
    maxHold = 24,
    setup = 'ict',
    htf = []
}) {
    const { bars, end } = ctx;
    const entry = bars.close[signalIndex];
    if (![entry, stop, target].every(v => Number.isFinite(v) && v > 0)) return null;
    if (direction > 0 && !(stop < entry && entry < target)) return null;
    if (direction < 0 && !(target < entry && entry < stop)) return null;
    const risk = Math.abs(entry - stop);
    if (!(risk > 0)) return null;
    const position = positionFor(ctx, { direction, entryIndex: signalIndex, entry, stop, target, risk, setup, htf });
    const holdEnd = Math.min(end - 1, signalIndex + maxHold);
    for (let j = signalIndex + 1; j <= holdEnd; j++) {
        if (direction > 0) {
            if (bars.low[j] <= stop) return ctx.makeTrade(position, stop, 'stop', j);
            if (bars.high[j] >= target) return ctx.makeTrade(position, target, 'target', j);
        } else {
            if (bars.high[j] >= stop) return ctx.makeTrade(position, stop, 'stop', j);
            if (bars.low[j] <= target) return ctx.makeTrade(position, target, 'target', j);
        }
    }
    return ctx.makeTrade(position, bars.close[holdEnd], 'time', holdEnd);
}
