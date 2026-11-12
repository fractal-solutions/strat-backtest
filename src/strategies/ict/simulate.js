// Trade simulators shared by the ICT strategies.
//
// The engine only summarizes trades; these helpers turn an ICT signal into a
// filled trade using a limit or market entry, a stop, a target, and a time
// limit. They are conservative on the fill bar: if the bar that fills the
// limit also trades through the stop, the stop is assumed first.
//
// Trade management modes:
//   pdf      - one stop, one target (the 2022 PDF's range target)
//   partial  - take `partialFraction` at `partialAt` R, move the stop to
//              breakeven, let the rest run to the target
//   trail    - partial + breakeven + trail the runner behind the previous bar

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

function manageExit(ctx, position, bars, startIndex, endIndex, options) {
    const {
        management = 'pdf',
        partialAt = 1,
        partialFraction = 0.5,
        breakeven = true,
        trail = false
    } = options;
    const direction = position.direction;
    const entry = position.entryRaw;
    const risk = position.risk;
    const target = position.targetRaw;
    const useTrail = trail || management === 'trail';
    let stop = position.stopRaw;

    let partialDone = false;
    let partialExitPrice = 0;
    let partialExitIndex = -1;
    let runnerExit = null;
    let runnerReason = null;
    let runnerIndex = -1;

    for (let j = startIndex; j <= endIndex; j++) {
        // Stop first, always.
        if (direction > 0 ? bars.low[j] <= stop : bars.high[j] >= stop) {
            runnerExit = stop;
            runnerReason = 'stop';
            runnerIndex = j;
            break;
        }

        // Partial at the configured R.
        if (management !== 'pdf' && !partialDone) {
            const partialPrice = direction > 0 ? entry + partialAt * risk : entry - partialAt * risk;
            const hit = direction > 0 ? bars.high[j] >= partialPrice : bars.low[j] <= partialPrice;
            if (hit) {
                partialDone = true;
                partialExitPrice = partialPrice;
                partialExitIndex = j;
                if (breakeven) stop = entry;
            }
        }

        // Target.
        if (direction > 0 ? bars.high[j] >= target : bars.low[j] <= target) {
            runnerExit = target;
            runnerReason = 'target';
            runnerIndex = j;
            break;
        }

        // Trail the runner behind the previous bar after the partial.
        if (partialDone && useTrail && j > startIndex) {
            if (direction > 0) stop = Math.max(stop, bars.low[j - 1]);
            else stop = Math.min(stop, bars.high[j - 1]);
        }
    }

    if (runnerExit === null) {
        runnerExit = bars.close[endIndex];
        runnerReason = 'time';
        runnerIndex = endIndex;
    }

    if (!partialDone || management === 'pdf') {
        return ctx.makeTrade(position, runnerExit, runnerReason, runnerIndex);
    }

    const runnerTrade = ctx.makeTrade(position, runnerExit, runnerReason, runnerIndex);
    const entryCost = bars.spreadPrice / 2 + entry * ctx.friction;
    const partialExitCost = bars.spreadPrice / 2 + partialExitPrice * ctx.friction;
    const partialNetBeforeEntry = partialAt - partialExitCost / risk;
    const netR = partialFraction * partialNetBeforeEntry
        + (1 - partialFraction) * runnerTrade.netR
        - partialFraction * entryCost / risk;
    const grossR = partialFraction * partialAt + (1 - partialFraction) * runnerTrade.grossR;

    return {
        ...runnerTrade,
        netR,
        grossR,
        costR: grossR - netR,
        reason: `partial+${runnerReason}`,
        partialR: partialNetBeforeEntry,
        partialFraction,
        partialAt,
        partialExitIndex,
        partialExitDate: ctx.dateOf(partialExitIndex)
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
    htf = [],
    management = 'pdf',
    partialAt = 1,
    partialFraction = 0.5,
    breakeven = true,
    trail = false
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
    return manageExit(ctx, position, bars, fillIndex + 1, holdEnd, {
        management, partialAt, partialFraction, breakeven, trail
    });
}

export function simulateMarket(ctx, {
    signalIndex,
    direction,
    stop,
    target,
    maxHold = 24,
    setup = 'ict',
    htf = [],
    management = 'pdf',
    partialAt = 1,
    partialFraction = 0.5,
    breakeven = true,
    trail = false
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
    return manageExit(ctx, position, bars, signalIndex + 1, holdEnd, {
        management, partialAt, partialFraction, breakeven, trail
    });
}
