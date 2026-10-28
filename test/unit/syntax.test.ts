import { describe, expect, it } from 'vitest';
import { tokenize } from '../../src/shared/syntax';

/** The tokens as [text, role]. */
const tokens = (src: string) => tokenize(src).map((t) => [src.slice(t.from, t.to), t.role]);

describe('tokenize', () => {
  it('tells keys, operators, strings, field references and numbers apart', () => {
    expect(tokens('{ name: "Mario", $or: [{ "age": { $gte: -1.5e3 } }], total: "$amount", "$expr": 1 }')).toEqual([
      ['name', 'key'],
      ['"Mario"', 'string'],
      ['$or', 'op'],
      ['"age"', 'key'],
      ['$gte', 'op'],
      ['-1.5e3', 'number'],
      ['total', 'key'],
      ['"$amount"', 'ref'],
      ['"$expr"', 'op'],
      ['1', 'number'],
    ]);
  });

  it('colors a helper together with its argument', () => {
    expect(tokens('{ _id: ObjectId("65a1b2c3d4e5f60718293a4b"), at: ISODate(), n: NumberLong(5), d: new Date(\'2024\') }')).toEqual([
      ['_id', 'key'],
      ['ObjectId("65a1b2c3d4e5f60718293a4b")', 'oid'],
      ['at', 'key'],
      ['ISODate()', 'date'],
      ['n', 'key'],
      ['NumberLong(5)', 'number'],
      ['d', 'key'],
      ['new', 'op'],
      ["Date('2024')", 'date'],
    ]);
  });

  it('colors constants and leaves unknown words alone', () => {
    expect(tokens('[true, null, MinKey(), foo, NaN]')).toEqual([
      ['true', 'bool'],
      ['null', 'bool'],
      ['MinKey', 'bool'],
      ['NaN', 'number'],
    ]);
  });

  it('reads a regex where a value starts and a division elsewhere', () => {
    expect(tokens('{ a: /x\\/y[/]/i }')).toEqual([
      ['a', 'key'],
      ['/x\\/y[/]/i', 'regex'],
    ]);
    expect(tokens('{ $divide: [a / 2, 3] }').map(([, role]) => role)).toEqual(['op', 'number', 'number']);
  });

  it('reads comments, and no tokens inside them or inside strings', () => {
    expect(tokens('// a: 1\n{ b: "// c" /* d: 2 */ }')).toEqual([
      ['// a: 1', 'comment'],
      ['b', 'key'],
      ['"// c"', 'string'],
      ['/* d: 2 */', 'comment'],
    ]);
  });

  it('ends an unterminated string at the end of its line', () => {
    expect(tokens('{ a: "open\n  b: 1 }')).toEqual([
      ['a', 'key'],
      ['"open\n', 'string'],
      ['b', 'key'],
      ['1', 'number'],
    ]);
  });

  it('does not take properties of Object.prototype for helpers', () => {
    expect(tokens('[constructor, toString]')).toEqual([]);
  });
});
