import { describe, expect, it } from 'vitest';
import { buildColumns } from '../../src/shared/columns';
import { csvTable, csvToDocs, csvValue, parseCsv, toCsv } from '../../src/shared/csv';

describe('csvValue', () => {
  it('turns relaxed EJSON into spreadsheet text', () => {
    expect(csvValue(null)).toBe('');
    expect(csvValue(undefined)).toBe('');
    expect(csvValue('text')).toBe('text');
    expect(csvValue(1.5)).toBe('1.5');
    expect(csvValue(false)).toBe('false');
    expect(csvValue({ $oid: '64b000000000000000000001' })).toBe('64b000000000000000000001');
    expect(csvValue({ $numberLong: '9007199254740993' })).toBe('9007199254740993');
    expect(csvValue({ $numberDecimal: '1.10' })).toBe('1.10');
    expect(csvValue({ $date: '2024-01-02T03:04:05.000Z' })).toBe('2024-01-02T03:04:05.000Z');
    expect(csvValue({ $date: { $numberLong: '0' } })).toBe('1970-01-01T00:00:00.000Z');
    expect(csvValue({ a: 1 })).toBe('{"a":1}');
    expect(csvValue([1, 'x'])).toBe('[1,"x"]');
  });
});

describe('toCsv / parseCsv', () => {
  it('quotes only what needs it and ends rows with CRLF', () => {
    expect(toCsv([['a', 'b'], ['1', 'x,y']])).toBe('a,b\r\n1,"x,y"\r\n');
    expect(toCsv([['say "hi"', ' lead', 'trail ', 'multi\nline']])).toBe('"say ""hi"""," lead","trail ","multi\nline"\r\n');
  });

  it('round trips awkward fields', () => {
    const table = [
      ['id', 'text', 'empty'],
      ['1', 'comma, inside', ''],
      ['2', 'quote " inside', ''],
      ['3', 'line\nbreak\r\nand CRLF', 'x'],
      ['4', '  spaces  ', '""'],
      ['5', 'ünïcödé ✓', ''],
    ];
    expect(parseCsv(toCsv(table))).toEqual(table);
  });

  it('parses LF and CRLF, a BOM, and a last row without a newline', () => {
    expect(parseCsv('﻿a,b\nc,d\r\ne,f')).toEqual([
      ['a', 'b'],
      ['c', 'd'],
      ['e', 'f'],
    ]);
  });

  it('skips blank lines but keeps rows of empty fields', () => {
    expect(parseCsv('a,b\n\n,\n')).toEqual([
      ['a', 'b'],
      ['', ''],
    ]);
  });

  it('keeps a quote in the middle of an unquoted field', () => {
    expect(parseCsv('5" pipe,x\n')).toEqual([['5" pipe', 'x']]);
  });

  it('throws on an unterminated quoted field', () => {
    expect(() => parseCsv('a,"open\n')).toThrow(/Unterminated/);
  });
});

describe('csvToDocs', () => {
  it('infers types from the text', () => {
    const [doc] = csvToDocs([
      ['_id', 'n', 'neg', 'f', 'exp', 'big', 'zip', 't', 'nul', 'when', 'notdate', 'obj', 'arr', 'bad', 's'],
      ['64b000000000000000000001', '42', '-7', '1.5', '1e3', '12345678901234567890', '00123', 'true', 'null', '2024-01-02T03:04:05.000Z', '2024-01-02', '{"a":1}', '[1,2]', '{nope', 'hello'],
    ]);
    expect(doc).toEqual({
      _id: { $oid: '64b000000000000000000001' },
      n: 42,
      neg: -7,
      f: 1.5,
      exp: 1000,
      big: { $numberLong: '12345678901234567890' },
      zip: '00123',
      t: true,
      nul: null,
      when: { $date: '2024-01-02T03:04:05.000Z' },
      notdate: '2024-01-02',
      obj: { a: 1 },
      arr: [1, 2],
      bad: '{nope',
      s: 'hello',
    });
  });

  it('only turns 24-hex text into an ObjectId for _id', () => {
    const [doc] = csvToDocs([['ref'], ['64b000000000000000000001']]);
    expect(doc.ref).toBe('64b000000000000000000001');
  });

  it('builds sub-documents from dotted headers and leaves empty cells out', () => {
    expect(csvToDocs([['a.b', 'a.c', 'd'], ['1', '', 'x'], ['', '', '']])).toEqual([{ a: { b: 1 }, d: 'x' }, {}]);
  });

  it('rejects rows with more fields than the header', () => {
    expect(() => csvToDocs([['a'], ['1', '2']])).toThrow(/Row 2 has 2 fields/);
  });

  it('returns nothing without a header', () => {
    expect(csvToDocs([])).toEqual([]);
  });
});

describe('csvTable', () => {
  const docs: Record<string, unknown>[] = [
    { _id: 1, name: 'a', address: { city: 'Rome' }, items: [{ sku: 'x', qty: 1 }, { sku: 'y' }] },
    { _id: 2, items: [], address: 'unknown' },
  ];

  it('has one column per leaf and one row per document when nothing is expanded', () => {
    const table = csvTable(docs, buildColumns(docs, new Set()));
    expect(table).toEqual([
      ['_id', 'name', 'address', 'items'],
      ['1', 'a', '{"city":"Rome"}', '[{"sku":"x","qty":1},{"sku":"y"}]'],
      ['2', '', 'unknown', '[]'],
    ]);
  });

  it('flattens expanded sub-documents and repeats document values on each array element row', () => {
    const cols = buildColumns(docs, new Set(['address', 'items']));
    const table = csvTable(docs, cols);
    expect(table[0]).toEqual(['_id', 'name', 'address.city', 'items.sku', 'items.qty']);
    expect(table.slice(1)).toEqual([
      ['1', 'a', 'Rome', 'x', '1'],
      ['1', 'a', 'Rome', 'y', ''],
      // A non-object value at an expanded path goes in the group's first column; an empty array is one row.
      ['2', '', 'unknown', '[]', ''],
    ]);
  });

  it('round trips through CSV text into documents', () => {
    const flat = [{ _id: { $oid: '64b000000000000000000001' }, n: 3, tags: ['a', 'b'], when: { $date: '2024-05-06T00:00:00.000Z' } }];
    const text = toCsv(csvTable(flat, buildColumns(flat, new Set())));
    expect(csvToDocs(parseCsv(text))).toEqual(flat);
  });
});
