import { createRules, type RulesEngine } from '@lp-labs/business-rules';
const engine: RulesEngine = createRules({ id: 'p', version: '1', rules: [] });
const result: string = engine.evaluate({}).version;
void result;
