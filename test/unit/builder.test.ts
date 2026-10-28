import { describe, expect, it } from 'vitest';
import { BuilderQuery, BuilderRow, filterToRows, parseValue, rowComplete, rowsToFilter } from '../../src/shared/builder';
import { parseQuery } from '../../src/shared/query';

const OID = '65a1b2c3d4e5f60718293a4b';
const row = (field: string, op: BuilderRow['op'], value = ''): BuilderRow => ({ field, op, value });
const and = (...rows: BuilderRow[]): BuilderQuery => ({ combine: 'and', rows });
const or = (...rows: BuilderRow[]): BuilderQuery => ({ combine: 'or', rows });

describe('filterToRows', () => {
  it('shows each field condition as a row', () => {
    expect(filterToRows(parseQuery(`{ name: "Mario", _id: ObjectId("${OID}"), tags: { $in: ["a", "b"] } }`))).toEqual(
      and(row('name', 'eq', '"Mario"'), row('_id', 'eq', `ObjectId("${OID}")`), row('tags', 'in', '["a", "b"]')),
    );
  });

  it('splits a range into one row per operator', () => {
    expect(filterToRows({ age: { $gte: 20, $lt: 30 }, n: { $ne: null } })).toEqual(
      and(row('age', 'gte', '20'), row('age', 'lt', '30'), row('n', 'ne', 'null')),
    );
  });

  it('reads $and and $or lists of single-field conditions', () => {
    expect(filterToRows({ $or: [{ a: 1 }, { b: { $gt: 2 } }] })).toEqual(or(row('a', 'eq', '1'), row('b', 'gt', '2')));
    expect(filterToRows({ $and: [{ a: { $gt: 1 } }, { a: { $gt: 5 } }] })).toEqual(and(row('a', 'gt', '1'), row('a', 'gt', '5')));
  });

  it('reads regular expressions, $regex with $options, $exists, $type and $size', () => {
    expect(
      filterToRows({
        a: { $regularExpression: { pattern: '^x', options: 'i' } },
        b: { $regex: 'y$', $options: 'm' },
        c: { $exists: true },
        d: { $exists: 0 },
        e: { $type: 'string' },
        f: { $size: 2 },
      }),
    ).toEqual(
      and(
        row('a', 'regex', '/^x/i'),
        row('b', 'regex', '/y$/m'),
        row('c', 'exists'),
        row('d', 'missing'),
        row('e', 'type', 'string'),
        row('f', 'size', '2'),
      ),
    );
  });

  it('shows a document value as = when it has no operators', () => {
    expect(filterToRows({ address: { city: 'Rome' } })).toEqual(and(row('address', 'eq', '{ city: "Rome" }')));
  });

  it('gives an empty and-query for an empty filter', () => {
    expect(filterToRows({})).toEqual(and());
  });

  it('gives undefined for filters the rows cannot show', () => {
    const unrepresentable: unknown[] = [
      [{ a: 1 }],
      'x',
      { $expr: { $gt: ['$a', '$b'] } },
      { a: 1, $or: [{ b: 1 }, { c: 1 }] },
      { $or: [] },
      { $or: [{ a: 1, b: 2 }] },
      { $or: [{ $and: [{ a: 1 }] }] },
      { $or: [{ a: { $gt: 1, $lt: 5 } }] },
      { $or: ['x'] },
      { a: { $elemMatch: { b: 1 } } },
      { a: { $not: { $gt: 1 } } },
      { a: { $in: 'not a list' } },
      { a: { $exists: 'yes' } },
      { a: { $type: 2 } },
      { a: { $size: '2' } },
      { a: { $options: 'i' } },
      { a: { $regex: 'x', $options: 1 } },
      { a: { $regex: { $regularExpression: { pattern: 'x', options: 'i' } }, $options: 'm' } },
      { a: { b: 1, $c: 2 } },
    ];
    for (const filter of unrepresentable) expect(filterToRows(filter), JSON.stringify(filter)).toBeUndefined();
  });
});

describe('parseValue', () => {
  it('reads mongosh values, or else keeps the text', () => {
    expect(parseValue(' 42 ')).toBe(42);
    expect(parseValue('"42"')).toBe('42');
    expect(parseValue('true')).toBe(true);
    expect(parseValue('null')).toBe(null);
    expect(parseValue('ISODate("2024-01-01")')).toEqual({ $date: '2024-01-01T00:00:00.000Z' });
    expect(parseValue('[1, 2]')).toEqual([1, 2]);
    expect(parseValue('Mario')).toBe('Mario');
    expect(parseValue('hello world')).toBe('hello world');
    expect(parseValue('1, 2')).toBe('1, 2');
    expect(parseValue("it's")).toBe("it's");
  });
});

describe('rowComplete', () => {
  it('needs a field, and a value unless the operator takes none', () => {
    expect(rowComplete(row('a', 'eq', '1'))).toBe(true);
    expect(rowComplete(row(' ', 'eq', '1'))).toBe(false);
    expect(rowComplete(row('a', 'eq', '  '))).toBe(false);
    expect(rowComplete(row('a', 'exists'))).toBe(true);
    expect(rowComplete(row('a', 'missing'))).toBe(true);
  });
});

describe('rowsToFilter', () => {
  it('builds one object for and, skipping incomplete rows', () => {
    expect(rowsToFilter(and(row('name', 'eq', 'Mario'), row('', 'eq', '1'), row('age', 'gt', ''), row(' n ', 'lte', '5')))).toEqual({
      name: 'Mario',
      n: { $lte: 5 },
    });
    expect(rowsToFilter(and())).toEqual({});
  });

  it('merges the conditions on one field into a range', () => {
    expect(rowsToFilter(and(row('age', 'gte', '20'), row('age', 'lte', '30'), row('age', 'exists')))).toEqual({
      age: { $gte: 20, $lte: 30, $exists: true },
    });
  });

  it('uses $and when an operator repeats on a field', () => {
    expect(rowsToFilter(and(row('a', 'gt', '1'), row('b', 'eq', '2'), row('a', 'gt', '5')))).toEqual({
      $and: [{ a: { $gt: 1 } }, { b: 2 }, { a: { $gt: 5 } }],
    });
    expect(rowsToFilter(and(row('a', 'eq', '1'), row('a', 'eq', '2')))).toEqual({ $and: [{ a: 1 }, { a: 2 }] });
  });

  it('uses $or for or, unless there is a single row', () => {
    expect(rowsToFilter(or(row('a', 'eq', '1'), row('a', 'missing')))).toEqual({ $or: [{ a: 1 }, { a: { $exists: false } }] });
    expect(rowsToFilter(or(row('a', 'gt', '1')))).toEqual({ a: { $gt: 1 } });
  });

  it('reads the values of in / not in as a list', () => {
    expect(rowsToFilter(and(row('a', 'in', '[1, 2]')))).toEqual({ a: { $in: [1, 2] } });
    expect(rowsToFilter(and(row('a', 'in', '1, "x", true')))).toEqual({ a: { $in: [1, 'x', true] } });
    expect(rowsToFilter(and(row('a', 'nin', 'red, green ,blue')))).toEqual({ a: { $nin: ['red', 'green', 'blue'] } });
    expect(rowsToFilter(and(row('a', 'in', '[1, 2], 3')))).toEqual({ a: { $in: [[1, 2], 3] } });
    expect(rowsToFilter(and(row('a', 'in', '5')))).toEqual({ a: { $in: [5] } });
  });

  it('makes a regular expression of a regex row', () => {
    expect(rowsToFilter(and(row('a', 'regex', '/^ab/i')))).toEqual({ a: { $regularExpression: { pattern: '^ab', options: 'i' } } });
    expect(rowsToFilter(and(row('a', 'regex', 'http://x')))).toEqual({ a: { $regularExpression: { pattern: 'http://x', options: '' } } });
    expect(rowsToFilter(and(row('a', 'regex', '^a.b$')))).toEqual({ a: { $regularExpression: { pattern: '^a.b$', options: '' } } });
    // Two conditions on the field: the regex goes with $regex.
    expect(rowsToFilter(and(row('a', 'regex', '/x/'), row('a', 'exists')))).toEqual({
      a: { $regex: { $regularExpression: { pattern: 'x', options: '' } }, $exists: true },
    });
  });

  it('keeps $eq for a document value whose keys look like operators', () => {
    expect(rowsToFilter(and(row('a', 'eq', '{ $gt: 1 }')))).toEqual({ a: { $eq: { $gt: 1 } } });
    expect(rowsToFilter(and(row('a', 'eq', `ObjectId("${OID}")`)))).toEqual({ a: { $oid: OID } });
  });

  it('checks the value of size', () => {
    expect(rowsToFilter(and(row('a', 'size', '3')))).toEqual({ a: { $size: 3 } });
    expect(() => rowsToFilter(and(row('a', 'size', '-1')))).toThrow('a: size needs a whole number');
    expect(() => rowsToFilter(and(row('a', 'size', '1.5')))).toThrow('size needs a whole number');
    expect(() => rowsToFilter(and(row('a', 'size', 'two')))).toThrow('size needs a whole number');
  });

  it('passes the type name as it is', () => {
    expect(rowsToFilter(and(row('a', 'type', ' objectId ')))).toEqual({ a: { $type: 'objectId' } });
  });
});

describe('rows ⇄ filter round trip', () => {
  const filters: Record<string, unknown>[] = [
    { name: 'Mario', age: { $gte: 20, $lte: 30 } },
    { $or: [{ a: 1 }, { b: { $exists: false } }, { c: { $regularExpression: { pattern: '^x.y', options: 'i' } } }] },
    { $and: [{ a: { $gt: 1 } }, { a: { $gt: 5 } }] },
    { _id: { $oid: OID }, tags: { $nin: ['a', 'b'] }, n: { $size: 0 }, t: { $type: 'date' } },
    { when: { $lt: { $date: '2024-01-01T00:00:00.000Z' } }, big: { $numberLong: '9223372036854775807' } },
  ];
  for (const filter of filters) {
    it(JSON.stringify(filter), () => {
      const rows = filterToRows(filter);
      expect(rows).toBeDefined();
      expect(rowsToFilter(rows!)).toEqual(filter);
    });
  }
});
