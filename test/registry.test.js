import { describe, expect, test } from 'bun:test';
import { STRATEGIES, getStrategy, listStrategies } from '../src/strategies/index.js';

describe('strategy registry', () => {
    test('every strategy exposes the engine contract', () => {
        for (const [key, strategy] of Object.entries(STRATEGIES)) {
            expect(typeof strategy.run).toBe('function');
            expect(typeof (strategy.id ?? key)).toBe('string');
            expect(typeof (strategy.label ?? key)).toBe('string');
        }
    });

    test('ids are unique and resolvable', () => {
        const ids = listStrategies().map(strategy => strategy.id);
        expect(new Set(ids).size).toBe(ids.length);
        for (const id of ids) {
            expect(getStrategy(id).id).toBe(id);
        }
    });

    test('unknown strategy fails loudly', () => {
        expect(() => getStrategy('does-not-exist')).toThrow(/Unknown strategy/);
    });

    test('the Strat plug-in is available with an honest default', () => {
        const strat = getStrategy('strat');
        expect(strat.defaults.ambiguous).toBe('stop');
    });

    test('the ICT 2022 model is registered', () => {
        expect(getStrategy('ict-2022').label).toMatch(/ICT 2022/);
    });
});
