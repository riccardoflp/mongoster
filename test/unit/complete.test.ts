import { BSON } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { CompletionKind, CompletionResult, FieldHint, complete, fieldHints } from '../../src/shared/complete';
import { analyzeSchema } from '../../src/shared/schema';

const fields: FieldHint[] = [
  { path: 'status', types: ['string'], ratio: 1, values: [{ value: 'active', count: 5 }, { value: 'off', count: 2 }] },
  { path: 'age', types: ['int'], ratio: 0.5, values: [{ value: 30, count: 3 }] },
  { path: 'address.city', types: ['string'], ratio: 0.8, values: [{ value: 'Rome', count: 1 }] },
  { path: 'items', types: ['array'], ratio: 1, values: [] },
  { path: 'items.sku', types: ['string'], ratio: 1, values: [{ value: 'x-1', count: 4 }] },
];

/** Completion at the `‸` of the text. */
function at(textWithCaret: string, kind: CompletionKind = 'filter', hints = fields): CompletionResult | null {
  const offset = textWithCaret.indexOf('‸');
  if (offset < 0) throw new Error('no caret');
  return complete(textWithCaret.replace('‸', ''), offset, kind, hints);
}
const labels = (r: CompletionResult | null) => r?.items.map((i) => i.label) ?? [];
const item = (r: CompletionResult | null, label: string) => {
  const found = r?.items.find((i) => i.label === label);
  if (!found) throw new Error(`no item ${label} in ${labels(r).join(', ')}`);
  return found;
};

describe('complete: filter keys', () => {
  it('suggests fields, then top-level query operators, at a key', () => {
    const r = at('{ ‸ }');
    expect(r).toMatchObject({ position: 'key', prefix: '', from: 2, to: 2 });
    expect(labels(r).slice(0, 5)).toEqual(['status', 'age', 'address.city', 'items', 'items.sku']);
    expect(labels(r)).toContain('$or');
    expect(labels(r)).not.toContain('$gt');
    expect(item(r, 'age').detail).toBe('int · 50%');
    expect(item(r, 'status').detail).toBe('string');
  });

  it('inserts ": " and the operator template with the caret inside', () => {
    const r = at('{ ‸ }');
    expect(item(r, 'status')).toMatchObject({ insert: 'status: ', cursor: 'status: '.length });
    const or = item(r, '$or');
    expect(or.insert).toBe('$or: [{  }]');
    expect(or.cursor).toBe('$or: [{ '.length);
    // A key that isn't an identifier is quoted.
    expect(item(r, 'address.city').insert).toBe('"address.city": ');
  });

  it('filters and ranks by the typed prefix, replacing the whole word', () => {
    const r = at('{ sta‸tu }');
    expect(r).toMatchObject({ from: 2, to: 7, prefix: 'sta' });
    expect(labels(r)[0]).toBe('status');
    // A later path segment matches too ("city" in "address.city").
    expect(labels(at('{ ci‸ }'))).toEqual(['address.city']);
  });

  it('does not add the colon when it is already there', () => {
    const r = at('{ sta‸ : 1 }');
    expect(item(r, 'status')).toEqual({ label: 'status', detail: 'string', kind: 'field', insert: 'status' });
  });

  it('completes inside a quoted key, replacing up to the closing quote', () => {
    const text = '{ "addr‸" }';
    const r = at(text);
    expect(r).toMatchObject({ prefix: 'addr', from: 3, to: 8 });
    expect(item(r, 'address.city').insert).toBe('address.city": ');
  });

  it('offers only operators for a "$" prefix', () => {
    const r = at('{ $‸ }');
    expect(r!.items.every((i) => i.label.startsWith('$'))).toBe(true);
    expect(labels(r)).toContain('$and');
  });

  it('suggests the fields of the elements inside $elemMatch, with field operators', () => {
    const r = at('{ items: { $elemMatch: { ‸ } } }');
    expect(labels(r)).toContain('sku');
    expect(labels(r)).toContain('$gt');
    expect(labels(r)).not.toContain('status');
  });

  it('suggests fields again inside $or conditions', () => {
    expect(labels(at('{ $or: [{ ‸ }] }'))).toContain('status');
  });

  it('suggests comparison operators in a field’s operator object', () => {
    const r = at('{ age: { ‸ } }');
    expect(labels(r)).toEqual(expect.arrayContaining(['$gt', '$in', '$exists']));
    expect(labels(r)).not.toContain('status');
  });
});

describe('complete: filter values', () => {
  it('suggests the field’s frequent values as mongosh text', () => {
    const r = at('{ status: ‸ }');
    expect(r?.position).toBe('value');
    expect(r?.items).toEqual([
      { label: '"active"', detail: '×5', kind: 'value', insert: '"active"' },
      { label: '"off"', detail: '×2', kind: 'value', insert: '"off"' },
    ]);
  });

  it('inside a string, suggests string values only and closes the quote', () => {
    const r = at('{ status: "ac‸ }');
    expect(r?.items).toEqual([{ label: '"active"', detail: '×5', kind: 'value', insert: 'active"' }]);
    expect(at('{ age: "‸" }')?.items).toEqual([]);
  });

  it('suggests values in operator positions and lists', () => {
    expect(labels(at('{ age: { $gte: ‸ } }'))).toEqual(['30']);
    expect(labels(at('{ age: { $in: [‸] } }'))).toEqual(['30']);
    expect(labels(at('{ age: { $in: [30, ‸] } }'))).toEqual(['30']);
    expect(labels(at('{ age: { $exists: ‸ } }'))).toEqual(['true', 'false']);
    expect(labels(at('{ age: { $type: "‸" } }'))).toContain('"string"');
    expect(item(at('{ age: { $type: "‸" } }'), '"int"').insert).toBe('int"');
  });

  it('escapes the inserted text for the quote in use', () => {
    const hints: FieldHint[] = [{ path: 'q', types: ['string'], ratio: 1, values: [{ value: `it's`, count: 1 }] }];
    expect(item(at(`{ q: '‸' }`, 'filter', hints), '"it\'s"').insert).toBe(`it\\'s'`);
  });
});

describe('complete: where nothing applies', () => {
  it('returns null in comments, regexes and calls', () => {
    expect(at('{ // ‸')).toBeNull();
    expect(at('{ /* ‸ */ }')).toBeNull();
    expect(at('{ name: /ab‸c/ }')).toBeNull();
    expect(at('{ _id: ObjectId(‸) }')).toBeNull();
  });

  it('returns null after a complete value', () => {
    expect(at('{ a: 1 }‸')).toBeNull();
    expect(at('{ a: 1 ‸}')).toBeNull();
    expect(at('{ a: ObjectId("x") ‸}')).toBeNull();
  });

  it('continues after a regex literal and a call', () => {
    expect(at('{ name: /abc/i, ‸ }')?.position).toBe('key');
    expect(at('{ d: ISODate("2024-01-01"), ‸ }')?.position).toBe('key');
  });
});

describe('complete: other kinds', () => {
  it('sort: fields, then directions; index keys also take special types', () => {
    expect(labels(at('{ ‸ }', 'sort'))).toEqual(['status', 'age', 'address.city', 'items', 'items.sku']);
    expect(labels(at('{ age: ‸ }', 'sort'))).toEqual(['1', '-1']);
    expect(labels(at('{ age: ‸ }', 'index'))).toEqual(['1', '-1', '"text"', '"2dsphere"', '"hashed"']);
  });

  it('project: 1 and 0', () => {
    expect(labels(at('{ age: ‸ }', 'project'))).toEqual(['1', '0']);
  });

  it('update: operators, then fields, then values', () => {
    expect(labels(at('{ ‸ }', 'update'))).toContain('$set');
    expect(labels(at('{ $set: { ‸ } }', 'update'))).toContain('status');
    expect(labels(at('{ $set: { status: ‸ } }', 'update'))).toEqual(['"active"', '"off"']);
    expect(labels(at('{ $pop: { items: ‸ } }', 'update'))).toEqual(['1', '-1']);
    expect(at('{ $inc: { age: ‸ } }', 'update')?.items).toEqual([]);
  });

  it('pipeline: stages, then each stage’s own context', () => {
    expect(labels(at('[{ ‸ }]', 'pipeline'))).toContain('$match');
    const match = item(at('[{ $ma‸ }]', 'pipeline'), '$match');
    expect(match.insert).toBe('$match: {  }');
    expect(labels(at('[{ $match: { ‸ } }]', 'pipeline'))).toContain('status');
    expect(labels(at('[{ $sort: { age: ‸ } }]', 'pipeline'))).toEqual(['1', '-1']);
    expect(labels(at('[{ $group: { ‸ } }]', 'pipeline'))).toEqual(['_id']);
    expect(labels(at('[{ $group: { _id: null, total: { ‸ } } }]', 'pipeline'))).toContain('$sum');
    expect(labels(at('[{ $lookup: { ‸ } }]', 'pipeline'))).toEqual(['from', 'localField', 'foreignField', 'as', 'let', 'pipeline']);
    expect(labels(at('[{ $limit: ‸ }]', 'pipeline'))).toEqual([]);
  });

  it('expressions: field references and variables, quoted as needed', () => {
    const r = at('[{ $group: { _id: "$st‸" } }]', 'pipeline');
    expect(labels(r)[0]).toBe('$status');
    expect(item(r, '$status').insert).toBe('$status"');
    const bare = at('[{ $project: { x: ‸ } }]', 'pipeline');
    expect(item(bare, '$age').insert).toBe('"$age"');
    expect(labels(bare)).toEqual(expect.arrayContaining(['$$ROOT', '1', '0']));
  });

  it('a single stage body and a field name argument', () => {
    expect(labels(at('‸', { stage: '$unwind' }))).toContain('$items');
    expect(labels(at('{ ‸ }', { stage: '$unwind' }))).toEqual(['path', 'includeArrayIndex', 'preserveNullAndEmptyArrays']);
    expect(labels(at('{ preserveNullAndEmptyArrays: ‸ }', { stage: '$unwind' }))).toEqual(['true', 'false']);
    expect(item(at('"it‸"', 'field'), 'items.sku').insert).toBe('items.sku"');
    expect(labels(at('{ ‸ }', 'stageObject'))).toContain('$group');
  });
});

describe('fieldHints', () => {
  it('flattens a schema into one hint per path, merging array elements into their array', () => {
    const docs = [
      { a: 1, tags: ['x', 'y'], items: [{ sku: 'k' }] },
      { a: 'one', tags: ['x'], items: [{ sku: 'k' }, { sku: 'j' }] },
      { b: { c: true } },
      { b: { c: true } },
    ].map((d) => BSON.EJSON.serialize(d, { relaxed: false }));
    const hints = fieldHints(analyzeSchema(docs));
    const byPath = Object.fromEntries(hints.map((h) => [h.path, h]));
    expect(Object.keys(byPath).sort()).toEqual(['a', 'b', 'b.c', 'items', 'items.sku', 'tags']);
    expect(byPath.a).toMatchObject({ types: ['int', 'string'], ratio: 0.5 });
    expect(byPath.a.values).toEqual(expect.arrayContaining([{ value: 1, count: 1 }, { value: 'one', count: 1 }]));
    // Elements of tags: values under the array's own path, most frequent first.
    expect(byPath.tags.types).toEqual(['array', 'string']);
    expect(byPath.tags.values).toEqual([
      { value: 'x', count: 2 },
      { value: 'y', count: 1 },
    ]);
    expect(byPath['items.sku'].values[0]).toEqual({ value: 'k', count: 2 });
    expect(byPath['b.c']).toMatchObject({ ratio: 1, types: ['bool'] });
  });
});
