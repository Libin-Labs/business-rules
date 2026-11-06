# @lp-labs/business-rules

Evaluate versioned declarative rules against JSON facts, producing ordered decisions and explanations without executing user-authored JavaScript.

- Zero runtime or peer dependencies, no sibling-package imports.
- ESM, CommonJS and TypeScript declarations.
- Explicit priorities, first/all match strategies and disabled-rule traces.
- Bounded policy/fact validation and condition evaluation.
- Deterministic synchronous evaluation; no global state, network or browser globals.

## Installation

```sh
npm install @lp-labs/business-rules
```

Requires Node.js 18+ or a modern browser with an ESM-aware bundler.

## Quickstart

```js
import { createRules } from '@lp-labs/business-rules';

const rules = createRules({
  id: 'shipping',
  version: '2026-1',
  rules: [{
    id: 'free-shipping',
    priority: 10,
    when: {
      op: 'all',
      conditions: [
        { op: 'gte', path: ['total'], value: 100 },
        { op: 'in', path: ['country'], values: ['GB', 'US'] },
      ],
    },
    output: { shipping: 'free' },
  }],
});

const result = rules.evaluate({ total: 120, country: 'GB' });
console.log(result.matches[0].output); // { shipping: 'free' }
console.log(result.version); // 2026-1
console.log(result.traces[0].condition.children.map((trace) => trace.matched)); // [true, true]
```

CommonJS: `const { createRules } = require('@lp-labs/business-rules')`.

## API

Runtime export: `createRules`.

Type exports: `Scalar`, `JsonValue`, `Condition`, `Rule`, `Policy`, `EngineOptions`, `ConditionTrace`, `RuleTrace`, `Evaluation`, `RulesEngine`.

### createRules(policy, options?)

Compile and validate a copied policy:

```ts
interface Policy {
  id: string;
  version: string;
  rules: readonly Rule[];
}
interface Rule {
  id: string;
  when: Condition;
  output: JsonValue;
  priority?: number;
  enabled?: boolean;
}
```

IDs/versions are nonempty strings up to 128 UTF-16 units. Rule IDs must be unique within the policy. `priority` defaults to zero and must be a safe integer; highest priority runs first, declaration order breaks ties. `enabled` defaults to true. Disabled rules are validated but not evaluated.

Unknown policy/rule/condition fields are errors so misspelled options in declarative definitions cannot silently change behavior. Output is arbitrary supported JSON data, not an executable action.

| Engine option | Default | Meaning |
|---|---|---|
| `strategy` | `'all'` | `'all'` evaluates all enabled rules; `'first'` stops after the first matching rule. |
| `maxRules` | `1000` | Maximum policy rule count; positive safe integer. |
| `maxPolicyNodes` | `100000` | Maximum JSON values in the complete policy, including definitions and outputs. |
| `maxFactNodes` | `100000` | Maximum JSON values validated per evaluation. |
| `maxDepth` | `32` | Maximum fact nesting depth, root zero; integer 1..128. |
| `maxEvaluations` | `10000` | Maximum evaluated condition nodes across enabled rules in one evaluation. |

Other numeric limits must be positive safe integers. Condition nesting is capped at 64; policy JSON nesting at 196. Strings are capped at 65536 UTF-16 units and object keys at 1024 units.

### evaluate(facts)

The engine exposes `evaluate(facts)` where facts is a plain object. It validates and snapshots the full input before decisions, even when a rule touches only one field. Supported nested JSON values are null, booleans, strings, finite numbers, dense ordinary arrays and plain/null-prototype objects with enumerable own string-keyed data properties.

Rejected: undefined, nonfinite numbers, bigint, functions, symbols/symbol keys, custom classes/dates/maps, cycles, accessors, nonenumerable fields, sparse arrays and extra array properties. Accessors are rejected via descriptors without invoking them; hostile Proxy traps are not a supported isolation boundary.

Neither input nor policy objects are mutated or retained by reference. Outputs and traces are freshly allocated for each call. There is no policy update method: create a new engine with a new explicit version when definitions change.

## Condition language

`Scalar` is string, finite number, boolean or null. No implicit coercion, regular expressions, scripts, reflection, dynamic callbacks or custom executable operators exist.

| Shape | Meaning |
|---|---|
| `{ op: 'all', conditions: [...] }` | Every child matches; empty all is true. |
| `{ op: 'any', conditions: [...] }` | Any child matches; empty any is false. |
| `{ op: 'not', condition: ... }` | Invert one child's boolean result. |
| `{ op: 'exists', path }` | Own value exists, including explicit null. |
| `{ op: 'eq', path, value }` | Exact scalar equality with matching runtime type. |
| `{ op: 'ne', path, value }` | Scalar inequality with matching runtime type. Missing/mismatched values do not match. |
| `{ op: 'gt' \| 'gte' \| 'lt' \| 'lte', path, value }` | Strict numeric comparison; definition value and fact must be numbers. |
| `{ op: 'in', path, values: [...] }` | Exact scalar membership; empty list never matches. |
| `{ op: 'contains', path, value }` | Literal substring for string/string, or exact scalar membership for an array. |
| `{ op: 'startsWith', path, value: string }` | Literal case-sensitive prefix. |

Strings use JavaScript exact comparison. Numeric equality follows `===`, including negative zero equaling zero; nonfinite inputs are rejected. Object/array deep equality is deliberately not provided.

Every `path` is an array of at most 32 string segments, **not a dotted expression**. Empty path addresses the whole facts root. Object traversal uses own properties only. Array traversal requires canonical non-negative indexes such as `'0'`, not `'01'`, `'-1'` or `'length'`. Paths never traverse primitive prototypes. Literal dots, slashes, `__proto__` and `constructor` are supported as own field names.

Missing fields are distinct from explicit null. All non-existence leaf comparisons on missing values are false. `not` still inverts this false result: use an explicit `exists` condition alongside a negated comparison if absence must not qualify.

```js
import { createRules } from '@lp-labs/business-rules';
const rules = createRules({
  id: 'review', version: '1',
  rules: [{
    id: 'known-not-blocked',
    when: { op: 'all', conditions: [
      { op: 'exists', path: ['blocked'] },
      { op: 'not', condition: { op: 'eq', path: ['blocked'], value: true } },
    ] },
    output: 'review',
  }],
});
console.log(rules.evaluate({}).matches); // []
console.log(rules.evaluate({ blocked: false }).matches[0].output); // review
```

## Decisions and explanations

`Evaluation` contains `{ policyId, version, matches, traces }`.

- `matches`: ordered `{ id, output }[]` for matching rules.
- `traces`: one `{ id, enabled, matched, condition? }` per visited rule.
- Disabled rules have no condition trace.
- First-match strategy does not include rules after its winning rule.

`ConditionTrace` contains operator, boolean match, optional path/children and a reason:

- `'group'`: logical all/any/not;
- `'present'`: existence found a value;
- `'missing'`: own path not found;
- `'type-mismatch'`: operation does not accept the fact's type;
- `'compared'`: supported comparison completed, whether true or false.

Groups evaluate **all children**, not short-circuit, so traces show every child and work budgets count all evaluations. Rule-level first-match is the only selection short-circuit.

Traces omit actual fact values and comparison constants, but paths/rule IDs may still reveal sensitive structure. Outputs are explicitly chosen policy data and may themselves be sensitive. The package does not log or persist inputs or decisions. Store any required audit record through your authorized application boundary.

## Customization and integration

Define domain facts upstream, use reusable condition builders in your application, assign explicit policy versions, and interpret output data downstream. For example, output `{ discountPercent: 5 }` and apply it through a separately tested monetary calculation. Do not execute arbitrary strings returned as actions.

There are no automatic network actions, database writes, schedules, runtime migrations, persistence adapters, schema-standard imports or hot-reload watchers. Version strings label the policy but are not signatures or authorization. Enforce who can supply policies and facts server-side when decisions affect permissions, money or protected operations.

## Performance and errors

Validation is O(visited JSON nodes), excluding reflection and string/key sizes. Evaluation is bounded by condition count plus path traversal, substring and membership work. `maxEvaluations` counts nodes, not every character/member comparison; large scalar arrays still require linear membership searches. Output copying and full traces consume memory proportional to returned data.

Bad JSON, definitions, types and unknown operators throw `TypeError`; quotas/nesting limits throw `RangeError`. Capacity overflow returns no partial successful evaluation. Missing/type-incompatible facts are explicit false results with diagnostic reasons, not thrown errors.

This independently authored initial release provides a bounded JSON rule interpreter, not a full decision-model standard, legal policy certification or security-policy sandbox.

## Support

If this library is useful to you, consider supporting its maintenance with a [donation via PayPal](https://www.paypal.me/LibinPrasanth).

## Author

Created by [Libin Prasanth](https://www.linkedin.com/in/libinprasanth/). Connect on LinkedIn for updates and discussion.
