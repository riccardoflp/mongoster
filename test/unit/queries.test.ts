import { describe, expect, it } from 'vitest';
import { BSON } from 'mongodb';
import { StageError, buildPipeline, fromRelaxed, toBson, toUpdate } from '../../src/queries';
import type { PipelineStage } from '../../src/shared/pipeline';

const OID = '65a1b2c3d4e5f60718293a4b';
const stage = (op: string, body: string, enabled = true): PipelineStage => ({ op, body, enabled });

describe('toBson', () => {
  it('gives undefined for empty text', () => {
    expect(toBson('', 'Filter')).toBeUndefined();
    expect(toBson(' \n ', 'Filter')).toBeUndefined();
  });

  it('keeps the BSON types exact', () => {
    const doc = toBson(
      `{ _id: ObjectId("${OID}"), big: NumberLong("9223372036854775807"), small: NumberLong(5), price: NumberDecimal("0.1"),
         at: ISODate("2024-03-01T10:20:30.123Z"), re: /a.c/i, n: 5, f: 1.5, u: UUID("01234567-89ab-cdef-0123-456789abcdef") }`,
      'Filter',
    )!;
    expect(doc._id).toBeInstanceOf(BSON.ObjectId);
    expect(doc._id.toHexString()).toBe(OID);
    expect(doc.big).toBeInstanceOf(BSON.Long);
    expect(doc.big.toString()).toBe('9223372036854775807');
    expect(doc.small).toBeInstanceOf(BSON.Long);
    expect(doc.price).toBeInstanceOf(BSON.Decimal128);
    expect(doc.price.toString()).toBe('0.1');
    expect(doc.at).toBeInstanceOf(Date);
    expect(doc.at.toISOString()).toBe('2024-03-01T10:20:30.123Z');
    expect(doc.re).toBeInstanceOf(BSON.BSONRegExp);
    expect(doc.re.pattern).toBe('a.c');
    expect(doc.re.options).toBe('i');
    expect(doc.n).toBeInstanceOf(BSON.Int32);
    expect(doc.f).toBeInstanceOf(BSON.Double);
    expect(doc.u).toBeInstanceOf(BSON.Binary);
    expect(doc.u.sub_type).toBe(4);
  });

  it('serializes to the same bytes as the driver values', () => {
    const doc = toBson('{ n: NumberLong("-9223372036854775808"), d: NumberDecimal("1E+6144") }', 'Filter')!;
    expect(BSON.serialize(doc)).toEqual(
      BSON.serialize({ n: BSON.Long.fromString('-9223372036854775808'), d: BSON.Decimal128.fromString('1E+6144') }),
    );
  });

  it('prefixes errors with the label', () => {
    expect(() => toBson('{ a: ', 'Projection')).toThrow(/^Projection: /);
    expect(() => toBson('[1, 2]', 'Sort')).toThrow('Sort must be an object');
    expect(() => toBson('5', 'Filter')).toThrow('Filter must be an object');
  });
});

describe('fromRelaxed', () => {
  it('turns relaxed EJSON values into BSON values', () => {
    expect(fromRelaxed({ $oid: OID })).toBeInstanceOf(BSON.ObjectId);
    expect(fromRelaxed([{ $numberLong: '1' }])).toEqual([BSON.Long.fromNumber(1)]);
    expect(fromRelaxed('x')).toBe('x');
  });
});

describe('toUpdate', () => {
  it('accepts update operators and keeps their types', () => {
    const update = toUpdate('{ $set: { n: NumberLong("9007199254740993") }, $inc: { c: 1 } }') as BSON.Document;
    expect(update.$set.n).toBeInstanceOf(BSON.Long);
    expect(update.$set.n.toString()).toBe('9007199254740993');
    expect(Object.keys(update)).toEqual(['$set', '$inc']);
  });

  it('accepts an update pipeline', () => {
    const update = toUpdate('[ { $set: { a: 1 } }, { $unset: "b" } ]');
    expect(Array.isArray(update)).toBe(true);
    expect(update).toHaveLength(2);
  });

  it('rejects what is not an update', () => {
    expect(() => toUpdate('')).toThrow('Update: enter the changes');
    expect(() => toUpdate('{ a: 1 }')).toThrow('a plain document would replace whole documents');
    expect(() => toUpdate('{ $set: { a: 1 }, b: 2 }')).toThrow('use update operators');
    expect(() => toUpdate('{}')).toThrow('use update operators');
    expect(() => toUpdate('[]')).toThrow('a pipeline is a list of stages');
    expect(() => toUpdate('[{ $set: { a: 1 } }, { a: 1 }]')).toThrow('a pipeline is a list of stages');
    expect(() => toUpdate('{ $set: ')).toThrow(/^Update: /);
  });
});

describe('buildPipeline', () => {
  const stages = [
    stage('$match', `{ _id: { $gt: ObjectId("${OID}") } }`),
    stage('$sort', '{ n: -1 }', false),
    stage('$set', '{ big: NumberLong("9223372036854775807") }'),
    stage('$limit', '5'),
  ];

  it('builds the enabled stages up to `upto`, with BSON values', () => {
    const { pipeline, write } = buildPipeline(stages, 3);
    expect(pipeline.map((s) => Object.keys(s)[0])).toEqual(['$match', '$set', '$limit']);
    expect(pipeline[0].$match._id.$gt).toBeInstanceOf(BSON.ObjectId);
    expect(pipeline[1].$set.big).toBeInstanceOf(BSON.Long);
    expect(write).toBeUndefined();

    expect(buildPipeline(stages, 1).pipeline.map((s) => Object.keys(s)[0])).toEqual(['$match']);
    expect(buildPipeline(stages, 0).pipeline).toHaveLength(1);
  });

  it('trims the operator', () => {
    expect(buildPipeline([stage(' $limit ', '1')], 0).pipeline).toEqual([{ $limit: new BSON.Int32(1) }]);
  });

  it('reports a stage that does not parse with its index in the editor', () => {
    const broken = [stage('$match', '{}'), stage('$sort', '{', false), stage('$project', '{ a: ')];
    let error: unknown;
    try {
      buildPipeline(broken, 2);
    } catch (err) {
      error = err;
    }
    expect(error).toBeInstanceOf(StageError);
    expect((error as StageError).stage).toBe(2);
    expect((error as StageError).message).toMatch(/^Stage 3 \(\$project\): /);
    // A disabled stage that doesn't parse is not an error.
    expect(() => buildPipeline(broken, 1)).not.toThrow();
  });

  it('returns the final write stage', () => {
    const { pipeline, write } = buildPipeline([stage('$match', '{}'), stage('$out', '"archive"')], 1);
    expect(pipeline).toEqual([{ $match: {} }, { $out: 'archive' }]);
    expect(write?.op).toBe('$out');
  });

  it('requires $out and $merge to be the last stage', () => {
    const list = [stage('$match', '{}'), stage('$merge', '{ into: "x" }'), stage('$limit', '1')];
    expect(() => buildPipeline(list, 2)).toThrow('$merge must be the last stage of the pipeline');
    try {
      buildPipeline(list, 2);
    } catch (err) {
      expect((err as StageError).stage).toBe(1);
    }
    // Running only up to the $merge, or with the following stage disabled, is fine.
    expect(buildPipeline(list, 1).write?.op).toBe('$merge');
    expect(buildPipeline([...list.slice(0, 2), stage('$limit', '1', false)], 2).write?.op).toBe('$merge');
    // A disabled $out in the middle doesn't count.
    expect(buildPipeline([stage('$out', '"x"', false), stage('$limit', '1')], 1).write).toBeUndefined();
  });
});
