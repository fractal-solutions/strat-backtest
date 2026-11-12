// Trial registry for multiple-testing control.
//
// Every strategy/variant that gets a serious look should be recorded here. The
// deflated Sharpe uses the full list of trial Sharpes, not just the winner.
// results/ is gitignored, so each clone keeps its own research log.

import { join } from 'node:path';
import { readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { shSeries, deflatedSharpeSeries } from './stats.js';

const ROOT = join(import.meta.dir, '..');
const DEFAULT_PATH = join(ROOT, 'results', 'trials.json');

export function loadTrials(path = DEFAULT_PATH) {
    try {
        const data = JSON.parse(readFileSync(path, 'utf8'));
        return Array.isArray(data.trials) ? data.trials : [];
    } catch {
        return [];
    }
}

export function saveTrials(trials, path = DEFAULT_PATH) {
    mkdirSync(join(path, '..'), { recursive: true });
    writeFileSync(path, JSON.stringify({ trials }, null, 2));
}

/**
 * Record one trial. Re-recording the same id replaces it, so re-running a
 * strategy does not inflate the trial count.
 */
export function recordTrial({
    id,
    strategy = null,
    sharpe,
    source = 'manual',
    note = null,
    monthlyReturns = null
}, path = DEFAULT_PATH) {
    if (!id) throw new Error('recordTrial needs an id');
    if (!Number.isFinite(sharpe)) throw new Error(`recordTrial "${id}" needs a finite Sharpe`);
    const trials = loadTrials(path).filter(trial => trial.id !== id);
    trials.push({
        id,
        strategy,
        sharpe,
        source,
        note,
        recorded: new Date().toISOString()
    });
    saveTrials(trials, path);
    return trials;
}

export function recordPortfolioTrial({ id, strategy, monthlyReturns, source = 'portfolio', note = null }, path = DEFAULT_PATH) {
    const values = monthlyReturns.map(row => row.value ?? row);
    const sharpe = shSeries(values);
    return recordTrial({ id, strategy, sharpe, source, note, monthlyReturns: values }, path);
}

export function trialSharpes(path = DEFAULT_PATH) {
    return loadTrials(path)
        .map(trial => Number(trial.sharpe))
        .filter(Number.isFinite);
}

/**
 * Deflated Sharpe for a monthly return series against every recorded trial.
 * `extra` lets a caller include pre-registered trials that are not in the
 * registry file (e.g. the original five portfolio variants).
 */
export function deflatedSharpeFor(monthlyReturns, { path = DEFAULT_PATH, extra = [] } = {}) {
    const values = monthlyReturns.map(row => row.value ?? row);
    const sharpes = [...trialSharpes(path), ...extra].filter(Number.isFinite);
    const result = deflatedSharpeSeries(values, sharpes);
    return { ...result, trialCount: sharpes.length, trialSharpes: sharpes };
}
