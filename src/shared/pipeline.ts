// Aggregation pipeline model shared by the webview and the extension host.
import { isPlainObject, parseQuery, prettyShell } from './query';

export interface PipelineStage {
  /** Stage operator, e.g. "$match". */
  op: string;
  /** Stage argument in mongosh syntax, e.g. '{ status: "active" }' or '10' for $limit. */
  body: string;
  enabled: boolean;
}

/** Common stages with a starter body, in menu order. */
export const STAGE_TEMPLATES: Record<string, string> = {
  $match: '{\n  \n}',
  $project: '{\n  field: 1\n}',
  $addFields: '{\n  newField: "$field"\n}',
  $set: '{\n  field: "value"\n}',
  $unset: '"field"',
  $group: '{\n  _id: "$field",\n  count: { $sum: 1 }\n}',
  $sort: '{\n  field: -1\n}',
  $limit: '10',
  $skip: '10',
  $unwind: '"$arrayField"',
  $lookup: '{\n  from: "collection",\n  localField: "field",\n  foreignField: "_id",\n  as: "joined"\n}',
  $count: '"count"',
  $sortByCount: '"$field"',
  $replaceRoot: '{\n  newRoot: "$field"\n}',
  $sample: '{\n  size: 10\n}',
  $facet: '{\n  facetName: [\n    { $count: "count" }\n  ]\n}',
  $bucket: '{\n  groupBy: "$field",\n  boundaries: [0, 10, 100],\n  default: "other"\n}',
  $search: '{\n  index: "default",\n  text: {\n    query: "word",\n    path: "field"\n  }\n}',
  $searchMeta: '{\n  index: "default",\n  exists: { path: "field" },\n  count: { type: "total" }\n}',
  $vectorSearch: '{\n  index: "vector_index",\n  path: "embedding",\n  queryVector: [0.1, 0.2, 0.3],\n  numCandidates: 100,\n  limit: 10\n}',
  $out: '"outputCollection"',
  $merge: '{\n  into: "outputCollection"\n}',
};

/** Stages that write to the database. */
export const WRITE_STAGES = new Set(['$out', '$merge']);

export function isWriteStage(stage: PipelineStage): boolean {
  return stage.enabled && WRITE_STAGES.has(stage.op.trim());
}

/**
 * Stages that are not a plain read of the collection the pipeline runs on: they write, stay open
 * waiting for changes, list what the server and its other sessions are doing, or give the queries
 * other clients ran, with their values.
 */
export const NOT_PLAIN_READ_STAGES = new Set([
  '$out',
  '$merge',
  '$changeStream',
  '$changeStreamSplitLargeEvent',
  '$currentOp',
  '$listSessions',
  '$listLocalSessions',
  '$queryStats',
  '$listSampledQueries',
  '$planCacheStats',
]);

/** The pipelines nested in a stage: the facets of $facet, the pipeline of $lookup and $unionWith. */
function nestedPipelines(op: string, body: unknown): unknown[][] {
  if (!isPlainObject(body)) return [];
  if (op === '$facet') return Object.values(body).filter(Array.isArray);
  if (op === '$lookup' || op === '$unionWith') return Array.isArray(body.pipeline) ? [body.pipeline] : [];
  return [];
}

/** Calls `visit` with every stage of a parsed pipeline (plain values), the nested pipelines' too. */
function walkStages(pipeline: unknown[], visit: (op: string, body: unknown) => void, depth = 0): void {
  // Deeper than any real pipeline: a pipeline built to nest without end is cut off here.
  if (depth > 20) throw new Error('The pipeline is nested too deeply');
  for (const stage of pipeline) {
    if (!isPlainObject(stage)) continue;
    for (const [op, body] of Object.entries(stage)) {
      visit(op, body);
      for (const nested of nestedPipelines(op, body)) walkStages(nested, visit, depth + 1);
    }
  }
}

/**
 * The first stage of a parsed pipeline (plain values, as parseQuery gives them) that is not a plain
 * read, looked for in $facet, $lookup.pipeline and $unionWith.pipeline too; undefined when there is none.
 */
export function notPlainReadStage(pipeline: unknown[]): string | undefined {
  let found: string | undefined;
  walkStages(pipeline, (op) => {
    if (found === undefined && NOT_PLAIN_READ_STAGES.has(op)) found = op;
  });
  return found;
}

/**
 * The collections a parsed pipeline reads besides its own: the `from` of $lookup and $graphLookup and
 * the collection of $unionWith, of the nested pipelines too.
 */
export function joinedCollections(pipeline: unknown[]): string[] {
  const names: string[] = [];
  const add = (v: unknown) => {
    if (typeof v === 'string') names.push(v);
    // The form { db, coll } that reads a collection of another database.
    else if (isPlainObject(v) && typeof v.coll === 'string') names.push(v.coll);
  };
  walkStages(pipeline, (op, body) => {
    if (op === '$unionWith') add(isPlainObject(body) ? body.coll : body);
    else if ((op === '$lookup' || op === '$graphLookup') && isPlainObject(body)) add(body.from);
  });
  return names;
}

/** Atlas Search stages: the server only takes them as the first stage of a pipeline. */
export const FIRST_STAGES = new Set(['$search', '$searchMeta', '$vectorSearch']);

/** Indexes of the enabled stages that must be first and aren't. */
export function misplacedFirstStages(stages: PipelineStage[]): number[] {
  const first = stages.findIndex((s) => s.enabled);
  return stages.flatMap((s, i) => (s.enabled && i !== first && FIRST_STAGES.has(s.op.trim()) ? [i] : []));
}

/** Parses a stage body; throws with a readable message. */
export function parseStageBody(stage: PipelineStage): unknown {
  if (!/^\$[A-Za-z]+$/.test(stage.op.trim())) throw new Error(`"${stage.op}" is not a stage operator (e.g. $match)`);
  if (!stage.body.trim()) throw new Error('The stage body is empty');
  return parseQuery(stage.body);
}

/** Whole pipeline as mongosh text: [ { $match: ... }, ... ]. Disabled stages are left out. */
export function pipelineToText(stages: PipelineStage[]): string {
  const parts = stages
    .filter((s) => s.enabled)
    .map((s) => {
      try {
        return `  ${prettyShell({ [s.op.trim()]: parseStageBody(s) }, 1)}`;
      } catch {
        return `  { ${s.op.trim()}: ${s.body.trim()} }`;
      }
    });
  return parts.length ? `[\n${parts.join(',\n')}\n]` : '[]';
}

/** Parses pipeline text ([ { $op: ... }, ... ] or a single stage object) into stages. */
export function textToPipeline(text: string): PipelineStage[] {
  if (!text.trim()) return [];
  const value = parseQuery(text);
  const list = Array.isArray(value) ? value : [value];
  return list.map((stage, i) => {
    const keys = isPlainObject(stage) ? Object.keys(stage) : [];
    if (keys.length !== 1 || !keys[0].startsWith('$')) {
      throw new Error(`Stage ${i + 1} must be an object with a single $operator key`);
    }
    return { op: keys[0], body: prettyShell((stage as Record<string, unknown>)[keys[0]], 0, 36), enabled: true };
  });
}

/** "$match → $group → $sort" */
export function summarizePipeline(stages: PipelineStage[]): string {
  return stages.filter((s) => s.enabled).map((s) => s.op).join(' → ') || 'empty pipeline';
}
