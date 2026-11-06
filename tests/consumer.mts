import { createRules, type Policy, type Evaluation, type Condition } from '@lp-labs/business-rules';
const condition: Condition = { op: 'gte', path: ['age'], value: 18 };
const policy: Policy = {
  id: 'eligibility',
  version: '1',
  rules: [{ id: 'adult', when: condition, output: { eligible: true } }],
};
const result: Evaluation = createRules(policy).evaluate({ age: 20 });
// @ts-expect-error unsupported operators do not execute arbitrary JavaScript.
const invalid: Condition = { op: 'eval', value: 'true' };
// @ts-expect-error outputs must be JSON values.
createRules({ id: 'p', version: '1', rules: [{ id: 'a', when: condition, output: () => 1 }] });
void [result, invalid];
