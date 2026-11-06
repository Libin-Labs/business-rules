export type Scalar = string | number | boolean | null;
export type JsonValue = Scalar | JsonValue[] | { [key: string]: JsonValue };
export type Condition =
  | { op: 'all'; conditions: readonly Condition[] }
  | { op: 'any'; conditions: readonly Condition[] }
  | { op: 'not'; condition: Condition }
  | { op: 'exists'; path: readonly string[] }
  | {
      op: 'eq' | 'ne' | 'gt' | 'gte' | 'lt' | 'lte' | 'contains' | 'startsWith';
      path: readonly string[];
      value: Scalar;
    }
  | { op: 'in'; path: readonly string[]; values: readonly Scalar[] };
export interface Rule {
  id: string;
  when: Condition;
  output: JsonValue;
  priority?: number;
  enabled?: boolean;
}
export interface Policy {
  id: string;
  version: string;
  rules: readonly Rule[];
}
export interface EngineOptions {
  strategy?: 'all' | 'first';
  maxRules?: number;
  maxPolicyNodes?: number;
  maxFactNodes?: number;
  maxDepth?: number;
  maxEvaluations?: number;
}
export interface ConditionTrace {
  op: Condition['op'];
  matched: boolean;
  reason: 'group' | 'compared' | 'missing' | 'type-mismatch' | 'present';
  path?: string[];
  children?: ConditionTrace[];
}
export interface RuleTrace {
  id: string;
  enabled: boolean;
  matched: boolean;
  condition?: ConditionTrace;
}
export interface Evaluation {
  policyId: string;
  version: string;
  matches: { id: string; output: JsonValue }[];
  traces: RuleTrace[];
}
export interface RulesEngine {
  evaluate(facts: Readonly<Record<string, unknown>>): Evaluation;
}
function integer(value: number, name: string, maximum = Number.MAX_SAFE_INTEGER): number {
  if (!Number.isSafeInteger(value) || value < 1 || value > maximum)
    throw new RangeError(`${name} must be a positive safe integer <= ${maximum}.`);
  return value;
}
function plain(value: unknown): value is Record<string, unknown> {
  return (
    value !== null &&
    typeof value === 'object' &&
    (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
  );
}
function scalar(value: unknown): value is Scalar {
  return (
    value === null ||
    typeof value === 'string' ||
    typeof value === 'boolean' ||
    (typeof value === 'number' && Number.isFinite(value))
  );
}
function snapshot(value: unknown, maximum: number, depthLimit: number): JsonValue {
  let nodes = 0;
  const ancestors = new Set<object>();
  const visit = (input: unknown, depth: number): JsonValue => {
    if (++nodes > maximum) throw new RangeError('JSON input exceeds node limit.');
    if (depth > depthLimit) throw new RangeError('JSON input exceeds depth limit.');
    if (typeof input === 'string' && input.length > 65_536)
      throw new RangeError('JSON string exceeds 65536 UTF-16 units.');
    if (scalar(input)) return input;
    if (!Array.isArray(input) && !plain(input))
      throw new TypeError('Expected finite JSON values, dense arrays and plain data objects.');
    if (ancestors.has(input)) throw new TypeError('Cyclic JSON values are not supported.');
    ancestors.add(input);
    const descriptors = Object.getOwnPropertyDescriptors(input);
    if (Reflect.ownKeys(input).some((key) => typeof key === 'symbol'))
      throw new TypeError('Symbol keys are not supported.');
    let result: JsonValue;
    if (Array.isArray(input)) {
      if (input.length > maximum - nodes || Object.keys(descriptors).length !== input.length + 1)
        throw new RangeError('Array exceeds node limit or has missing/extra properties.');
      const array: JsonValue[] = [];
      for (let index = 0; index < input.length; index++) {
        const descriptor = descriptors[String(index)];
        if (!descriptor || !descriptor.enumerable || !('value' in descriptor))
          throw new TypeError('Array items must be enumerable data properties.');
        array.push(visit(descriptor.value, depth + 1));
      }
      result = array;
    } else {
      const entries = Object.entries(descriptors);
      if (entries.length > maximum - nodes) throw new RangeError('Object exceeds node limit.');
      result = Object.fromEntries(
        entries.map(([key, descriptor]) => {
          if (key.length > 1024) throw new RangeError('JSON key exceeds 1024 UTF-16 units.');
          if (!descriptor.enumerable || !('value' in descriptor))
            throw new TypeError('Fields must be enumerable data properties.');
          return [key, visit(descriptor.value, depth + 1)];
        }),
      );
    }
    ancestors.delete(input);
    return result;
  };
  return visit(value, 0);
}
function record(value: unknown): Record<string, unknown> {
  if (!plain(value)) throw new TypeError('Expected an object.');
  return value;
}
function shape(value: Record<string, unknown>, required: string[], optional: string[] = []): void {
  if (
    required.some((key) => !Object.hasOwn(value, key)) ||
    Object.keys(value).some((key) => !required.includes(key) && !optional.includes(key))
  ) {
    throw new TypeError(`Unexpected or missing fields; expected ${required.join(', ')}.`);
  }
}
function identity(value: unknown): string {
  if (typeof value !== 'string' || value.length === 0 || value.length > 128)
    throw new TypeError('IDs and versions must be nonempty strings up to 128 units.');
  return value;
}
function path(value: unknown): string[] {
  if (
    !Array.isArray(value) ||
    value.length > 32 ||
    value.some((segment) => typeof segment !== 'string' || segment.length > 1024)
  )
    throw new TypeError('Paths require at most 32 string segments.');
  return value;
}
function condition(input: unknown, depth: number): Condition {
  if (depth > 64) throw new RangeError('Condition nesting exceeds 64.');
  const value = record(input);
  const op = value.op;
  if (op === 'all' || op === 'any') {
    shape(value, ['op', 'conditions']);
    if (!Array.isArray(value.conditions)) throw new TypeError('conditions must be an array.');
    return { op, conditions: value.conditions.map((child) => condition(child, depth + 1)) };
  }
  if (op === 'not') {
    shape(value, ['op', 'condition']);
    return { op, condition: condition(value.condition, depth + 1) };
  }
  if (op === 'exists') {
    shape(value, ['op', 'path']);
    return { op, path: path(value.path) };
  }
  if (op === 'in') {
    shape(value, ['op', 'path', 'values']);
    if (!Array.isArray(value.values) || !value.values.every(scalar))
      throw new TypeError('in requires scalar values.');
    return { op, path: path(value.path), values: value.values };
  }
  if (
    op === 'eq' ||
    op === 'ne' ||
    op === 'gt' ||
    op === 'gte' ||
    op === 'lt' ||
    op === 'lte' ||
    op === 'contains' ||
    op === 'startsWith'
  ) {
    shape(value, ['op', 'path', 'value']);
    if (!scalar(value.value)) throw new TypeError('Comparisons require a scalar value.');
    if (['gt', 'gte', 'lt', 'lte'].includes(op) && typeof value.value !== 'number')
      throw new TypeError('Ordering requires a numeric value.');
    if (op === 'startsWith' && typeof value.value !== 'string')
      throw new TypeError('startsWith requires a string value.');
    return { op, path: path(value.path), value: value.value };
  }
  throw new TypeError(`Unknown condition operator: ${String(op)}`);
}
const missing = Symbol('missing');
function lookup(facts: JsonValue, segments: readonly string[]): JsonValue | typeof missing {
  let current = facts;
  for (const segment of segments) {
    if (current === null || typeof current !== 'object' || !Object.hasOwn(current, segment))
      return missing;
    if (Array.isArray(current)) {
      if (!/^(0|[1-9]\d*)$/.test(segment) || Number(segment) >= current.length) return missing;
      current = current[Number(segment)]!;
    } else current = current[segment]!;
  }
  return current;
}
function evaluateCondition(
  value: Condition,
  facts: JsonValue,
  budget: { left: number },
): ConditionTrace {
  if (budget.left-- === 0) throw new RangeError('Evaluation exceeds maxEvaluations.');
  if (value.op === 'all' || value.op === 'any') {
    const children = value.conditions.map((child) => evaluateCondition(child, facts, budget));
    return {
      op: value.op,
      matched:
        value.op === 'all'
          ? children.every((child) => child.matched)
          : children.some((child) => child.matched),
      reason: 'group',
      children,
    };
  }
  if (value.op === 'not') {
    const child = evaluateCondition(value.condition, facts, budget);
    return { op: value.op, matched: !child.matched, reason: 'group', children: [child] };
  }
  const actual = lookup(facts, value.path);
  const trace = (matched: boolean, reason: ConditionTrace['reason']): ConditionTrace => ({
    op: value.op,
    matched,
    reason,
    path: [...value.path],
  });
  if (value.op === 'exists')
    return trace(actual !== missing, actual === missing ? 'missing' : 'present');
  if (actual === missing) return trace(false, 'missing');
  if (value.op === 'in') {
    return scalar(actual)
      ? trace(
          value.values.some((expected) => actual === expected),
          'compared',
        )
      : trace(false, 'type-mismatch');
  }
  if (value.op === 'contains') {
    if (typeof actual === 'string' && typeof value.value === 'string')
      return trace(actual.includes(value.value), 'compared');
    if (Array.isArray(actual))
      return trace(
        actual.some((item) => scalar(item) && item === value.value),
        'compared',
      );
    return trace(false, 'type-mismatch');
  }
  if (value.op === 'startsWith')
    return typeof actual === 'string' && typeof value.value === 'string'
      ? trace(actual.startsWith(value.value), 'compared')
      : trace(false, 'type-mismatch');
  if (!scalar(actual) || typeof actual !== typeof value.value) return trace(false, 'type-mismatch');
  if (value.op === 'eq') return trace(actual === value.value, 'compared');
  if (value.op === 'ne') return trace(actual !== value.value, 'compared');
  if (typeof actual !== 'number' || typeof value.value !== 'number')
    return trace(false, 'type-mismatch');
  switch (value.op) {
    case 'gt':
      return trace(actual > value.value, 'compared');
    case 'gte':
      return trace(actual >= value.value, 'compared');
    case 'lt':
      return trace(actual < value.value, 'compared');
    case 'lte':
      return trace(actual <= value.value, 'compared');
  }
}
export function createRules(policy: Policy, options: EngineOptions = {}): RulesEngine {
  const maxRules = integer(options.maxRules ?? 1000, 'maxRules');
  const maxPolicyNodes = integer(options.maxPolicyNodes ?? 100_000, 'maxPolicyNodes');
  const maxFactNodes = integer(options.maxFactNodes ?? 100_000, 'maxFactNodes');
  const maxDepth = integer(options.maxDepth ?? 32, 'maxDepth', 128);
  const maxEvaluations = integer(options.maxEvaluations ?? 10_000, 'maxEvaluations');
  const strategy = options.strategy ?? 'all';
  if (strategy !== 'all' && strategy !== 'first')
    throw new TypeError('Unsupported evaluation strategy.');
  const saved = record(snapshot(policy, maxPolicyNodes, 196));
  shape(saved, ['id', 'version', 'rules']);
  const id = identity(saved.id),
    version = identity(saved.version);
  if (!Array.isArray(saved.rules)) throw new TypeError('Policy rules must be an array.');
  if (saved.rules.length > maxRules) throw new RangeError('Policy exceeds maxRules.');
  const ids = new Set<string>();
  const rules = saved.rules
    .map((input) => {
      const rule = record(input);
      shape(rule, ['id', 'when', 'output'], ['priority', 'enabled']);
      const ruleId = identity(rule.id);
      if (ids.has(ruleId)) throw new TypeError(`Duplicate rule id: ${ruleId}`);
      ids.add(ruleId);
      const priority = rule.priority === undefined ? 0 : rule.priority;
      if (typeof priority !== 'number' || !Number.isSafeInteger(priority))
        throw new TypeError('Priority must be a safe integer.');
      const enabled = rule.enabled === undefined ? true : rule.enabled;
      if (typeof enabled !== 'boolean') throw new TypeError('enabled must be a boolean.');
      return {
        id: ruleId,
        priority,
        enabled,
        when: condition(rule.when, 0),
        output: rule.output as JsonValue,
      };
    })
    .sort((a, b) => b.priority - a.priority);
  return {
    evaluate(facts) {
      if (!plain(facts)) throw new TypeError('Facts must be a plain object.');
      const input = snapshot(facts, maxFactNodes, maxDepth);
      const budget = { left: maxEvaluations };
      const matches: Evaluation['matches'] = [];
      const traces: RuleTrace[] = [];
      for (const rule of rules) {
        if (!rule.enabled) {
          traces.push({ id: rule.id, enabled: false, matched: false });
          continue;
        }
        const trace = evaluateCondition(rule.when, input, budget);
        traces.push({ id: rule.id, enabled: true, matched: trace.matched, condition: trace });
        if (trace.matched) {
          matches.push({ id: rule.id, output: snapshot(rule.output, maxPolicyNodes, 196) });
          if (strategy === 'first') break;
        }
      }
      return { policyId: id, version, matches, traces };
    },
  };
}
