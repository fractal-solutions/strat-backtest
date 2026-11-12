// Mechanical ICT primitives.
//
// These are deliberately simple, testable definitions. They are not the final
// word on ICT; they are a shared vocabulary so strategies can be compared on
// the same data and costs.

export function atr(bars, index, period = 14) {
    let sum = 0;
    let count = 0;
    for (let i = Math.max(1, index - period + 1); i <= index; i++) {
        const tr = Math.max(
            bars.high[i] - bars.low[i],
            Math.abs(bars.high[i] - bars.close[i - 1]),
            Math.abs(bars.low[i] - bars.close[i - 1])
        );
        sum += tr;
        count++;
    }
    return count ? sum / count : 0;
}

export function ema(values, period) {
    const out = new Array(values.length).fill(NaN);
    if (!values.length) return out;
    const k = 2 / (period + 1);
    let prev = values[0];
    out[0] = prev;
    for (let i = 1; i < values.length; i++) {
        prev = values[i] * k + prev * (1 - k);
        out[i] = prev;
    }
    return out;
}

export function isSwingHigh(bars, i, left = 2, right = 2) {
    if (i - left < 0 || i + right >= bars.n) return false;
    for (let j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (bars.high[j] >= bars.high[i]) return false;
    }
    return true;
}

export function isSwingLow(bars, i, left = 2, right = 2) {
    if (i - left < 0 || i + right >= bars.n) return false;
    for (let j = i - left; j <= i + right; j++) {
        if (j === i) continue;
        if (bars.low[j] <= bars.low[i]) return false;
    }
    return true;
}

export function findSwingHigh(bars, before, lookback = 20, left = 2, right = 2) {
    for (let i = before - right - 1; i >= Math.max(left, before - lookback); i--) {
        if (isSwingHigh(bars, i, left, right)) return i;
    }
    return -1;
}

export function findSwingLow(bars, before, lookback = 20, left = 2, right = 2) {
    for (let i = before - right - 1; i >= Math.max(left, before - lookback); i--) {
        if (isSwingLow(bars, i, left, right)) return i;
    }
    return -1;
}

/**
 * A liquidity sweep: price takes out the most recent swing high/low but closes
 * back inside it. The failed break is the clue that the move was engineered.
 */
export function sweepAt(bars, index, lookback = 20) {
    const swingHighIndex = findSwingHigh(bars, index, lookback);
    const swingLowIndex = findSwingLow(bars, index, lookback);
    const highSweep = swingHighIndex >= 0
        && bars.high[index] > bars.high[swingHighIndex]
        && bars.close[index] < bars.high[swingHighIndex];
    const lowSweep = swingLowIndex >= 0
        && bars.low[index] < bars.low[swingLowIndex]
        && bars.close[index] > bars.low[swingLowIndex];
    return { highSweep, lowSweep, swingHighIndex, swingLowIndex };
}

/** Bullish three-candle imbalance: candle 3 low is above candle 1 high. */
export function bullishFvgAt(bars, i) {
    if (i < 2) return null;
    if (!(bars.low[i] > bars.high[i - 2])) return null;
    const low = bars.high[i - 2];
    const high = bars.low[i];
    return { index: i, low, high, mid: (low + high) / 2 };
}

/** Bearish three-candle imbalance: candle 3 high is below candle 1 low. */
export function bearishFvgAt(bars, i) {
    if (i < 2) return null;
    if (!(bars.high[i] < bars.low[i - 2])) return null;
    const low = bars.high[i];
    const high = bars.low[i - 2];
    return { index: i, low, high, mid: (low + high) / 2 };
}

export function findRecentFvg(bars, index, direction, lookback = 30) {
    for (let i = index - 1; i >= Math.max(2, index - lookback); i--) {
        const fvg = direction > 0 ? bullishFvgAt(bars, i) : bearishFvgAt(bars, i);
        if (!fvg) continue;
        if (direction > 0 && fvg.high < bars.close[index]) return fvg;
        if (direction < 0 && fvg.low > bars.close[index]) return fvg;
    }
    return null;
}

/**
 * The last opposite-coloured candle before the current move.
 * direction = 1: last down candle (bullish order block).
 * direction = -1: last up candle (bearish order block).
 */
export function orderBlockBefore(bars, index, direction, lookback = 10) {
    for (let i = index - 1; i >= Math.max(1, index - lookback); i--) {
        const down = bars.close[i] < bars.open[i];
        const up = bars.close[i] > bars.open[i];
        if (direction > 0 && down) {
            return { index: i, low: bars.low[i], high: bars.high[i], mid: (bars.low[i] + bars.high[i]) / 2 };
        }
        if (direction < 0 && up) {
            return { index: i, low: bars.low[i], high: bars.high[i], mid: (bars.low[i] + bars.high[i]) / 2 };
        }
    }
    return null;
}

const KILLZONES = {
    london: [7, 10],
    ny: [12, 15],
    'ny-reversal': [14, 16]
};

export function inKillzone(timeMs, zones = ['london', 'ny']) {
    if (!Number.isFinite(timeMs)) return true;
    const hour = new Date(timeMs).getUTCHours();
    return zones.some(zone => {
        const window = KILLZONES[zone];
        return window && hour >= window[0] && hour < window[1];
    });
}

/** Asian session high/low for the UTC date containing `index`. */
export function asianRange(bars, index) {
    if (!Array.isArray(bars.time) || !Number.isFinite(bars.time[index])) return null;
    const date = new Date(bars.time[index] * 1000).toISOString().slice(0, 10);
    let high = -Infinity;
    let low = Infinity;
    for (let i = index; i >= 0; i--) {
        const day = new Date(bars.time[i] * 1000).toISOString().slice(0, 10);
        if (day !== date) break;
        const hour = new Date(bars.time[i] * 1000).getUTCHours();
        if (hour >= 0 && hour < 7) {
            high = Math.max(high, bars.high[i]);
            low = Math.min(low, bars.low[i]);
        }
    }
    return high > low ? { high, low } : null;
}

/** Aggregate bars into daily OHLC buckets, keeping the last bar index. */
export function dailyBars(bars) {
    if (!Array.isArray(bars.time) || !Number.isFinite(bars.time[0])) return [];
    const days = [];
    let current = null;
    for (let i = 0; i < bars.n; i++) {
        const date = new Date(bars.time[i] * 1000).toISOString().slice(0, 10);
        if (!current || current.date !== date) {
            current = {
                date,
                open: bars.open[i],
                high: bars.high[i],
                low: bars.low[i],
                close: bars.close[i],
                endIndex: i
            };
            days.push(current);
        } else {
            current.high = Math.max(current.high, bars.high[i]);
            current.low = Math.min(current.low, bars.low[i]);
            current.close = bars.close[i];
            current.endIndex = i;
        }
    }
    return days;
}

/** Daily bias from the last completed day's close vs its EMA. Causal. */
export function dailyBiasAt(days, dailyEma, index) {
    for (let i = days.length - 1; i >= 0; i--) {
        if (days[i].endIndex < index) {
            const close = days[i].close;
            const value = dailyEma[i];
            if (!Number.isFinite(value)) return 0;
            return close > value ? 1 : close < value ? -1 : 0;
        }
    }
    return 0;
}

/** The last daily bucket that closed before `index`. */
export function previousDayAt(days, index) {
    for (let i = days.length - 1; i >= 0; i--) {
        if (days[i].endIndex < index) return days[i];
    }
    return null;
}

/** High/low of a UTC-hour window on one date. */
export function rangeForDate(bars, date, startHour, endHour) {
    let high = -Infinity;
    let low = Infinity;
    let count = 0;
    for (let i = 0; i < bars.n; i++) {
        const t = new Date(bars.time[i] * 1000);
        if (t.toISOString().slice(0, 10) !== date) continue;
        const hour = t.getUTCHours();
        if (hour >= startHour && hour < endHour) {
            high = Math.max(high, bars.high[i]);
            low = Math.min(low, bars.low[i]);
            count++;
        }
    }
    return count ? { high, low } : null;
}

/**
 * ICT optimal trade entry: the 62%-79% retracement of the last leg.
 * direction = 1 retraces a low->high leg downward; -1 retraces a high->low leg up.
 */
export function oteZone(low, high, direction, min = 0.62, max = 0.79) {
    const span = high - low;
    if (!(span > 0)) return null;
    if (direction > 0) return { low: high - max * span, high: high - min * span };
    return { low: low + min * span, high: low + max * span };
}

/** A displacement candle: directional body and an above-normal range. */
export function isDisplacement(bars, index, atrValue, multiplier = 1, bodyMin = 0.55) {
    const range = bars.high[index] - bars.low[index];
    const body = Math.abs(bars.close[index] - bars.open[index]);
    if (!(range > 0)) return false;
    return body >= bodyMin * range && (!Number.isFinite(atrValue) || range >= atrValue * multiplier);
}

export function isoDate(timeMs) {
    return new Date(timeMs).toISOString().slice(0, 10);
}

export function utcHour(timeMs) {
    return new Date(timeMs).getUTCHours();
}
