import { describe, expect, it } from 'vitest';
import {
  PipelineStage,
  STAGE_TEMPLATES,
  isWriteStage,
  parseStageBody,
  pipelineToText,
  summarizePipeline,
  textToPipeline,
} from '../../src/shared/pipeline';
import { parseQuery } from '../../src/shared/query';

const stage = (op: string, body: string, enabled = true): PipelineStage => ({ op, body, enabled });

describe('STAGE_TEMPLATES', () => {
  it('are all valid stage bodies', () => {
    for (const [op, body] of Object.entries(STAGE_TEMPLATES)) expect(() => parseStageBody(stage(op, body)), op).not.toThrow();
  });
});

describe('parseStageBody', () => {
  it('parses the body in mongosh syntax', () => {
    expect(parseStageBody(stage(' $match ', '{ _id: ObjectId("65a1b2c3d4e5f60718293a4b") }'))).toEqual({
      _id: { $oid: '65a1b2c3d4e5f60718293a4b' },
    });
    expect(parseStageBody(stage('$limit', '10'))).toBe(10);
  });

  it('rejects an operator that is not a stage operator', () => {
    expect(() => parseStageBody(stage('match', '{}'))).toThrow('is not a stage operator');
    expect(() => parseStageBody(stage('$ma tch', '{}'))).toThrow('is not a stage operator');
  });

  it('rejects an empty body', () => {
    expect(() => parseStageBody(stage('$match', '  \n'))).toThrow('The stage body is empty');
  });
});

describe('isWriteStage', () => {
  it('is true for enabled $out and $merge stages', () => {
    expect(isWriteStage(stage('$out', '"x"'))).toBe(true);
    expect(isWriteStage(stage(' $merge ', '{ into: "x" }'))).toBe(true);
    expect(isWriteStage(stage('$out', '"x"', false))).toBe(false);
    expect(isWriteStage(stage('$match', '{}'))).toBe(false);
  });
});

describe('pipelineToText', () => {
  it('writes the enabled stages as an array', () => {
    const text = pipelineToText([
      stage('$match', '{ status: "A" }'),
      stage('$sort', '{ n: -1 }', false),
      stage('$limit', '5'),
    ]);
    expect(parseQuery(text)).toEqual([{ $match: { status: 'A' } }, { $limit: 5 }]);
  });

  it('gives [] when no stage is enabled', () => {
    expect(pipelineToText([])).toBe('[]');
    expect(pipelineToText([stage('$match', '{}', false)])).toBe('[]');
  });

  it('keeps the text of a stage it cannot parse', () => {
    expect(pipelineToText([stage('$match', '{ a: ')])).toBe('[\n  { $match: { a: }\n]');
  });
});

describe('textToPipeline', () => {
  it('reads an array of stages', () => {
    const stages = textToPipeline('[ { $match: { a: 1 } }, { $group: { _id: "$a", n: { $sum: 1 } } }, { $limit: 3 } ]');
    expect(stages.map((s) => s.op)).toEqual(['$match', '$group', '$limit']);
    expect(stages.every((s) => s.enabled)).toBe(true);
    expect(stages.map(parseStageBody)).toEqual([{ a: 1 }, { _id: '$a', n: { $sum: 1 } }, 3]);
  });

  it('reads a single stage object, and nothing from empty text', () => {
    expect(textToPipeline('{ $count: "n" }')).toEqual([{ op: '$count', body: '"n"', enabled: true }]);
    expect(textToPipeline('  ')).toEqual([]);
  });

  it('rejects stages that are not one $operator', () => {
    expect(() => textToPipeline('[{ $match: {} }, { $sort: { a: 1 }, $limit: 1 }]')).toThrow('Stage 2 must be an object with a single $operator key');
    expect(() => textToPipeline('[{ match: {} }]')).toThrow('Stage 1');
    expect(() => textToPipeline('[5]')).toThrow('Stage 1');
  });

  it('round trips with pipelineToText, keeping BSON types', () => {
    const text = `[
      { $match: { _id: { $gt: ObjectId("65a1b2c3d4e5f60718293a4b") }, at: { $lt: ISODate("2024-01-01T00:00:00Z") }, name: /^a/i } },
      { $set: { big: NumberLong("9223372036854775807"), price: NumberDecimal("9.99") } },
      { $unwind: "$items" }
    ]`;
    const stages = textToPipeline(text);
    expect(parseQuery(pipelineToText(stages))).toEqual(parseQuery(text));
    expect(textToPipeline(pipelineToText(stages))).toEqual(stages);
  });
});

describe('summarizePipeline', () => {
  it('lists the enabled operators', () => {
    expect(summarizePipeline([stage('$match', '{}'), stage('$sort', '{}', false), stage('$group', '{}')])).toBe('$match → $group');
    expect(summarizePipeline([])).toBe('empty pipeline');
  });
});
