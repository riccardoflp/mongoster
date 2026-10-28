import { BSON, Decimal128, Long, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { DISTINCT_CAP, FieldSchema, SchemaSummary, TypeSchema, analyzeSchema, bsonType, toJsonSchema } from '../../src/shared/schema';

/** The documents as the extension host gives them: canonical Extended JSON. */
const canonical = (docs: object[]) => docs.map((d) => BSON.EJSON.serialize(d, { relaxed: false }));

const field = (fields: FieldSchema[] | undefined, name: string) => {
  const f = fields?.find((x) => x.name === name);
  if (!f) throw new Error(`no field ${name}`);
  return f;
};
const type = (f: FieldSchema, t: string): TypeSchema => {
  const s = f.types.find((x) => x.type === t);
  if (!s) throw new Error(`no type ${t} in ${f.path}`);
  return s;
};

describe('bsonType', () => {
  it('names plain and wrapped values', () => {
    expect(bsonType(null)).toBe('null');
    expect(bsonType('s')).toBe('string');
    expect(bsonType(1)).toBe('int');
    expect(bsonType(1.5)).toBe('double');
    expect(bsonType(true)).toBe('bool');
    expect(bsonType([])).toBe('array');
    expect(bsonType({ a: 1 })).toBe('object');
    expect(bsonType({ $oid: '64b000000000000000000001' })).toBe('objectId');
    expect(bsonType({ $date: { $numberLong: '0' } })).toBe('date');
    expect(bsonType({ $numberLong: '5' })).toBe('long');
    expect(bsonType({ $numberDecimal: '5' })).toBe('decimal');
    expect(bsonType({ $uuid: '00000000-0000-0000-0000-000000000000' })).toBe('binData');
    expect(bsonType({ $regularExpression: { pattern: 'a', options: '' } })).toBe('regex');
    // An operator-like object that is not an EJSON wrapper is an object.
    expect(bsonType({ $gt: 1 })).toBe('object');
  });
});

describe('analyzeSchema', () => {
  it('counts presence per field against the number of documents', () => {
    const s = analyzeSchema(canonical([{ a: 1, b: 'x' }, { a: 2 }, { a: null }]));
    expect(s.sampled).toBe(3);
    expect(field(s.fields, 'a')).toMatchObject({ path: 'a', label: 'a', count: 3, of: 3 });
    expect(field(s.fields, 'b')).toMatchObject({ count: 1, of: 3 });
  });

  it('ignores values that are not documents', () => {
    const s = analyzeSchema([1, 'x', null, [{ a: 1 }], { a: 1 }]);
    expect(s.sampled).toBe(1);
  });

  it('lists mixed types most frequent first, with BSON types kept apart', () => {
    const s = analyzeSchema(
      canonical([{ v: 1 }, { v: 2 }, { v: 'x' }, { v: 2.5 }, { v: Long.fromNumber(3) }, { v: Decimal128.fromString('1.1') }, { v: 4 }]),
    );
    const v = field(s.fields, 'v');
    expect(v.types[0]).toMatchObject({ type: 'int', count: 3 });
    expect(v.types.map((t) => t.type).sort()).toEqual(['decimal', 'double', 'int', 'long', 'string']);
  });

  it('gives top values with counts, min and max as relaxed EJSON', () => {
    const id = new ObjectId('64b000000000000000000001');
    const s = analyzeSchema(
      canonical([
        { status: 'a', n: 5, when: new Date('2024-01-01T00:00:00Z'), id },
        { status: 'b', n: 1, when: new Date('2023-01-01T00:00:00Z'), id },
        { status: 'a', n: 3, when: new Date('2025-01-01T00:00:00Z') },
      ]),
    );
    const status = type(field(s.fields, 'status'), 'string');
    expect(status.top).toEqual([
      { value: 'a', count: 2 },
      { value: 'b', count: 1 },
    ]);
    expect(status.distinct).toBe(2);
    const n = type(field(s.fields, 'n'), 'int');
    expect(n).toMatchObject({ min: 1, max: 5 });
    const when = type(field(s.fields, 'when'), 'date');
    expect(when.min).toEqual({ $date: '2023-01-01T00:00:00.000Z' });
    expect(when.max).toEqual({ $date: '2025-01-01T00:00:00.000Z' });
    expect(type(field(s.fields, 'id'), 'objectId').top).toEqual([{ value: { $oid: id.toHexString() }, count: 2 }]);
  });

  it('makes a histogram with round boundaries for numbers with many distinct values', () => {
    const s = analyzeSchema(canonical(Array.from({ length: 100 }, (_, i) => ({ n: i }))));
    const n = type(field(s.fields, 'n'), 'int');
    expect(n.top).toBeUndefined();
    expect(n.bins).toHaveLength(10);
    expect(n.bins![0]).toEqual({ from: 0, to: 10, count: 10 });
    expect(n.bins![9]).toEqual({ from: 90, to: 100, count: 10 });
    expect(n.bins!.reduce((a, b) => a + b.count, 0)).toBe(100);
  });

  it('uses dates as bin boundaries for date histograms', () => {
    const start = Date.UTC(2024, 0, 1);
    const s = analyzeSchema(canonical(Array.from({ length: 30 }, (_, i) => ({ d: new Date(start + i * 86400e3) }))));
    const bins = type(field(s.fields, 'd'), 'date').bins!;
    expect(bins.length).toBeGreaterThan(1);
    const ms = (v: unknown) => Date.parse((v as { $date: string }).$date);
    // Boundaries are multiples of a round step (7 days here, from the epoch): the first bin holds the minimum.
    expect(ms(bins[0].from)).toBeLessThanOrEqual(start);
    expect(ms(bins[0].to)).toBeGreaterThan(start);
    expect(ms(bins[0].to) - ms(bins[0].from)).toBe(7 * 86400e3);
    expect(bins.reduce((a, b) => a + b.count, 0)).toBe(30);
    // Contiguous: each bin starts where the previous one ends.
    for (let i = 1; i < bins.length; i++) expect(bins[i].from).toEqual(bins[i - 1].to);
  });

  it('caps the distinct values it tracks', () => {
    const s = analyzeSchema(canonical(Array.from({ length: DISTINCT_CAP + 5 }, (_, i) => ({ s: `v${i}` }))));
    const t = type(field(s.fields, 's'), 'string');
    expect(t.distinct).toBe(DISTINCT_CAP);
    expect(t.distinctCapped).toBe(true);
  });

  it('merges the fields of sub-documents, relative to the objects that have them', () => {
    const s = analyzeSchema(canonical([{ a: { b: 1, c: 'x' } }, { a: { b: 2 } }, { a: 'scalar' }]));
    const a = field(s.fields, 'a');
    expect(a.types.map((t) => t.type)).toEqual(['object', 'string']);
    const b = field(a.fields, 'b');
    expect(b).toMatchObject({ path: 'a.b', label: 'a.b', count: 2, of: 2 });
    expect(field(a.fields, 'c')).toMatchObject({ count: 1, of: 2 });
  });

  it('describes arrays: lengths and their elements as a field', () => {
    const s = analyzeSchema(canonical([{ items: [{ sku: 'x' }, { sku: 'y', qty: 1 }] }, { items: [] }, { items: [{ sku: 'z' }, 3] }]));
    const arr = type(field(s.fields, 'items'), 'array');
    expect(arr.lengths).toEqual({ min: 0, max: 2, avg: 1.3 });
    const elements = arr.elements!;
    expect(elements).toMatchObject({ name: '[]', path: 'items', label: 'items[]', count: 4, of: 3 });
    expect(elements.types.map((t) => t.type)).toEqual(['object', 'int']);
    expect(field(elements.fields, 'sku')).toMatchObject({ path: 'items.sku', label: 'items[].sku', count: 3, of: 3 });
    expect(field(elements.fields, 'qty')).toMatchObject({ count: 1, of: 3 });
  });

  it('leaves out elements of arrays that are always empty', () => {
    const s = analyzeSchema(canonical([{ a: [] }]));
    expect(type(field(s.fields, 'a'), 'array').elements).toBeUndefined();
  });
});

describe('toJsonSchema', () => {
  const summary = (docs: object[]): SchemaSummary => analyzeSchema(canonical(docs));

  it('requires the fields present in every document and lists their types', () => {
    const schema = toJsonSchema(summary([{ _id: 1, name: 'a', age: 3 }, { _id: 2, name: 'b', age: 'x' }, { _id: 3, name: null }]));
    expect(schema).toEqual({
      bsonType: 'object',
      required: ['_id', 'name'],
      properties: {
        _id: { bsonType: 'int' },
        name: { bsonType: ['string', 'null'] },
        age: { bsonType: ['int', 'string'] },
      },
    });
  });

  it('describes nested objects and array elements', () => {
    const schema = toJsonSchema(summary([{ a: { b: 1, c: true }, tags: ['x'] }, { a: { b: 2 }, tags: [] }]));
    expect(schema.properties).toEqual({
      a: { bsonType: 'object', required: ['b'], properties: { b: { bsonType: 'int' }, c: { bsonType: 'bool' } } },
      tags: { bsonType: 'array', items: { bsonType: 'string' } },
    });
  });

  it('has no required list when no field is always present', () => {
    const schema = toJsonSchema(summary([{ a: 1 }, { b: 1 }]));
    expect(schema).not.toHaveProperty('required');
  });

  it('describes objects inside arrays', () => {
    const schema = toJsonSchema(summary([{ items: [{ sku: 'x', qty: 1 }, { sku: 'y' }] }]));
    expect(schema.properties).toEqual({
      items: {
        bsonType: 'array',
        items: { bsonType: 'object', required: ['sku'], properties: { sku: { bsonType: 'string' }, qty: { bsonType: 'int' } } },
      },
    });
  });
});
