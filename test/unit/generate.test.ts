import { BSON, Decimal128, Double, Int32, Long, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { DocumentGenerator, generateDocuments, seededRandom } from '../../src/shared/generate';
import { FieldSchema, SchemaSummary, TypeSchema, analyzeSchema } from '../../src/shared/schema';

/** The documents as the extension host gives them: canonical Extended JSON. */
const canonical = (docs: object[]) => docs.map((d) => BSON.EJSON.serialize(d, { relaxed: false }));
/** Canonical EJSON back to BSON values (Int32, Long, Double…). */
const bson = (doc: unknown) => BSON.EJSON.deserialize(doc as BSON.Document, { relaxed: false });

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
const presence = (f: FieldSchema) => f.count / f.of;
const share = (f: FieldSchema, t: string) => (f.types.find((x) => x.type === t)?.count ?? 0) / f.count;
const NOW = Date.UTC(2026, 0, 15, 12, 0, 0);
const DAY = 86_400_000;

/** 1000 documents with a known mix of fields, types and values (deterministic, no randomness). */
function sampleDocs(): object[] {
  const docs: object[] = [];
  for (let i = 0; i < 1000; i++) {
    const doc: Record<string, unknown> = {
      _id: ObjectId.createFromTime(1_700_000_000 + i * 60),
      status: i % 10 < 6 ? 'active' : i % 10 < 9 ? 'pending' : 'closed',
      score: new Double(Math.round(((i * 37) % 1000) / 10) / 10 + 0.25),
      balance: Long.fromNumber(1_000_000 + ((i * 7919) % 50_000)),
      price: Decimal128.fromString(`${(i * 13) % 500}.${String(i % 100).padStart(2, '0')}`),
      createdAt: new Date(Date.UTC(2024, 0, 1) + ((i * 7) % 365) * DAY + (i % 86) * 1000),
      day: new Date(Date.UTC(2024, 0, 1) + (i % 200) * DAY),
      ownerId: ObjectId.createFromTime(1_650_000_000 + ((i * 101) % 997) * 3600),
      email: `user${i}@example.org`,
      tags: Array.from({ length: i % 4 }, (_, k) => ['red', 'green', 'blue'][(i + k) % 3]),
      mixed: i % 10 < 7 ? new Int32(i) : `m${i}`,
      maybe: i % 5 < 2 ? null : `text ${i}`,
    };
    if (i % 5 !== 0) doc.age = new Int32(18 + ((i * 17) % 63));
    if (i % 2 === 0) doc.address = { city: ['Rome', 'Milan', 'Turin'][i % 3], zip: `${10000 + i}` };
    docs.push(doc);
  }
  return docs;
}

const schema = analyzeSchema(canonical(sampleDocs()), { details: true });

describe('seededRandom', () => {
  it('gives the same numbers for the same seed, in [0, 1)', () => {
    const a = seededRandom('seed');
    const b = seededRandom('seed');
    const xs = Array.from({ length: 1000 }, () => a());
    expect(Array.from({ length: 1000 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
    // Spread over the interval, not stuck.
    expect(new Set(xs).size).toBeGreaterThan(990);
    const mean = xs.reduce((s, x) => s + x, 0) / xs.length;
    expect(mean).toBeGreaterThan(0.45);
    expect(mean).toBeLessThan(0.55);
  });

  it('gives other numbers for another seed, and numbers and strings alike', () => {
    const first = (seed: string | number) => Array.from({ length: 5 }, seededRandom(seed));
    expect(first('a')).not.toEqual(first('b'));
    expect(first(42)).toEqual(first('42'));
  });
});

describe('generateDocuments: reproducibility', () => {
  it('gives the same documents for the same seed and time', () => {
    const run = (seed: string) => generateDocuments(schema, 50, { random: seededRandom(seed), now: NOW });
    expect(run('x')).toEqual(run('x'));
    expect(run('x')).not.toEqual(run('y'));
  });

  it('streams the same documents as generateDocuments', () => {
    const gen = new DocumentGenerator(schema, { random: seededRandom(7), now: NOW });
    const streamed = Array.from({ length: 20 }, () => gen.next());
    expect(streamed).toEqual(generateDocuments(schema, 20, { random: seededRandom(7), now: NOW }));
  });

  it('gives as many documents as asked', () => {
    expect(generateDocuments(schema, 0)).toEqual([]);
    expect(generateDocuments(schema, 3)).toHaveLength(3);
  });
});

describe('generateDocuments: documents like the analyzed ones', () => {
  const N = 4000;
  const generated = generateDocuments(schema, N, { random: seededRandom('proportions'), now: NOW });
  const again = analyzeSchema(generated, { details: true });

  it('produces valid canonical Extended JSON', () => {
    for (const d of generated.slice(0, 200)) expect(() => bson(d)).not.toThrow();
    expect(again.sampled).toBe(N);
  });

  it('keeps the fields, each present about as often as in the analysis', () => {
    expect(again.fields.map((f) => f.name).sort()).toEqual(schema.fields.map((f) => f.name).sort());
    for (const f of schema.fields) {
      expect(presence(field(again.fields, f.name)), f.name).toBeCloseTo(presence(f), 1);
    }
    expect(presence(field(again.fields, 'age'))).toBeGreaterThan(0.75);
    expect(presence(field(again.fields, 'age'))).toBeLessThan(0.85);
    expect(presence(field(again.fields, 'address'))).toBeGreaterThan(0.45);
    expect(presence(field(again.fields, 'address'))).toBeLessThan(0.55);
    // Nested fields too, against their parent objects.
    const city = field(field(again.fields, 'address').fields, 'city');
    expect(presence(city)).toBe(1);
  });

  it('keeps the BSON types of the values', () => {
    const expected: Record<string, string> = {
      _id: 'objectId',
      status: 'string',
      score: 'double',
      balance: 'long',
      price: 'decimal',
      createdAt: 'date',
      ownerId: 'objectId',
      email: 'string',
      tags: 'array',
      age: 'int',
      address: 'object',
    };
    for (const [name, t] of Object.entries(expected)) expect(field(again.fields, name).types.map((x) => x.type), name).toEqual([t]);
    const d = bson(generated.find((x) => 'age' in x)!);
    expect(d._id).toBeInstanceOf(ObjectId);
    expect(d.score).toBeInstanceOf(Double);
    expect(d.balance).toBeInstanceOf(Long);
    expect(d.price).toBeInstanceOf(Decimal128);
    expect(d.createdAt).toBeInstanceOf(Date);
    expect(d.ownerId).toBeInstanceOf(ObjectId);
    expect(d.age).toBeInstanceOf(Int32);
  });

  it('mixes the types of a field in the same proportions', () => {
    const mixed = field(again.fields, 'mixed');
    expect(share(mixed, 'int')).toBeGreaterThan(0.65);
    expect(share(mixed, 'int')).toBeLessThan(0.75);
    expect(share(mixed, 'string')).toBeCloseTo(1 - share(mixed, 'int'), 10);
    const maybe = field(again.fields, 'maybe');
    expect(share(maybe, 'null')).toBeGreaterThan(0.35);
    expect(share(maybe, 'null')).toBeLessThan(0.45);
  });

  it('re-samples the values of a field with few of them, as often as seen', () => {
    const status = type(field(again.fields, 'status'), 'string');
    const counts = Object.fromEntries((status.details?.values ?? []).map((v) => [v.value, v.count / status.count]));
    expect(Object.keys(counts).sort()).toEqual(['active', 'closed', 'pending']);
    expect(counts.active).toBeCloseTo(0.6, 1);
    expect(counts.pending).toBeCloseTo(0.3, 1);
    expect(counts.closed).toBeCloseTo(0.1, 1);
    const cities = type(field(field(again.fields, 'address').fields, 'city'), 'string').details?.values?.map((v) => v.value);
    expect(cities?.sort()).toEqual(['Milan', 'Rome', 'Turin']);
    const tags = type(field(again.fields, 'tags'), 'array').elements!;
    expect(type(tags, 'string').details?.values?.map((v) => v.value).sort()).toEqual(['blue', 'green', 'red']);
  });

  it('draws numbers and dates within the observed ranges, with integers kept integers', () => {
    const within = (name: string, t: string) => {
      const before = type(field(schema.fields, name), t);
      const after = type(field(again.fields, name), t);
      const n = (v: unknown) => (typeof v === 'number' ? v : Number(Object.values(v as object)[0]));
      expect(n(after.min), `${name} min`).toBeGreaterThanOrEqual(n(before.min));
      expect(n(after.max), `${name} max`).toBeLessThanOrEqual(n(before.max));
      // Many different values, not a handful.
      expect(after.distinct, `${name} distinct`).toBeGreaterThan(40);
    };
    within('age', 'int');
    within('balance', 'long');
    within('score', 'double');
    within('price', 'decimal');
    const dates = generated.map((d) => d.createdAt as { $date: { $numberLong: string } }).filter(Boolean).map((d) => Number(d.$date.$numberLong));
    const before = type(field(schema.fields, 'createdAt'), 'date');
    expect(Math.min(...dates)).toBeGreaterThanOrEqual(Date.parse((before.min as { $date: string }).$date));
    expect(Math.max(...dates)).toBeLessThanOrEqual(Date.parse((before.max as { $date: string }).$date));
    // The average stays close to the original one: the histogram is followed.
    const avg = (xs: number[]) => xs.reduce((s, x) => s + x, 0) / xs.length;
    const ages = (docs: unknown[]) => docs.flatMap((d) => ((d as { age?: { $numberInt: string } }).age ? [Number((d as { age: { $numberInt: string } }).age.$numberInt)] : []));
    expect(avg(ages(generated))).toBeGreaterThan(avg(ages(canonical(sampleDocs()))) - 3);
    expect(avg(ages(generated))).toBeLessThan(avg(ages(canonical(sampleDocs()))) + 3);
  });

  it('keeps the decimals of doubles and decimals, and dates at midnight when they all were', () => {
    expect(type(field(again.fields, 'score'), 'double').details?.decimals).toBeLessThanOrEqual(2);
    for (const d of generated.slice(0, 300)) {
      const price = (d.price as { $numberDecimal: string }).$numberDecimal;
      expect(price).toMatch(/^\d+\.\d{2}$/);
    }
    expect(type(field(again.fields, 'day'), 'date').details?.dateOnly).toBe(true);
    expect(type(field(again.fields, 'createdAt'), 'date').details?.dateOnly).toBe(false);
  });

  it('follows the lengths of the arrays', () => {
    const before = type(field(schema.fields, 'tags'), 'array');
    const after = type(field(again.fields, 'tags'), 'array');
    expect(after.lengths).toMatchObject({ min: before.lengths!.min, max: before.lengths!.max });
    expect(after.lengths!.avg).toBeCloseTo(before.lengths!.avg, 0);
  });

  it('makes strings shaped like the examples', () => {
    for (const d of generated.slice(0, 200)) expect(d.email).toMatch(/^[^@\s]+@example\.org$/);
  });

  it('creates referenced ObjectIds within the time span of those seen', () => {
    const owner = type(field(schema.fields, 'ownerId'), 'objectId');
    const seconds = (owner.details?.values ?? owner.top ?? []).map((v) => parseInt((v.value as { $oid: string }).$oid.slice(0, 8), 16));
    const [from, to] = [Math.min(...seconds), Math.max(...seconds)];
    for (const d of generated.slice(0, 300)) {
      const t = parseInt((d.ownerId as { $oid: string }).$oid.slice(0, 8), 16);
      expect(t).toBeGreaterThanOrEqual(from);
      expect(t).toBeLessThanOrEqual(to);
    }
  });
});

describe('generateDocuments: _id', () => {
  it('gives new ObjectIds created now, all different', () => {
    const docs = generateDocuments(schema, 500, { random: seededRandom(1), now: NOW });
    const ids = docs.map((d) => (d._id as { $oid: string }).$oid);
    expect(new Set(ids).size).toBe(500);
    for (const id of ids) {
      expect(id).toMatch(/^[0-9a-f]{24}$/);
      expect(parseInt(id.slice(0, 8), 16)).toBe(NOW / 1000);
    }
  });

  it('continues integer _ids after the largest one, or from nextId', () => {
    const ints = analyzeSchema(canonical([{ _id: 1, a: 1 }, { _id: 7, a: 2 }, { _id: 3, a: 3 }]), { details: true });
    expect(generateDocuments(ints, 3, { random: seededRandom(1) }).map((d) => d._id)).toEqual([
      { $numberInt: '8' },
      { $numberInt: '9' },
      { $numberInt: '10' },
    ]);
    expect(generateDocuments(ints, 2, { random: seededRandom(1), nextId: 100 }).map((d) => d._id)).toEqual([{ $numberInt: '100' }, { $numberInt: '101' }]);
    // Past the 32-bit range an int _id becomes a long.
    expect(generateDocuments(ints, 1, { random: seededRandom(1), nextId: 2 ** 31 })[0]._id).toEqual({ $numberLong: String(2 ** 31) });
    const longs = analyzeSchema(canonical([{ _id: Long.fromNumber(41) }, { _id: Long.fromNumber(5) }]), { details: true });
    expect(generateDocuments(longs, 2).map((d) => d._id)).toEqual([{ $numberLong: '42' }, { $numberLong: '43' }]);
  });

  it('gives string _ids that do not repeat, shaped like the ones seen', () => {
    const strings = analyzeSchema(
      canonical(Array.from({ length: 50 }, (_, i) => ({ _id: `ORD-${String(1000 + i * 7)}`, n: i }))),
      { details: true },
    );
    const ids = generateDocuments(strings, 300, { random: seededRandom(3) }).map((d) => d._id as string);
    expect(new Set(ids).size).toBe(300);
    for (const id of ids) expect(id).toMatch(/^ORD-\d{4}$/);
  });

  it('gives UUID _ids as UUIDs', () => {
    const uuids = analyzeSchema(canonical(Array.from({ length: 20 }, () => ({ _id: new BSON.UUID() }))), { details: true });
    const docs = generateDocuments(uuids, 50, { random: seededRandom(5) });
    for (const d of docs) {
      const id = bson(d)._id;
      expect(id).toBeInstanceOf(BSON.Binary);
      expect((id as BSON.Binary).sub_type).toBe(4);
      expect((id as BSON.Binary).toUUID().toHexString()).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
    }
  });
});

describe('generateDocuments: empty and minimal schemas', () => {
  it('gives documents with only an ObjectId _id for an empty analysis', () => {
    const empty: SchemaSummary = analyzeSchema([], { details: true });
    expect(empty.fields).toEqual([]);
    const docs = generateDocuments(empty, 5, { random: seededRandom(1), now: NOW });
    for (const d of docs) {
      expect(Object.keys(d)).toEqual(['_id']);
      expect((d._id as { $oid: string }).$oid).toMatch(/^[0-9a-f]{24}$/);
    }
  });

  it('works on an analysis without details', () => {
    const plain = analyzeSchema(canonical(sampleDocs().slice(0, 100)));
    const docs = generateDocuments(plain, 200, { random: seededRandom(2), now: NOW });
    const again = analyzeSchema(docs);
    expect(field(again.fields, 'age').types.map((t) => t.type)).toEqual(['int']);
    expect(field(again.fields, 'status').types.map((t) => t.type)).toEqual(['string']);
  });

  it('copies a field with a single value, and empty objects and arrays', () => {
    const one = analyzeSchema(canonical([{ kind: 'x', meta: {}, list: [] }, { kind: 'x', meta: {}, list: [] }]), { details: true });
    const docs = generateDocuments(one, 10, { random: seededRandom(1), now: NOW });
    for (const d of docs) expect(d).toMatchObject({ kind: 'x', meta: {}, list: [] });
  });

  it('keeps null-only fields null and booleans booleans', () => {
    const s = analyzeSchema(canonical(Array.from({ length: 100 }, (_, i) => ({ gone: null, ok: i % 4 !== 0 }))), { details: true });
    const docs = generateDocuments(s, 1000, { random: seededRandom(9), now: NOW });
    expect(docs.every((d) => d.gone === null)).toBe(true);
    const yes = docs.filter((d) => d.ok === true).length / docs.length;
    expect(docs.every((d) => typeof d.ok === 'boolean')).toBe(true);
    expect(yes).toBeGreaterThan(0.7);
    expect(yes).toBeLessThan(0.8);
  });
});
