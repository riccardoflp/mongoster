import { describe, expect, it } from 'vitest';
import { BSON } from 'mongodb';
import {
  escapeSlashes,
  formatFilter,
  isEjsonWrapper,
  isOperatorObject,
  mergeCondition,
  mergeProjection,
  mergeSort,
  parseQuery,
  prettyShell,
  relaxEjson,
  shellToJson5,
  toShell,
} from '../../src/shared/query';

const OID = '65a1b2c3d4e5f60718293a4b';

/** `\/` and `/` mean the same in a pattern. */
const unescapeSlashes = (pattern: string) => pattern.replace(/\\[\s\S]/g, (m) => (m === '\\/' ? '/' : m));

describe('parseQuery', () => {
  it('reads plain JSON5', () => {
    expect(parseQuery('{ a: 1, "b-c": [true, null], d: \'x\', }')).toEqual({ a: 1, 'b-c': [true, null], d: 'x' });
  });

  it('turns the shell helpers into EJSON wrappers', () => {
    expect(
      parseQuery(`{
        id: ObjectId("${OID}"),
        single: ObjectId('${OID}'),
        at: ISODate("2024-03-01T10:20:30Z"),
        day: new Date("2024-03-01"),
        long: NumberLong("9223372036854775807"),
        shortLong: NumberLong(42),
        negLong: NumberLong(-7),
        int: NumberInt("12"),
        dec: NumberDecimal("0.1"),
        decNaN: NumberDecimal("NaN"),
        uuid: UUID("0123456789ABCDEF0123456789abcdef"),
        bin: BinData(4, "AQID"),
        ts: Timestamp({ t: 1700000000, i: 3 }),
        ts2: Timestamp(5, 6),
        min: MinKey(),
        max: MaxKey(),
      }`),
    ).toEqual({
      id: { $oid: OID },
      single: { $oid: OID },
      at: { $date: '2024-03-01T10:20:30.000Z' },
      day: { $date: '2024-03-01T00:00:00.000Z' },
      long: { $numberLong: '9223372036854775807' },
      shortLong: { $numberLong: '42' },
      negLong: { $numberLong: '-7' },
      int: 12,
      dec: { $numberDecimal: '0.1' },
      decNaN: { $numberDecimal: 'NaN' },
      uuid: { $uuid: '01234567-89ab-cdef-0123-456789abcdef' },
      bin: { $binary: { base64: 'AQID', subType: '04' } },
      ts: { $timestamp: { t: 1700000000, i: 3 } },
      ts2: { $timestamp: { t: 5, i: 6 } },
      min: { $minKey: 1 },
      max: { $maxKey: 1 },
    });
  });

  it('gives ISODate() without an argument the current time', () => {
    const before = Date.now();
    const v = parseQuery('{ now: ISODate() }') as { now: { $date: string } };
    const t = Date.parse(v.now.$date);
    expect(t).toBeGreaterThanOrEqual(before - 1000);
    expect(t).toBeLessThanOrEqual(Date.now() + 1000);
  });

  it('keeps a date it cannot read as the text written', () => {
    expect(parseQuery('{ d: ISODate("not a date") }')).toEqual({ d: { $date: 'not a date' } });
  });

  it('reads regex literals, keeping the supported options sorted and once', () => {
    expect(parseQuery('{ a: /^ab+c$/xig, b: /a\\/b/, c: /[/]x/ }')).toEqual({
      a: { $regularExpression: { pattern: '^ab+c$', options: 'ix' } },
      b: { $regularExpression: { pattern: 'a\\/b', options: '' } },
      c: { $regularExpression: { pattern: '[/]x', options: '' } },
    });
    expect(parseQuery('[/a/i, /b/]')).toEqual([
      { $regularExpression: { pattern: 'a', options: 'i' } },
      { $regularExpression: { pattern: 'b', options: '' } },
    ]);
  });

  it('leaves the contents of strings alone', () => {
    expect(parseQuery(`{ a: "ObjectId('${OID}')", b: '/not a regex/', c: "it's \\"NumberLong(1)\\"", d: "// no comment" }`)).toEqual({
      a: `ObjectId('${OID}')`,
      b: '/not a regex/',
      c: 'it\'s "NumberLong(1)"',
      d: '// no comment',
    });
  });

  it('skips comments', () => {
    expect(parseQuery('{\n  // the status\n  status: "A", /* inline */ n: 1 // end\n}')).toEqual({ status: 'A', n: 1 });
  });

  it('does not rewrite helpers that are part of a longer name', () => {
    expect(shellToJson5('{ a: myObjectId("x") }')).toBe('{ a: myObjectId("x") }');
  });

  it('throws on text that is not a value', () => {
    expect(() => parseQuery('{ a: }')).toThrow();
    expect(() => parseQuery('{ a: 1')).toThrow();
  });
});

describe('isEjsonWrapper / isOperatorObject', () => {
  it('tells type wrappers from operator objects and documents', () => {
    expect(isEjsonWrapper({ $oid: OID })).toBe(true);
    expect(isEjsonWrapper({ $code: 'f()', $scope: {} })).toBe(true);
    expect(isEjsonWrapper({ $oid: OID, other: 1 })).toBe(false);
    expect(isEjsonWrapper({ $gt: 1 })).toBe(false);
    expect(isEjsonWrapper([])).toBe(false);

    expect(isOperatorObject({ $gte: 1, $lt: 5 })).toBe(true);
    expect(isOperatorObject({ $date: '2024-01-01T00:00:00.000Z' })).toBe(false);
    expect(isOperatorObject({ $gt: 1, a: 2 })).toBe(false);
    expect(isOperatorObject({})).toBe(false);
  });
});

describe('relaxEjson', () => {
  it('turns canonical EJSON into relaxed EJSON', () => {
    const doc = {
      _id: new BSON.ObjectId(OID),
      i: new BSON.Int32(5),
      d: new BSON.Double(1.5),
      small: BSON.Long.fromNumber(42),
      big: BSON.Long.fromString('9223372036854775807'),
      dec: BSON.Decimal128.fromString('1.10'),
      when: new Date('2024-03-01T10:20:30.000Z'),
      nested: { list: [new BSON.Int32(1), { x: new BSON.Double(2) }] },
    };
    expect(relaxEjson(BSON.EJSON.serialize(doc, { relaxed: false }))).toEqual({
      _id: { $oid: OID },
      i: 5,
      d: 1.5,
      small: 42,
      big: { $numberLong: '9223372036854775807' },
      dec: { $numberDecimal: '1.10' },
      when: { $date: '2024-03-01T10:20:30.000Z' },
      nested: { list: [1, { x: 2 }] },
    });
  });

  it('keeps the values relaxed EJSON cannot hold as wrappers', () => {
    expect(relaxEjson({ $numberDouble: 'NaN' })).toEqual({ $numberDouble: 'NaN' });
    expect(relaxEjson({ $numberDouble: '-Infinity' })).toEqual({ $numberDouble: '-Infinity' });
    expect(relaxEjson({ $numberLong: '9007199254740993' })).toEqual({ $numberLong: '9007199254740993' });
    // Dates before 1970 or after 9999 keep their milliseconds.
    expect(relaxEjson({ $date: { $numberLong: '-1000' } })).toEqual({ $date: { $numberLong: '-1000' } });
    expect(relaxEjson({ $date: { $numberLong: '253402300800000' } })).toEqual({ $date: { $numberLong: '253402300800000' } });
    expect(relaxEjson({ $date: { $numberLong: '0' } })).toEqual({ $date: '1970-01-01T00:00:00.000Z' });
  });
});

describe('toShell', () => {
  it('writes the wrappers as shell helpers', () => {
    expect(toShell({ $oid: OID })).toBe(`ObjectId("${OID}")`);
    expect(toShell({ $date: '2024-03-01T10:20:30.000Z' })).toBe('ISODate("2024-03-01T10:20:30.000Z")');
    expect(toShell({ $date: { $numberLong: '0' } })).toBe('ISODate("1970-01-01T00:00:00.000Z")');
    expect(toShell({ $numberLong: '9223372036854775807' })).toBe('NumberLong("9223372036854775807")');
    expect(toShell({ $numberDecimal: '0.1' })).toBe('NumberDecimal("0.1")');
    expect(toShell({ $timestamp: { t: 1, i: 2 } })).toBe('Timestamp({ t: 1, i: 2 })');
    expect(toShell({ $binary: { base64: 'AQID', subType: '00' } })).toBe('BinData(0, "AQID")');
    expect(toShell({ $minKey: 1 })).toBe('MinKey()');
    expect(toShell({ $maxKey: 1 })).toBe('MaxKey()');
  });

  it('writes binary UUIDs (subtypes 3 and 4) as UUID()', () => {
    const uuid = new BSON.UUID('01234567-89ab-cdef-0123-456789abcdef');
    const relaxed = relaxEjson(BSON.EJSON.serialize({ u: uuid }, { relaxed: false })) as { u: Record<string, unknown> };
    expect(toShell(relaxed.u)).toBe('UUID("01234567-89ab-cdef-0123-456789abcdef")');
  });

  it('quotes keys that are not identifiers, and writes special numbers', () => {
    expect(toShell({ a: 1, 'b.c': 2, 'with space': 3, $gt: NaN, _x$: Infinity, y: -Infinity })).toBe(
      '{ a: 1, "b.c": 2, "with space": 3, $gt: NaN, _x$: Infinity, y: -Infinity }',
    );
  });

  it('writes empty containers compactly and indents on request', () => {
    expect(toShell({ a: [], b: {} })).toBe('{ a: [], b: {} }');
    expect(toShell({ a: [1, { b: 2 }] }, 2)).toBe('{\n  a: [\n    1,\n    {\n      b: 2\n    }\n  ]\n}');
  });

  it('escapes the slashes of regex patterns so the literal reads back', () => {
    for (const pattern of ['a/b', 'http://x', '^https?:\\/\\/', 'a\\\\/b', '[/]', '//', '/']) {
      const text = toShell({ $regularExpression: { pattern, options: 'i' } });
      const back = parseQuery(text) as { $regularExpression: { pattern: string; options: string } };
      expect(back.$regularExpression.options).toBe('i');
      // Same regular expression, though `/` may come back escaped.
      expect(unescapeSlashes(back.$regularExpression.pattern)).toBe(unescapeSlashes(pattern));
      // And formatting it again gives the same text.
      expect(toShell(back)).toBe(text);
    }
  });

  it('escapeSlashes keeps escape sequences whole', () => {
    expect(escapeSlashes('a/b')).toBe('a\\/b');
    expect(escapeSlashes('a\\/b')).toBe('a\\/b');
    expect(escapeSlashes('a\\\\/b')).toBe('a\\\\\\/b');
    expect(escapeSlashes('://')).toBe(':\\/\\/');
  });
});

describe('parse ⇄ format round trips', () => {
  const values: Record<string, unknown> = {
    objectId: { $oid: OID },
    date: { $date: '2024-03-01T10:20:30.123Z' },
    regex: { $regularExpression: { pattern: '^Ma.*o$', options: 'im' } },
    longBeyondSafe: { $numberLong: '-9223372036854775808' },
    decimal: { $numberDecimal: '123456789012345678901234.5678' },
    uuid: { $uuid: 'abcdef01-2345-6789-abcd-ef0123456789' },
    binary: { $binary: { base64: 'SGVsbG8=', subType: '80' } },
    timestamp: { $timestamp: { t: 1700000000, i: 7 } },
    minKey: { $minKey: 1 },
    maxKey: { $maxKey: 1 },
    nested: {
      a: [1, 'two', null, true, { b: { $oid: OID }, c: [{ $date: '2000-01-01T00:00:00.000Z' }] }],
      'odd key': { $gte: 1.5, $in: [{ $numberLong: '9007199254740993' }] },
    },
    specials: [NaN, Infinity, -Infinity, -0.5, 1e21],
  };

  for (const [name, v] of Object.entries(values)) {
    it(name, () => {
      expect(parseQuery(toShell(v))).toEqual(v);
      expect(parseQuery(toShell(v, 2))).toEqual(v);
      expect(parseQuery(prettyShell(v, 0, 20))).toEqual(v);
    });
  }

  it('reads back the canonical EJSON of real BSON values', () => {
    const doc = {
      _id: new BSON.ObjectId(OID),
      n: BSON.Long.fromString('1234567890123456789'),
      d: BSON.Decimal128.fromString('9.99'),
      at: new Date('2023-12-31T23:59:59.999Z'),
      re: new BSON.BSONRegExp('a/b', 'i'),
      bin: new BSON.Binary(Buffer.from([1, 2, 3]), 0),
      ts: new BSON.Timestamp({ t: 10, i: 1 }),
    };
    const relaxed = relaxEjson(BSON.EJSON.serialize(doc, { relaxed: false }));
    const back = BSON.EJSON.deserialize(parseQuery(toShell(relaxed)) as BSON.Document, { relaxed: false });
    expect(BSON.serialize(back)).toEqual(BSON.serialize({ ...doc, re: new BSON.BSONRegExp('a\\/b', 'i') }));
  });
});

describe('prettyShell', () => {
  it('keeps a value on one line when it fits', () => {
    expect(prettyShell({ a: 1, b: [1, 2] })).toBe('{ a: 1, b: [1, 2] }');
  });

  it('breaks only what does not fit', () => {
    const text = prettyShell({ short: 1, long: { aaaaaaaaaa: 'bbbbbbbbbbbbbbbb', cccccccccc: 'dddddddddddddddd' } }, 0, 40);
    expect(text).toBe('{\n  short: 1,\n  long: {\n    aaaaaaaaaa: "bbbbbbbbbbbbbbbb",\n    cccccccccc: "dddddddddddddddd"\n  }\n}');
  });

  it('never breaks a type wrapper', () => {
    expect(prettyShell({ $oid: OID }, 0, 5)).toBe(`ObjectId("${OID}")`);
  });
});

describe('formatFilter', () => {
  it('is one line up to 70 characters', () => {
    expect(formatFilter({ status: 'A', qty: { $lt: 30 } })).toBe('{ status: "A", qty: { $lt: 30 } }');
  });

  it('puts each top-level field on its own line beyond that', () => {
    const filter = { name: 'a fairly long name to push the width', createdAt: { $gte: { $date: '2024-01-01T00:00:00.000Z' } } };
    const text = formatFilter(filter);
    expect(text.split('\n')).toEqual([
      '{',
      '  name: "a fairly long name to push the width",',
      '  createdAt: { $gte: ISODate("2024-01-01T00:00:00.000Z") }',
      '}',
    ]);
    expect(parseQuery(text)).toEqual(filter);
  });
});

describe('mergeCondition', () => {
  it('adds a condition to an empty or existing filter', () => {
    expect(mergeCondition('', 'status', 'A')).toBe('{ status: "A" }');
    expect(mergeCondition('  ', 'n', 1)).toBe('{ n: 1 }');
    expect(mergeCondition(`{ _id: ObjectId("${OID}") }`, 'n', { $gt: 1 })).toBe(`{ _id: ObjectId("${OID}"), n: { $gt: 1 } }`);
  });

  it('merges operator objects on the same field into a range', () => {
    const text = mergeCondition('{ age: { $gte: 20 } }', 'age', { $lte: 30 });
    expect(parseQuery(text)).toEqual({ age: { $gte: 20, $lte: 30 } });
    // A later operator of the same kind replaces the earlier one.
    expect(parseQuery(mergeCondition(text, 'age', { $gte: 25 }))).toEqual({ age: { $gte: 25, $lte: 30 } });
  });

  it('replaces a field when either side is a value', () => {
    expect(parseQuery(mergeCondition('{ a: { $gt: 1 } }', 'a', 5))).toEqual({ a: 5 });
    expect(parseQuery(mergeCondition('{ a: 5 }', 'a', { $gt: 1 }))).toEqual({ a: { $gt: 1 } });
  });

  it('puts conditions within an array into one $elemMatch', () => {
    let text = mergeCondition('', 'items.qty', { $gt: 1 }, 'items');
    text = mergeCondition(text, 'items.name', 'pen', 'items');
    text = mergeCondition(text, 'items.qty', { $lt: 10 }, 'items');
    expect(parseQuery(text)).toEqual({ items: { $elemMatch: { qty: { $gt: 1, $lt: 10 }, name: 'pen' } } });
  });

  it('replaces a plain value on the array field with the $elemMatch', () => {
    expect(parseQuery(mergeCondition('{ items: "x" }', 'items.qty', 2, 'items'))).toEqual({ items: { $elemMatch: { qty: 2 } } });
  });

  it('ignores `within` when the key is not inside it', () => {
    expect(parseQuery(mergeCondition('', 'other', 1, 'items'))).toEqual({ other: 1 });
  });

  it('throws when the text is not an object', () => {
    expect(() => mergeCondition('[1, 2]', 'a', 1)).toThrow('must be an object');
    expect(() => mergeCondition('"x"', 'a', 1)).toThrow('must be an object');
  });
});

describe('mergeSort', () => {
  it('adds a key after the others and keeps the priority of an existing one', () => {
    expect(mergeSort('', 'a', 1)).toBe('{ a: 1 }');
    expect(mergeSort('{ a: 1, b: -1 }', 'c', -1)).toBe('{ a: 1, b: -1, c: -1 }');
    expect(mergeSort('{ a: 1, b: -1 }', 'a', -1)).toBe('{ a: -1, b: -1 }');
  });

  it('removes a key with null, and gives an empty text for an empty sort', () => {
    expect(mergeSort('{ a: 1, b: -1 }', 'a', null)).toBe('{ b: -1 }');
    expect(mergeSort('{ a: 1 }', 'a', null)).toBe('');
  });

  it('throws when the text is not an object', () => {
    expect(() => mergeSort('[1]', 'a', 1)).toThrow('must be an object');
  });
});

describe('mergeProjection', () => {
  it('includes and excludes fields', () => {
    expect(mergeProjection('', 'a', 1)).toBe('{ a: 1 }');
    expect(mergeProjection('{ a: 1 }', 'b', 1)).toBe('{ a: 1, b: 1 }');
  });

  it('drops the opposite kind, except _id', () => {
    expect(parseQuery(mergeProjection('{ a: 0, _id: 0 }', 'b', 1))).toEqual({ _id: 0, b: 1 });
    expect(parseQuery(mergeProjection('{ a: 1, _id: 1 }', 'b', 0))).toEqual({ _id: 1, b: 0 });
    expect(parseQuery(mergeProjection('{ a: true }', 'b', 0))).toEqual({ b: 0 });
    expect(parseQuery(mergeProjection('{ a: false }', 'b', 1))).toEqual({ b: 1 });
  });

  it('excludes _id alongside an inclusion', () => {
    expect(parseQuery(mergeProjection('{ a: 1, b: 1 }', '_id', 0))).toEqual({ a: 1, b: 1, _id: 0 });
  });

  it('drops paths above or below the key (path collisions)', () => {
    expect(parseQuery(mergeProjection('{ a: 1, c: 1 }', 'a.b', 1))).toEqual({ c: 1, 'a.b': 1 });
    expect(parseQuery(mergeProjection('{ "a.b": 1, "a.c": 1, ab: 1 }', 'a', 1))).toEqual({ ab: 1, a: 1 });
  });

  it('removes a key with null', () => {
    expect(mergeProjection('{ a: 1, b: 1 }', 'a', null)).toBe('{ b: 1 }');
    expect(mergeProjection('{ a: 1 }', 'a', null)).toBe('');
  });
});
