// The original mechanical Strat strategy, now a plug-in.
//
// This is the same rule as before: classify candles, detect the five setups,
// enter on a break of the setup bar, stop at the opposite side, target the
// structural high/low.
//
// The default `ambiguous` mode is `stop` (honest). The legacy `skip` mode is
// kept only to reproduce the old, look-ahead headline for regression purposes.

import { classifyCandles, setupAt, htfBias, htfAllows, structuralTarget } from '../strat.js';
import { setupWeekday } from '../session.js';

export const id = 'strat';
export const label = 'Mechanical Strat (D1)';
export const defaults = { session: 'raw', ambiguous: 'stop' };

const PRESETS = {
    core: {
        setups: '2-1,3-1',
        htf: 'all',
        session: 'merge-sunday',
        'exclude-setup-dow': '5'
    }
};

function presetOf(args) {
    const name = args.preset === undefined ? null : String(args.preset).toLowerCase();
    const preset = name ? PRESETS[name] : null;
    if (name && !preset) {
        throw new Error(`Unknown preset "${name}" (expected: ${Object.keys(PRESETS).join(', ')})`);
    }
    return { name, preset };
}

const pick = (args, preset, key, fallback) => {
    if (args[key] !== undefined) return args[key];
    if (preset && preset[key] !== undefined) return preset[key];
    return fallback;
};

export function resolveSession(args) {
    const { preset } = presetOf(args);
    return pick(args, preset, 'session', defaults.session);
}

export function configure(args) {
    const { name, preset } = presetOf(args);
    const setups = new Set(String(pick(args, preset, 'setups', '2-1,3-1,1-2,2-2,3-2')).split(',').map(v => v.trim()));
    const htfMode = String(pick(args, preset, 'htf', 'continuity')).toLowerCase();
    const excludeSetupDow = new Set(
        String(pick(args, preset, 'exclude-setup-dow', '') ?? '')
            .split(',')
            .map(v => v.trim())
            .filter(v => v !== '')
            .map(v => {
                const parsed = Number(v);
                if (!Number.isInteger(parsed) || parsed < 0 || parsed > 6) {
                    throw new Error(`Invalid --exclude-setup-dow value "${v}" (expected 0-6, 0 = Sunday)`);
                }
                return parsed;
            })
    );
    const entryMode = String(args.entry ?? 'intrabar').toLowerCase();
    const ambiguousMode = String(args.ambiguous ?? defaults.ambiguous).toLowerCase();
    if (ambiguousMode !== 'skip' && ambiguousMode !== 'stop') {
        throw new Error(`Invalid --ambiguous "${args.ambiguous}" (expected skip or stop)`);
    }
    const targetMode = String(args.target ?? 'structural').toLowerCase();
    const blocks = args.blocks ? String(args.blocks).split(',').map(Number) : null;
    return {
        preset: name,
        setups: [...setups],
        htfMode,
        excludeSetupDow: [...excludeSetupDow].sort(),
        entryMode,
        ambiguousMode,
        targetMode,
        blocks,
        maxHold: args['max-hold'] !== undefined ? Number(args['max-hold']) : null,
        lookback: Number(args.lookback ?? 20)
    };
}

function checkExit(position, bars, j, maxHold, isEntryBar) {
    const direction = position.direction;
    const open = bars.open[j];
    const high = bars.high[j];
    const low = bars.low[j];
    const close = bars.close[j];
    const stop = position.stopRaw;
    const target = position.targetRaw;

    if (direction > 0) {
        if (!isEntryBar && open <= stop) return { price: open, reason: 'stop' };
        if (low <= stop) return { price: stop, reason: 'stop' };
        if (!isEntryBar && open >= target) return { price: open, reason: 'target' };
        if (high >= target) return { price: target, reason: 'target' };
    } else {
        if (!isEntryBar && open >= stop) return { price: open, reason: 'stop' };
        if (high >= stop) return { price: stop, reason: 'stop' };
        if (!isEntryBar && open <= target) return { price: open, reason: 'target' };
        if (low <= target) return { price: target, reason: 'target' };
    }

    const barsHeld = j - position.entryIndex + 1;
    if (barsHeld >= maxHold) return { price: close, reason: 'time' };
    return null;
}

export function run(ctx) {
    const { bars, config, start, end } = ctx;
    const setups = new Set(config.setups);
    const excludeSetupDow = new Set(config.excludeSetupDow);
    const blocks = config.blocks ?? ctx.tfDefaults.blocks;
    const maxHold = config.maxHold ?? ctx.tfDefaults.maxHold;
    const lookback = config.lookback;
    const useCalendar = ctx.tf === 'D1' && ctx.timeValid;

    const types = classifyCandles(bars);
    const trades = [];
    let position = null;

    const close = (exitPrice, reason, exitIndex) => {
        trades.push(ctx.makeTrade(position, exitPrice, reason, exitIndex));
        position = null;
    };

    for (let i = start; i < end; i++) {
        if (position) {
            const exit = checkExit(position, bars, i, maxHold, false);
            if (exit) close(exit.price, exit.reason, i);
            continue;
        }

        const s = i - 1;
        if (s < 2) continue;
        const setup = setupAt(types, bars, s);
        if (!setup || !setups.has(setup.name)) continue;
        if (excludeSetupDow.size && excludeSetupDow.has(setupWeekday(bars, s))) continue;

        const bias = htfBias(bars, s, blocks, useCalendar);
        const longHit = bars.high[i] >= setup.triggerHigh;
        const shortHit = bars.low[i] <= setup.triggerLow;
        const ambiguousHit = longHit && shortHit;
        if (ambiguousHit && (config.ambiguousMode === 'skip' || config.entryMode === 'close')) continue;

        const direction = ambiguousHit
            ? (Math.abs(bars.open[i] - setup.triggerHigh) <= Math.abs(bars.open[i] - setup.triggerLow) ? 1 : -1)
            : longHit ? 1 : shortHit ? -1 : 0;
        if (!direction) continue;
        if (!htfAllows(bias, direction, config.htfMode)) continue;

        let entryRaw;
        if (config.entryMode === 'close') {
            const beyond = direction > 0 ? bars.close[i] > setup.triggerHigh : bars.close[i] < setup.triggerLow;
            if (!beyond) continue;
            entryRaw = bars.close[i];
        } else {
            entryRaw = direction > 0 ? Math.max(bars.open[i], setup.triggerHigh) : Math.min(bars.open[i], setup.triggerLow);
        }

        const stopRaw = direction > 0 ? setup.stopLong : setup.stopShort;
        const risk = Math.abs(entryRaw - stopRaw);
        if (!(risk > 0) || !Number.isFinite(risk)) continue;

        const entryCost = bars.spreadPrice / 2 + entryRaw * ctx.friction;
        const entryNet = direction > 0 ? entryRaw + entryCost : entryRaw - entryCost;
        const targetRaw = config.targetMode === '2r'
            ? entryRaw + direction * 2 * risk
            : structuralTarget(bars, s, direction, entryRaw, risk, lookback);

        const carryAnnual = ctx.ratesUsable ? ctx.rateContext.carryAnnual(ctx.dateOf(i)) : null;
        position = {
            strategy: id,
            setup: setup.name,
            direction,
            entryIndex: i,
            entryRaw,
            entryNet,
            stopRaw,
            targetRaw,
            risk,
            htf: bias,
            setupWeekday: setupWeekday(bars, s),
            carryAnnual
        };

        if (ambiguousHit) {
            // Both sides of the setup trade on the entry day. Whichever was
            // touched first, the other side is the stop, so record a loss.
            close(stopRaw, 'ambiguous', i);
        }
    }

    if (position) {
        const last = end - 1;
        close(bars.close[last], 'eod', last);
    }

    return trades;
}
