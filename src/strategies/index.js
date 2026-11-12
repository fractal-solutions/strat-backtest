// Strategy registry. Add a module here to make it available to every CLI
// (backtest, portfolio, sweep, walkforward, robustness).

import * as strat from './strat.js';
import * as ictSweepOb from './ict/sweep-ob.js';
import * as ictFvg from './ict/fvg.js';
import * as ictPo3 from './ict/po3.js';
import * as ict2022 from './ict/2022.js';
import * as ict2022Mtf from './ict/2022-mtf.js';
import * as ictBreaker from './ict/breaker.js';
import * as ictKillzone from './ict/killzone.js';

export const STRATEGIES = {
    strat,
    'ict-2022': ict2022,
    'ict-2022-mtf': ict2022Mtf,
    'ict-sweep-ob': ictSweepOb,
    'ict-fvg': ictFvg,
    'ict-breaker': ictBreaker,
    'ict-po3': ictPo3,
    'ict-killzone': ictKillzone
};

export function getStrategy(id) {
    const key = String(id ?? 'strat').toLowerCase();
    const strategy = STRATEGIES[key];
    if (!strategy) {
        throw new Error(`Unknown strategy "${id}". Available: ${Object.keys(STRATEGIES).join(', ')}`);
    }
    return strategy;
}

export function listStrategies() {
    return Object.entries(STRATEGIES).map(([key, strategy]) => ({
        id: strategy.id ?? key,
        label: strategy.label ?? key,
        defaults: strategy.defaults ?? {}
    }));
}
