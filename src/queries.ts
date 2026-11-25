// Turning the webview's query texts into driver arguments, shared by the panel and the exporter.
import { BSON, CollationOptions, Document } from 'mongodb';
import { errorMessage } from './tree';
import { isPlainObject, parseQuery } from './shared/query';
import { PipelineStage, isWriteStage, misplacedFirstStages, parseStageBody } from './shared/pipeline';
import type { FindExtras } from './shared/messages';
export type { QuerySource } from './shared/messages';

const { EJSON } = BSON;

/** An error in one stage of a pipeline; `stage` is its index in the editor. */
export class StageError extends Error {
  constructor(
    message: string,
    readonly stage: number,
  ) {
    super(message);
  }
}

/** Relaxed EJSON plain value from the webview -> BSON value. */
export function fromRelaxed(value: unknown): unknown {
  return EJSON.deserialize({ v: value } as Document, { relaxed: false }).v;
}

export function toBson(text: string, label: string): Document | undefined {
  if (!text.trim()) return undefined;
  let value: unknown;
  try {
    value = parseQuery(text);
  } catch (err) {
    throw new Error(`${label}: ${errorMessage(err)}`);
  }
  if (!isPlainObject(value)) throw new Error(`${label} must be an object`);
  // Non-relaxed keeps NumberLong/NumberDecimal exact instead of collapsing them to JS numbers.
  return EJSON.deserialize(value, { relaxed: false }) as Document;
}

/** The collation of a find: a document with at least a `locale`. */
export function toCollation(text: string | undefined): CollationOptions | undefined {
  const collation = toBson(text ?? '', 'Collation');
  if (collation && typeof collation.locale !== 'string') throw new Error('Collation needs a locale, e.g. { locale: "en", strength: 2 }');
  return collation as CollationOptions | undefined;
}

/** The hint of a find: the keys of an index (`{ status: 1 }`) or its name, quoted or not (`status_1`). */
export function toHint(text: string | undefined): string | Document | undefined {
  const trimmed = (text ?? '').trim();
  if (!trimmed) return undefined;
  if (trimmed.startsWith('{')) return toBson(trimmed, 'Hint');
  if (!/^["'`]/.test(trimmed)) return trimmed;
  let name: unknown;
  try {
    name = parseQuery(trimmed);
  } catch (err) {
    throw new Error(`Hint: ${errorMessage(err)}`);
  }
  if (typeof name !== 'string' || !name) throw new Error('Hint must be the name of an index or its keys, e.g. { status: 1 }');
  return name;
}

/** Sort, projection, collation and hint of a find as driver options; the ones not given are left out. */
export function findOptions(q: { sort: string; projection: string } & FindExtras): { sort?: Document; projection?: Document; collation?: CollationOptions; hint?: string | Document } {
  const options = {
    sort: toBson(q.sort, 'Sort'),
    projection: toBson(q.projection, 'Projection'),
    collation: toCollation(q.collation),
    hint: toHint(q.hint),
  };
  return Object.fromEntries(Object.entries(options).filter(([, v]) => v !== undefined));
}

/** The changes of "Update many": update operators (`{ $set: … }`) or an update pipeline (`[ { $set: … } ]`). */
export function toUpdate(text: string): Document | Document[] {
  if (!text.trim()) throw new Error('Update: enter the changes, e.g. { $set: { field: "value" } }');
  let value: unknown;
  try {
    value = parseQuery(text);
  } catch (err) {
    throw new Error(`Update: ${errorMessage(err)}`);
  }
  const operators = (v: unknown) => isPlainObject(v) && Object.keys(v).length > 0 && Object.keys(v).every((k) => k.startsWith('$'));
  if (Array.isArray(value)) {
    if (!value.length || !value.every(operators)) throw new Error('Update: a pipeline is a list of stages like { $set: { … } }');
  } else if (!operators(value)) {
    throw new Error('Update: use update operators like { $set: { field: "value" } } (a plain document would replace whole documents)');
  }
  return fromRelaxed(value) as Document | Document[];
}

/** The enabled stages up to `upto` as a driver pipeline; `write` is its final $out/$merge stage, if any. */
export function buildPipeline(stages: PipelineStage[], upto: number): { pipeline: Document[]; write?: PipelineStage } {
  const active = stages
    .slice(0, upto + 1)
    .map((stage, index) => ({ stage, index }))
    .filter(({ stage }) => stage.enabled);

  const pipeline: Document[] = [];
  for (const { stage, index } of active) {
    try {
      pipeline.push({ [stage.op.trim()]: fromRelaxed(parseStageBody(stage)) });
    } catch (err) {
      throw new StageError(`Stage ${index + 1} (${stage.op}): ${errorMessage(err)}`, index);
    }
  }
  const [notFirst] = misplacedFirstStages(stages.slice(0, upto + 1));
  if (notFirst !== undefined) throw new StageError(`${stages[notFirst].op.trim()} must be the first stage of the pipeline`, notFirst);
  const writes = active.filter(({ stage }) => isWriteStage(stage));
  const misplaced = writes.find((w) => w !== active[active.length - 1]);
  if (misplaced) throw new StageError(`${misplaced.stage.op} must be the last stage of the pipeline`, misplaced.index);
  return { pipeline, write: writes[0]?.stage };
}
