// Thin CLI over the generic engine. The strategy owns the rule; the engine owns
// data, costs, session handling, date windows, stats, and result files.

import { parseArgs, prepareContext, runStrategy, report } from './engine.js';
import { getStrategy, listStrategies } from './strategies/index.js';

const args = parseArgs(process.argv.slice(2));

if (args['list-strategies']) {
    console.log('Available strategies:');
    for (const strategy of listStrategies()) {
        console.log(`  ${strategy.id.padEnd(16)} ${strategy.label}`);
    }
    process.exit(0);
}

const strategy = getStrategy(args.strategy);
const ctx = await prepareContext(args, strategy);
const trades = runStrategy(strategy, ctx);
await report(ctx, trades);
