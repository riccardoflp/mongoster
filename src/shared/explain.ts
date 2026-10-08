// Readable summary of explain("executionStats") output for find and aggregate, plus an index suggestion.
import { isOperatorObject, isPlainObject } from './query';

export interface PlanNode {
  stage: string;
  /** Short description: index and bounds, filter, sort pattern, … (mongosh-like JSON). */
  details: Record<string, unknown>;
  children: PlanNode[];
  nReturned?: number;
  keysExamined?: number;
  docsExamined?: number;
  timeMs?: number;
}

export interface ExplainSummary {
  /** Plan of the query layer (the find, or the part of a pipeline pushed down to it). */
  plan: PlanNode | null;
  /** Index names used by the plan. */
  indexes: string[];
  collscan: boolean;
  /** A SORT stage in memory (no index provides the order). */
  inMemorySort: boolean;
  nReturned?: number;
  totalKeysExamined?: number;
  totalDocsExamined?: number;
  executionTimeMillis?: number;
  rejectedPlans: number;
  /** Aggregation stages run after the query layer. */
  pipeline: { stage: string; nReturned?: number; timeMs?: number }[];
}

type Obj = Record<string, unknown>;
const num = (v: unknown) => (typeof v === 'number' ? v : undefined);

/** First object (depth-first) that has `key`. */
function findWith(root: unknown, key: string, depth = 0): Obj | undefined {
  if (depth > 8 || root === null || typeof root !== 'object') return undefined;
  if (!Array.isArray(root) && key in (root as Obj)) return root as Obj;
  for (const v of Array.isArray(root) ? root : Object.values(root as Obj)) {
    const found = findWith(v, key, depth + 1);
    if (found) return found;
  }
  return undefined;
}

const DETAIL_KEYS = [
  'indexName',
  'keyPattern',
  'indexBounds',
  'filter',
  'sortPattern',
  'transformBy',
  'limitAmount',
  'skipAmount',
  'direction',
  'isMultiKey',
];

function toNode(stage: Obj): PlanNode {
  const children: unknown[] = [];
  if (isPlainObject(stage.inputStage)) children.push(stage.inputStage);
  if (Array.isArray(stage.inputStages)) children.push(...stage.inputStages);
  if (isPlainObject(stage.queryPlan)) children.push(stage.queryPlan);
  const details: Obj = {};
  for (const k of DETAIL_KEYS) if (stage[k] !== undefined) details[k] = stage[k];
  return {
    stage: String(stage.stage ?? '?'),
    details,
    children: children.filter(isPlainObject).map((c) => toNode(c as Obj)),
    nReturned: num(stage.nReturned),
    keysExamined: num(stage.keysExamined),
    docsExamined: num(stage.docsExamined),
    timeMs: num(stage.executionTimeMillisEstimate),
  };
}

function walk(node: PlanNode | null, fn: (n: PlanNode) => void): void {
  if (!node) return;
  fn(node);
  node.children.forEach((c) => walk(c, fn));
}

export function summarizeExplain(raw: unknown): ExplainSummary {
  const holder = findWith(raw, 'queryPlanner');
  const planner = holder?.queryPlanner as Obj | undefined;
  const stats = (holder?.executionStats ?? findWith(raw, 'executionStats')?.executionStats) as Obj | undefined;
  const winning = planner?.winningPlan as Obj | undefined;
  const logical = (winning && isPlainObject(winning.queryPlan) ? winning.queryPlan : winning) as Obj | undefined;
  // Classic execution stages mirror the plan with per-stage stats; slot-based (SBE) ones use other, lowercase names.
  const exec = stats?.executionStages as Obj | undefined;
  const classic = exec && typeof exec.stage === 'string' && exec.stage === exec.stage.toUpperCase();
  const plan = classic ? toNode(exec) : logical ? toNode(logical) : null;

  const indexes = new Set<string>();
  let collscan = false;
  let inMemorySort = false;
  walk(plan, (n) => {
    if (typeof n.details.indexName === 'string') indexes.add(n.details.indexName);
    if (n.stage === 'COLLSCAN') collscan = true;
    if (n.stage === 'SORT') inMemorySort = true;
  });

  const pipeline: ExplainSummary['pipeline'] = [];
  const stages = isPlainObject(raw) && Array.isArray(raw.stages) ? raw.stages : [];
  for (const s of stages) {
    if (!isPlainObject(s)) continue;
    const op = Object.keys(s).find((k) => k.startsWith('$'));
    if (!op || op === '$cursor') continue;
    pipeline.push({ stage: op, nReturned: num(s.nReturned), timeMs: num(s.executionTimeMillisEstimate) });
  }

  return {
    plan,
    indexes: [...indexes],
    collscan,
    inMemorySort,
    nReturned: num(stats?.nReturned),
    totalKeysExamined: num(stats?.totalKeysExamined),
    totalDocsExamined: num(stats?.totalDocsExamined),
    executionTimeMillis: num(stats?.executionTimeMillis),
    rejectedPlans: Array.isArray(planner?.rejectedPlans) ? planner.rejectedPlans.length : 0,
    pipeline,
  };
}

const RANGE_OPS = new Set(['$gt', '$gte', '$lt', '$lte', '$ne', '$nin', '$regex', '$exists', '$not']);

/**
 * An index for a filter + sort following the ESR rule: equality fields, then sort fields, then range fields.
 * Returns null when nothing in the filter or sort can use an index.
 */
export function suggestIndex(filter: unknown, sort: unknown): Record<string, 1 | -1> | null {
  const equality: string[] = [];
  const range: string[] = [];
  if (isPlainObject(filter)) {
    for (const [key, value] of Object.entries(filter)) {
      if (key.startsWith('$')) continue;
      if (isPlainObject(value) && '$regularExpression' in value) range.push(key);
      else if (isOperatorObject(value)) {
        const ops = Object.keys(value);
        if (ops.some((op) => op === '$eq' || op === '$in')) equality.push(key);
        else if (ops.some((op) => RANGE_OPS.has(op))) range.push(key);
        else if (ops.includes('$elemMatch')) equality.push(key);
      } else equality.push(key);
    }
  }
  const index: Record<string, 1 | -1> = {};
  for (const key of equality) index[key] = 1;
  if (isPlainObject(sort)) {
    for (const [key, dir] of Object.entries(sort)) if (!(key in index)) index[key] = dir === -1 ? -1 : 1;
  }
  for (const key of range) if (!(key in index)) index[key] = 1;
  return Object.keys(index).length ? index : null;
}
