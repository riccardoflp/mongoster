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
  $out: '"outputCollection"',
  $merge: '{\n  into: "outputCollection"\n}',
};

/** Stages that write to the database. */
export const WRITE_STAGES = new Set(['$out', '$merge']);

export function isWriteStage(stage: PipelineStage): boolean {
  return stage.enabled && WRITE_STAGES.has(stage.op.trim());
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
