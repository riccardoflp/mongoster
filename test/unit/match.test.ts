import { describe, expect, it } from 'vitest';
import { BSON } from 'mongodb';
import { MatchError, compileFilter } from '../../src/shared/match';
import { parseQuery, relaxEjson } from '../../src/shared/query';

const { EJSON } = BSON;

/** A document as the table has it: BSON values serialized to relaxed Extended JSON by the host. */
const relaxed = (doc: Record<string, unknown>) => relaxEjson(EJSON.serialize(doc, { relaxed: false }));

/** Whether the document (mongosh syntax) matches the filter (mongosh syntax). */
const matches = (filter: string, doc: string) => compileFilter(parseQuery(filter))(parseQuery(doc));

/** The error a filter is refused with. */
const refusal = (filter: string) => {
  try {
    compileFilter(parseQuery(filter));
  } catch (err) {
    expect(err).toBeInstanceOf(MatchError);
    return (err as Error).message;
  }
  throw new Error(`${filter} was accepted`);
};

describe('query.match: equality', () => {
  it('matches a field equal to a value', () => {
    expect(matches('{ status: "failed" }', '{ status: "failed" }')).toBe(true);
    expect(matches('{ status: "failed" }', '{ status: "ok" }')).toBe(false);
    expect(matches('{ status: "failed" }', '{ other: 1 }')).toBe(false);
  });

  it('ands the fields of the condition, and an empty condition matches everything', () => {
    expect(matches('{ a: 1, b: 2 }', '{ a: 1, b: 2 }')).toBe(true);
    expect(matches('{ a: 1, b: 2 }', '{ a: 1, b: 3 }')).toBe(false);
    expect(matches('{}', '{ a: 1 }')).toBe(true);
  });

  it('compares numbers by value across int, long, double and decimal', () => {
    const doc = relaxed({ i: new BSON.Int32(5), l: BSON.Long.fromNumber(5), d: new BSON.Double(5), m: BSON.Decimal128.fromString('5.0') });
    for (const f of ['i', 'l', 'd', 'm']) {
      expect(compileFilter(parseQuery(`{ ${f}: 5 }`))(doc), f).toBe(true);
      expect(compileFilter(parseQuery(`{ ${f}: NumberLong(5) }`))(doc), f).toBe(true);
      expect(compileFilter(parseQuery(`{ ${f}: NumberDecimal("5") }`))(doc), f).toBe(true);
    }
    expect(matches('{ n: 1 }', '{ n: "1" }')).toBe(false);
  });

  it('matches ObjectIds, dates, UUIDs and booleans as their types', () => {
    const doc = relaxed({
      _id: new BSON.ObjectId('64b7f0c2a1b2c3d4e5f60718'),
      at: new Date('2024-05-01T10:00:00Z'),
      uid: new BSON.UUID('0e2b4a5c-1d2e-4f30-8a1b-2c3d4e5f6071'),
      ok: true,
    });
    const m = (f: string) => compileFilter(parseQuery(f))(doc);
    expect(m('{ _id: ObjectId("64b7f0c2a1b2c3d4e5f60718") }')).toBe(true);
    expect(m('{ _id: ObjectId("64b7f0c2a1b2c3d4e5f60719") }')).toBe(false);
    expect(m('{ _id: "64b7f0c2a1b2c3d4e5f60718" }')).toBe(false);
    expect(m('{ at: ISODate("2024-05-01T10:00:00Z") }')).toBe(true);
    expect(m('{ uid: UUID("0e2b4a5c-1d2e-4f30-8a1b-2c3d4e5f6071") }')).toBe(true);
    expect(m('{ ok: true }')).toBe(true);
    expect(m('{ ok: 1 }')).toBe(false);
  });

  it('treats a missing field as null', () => {
    expect(matches('{ deletedAt: null }', '{ a: 1 }')).toBe(true);
    expect(matches('{ deletedAt: null }', '{ deletedAt: null }')).toBe(true);
    expect(matches('{ deletedAt: null }', '{ deletedAt: 0 }')).toBe(false);
  });

  it('compares sub-documents whole, with their fields in the same order', () => {
    expect(matches('{ size: { h: 14, w: 21 } }', '{ size: { h: 14, w: 21 } }')).toBe(true);
    expect(matches('{ size: { h: 14, w: 21 } }', '{ size: { w: 21, h: 14 } }')).toBe(false);
    expect(matches('{ size: { h: 14 } }', '{ size: { h: 14, w: 21 } }')).toBe(false);
  });

  it('follows dotted paths into sub-documents', () => {
    expect(matches('{ "address.city": "Rome" }', '{ address: { city: "Rome" } }')).toBe(true);
    expect(matches('{ "address.city": "Rome" }', '{ address: "Rome" }')).toBe(false);
    expect(matches('{ "address.city": null }', '{ address: "Rome" }')).toBe(true);
  });

  it('matches an array equal to the value or with an element equal to it', () => {
    expect(matches('{ tags: "red" }', '{ tags: ["blue", "red"] }')).toBe(true);
    expect(matches('{ tags: ["blue", "red"] }', '{ tags: ["blue", "red"] }')).toBe(true);
    expect(matches('{ tags: ["red", "blue"] }', '{ tags: ["blue", "red"] }')).toBe(false);
    expect(matches('{ tags: "green" }', '{ tags: ["blue", "red"] }')).toBe(false);
  });

  it('goes through arrays of sub-documents, and takes a number as an index', () => {
    const doc = '{ items: [ { sku: "a", qty: 1 }, { sku: "b", qty: 7 } ] }';
    expect(matches('{ "items.sku": "b" }', doc)).toBe(true);
    expect(matches('{ "items.sku": "c" }', doc)).toBe(false);
    expect(matches('{ "items.1.qty": 7 }', doc)).toBe(true);
    expect(matches('{ "items.0.qty": 7 }', doc)).toBe(false);
    expect(matches('{ "tags.0": "x" }', '{ tags: ["x", "y"] }')).toBe(true);
  });

  it('matches strings with a regex value', () => {
    expect(matches('{ email: /@example\\.com$/i }', '{ email: "Ada@EXAMPLE.com" }')).toBe(true);
    expect(matches('{ email: /@example\\.com$/ }', '{ email: "ada@example.org" }')).toBe(false);
    expect(matches('{ email: /x/ }', '{ email: 1 }')).toBe(false);
    expect(matches('{ tags: /^re/ }', '{ tags: ["blue", "red"] }')).toBe(true);
  });
});

describe('query.match: comparison', () => {
  it('compares numbers with $gt, $gte, $lt and $lte', () => {
    expect(matches('{ amount: { $gt: 1000 } }', '{ amount: 1500 }')).toBe(true);
    expect(matches('{ amount: { $gt: 1000 } }', '{ amount: 1000 }')).toBe(false);
    expect(matches('{ amount: { $gte: 1000 } }', '{ amount: 1000 }')).toBe(true);
    expect(matches('{ amount: { $lt: 0 } }', '{ amount: -0.5 }')).toBe(true);
    expect(matches('{ amount: { $lte: 10, $gt: 5 } }', '{ amount: 10 }')).toBe(true);
    expect(matches('{ amount: { $lte: 10, $gt: 5 } }', '{ amount: 5 }')).toBe(false);
    expect(matches('{ amount: { $gt: NumberLong(1) } }', '{ amount: NumberDecimal("1.5") }')).toBe(true);
  });

  it('never compares values of different types, as MongoDB brackets them', () => {
    expect(matches('{ amount: { $gt: 5 } }', '{ amount: "10" }')).toBe(false);
    expect(matches('{ amount: { $lt: 5 } }', '{ amount: "1" }')).toBe(false);
    expect(matches('{ amount: { $lt: 5 } }', '{ amount: null }')).toBe(false);
    expect(matches('{ amount: { $gt: 5 } }', '{ other: 1 }')).toBe(false);
  });

  it('compares strings by code point and dates by time', () => {
    expect(matches('{ name: { $gte: "M" } }', '{ name: "Mario" }')).toBe(true);
    expect(matches('{ name: { $gte: "M" } }', '{ name: "mario" }')).toBe(true);
    expect(matches('{ name: { $lt: "M" } }', '{ name: "mario" }')).toBe(false);
    expect(matches('{ at: { $gte: ISODate("2024-01-01") } }', '{ at: ISODate("2024-03-01T00:00:00Z") }')).toBe(true);
    expect(matches('{ at: { $gte: ISODate("2024-01-01") } }', '{ at: ISODate("2023-12-31T23:59:59Z") }')).toBe(false);
    expect(matches('{ at: { $gte: ISODate("2024-01-01") } }', '{ at: "2024-06-01" }')).toBe(false);
  });

  it('reads dates written with $numberLong milliseconds, as relaxEjson leaves them outside 1970–9999', () => {
    const doc = relaxed({ at: new Date(-1000) });
    expect(compileFilter(parseQuery('{ at: { $lt: ISODate("1970-01-01T00:00:00Z") } }'))(doc)).toBe(true);
  });

  it('compares ObjectIds by their hex value', () => {
    const doc = '{ _id: ObjectId("64b7f0c2a1b2c3d4e5f60718") }';
    expect(matches('{ _id: { $gt: ObjectId("64b7f0c2a1b2c3d4e5f60700") } }', doc)).toBe(true);
    expect(matches('{ _id: { $gt: ObjectId("64b7f0c2a1b2c3d4e5f60719") } }', doc)).toBe(false);
  });

  it('compares the elements of an array', () => {
    expect(matches('{ scores: { $gt: 90 } }', '{ scores: [70, 95] }')).toBe(true);
    expect(matches('{ scores: { $gt: 90 } }', '{ scores: [70, 85] }')).toBe(false);
    // Each bound may be met by a different element, as in MongoDB.
    expect(matches('{ scores: { $gt: 80, $lt: 75 } }', '{ scores: [70, 95] }')).toBe(true);
  });

  it('$gte and $lte null match null and a missing field', () => {
    expect(matches('{ a: { $gte: null } }', '{ b: 1 }')).toBe(true);
    expect(matches('{ a: { $gt: null } }', '{ a: null }')).toBe(false);
  });

  it('$ne and $nin are the negations of $eq and $in', () => {
    expect(matches('{ status: { $ne: "ok" } }', '{ status: "failed" }')).toBe(true);
    expect(matches('{ status: { $ne: "ok" } }', '{ other: 1 }')).toBe(true);
    expect(matches('{ status: { $ne: null } }', '{ other: 1 }')).toBe(false);
    expect(matches('{ tags: { $ne: "red" } }', '{ tags: ["blue", "red"] }')).toBe(false);
    expect(matches('{ status: { $nin: ["ok", "skipped"] } }', '{ status: "failed" }')).toBe(true);
    expect(matches('{ status: { $nin: ["ok", "skipped"] } }', '{ status: "ok" }')).toBe(false);
  });

  it('$eq with a regex is equality, not a match', () => {
    expect(matches('{ name: { $eq: /a/ } }', '{ name: "a" }')).toBe(false);
    expect(matches('{ name: { $eq: /a/ } }', '{ name: /a/ }')).toBe(true);
  });
});

describe('query.match: sets and arrays', () => {
  it('$in matches values and regexes, null for a missing field', () => {
    expect(matches('{ status: { $in: ["failed", "error"] } }', '{ status: "error" }')).toBe(true);
    expect(matches('{ status: { $in: ["failed", "error"] } }', '{ status: "ok" }')).toBe(false);
    expect(matches('{ status: { $in: [/^fail/, "x"] } }', '{ status: "failure" }')).toBe(true);
    expect(matches('{ status: { $in: [null] } }', '{ other: 1 }')).toBe(true);
    expect(matches('{ tags: { $in: ["red"] } }', '{ tags: ["blue", "red"] }')).toBe(true);
  });

  it('$all needs every value, $size the length', () => {
    expect(matches('{ tags: { $all: ["red", "blue"] } }', '{ tags: ["blue", "green", "red"] }')).toBe(true);
    expect(matches('{ tags: { $all: ["red", "pink"] } }', '{ tags: ["blue", "green", "red"] }')).toBe(false);
    expect(matches('{ tags: { $all: [] } }', '{ tags: [] }')).toBe(false);
    expect(matches('{ tags: { $size: 2 } }', '{ tags: [1, 2] }')).toBe(true);
    expect(matches('{ tags: { $size: 2 } }', '{ tags: [1] }')).toBe(false);
    expect(matches('{ tags: { $size: 0 } }', '{ tags: "x" }')).toBe(false);
  });

  it('$elemMatch needs one element meeting every condition', () => {
    const doc = '{ items: [ { sku: "a", qty: 1 }, { sku: "b", qty: 7 } ] }';
    expect(matches('{ items: { $elemMatch: { sku: "b", qty: { $gt: 5 } } } }', doc)).toBe(true);
    expect(matches('{ items: { $elemMatch: { sku: "a", qty: { $gt: 5 } } } }', doc)).toBe(false);
    expect(matches('{ scores: { $elemMatch: { $gt: 80, $lt: 85 } } }', '{ scores: [70, 95] }')).toBe(false);
    expect(matches('{ scores: { $elemMatch: { $gt: 80, $lt: 85 } } }', '{ scores: [70, 82] }')).toBe(true);
    expect(matches('{ items: { $elemMatch: { $or: [ { sku: "z" }, { qty: 1 } ] } } }', doc)).toBe(true);
    expect(matches('{ items: { $all: [ { $elemMatch: { qty: 7 } } ] } }', doc)).toBe(true);
  });
});

describe('query.match: $exists, $type, $regex, $mod, $not', () => {
  it('$exists tells a field present (even null) from a missing one', () => {
    expect(matches('{ deletedAt: { $exists: true } }', '{ deletedAt: null }')).toBe(true);
    expect(matches('{ deletedAt: { $exists: true } }', '{ a: 1 }')).toBe(false);
    expect(matches('{ deletedAt: { $exists: false } }', '{ a: 1 }')).toBe(true);
    expect(matches('{ "items.qty": { $exists: false } }', '{ items: [ { qty: 1 }, {} ] }')).toBe(false);
    expect(matches('{ "items.qty": { $exists: true } }', '{ items: [ {}, {} ] }')).toBe(false);
  });

  it('$type knows names, numbers and "number", and looks into arrays', () => {
    const doc = relaxed({
      s: 'x',
      i: 3,
      d: 1.5,
      l: BSON.Long.fromString('9007199254740993'),
      m: BSON.Decimal128.fromString('1.1'),
      o: new BSON.ObjectId(),
      t: new Date(),
      a: ['x', 1],
      sub: { x: 1 },
      n: null,
      b: false,
    });
    const m = (f: string) => compileFilter(parseQuery(f))(doc);
    expect(m('{ s: { $type: "string" } }')).toBe(true);
    expect(m('{ s: { $type: 2 } }')).toBe(true);
    expect(m('{ i: { $type: "int" } }')).toBe(true);
    expect(m('{ d: { $type: "double" } }')).toBe(true);
    expect(m('{ d: { $type: "int" } }')).toBe(false);
    expect(m('{ l: { $type: "long" } }')).toBe(true);
    expect(m('{ m: { $type: "decimal" } }')).toBe(true);
    expect(m('{ o: { $type: "objectId" } }')).toBe(true);
    expect(m('{ t: { $type: "date" } }')).toBe(true);
    expect(m('{ a: { $type: "array" } }')).toBe(true);
    expect(m('{ a: { $type: "number" } }')).toBe(true);
    expect(m('{ sub: { $type: "object" } }')).toBe(true);
    expect(m('{ n: { $type: "null" } }')).toBe(true);
    expect(m('{ b: { $type: "bool" } }')).toBe(true);
    expect(m('{ s: { $type: ["int", "string"] } }')).toBe(true);
    expect(m('{ missing: { $type: "null" } }')).toBe(false);
    for (const f of ['i', 'd', 'l', 'm']) expect(m(`{ ${f}: { $type: "number" } }`), f).toBe(true);
  });

  it('a whole number is int, long and double: the table does not tell them apart', () => {
    const doc = relaxed({ d: new BSON.Double(2) });
    for (const t of ['int', 'long', 'double']) expect(compileFilter(parseQuery(`{ d: { $type: "${t}" } }`))(doc), t).toBe(true);
  });

  it('$regex takes a string or a regex, with $options', () => {
    expect(matches('{ name: { $regex: "^ad", $options: "i" } }', '{ name: "Ada" }')).toBe(true);
    expect(matches('{ name: { $regex: "^ad" } }', '{ name: "Ada" }')).toBe(false);
    expect(matches('{ name: { $regex: /^ad/i } }', '{ name: "Ada" }')).toBe(true);
    expect(matches('{ name: { $regex: "a d # comment", $options: "x" } }', '{ name: "xad" }')).toBe(true);
    expect(matches('{ text: { $regex: "a.b", $options: "s" } }', '{ text: "a\\nb" }')).toBe(true);
  });

  it('$mod divides the integer part', () => {
    expect(matches('{ n: { $mod: [4, 1] } }', '{ n: 9 }')).toBe(true);
    expect(matches('{ n: { $mod: [4, 1] } }', '{ n: 9.9 }')).toBe(true);
    expect(matches('{ n: { $mod: [4, 1] } }', '{ n: 8 }')).toBe(false);
    expect(matches('{ n: { $mod: [4, 1] } }', '{ n: "9" }')).toBe(false);
  });

  it('$not negates an operator or a regex, and matches a missing field', () => {
    expect(matches('{ amount: { $not: { $gt: 100 } } }', '{ amount: 50 }')).toBe(true);
    expect(matches('{ amount: { $not: { $gt: 100 } } }', '{ amount: 500 }')).toBe(false);
    expect(matches('{ amount: { $not: { $gt: 100 } } }', '{ other: 1 }')).toBe(true);
    expect(matches('{ name: { $not: /^a/ } }', '{ name: "bob" }')).toBe(true);
  });
});

describe('query.match: logic', () => {
  it('$and, $or and $nor combine conditions, at any level', () => {
    expect(matches('{ $or: [ { status: "failed" }, { amount: { $gt: 1000 } } ] }', '{ status: "ok", amount: 2000 }')).toBe(true);
    expect(matches('{ $or: [ { status: "failed" }, { amount: { $gt: 1000 } } ] }', '{ status: "ok", amount: 20 }')).toBe(false);
    expect(matches('{ $and: [ { a: 1 }, { b: 2 } ] }', '{ a: 1, b: 2 }')).toBe(true);
    expect(matches('{ $nor: [ { a: 1 }, { b: 2 } ] }', '{ a: 3, b: 3 }')).toBe(true);
    expect(matches('{ $nor: [ { a: 1 }, { b: 2 } ] }', '{ a: 1 }')).toBe(false);
    expect(matches('{ x: 1, $or: [ { $and: [ { a: 1 }, { b: 1 } ] }, { c: 1 } ] }', '{ x: 1, a: 1, b: 1 }')).toBe(true);
  });

  it('ignores $comment', () => {
    expect(matches('{ a: 1, $comment: "why" }', '{ a: 1 }')).toBe(true);
  });
});

describe('query.match: refusals', () => {
  it('refuses the operators that need the server', () => {
    expect(refusal('{ $expr: { $gt: ["$a", "$b"] } }')).toBe('$expr is not supported in a formatting rule.');
    expect(refusal('{ $where: "this.a > 1" }')).toBe('$where is not supported in a formatting rule.');
    expect(refusal('{ $text: { $search: "x" } }')).toBe('$text is not supported in a formatting rule.');
    expect(refusal('{ loc: { $near: [0, 0] } }')).toBe('$near is not supported in a formatting rule.');
    expect(refusal('{ flags: { $bitsAllSet: 3 } }')).toBe('$bitsAllSet is not supported in a formatting rule.');
  });

  it('refuses unknown operators and malformed operands, saying what is wrong', () => {
    expect(refusal('{ a: { $foo: 1 } }')).toBe('Unknown operator $foo.');
    expect(refusal('{ $foo: 1 }')).toBe('Unknown operator $foo.');
    expect(refusal('{ a: { $in: 1 } }')).toBe('$in needs an array.');
    expect(refusal('{ $or: [] }')).toBe('$or needs a non-empty array of conditions.');
    expect(refusal('{ a: { $or: [ { b: 1 } ] } }')).toBe('$or goes at the top of the condition or inside $elemMatch, not on a field.');
    expect(refusal('{ a: { $mod: [0, 1] } }')).toBe('$mod: the divisor can not be 0.');
    expect(refusal('{ a: { $type: "text" } }')).toBe('$type: unknown type "text".');
    expect(refusal('{ a: { $not: 1 } }')).toBe('$not needs an operator such as { $gt: 1 } or a regular expression.');
    expect(refusal('{ a: { $options: "i" } }')).toBe('$options needs $regex.');
    expect(refusal('{ a: { $regex: "(" } }')).toMatch(/^Invalid regular expression \/\(\/: /);
    expect(refusal('[1, 2]')).toBe('The condition must be a document: { field: value }.');
  });
});
