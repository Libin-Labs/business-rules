import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { createRules } from '../dist/esm/index.js';

const rule = (when, output = 'yes', id = 'rule') => ({ id, when, output });
const engine = (when, options) =>
  createRules({ id: 'policy', version: 'v1', rules: [rule(when)] }, options);
const check = (when, facts) => engine(when).evaluate(facts).traces[0].condition;
test('versioned rules evaluate deterministic priorities and preserve stable declaration ties', () => {
  const policy = {
    id: 'checkout',
    version: '2026-1',
    rules: [
      { ...rule({ op: 'exists', path: ['id'] }, 'low', 'low'), priority: -1 },
      { ...rule({ op: 'exists', path: ['id'] }, 'first', 'first'), priority: 2 },
      { ...rule({ op: 'exists', path: ['id'] }, 'second', 'second'), priority: 2 },
    ],
  };
  const result = createRules(policy).evaluate({ id: 1 });
  assert.equal(result.policyId, 'checkout');
  assert.equal(result.version, '2026-1');
  assert.deepEqual(
    result.matches.map((match) => match.id),
    ['first', 'second', 'low'],
  );
  const first = createRules(policy, { strategy: 'first' }).evaluate({ id: 1 });
  assert.deepEqual(
    first.matches.map((match) => match.id),
    ['first'],
  );
  assert.equal(first.traces.length, 1);
});
test('all/any/not compose with full evaluated explanations, including empty groups', () => {
  const result = check(
    {
      op: 'all',
      conditions: [
        { op: 'gte', path: ['age'], value: 18 },
        {
          op: 'any',
          conditions: [
            { op: 'eq', path: ['country'], value: 'GB' },
            { op: 'eq', path: ['country'], value: 'US' },
          ],
        },
        { op: 'not', condition: { op: 'exists', path: ['banned'] } },
      ],
    },
    { age: 20, country: 'GB' },
  );
  assert.equal(result.matched, true);
  assert.equal(result.children[1].children.length, 2);
  assert.equal(result.children[2].children[0].reason, 'missing');
  assert.equal(check({ op: 'all', conditions: [] }, {}).matched, true);
  assert.equal(check({ op: 'any', conditions: [] }, {}).matched, false);
});
test('missing is not null, inequality never treats missing or mistyped values as a match', () => {
  assert.equal(check({ op: 'exists', path: ['a'] }, { a: null }).matched, true);
  assert.equal(check({ op: 'eq', path: ['a'], value: null }, { a: null }).matched, true);
  assert.equal(check({ op: 'eq', path: ['a'], value: null }, {}).reason, 'missing');
  assert.equal(check({ op: 'ne', path: ['a'], value: 1 }, {}).matched, false);
  assert.equal(check({ op: 'ne', path: ['a'], value: 1 }, { a: '1' }).reason, 'type-mismatch');
  assert.equal(check({ op: 'ne', path: ['a'], value: 1 }, { a: 2 }).matched, true);
});
test('numeric comparisons are finite, strict and do not coerce strings', () => {
  for (const [op, value, expected] of [
    ['gt', 2, false],
    ['gte', 2, true],
    ['lt', 2, false],
    ['lte', 2, true],
    ['gt', 1, true],
    ['lt', 3, true],
  ]) {
    assert.equal(check({ op, path: ['n'], value }, { n: 2 }).matched, expected);
    assert.equal(check({ op, path: ['n'], value }, { n: '2' }).reason, 'type-mismatch');
  }
  assert.throws(() => engine({ op: 'gt', path: ['n'], value: '2' }), TypeError);
});
test('in uses exact scalar membership and contains supports arrays or literal string substrings', () => {
  assert.equal(check({ op: 'in', path: ['a'], values: [1, '2', null] }, { a: '2' }).matched, true);
  assert.equal(check({ op: 'in', path: ['a'], values: [1] }, { a: '1' }).matched, false);
  assert.equal(check({ op: 'in', path: ['a'], values: [] }, { a: 1 }).matched, false);
  assert.equal(
    check({ op: 'contains', path: ['a'], value: null }, { a: [1, null, {}] }).matched,
    true,
  );
  assert.equal(check({ op: 'contains', path: ['a'], value: 'ab' }, { a: 'cabd' }).matched, true);
  assert.equal(
    check({ op: 'contains', path: ['a'], value: 1 }, { a: '1' }).reason,
    'type-mismatch',
  );
  assert.equal(check({ op: 'startsWith', path: ['a'], value: 'Ab' }, { a: 'Abc' }).matched, true);
  assert.equal(check({ op: 'startsWith', path: ['a'], value: 'ab' }, { a: 'Abc' }).matched, false);
});
test('paths traverse own nested keys and canonical array indexes, not prototypes or length', () => {
  assert.equal(
    check({ op: 'eq', path: ['rows', '0', 'id'], value: 1 }, { rows: [{ id: 1 }] }).matched,
    true,
  );
  assert.equal(check({ op: 'exists', path: ['rows', 'length'] }, { rows: [1] }).matched, false);
  assert.equal(check({ op: 'exists', path: ['rows', '01'] }, { rows: [1, 2] }).matched, false);
  assert.equal(check({ op: 'exists', path: ['toString'] }, {}).matched, false);
  assert.equal(check({ op: 'exists', path: [] }, {}).matched, true);
  const facts = JSON.parse('{"__proto__":{"constructor":"own"}}');
  assert.equal(
    check({ op: 'eq', path: ['__proto__', 'constructor'], value: 'own' }, facts).matched,
    true,
  );
  assert.equal({}.polluted, undefined);
});
test('disabled rules are validated but not evaluated and have explicit trace entries', () => {
  const rules = [{ ...rule({ op: 'exists', path: [] }), enabled: false }];
  const result = createRules({ id: 'p', version: '1', rules }).evaluate({});
  assert.deepEqual(result.traces, [{ id: 'rule', enabled: false, matched: false }]);
  assert.deepEqual(result.matches, []);
  assert.throws(
    () => createRules({ id: 'p', version: '1', rules: [{ ...rules[0], when: { op: 'unknown' } }] }),
    TypeError,
  );
});
test('policy and result mutations do not alter compiled behavior or later output', () => {
  const policy = {
    id: 'p',
    version: '1',
    rules: [rule({ op: 'eq', path: ['n'], value: 1 }, { value: [1] })],
  };
  const compiled = createRules(policy);
  policy.rules[0].when.value = 2;
  policy.rules[0].output.value.push(2);
  const first = compiled.evaluate({ n: 1 });
  first.matches[0].output.value.push(999);
  first.traces[0].condition.path[0] = 'changed';
  const second = compiled.evaluate({ n: 1 });
  assert.deepEqual(second.matches[0].output, { value: [1] });
  assert.deepEqual(second.traces[0].condition.path, ['n']);
});
test('explanations omit fact values and outputs remain explicit policy data', () => {
  const result = engine({ op: 'eq', path: ['secret'], value: 'private' }).evaluate({
    secret: 'private',
  });
  assert.equal(JSON.stringify(result.traces).includes('private'), false);
  assert.equal(result.traces[0].condition.reason, 'compared');
});
test('invalid JSON values, cycles, sparse arrays and accessors fail before evaluation', () => {
  let accessed = false;
  const getter = Object.defineProperty({}, 'a', {
    enumerable: true,
    get() {
      accessed = true;
      return 1;
    },
  });
  const cycle = {};
  cycle.self = cycle;
  const compiled = engine({ op: 'exists', path: [] });
  for (const invalid of [
    { a: undefined },
    { a: NaN },
    { a: Infinity },
    { a: 1n },
    { a: new Date() },
    { a: new Array(1) },
    cycle,
    getter,
    { a: () => {} },
    { [Symbol('x')]: 1 },
  ]) {
    assert.throws(() => compiled.evaluate(invalid));
  }
  assert.equal(accessed, false);
  assert.throws(() => compiled.evaluate([]), TypeError);
});
test('unexpected policy fields, operators, duplicates and mistyped optional values are rejected', () => {
  const base = { id: 'p', version: '1', rules: [rule({ op: 'exists', path: [] })] };
  assert.throws(() => createRules({ ...base, typo: 1 }), TypeError);
  assert.throws(() => createRules({ ...base, rules: [base.rules[0], base.rules[0]] }), /Duplicate/);
  for (const invalid of [
    { op: 'eval', path: [] },
    { op: 'exists', path: [], value: true },
    { op: 'eq', path: 'a', value: 1 },
    { op: 'eq', path: ['a'], value: {} },
    { op: 'in', path: [], values: [{}] },
    { op: 'startsWith', path: [], value: 1 },
  ])
    assert.throws(() => engine(invalid), TypeError);
  assert.throws(
    () => createRules({ ...base, rules: [{ ...base.rules[0], priority: null }] }),
    TypeError,
  );
  assert.throws(
    () => createRules({ ...base, rules: [{ ...base.rules[0], enabled: null }] }),
    TypeError,
  );
});
test('work and JSON limits fail explicitly without partial successful reports', () => {
  const conditions = {
    op: 'all',
    conditions: [
      { op: 'exists', path: ['a'] },
      { op: 'exists', path: ['b'] },
    ],
  };
  assert.throws(() => engine(conditions, { maxEvaluations: 2 }).evaluate({}), /maxEvaluations/);
  assert.equal(engine(conditions, { maxEvaluations: 3 }).evaluate({}).matches.length, 0);
  assert.throws(
    () => engine({ op: 'exists', path: [] }, { maxFactNodes: 1 }).evaluate({ a: 1 }),
    /node limit/,
  );
  assert.throws(
    () => engine({ op: 'exists', path: [] }, { maxDepth: 1 }).evaluate({ a: { b: 1 } }),
    /depth limit/,
  );
  assert.throws(() => engine({ op: 'exists', path: [] }, { maxPolicyNodes: 1 }), /node limit/);
  assert.throws(
    () =>
      createRules(
        {
          id: 'p',
          version: '1',
          rules: [
            rule({ op: 'exists', path: [] }, 1, 'a'),
            rule({ op: 'exists', path: [] }, 1, 'b'),
          ],
        },
        { maxRules: 1 },
      ),
    /maxRules/,
  );
});
test('logical groups do not short-circuit away diagnostics or evaluation budgets', () => {
  const result = check(
    {
      op: 'all',
      conditions: [
        { op: 'exists', path: ['missing'] },
        { op: 'exists', path: ['present'] },
      ],
    },
    { present: null },
  );
  assert.equal(result.matched, false);
  assert.equal(result.children[1].matched, true);
  assert.equal(result.children.length, 2);
});
test('generated rules agree with a simple business predicate across boundaries', () => {
  const compiled = engine({
    op: 'all',
    conditions: [
      { op: 'gte', path: ['age'], value: 18 },
      { op: 'lte', path: ['age'], value: 65 },
      { op: 'in', path: ['tier'], values: ['gold', 'silver'] },
      { op: 'not', condition: { op: 'eq', path: ['blocked'], value: true } },
    ],
  });
  for (let age = 0; age < 90; age++)
    for (const tier of ['gold', 'silver', 'basic'])
      for (const blocked of [true, false]) {
        const expected = age >= 18 && age <= 65 && ['gold', 'silver'].includes(tier) && !blocked;
        assert.equal(compiled.evaluate({ age, tier, blocked }).matches.length > 0, expected);
      }
});
test('CommonJS supports deterministic versioned policy execution', () => {
  const api = createRequire(import.meta.url)('../dist/cjs/index.js');
  const result = api
    .createRules({ id: 'p', version: '1', rules: [rule({ op: 'exists', path: ['id'] })] })
    .evaluate({ id: 1 });
  assert.equal(result.matches[0].output, 'yes');
});
