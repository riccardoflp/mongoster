// Turning the webview's query texts into driver arguments, shared by the panel and the exporter.
import { BSON, Document } from 'mongodb';
import { errorMessage } from './tree';
import { isPlainObject, parseQuery } from './shared/query';
import { PipelineStage, isWriteStage, parseStageBody } from './shared/pipeline';
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
  const writes = active.filter(({ stage }) => isWriteStage(stage));
  const misplaced = writes.find((w) => w !== active[active.length - 1]);
  if (misplaced) throw new StageError(`${misplaced.stage.op} must be the last stage of the pipeline`, misplaced.index);
  return { pipeline, write: writes[0]?.stage };
}
