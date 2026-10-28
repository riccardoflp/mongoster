import { BSON, Double, Int32, Long } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { comparable, fieldDiff, fieldsSummary, parseIgnore } from '../../src/shared/compare';
import { relaxEjson } from '../../src/shared/query';

const c = (doc: object) => BSON.EJSON.serialize(doc, { relaxed: false });
const strict = { ignore: [] as string[], ignoreOrder: false, numbersByValue: false };
const loose = { ignore: [] as string[], ignoreOrder: true, numbersByValue: true };
const equal = (a: object, b: object, opts = strict) => comparable(c(a), opts) === comparable(c(b), opts);

describe('comparable', () => {
  it('tells field order apart unless it is ignored', () => {
    expect(equal({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(false);
    expect(equal({ a: 1, b: 2 }, { b: 2, a: 1 }, { ...strict, ignoreOrder: true })).toBe(true);
    // Also inside sub-documents and array elements.
    expect(equal({ x: [{ a: 1, b: 2 }] }, { x: [{ b: 2, a: 1 }] }, { ...strict, ignoreOrder: true })).toBe(true);
  });

  it('never ignores the order of array elements', () => {
    expect(equal({ a: [1, 2] }, { a: [2, 1] }, loose)).toBe(false);
  });

  it('tells int, long and double apart unless numbers compare by value', () => {
    const int = { n: new Int32(1) };
    const long = { n: Long.fromNumber(1) };
    const double = { n: new Double(1) };
    expect(equal(int, double)).toBe(false);
    expect(equal(int, long)).toBe(false);
    const byValue = { ...strict, numbersByValue: true };
    expect(equal(int, double, byValue)).toBe(true);
    expect(equal(int, long, byValue)).toBe(true);
    expect(equal({ n: new Double(1.5) }, { n: new Double(1.5) }, byValue)).toBe(true);
    expect(equal({ n: new Double(1.5) }, { n: new Int32(1) }, byValue)).toBe(false);
    expect(equal({ n: new Double(-0) }, { n: new Int32(0) }, byValue)).toBe(true);
  });

  it('compares large longs exactly by value', () => {
    const byValue = { ...strict, numbersByValue: true };
    expect(equal({ n: Long.fromString('9007199254740993') }, { n: Long.fromString('9007199254740993') }, byValue)).toBe(true);
    // 2^53 + 1 is not a double: the nearest double is 2^53.
    expect(equal({ n: Long.fromString('9007199254740993') }, { n: new Double(9007199254740992) }, byValue)).toBe(false);
    expect(equal({ n: Long.fromString('9007199254740992') }, { n: new Double(9007199254740992) }, byValue)).toBe(true);
  });

  it('keeps special doubles distinct from each other', () => {
    const byValue = { ...strict, numbersByValue: true };
    expect(equal({ n: new Double(Infinity) }, { n: new Double(-Infinity) }, byValue)).toBe(false);
    expect(equal({ n: new Double(NaN) }, { n: new Double(NaN) }, byValue)).toBe(true);
  });

  it('leaves out ignored fields, also inside sub-documents and array elements', () => {
    const opts = { ...strict, ignore: ['updatedAt', 'meta.rev', 'items.tmp'] };
    expect(
      equal(
        { _id: 1, updatedAt: 1, meta: { rev: 1, v: 1 }, items: [{ a: 1, tmp: 1 }] },
        { _id: 1, updatedAt: 2, meta: { rev: 2, v: 1 }, items: [{ a: 1, tmp: 2 }] },
        opts,
      ),
    ).toBe(true);
    expect(equal({ meta: { v: 1 } }, { meta: { v: 2 } }, opts)).toBe(false);
  });

  it('ignores only the exact path', () => {
    expect(equal({ a: { b: 1 } }, { a: { b: 2 } }, { ...strict, ignore: ['b'] })).toBe(false);
  });
});

describe('fieldDiff', () => {
  const diff = (a: object, b: object, opts = strict) => fieldDiff(c(a), c(b), opts, relaxEjson);

  it('is empty for equal documents, whatever their field order', () => {
    expect(diff({ a: 1, b: { c: 2 } }, { b: { c: 2 }, a: 1 })).toEqual([]);
  });

  it('reports changed, missing and added fields by dotted path', () => {
    expect(diff({ a: 1, b: { c: 2, d: 3 }, gone: true }, { a: 2, b: { c: 2, d: 4 }, added: 'x' })).toEqual([
      { path: 'a', left: 1, right: 2 },
      { path: 'b.d', left: 3, right: 4 },
      { path: 'gone', left: true },
      { path: 'added', right: 'x' },
    ]);
  });

  it('compares arrays of the same length element by element, others as a whole', () => {
    expect(diff({ a: [1, { x: 1 }] }, { a: [1, { x: 2 }] })).toEqual([{ path: 'a.1.x', left: 1, right: 2 }]);
    expect(diff({ a: [1, 2] }, { a: [1, 2, 3] })).toEqual([{ path: 'a', left: [1, 2], right: [1, 2, 3] }]);
  });

  it('reports a type-only difference with the two BSON types', () => {
    expect(diff({ n: new Int32(1) }, { n: new Double(1) })).toEqual([{ path: 'n', left: 1, right: 1, types: ['int', 'double'] }]);
    expect(diff({ n: new Int32(1) }, { n: new Double(1) }, { ...strict, numbersByValue: true })).toEqual([]);
  });

  it('skips ignored fields, inside arrays by the elements’ path', () => {
    const opts = { ...strict, ignore: ['t', 'items.t'] };
    expect(diff({ t: 1, items: [{ t: 1, v: 1 }] }, { t: 2, items: [{ t: 2, v: 2 }] }, opts)).toEqual([
      { path: 'items.0.v', left: 1, right: 2 },
    ]);
  });

  it('names the whole document when the values are not documents', () => {
    expect(fieldDiff(1, 2, strict)).toEqual([{ path: '(document)', left: 1, right: 2 }]);
  });

  it('stops at 200 differences', () => {
    const a = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, 1]));
    const b = Object.fromEntries(Array.from({ length: 300 }, (_, i) => [`f${i}`, 2]));
    expect(diff(a, b)).toHaveLength(200);
  });
});

describe('fieldsSummary / parseIgnore', () => {
  it('shortens long lists', () => {
    const fields = ['a', 'b', 'c', 'd', 'e', 'f'].map((path) => ({ path }));
    expect(fieldsSummary(fields)).toBe('a, b, c, d (+2)');
    expect(fieldsSummary(fields.slice(0, 2))).toBe('a, b');
  });

  it('splits on commas and spaces, without duplicates or blanks', () => {
    expect(parseIgnore(' a, b.c  a\n,d ,')).toEqual(['a', 'b.c', 'd']);
    expect(parseIgnore('')).toEqual([]);
  });
});
