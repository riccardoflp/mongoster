import { describe, expect, it } from 'vitest';
import { BSON } from 'mongodb';
import { CODE_LANGUAGES, CodeLanguage, CodeQuery, generateCode } from '../../src/shared/codegen';
import { isPlainObject, parseQuery } from '../../src/shared/query';
import { toBson } from '../../src/queries';

const OID = '65a1b2c3d4e5f60718293a4b';
const snippet = { database: 'shop', collection: 'orders', program: false };
const program = { ...snippet, program: true };

const FILTER_TEXT = `{
  _id: ObjectId("${OID}"),
  at: { $gte: ISODate("2024-03-01T10:20:30.123Z") },
  n: NumberLong("9007199254740993"),
  d: NumberDecimal("0.1"),
  re: /^http:\\/\\//i,
  ok: true,
  none: null,
  list: [1, 2.5, "x"],
  "dotted.key": { $in: [1, 2] }
}`;
const filter = parseQuery(FILTER_TEXT);
const find = (extra: Partial<Extract<CodeQuery, { kind: 'find' }>> = {}): CodeQuery => ({ kind: 'find', filter, ...extra });

/** Text between the first `start` and the last `end`. */
function between(text: string, start: string, end: string): string {
  const from = text.indexOf(start) + start.length;
  return text.slice(from, text.lastIndexOf(end));
}

/** RegExp instances as the $regularExpression wrappers parseQuery gives. */
function normalize(v: unknown): unknown {
  if (v instanceof RegExp) return { $regularExpression: { pattern: v.source, options: v.flags } };
  if (Array.isArray(v)) return v.map(normalize);
  if (isPlainObject(v)) return Object.fromEntries(Object.entries(v).map(([k, x]) => [k, normalize(x)]));
  return v;
}

describe('mongosh', () => {
  it('writes a find that evaluates to the same arguments', () => {
    const code = generateCode('shell', find({ projection: { a: 1 }, sort: { b: -1 } }), snippet);
    const calls: Record<string, unknown[]> = {};
    const cursor = { sort: (...args: unknown[]) => ((calls.sort = args), cursor) };
    const db = { getCollection: (name: string) => ((calls.collection = [name]), { find: (...args: unknown[]) => ((calls.find = args), cursor) }) };
    const helpers = {
      ObjectId: (hex: string) => ({ $oid: hex }),
      ISODate: (s: string) => ({ $date: new Date(s).toISOString() }),
      NumberLong: (s: string) => ({ $numberLong: s }),
      NumberDecimal: (s: string) => ({ $numberDecimal: s }),
    };
    new Function('db', ...Object.keys(helpers), code)(db, ...Object.values(helpers));
    expect(calls.collection).toEqual(['orders']);
    expect(normalize(calls.find)).toEqual([filter, { a: 1 }]);
    expect(calls.sort).toEqual([{ b: -1 }]);
  });

  it('writes an aggregate, and use() in a program', () => {
    const pipeline = parseQuery('[{ $match: { a: ObjectId("' + OID + '") } }, { $group: { _id: "$b", n: { $sum: 1 } } }]') as unknown[];
    const code = generateCode('shell', { kind: 'aggregate', pipeline }, program);
    expect(code.startsWith('use("shop");\n\n')).toBe(true);
    expect(parseQuery(between(code, 'db.getCollection("orders").aggregate(', ');'))).toEqual(pipeline);
  });

  it('leaves out an empty projection and sort', () => {
    expect(generateCode('shell', { kind: 'find', filter: {}, projection: {}, sort: {} }, snippet)).toBe('db.getCollection("orders").find({});\n');
  });
});

describe('Node.js', () => {
  it('writes values that build the same BSON as the query', () => {
    const code = generateCode('javascript', find(), snippet);
    const decl = between(code, 'const filter = ', ';\n\nconst cursor');
    const classes = { ObjectId: BSON.ObjectId, Long: BSON.Long, Decimal128: BSON.Decimal128 };
    const built = new Function(...Object.keys(classes), `return (${decl});`)(...Object.values(classes));
    expect(BSON.serialize(built)).toEqual(BSON.serialize(toBson(FILTER_TEXT, 'Filter')!));
  });

  it('imports exactly the BSON classes it uses in a program', () => {
    const code = generateCode('javascript', find({ sort: { at: -1 } }), program);
    expect(code).toContain('import { MongoClient, Decimal128, Long, ObjectId } from "mongodb";');
    expect(code).toContain('client.db("shop").collection("orders").find(filter, { sort })');
    expect(code).toContain('await client.close();');
    const plain = generateCode('javascript', { kind: 'aggregate', pipeline: [{ $limit: 1 }] }, program);
    expect(plain).toContain('import { MongoClient } from "mongodb";');
  });

  it('writes regexes with options a JS literal cannot hold as BSONRegExp', () => {
    const code = generateCode('javascript', { kind: 'find', filter: { a: { $regularExpression: { pattern: 'a b', options: 'x' } } } }, program);
    expect(code).toContain('new BSONRegExp("a b", "x")');
    expect(code).toContain('import { MongoClient, BSONRegExp } from "mongodb";');
  });

  it('escapes every slash of a regex pattern in the literal', () => {
    const code = generateCode('javascript', { kind: 'find', filter: { url: { $regularExpression: { pattern: '^https://a//b', options: 'i' } } } }, snippet);
    const decl = between(code, 'const filter = ', ';\n\nconst cursor');
    const built = new Function(`return (${decl});`)() as { url: RegExp };
    expect(built.url).toBeInstanceOf(RegExp);
    expect(built.url.test('HTTPS://a//b/c')).toBe(true);
    expect(built.url.flags).toBe('i');
  });

  it('does not declare the options it does not pass', () => {
    const code = generateCode('javascript', { kind: 'find', filter: {} }, snippet);
    expect(code).toBe('const filter = {};\n\nconst cursor = client.db("shop").collection("orders").find(filter);\n');
  });
});

describe('Python', () => {
  const code = generateCode('python', find({ projection: { a: 1 }, sort: { b: -1, c: 1 } }), program);

  it('writes Python values', () => {
    expect(code).toContain('"_id": ObjectId("65a1b2c3d4e5f60718293a4b")');
    expect(code).toContain('datetime(2024, 3, 1, 10, 20, 30, 123000, tzinfo=timezone.utc)');
    expect(code).toContain('"n": Int64(9007199254740993)');
    expect(code).toContain('"d": Decimal128("0.1")');
    expect(code).toContain('"ok": True');
    expect(code).toContain('"none": None');
  });

  it('writes the sort as a list of pairs', () => {
    expect(code).toContain('sort = [("b", -1), ("c", 1)]');
    expect(code).toContain('collection.find(query, projection, sort=sort)');
  });

  it('puts the standard imports before the driver ones', () => {
    const head = code.slice(0, code.indexOf('\n\nclient ='));
    expect(head.split('\n\n')).toEqual([
      'import os\nfrom datetime import datetime, timezone',
      [
        'from pymongo import MongoClient',
        'from bson import ObjectId',
        'from bson.decimal128 import Decimal128',
        'from bson.int64 import Int64',
        'from bson.regex import Regex',
      ].join('\n'),
    ]);
  });

  it('writes a date at midnight without a time', () => {
    const day = generateCode('python', { kind: 'find', filter: { d: { $date: '2024-01-02T00:00:00.000Z' } } }, snippet);
    expect(day).toContain('datetime(2024, 1, 2, tzinfo=timezone.utc)');
  });
});

describe('Java', () => {
  it('writes Documents with long literals and sorted imports', () => {
    const code = generateCode('java', find({ projection: { a: 1 } }), program);
    expect(code).toContain('new Document("_id", new ObjectId("65a1b2c3d4e5f60718293a4b"))');
    expect(code).toContain('.append("n", 9007199254740993L)');
    expect(code).toContain('Date.from(Instant.parse("2024-03-01T10:20:30.123Z"))');
    expect(code).toContain('collection.find(filter).projection(projection)');
    const imports = code.split('\n').filter((l) => l.startsWith('import '));
    expect(imports).toEqual([...imports].sort());
    expect(new Set(imports).size).toBe(imports.length);
    expect(imports).toContain('import org.bson.types.ObjectId;');
    expect(imports).toContain('import org.bson.types.Decimal128;');
    expect(imports).toContain('import java.util.Arrays;');
  });

  it('adds L to plain numbers beyond int32', () => {
    expect(generateCode('java', { kind: 'find', filter: { a: 3000000000, b: 5 } }, snippet)).toContain(
      'new Document("a", 3000000000L).append("b", 5)',
    );
  });

  it('writes an empty filter as new Document()', () => {
    expect(generateCode('java', { kind: 'find', filter: {} }, snippet)).toContain('Document filter = new Document();');
  });
});

describe('C#', () => {
  it('writes BsonDocuments', () => {
    const code = generateCode('csharp', find({ projection: { a: 1 }, sort: { b: -1 } }), snippet);
    expect(code).toContain('{ "none", BsonNull.Value }');
    expect(code).toContain('new DateTime(2024, 3, 1, 10, 20, 30, DateTimeKind.Utc).AddMilliseconds(123)');
    expect(code).toContain('{ "n", 9007199254740993L }');
    expect(code).toContain('var projection = new BsonDocument("a", 1);');
    expect(code).toContain('collection.Find(filter).Sort(sort).Project(projection).ToList()');
  });
});

describe('Go', () => {
  it('writes bson.D documents and adds the helpers it uses once', () => {
    const code = generateCode('go', find(), snippet);
    expect(code).toContain('{Key: "_id", Value: objectID("65a1b2c3d4e5f60718293a4b")}');
    expect(code).toContain('time.Date(2024, time.March, 1, 10, 20, 30, 123000000, time.UTC)');
    expect(code).toContain('{Key: "n", Value: int64(9007199254740993)}');
    expect(code.match(/^func objectID/gm)).toHaveLength(1);
    expect(code.match(/^func decimal128/gm)).toHaveLength(1);
  });

  it('imports math for special numbers and time for dates in a program', () => {
    const code = generateCode('go', { kind: 'find', filter: { a: NaN, b: { $date: '2024-01-01T00:00:00.000Z' } } }, program);
    const imports = between(code, 'import (\n', '\n)');
    expect(imports).toContain('\t"math"');
    expect(imports).toContain('\t"time"');
    expect(code).toContain('math.NaN()');
  });

  it('writes a UUID as its bytes', () => {
    const code = generateCode('go', { kind: 'find', filter: { u: { $uuid: '00010203-0405-0607-0809-0a0b0c0d0e0f' } } }, snippet);
    expect(code).toContain(
      'bson.Binary{Subtype: 0x04, Data: []byte{0x00, 0x01, 0x02, 0x03, 0x04, 0x05, 0x06, 0x07, 0x08, 0x09, 0x0a, 0x0b, 0x0c, 0x0d, 0x0e, 0x0f}}',
    );
  });
});

describe('every language', () => {
  const languages = CODE_LANGUAGES.map((l) => l.id) as CodeLanguage[];

  it('names the database and the collection in a program', () => {
    for (const language of languages) {
      const code = generateCode(language, find(), program);
      expect(code, language).toContain('"shop"');
      expect(code, language).toContain('"orders"');
    }
  });

  it('writes an aggregation with every stage', () => {
    const pipeline = [{ $match: { status: 'A' } }, { $group: { _id: '$cust', total: { $sum: '$amount' } } }, { $sort: { total: -1 } }];
    for (const language of languages) {
      const code = generateCode(language, { kind: 'aggregate', pipeline }, snippet);
      for (const key of ['$match', '$group', '$sort', '$cust', '$amount']) expect(code, `${language} ${key}`).toContain(key);
    }
  });

  it('keeps a snippet free of connection code', () => {
    for (const language of languages) {
      const code = generateCode(language, find(), snippet);
      expect(code, language).not.toMatch(/MONGODB_URI|import |using /);
    }
  });
});
