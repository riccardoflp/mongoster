import { BSON, Decimal128, Int32, Long, ObjectId } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { COPY_MANY_FORMATS, CopyManyFormat, formatDocuments, parseDocuments } from '../../src/shared/formats';
import { parseQuery, relaxEjson } from '../../src/shared/query';

/** The BSON values behind EJSON text, whatever wrapper spells them ({ $uuid } or { $binary }, ISO or ms dates). */
const values = (v: unknown) => BSON.EJSON.serialize(BSON.EJSON.deserialize(v as BSON.Document, { relaxed: false }), { relaxed: false });

/** Documents as the table gives them: relaxed EJSON. */
const relaxed = (docs: object[]) => docs.map((d) => relaxEjson(BSON.EJSON.serialize(d, { relaxed: false })) as Record<string, unknown>);

const docs = relaxed([
  {
    _id: new ObjectId('65a1b2c3d4e5f60718293a4b'),
    name: 'Ada "the first" Lovelace',
    note: 'line one\nline two',
    age: new Int32(36),
    big: Long.fromString('9223372036854775807'),
    small: Long.fromNumber(5),
    price: Decimal128.fromString('19.99'),
    ratio: 0.25,
    when: new Date('2024-02-29T12:00:00Z'),
    old: new Date('1900-01-01T00:00:00Z'),
    uuid: new BSON.UUID('0123456789abcdef0123456789abcdef'),
    tags: ['a', 'b'],
    nested: { deep: { flag: true, none: null }, empty: {}, list: [] },
    unicode: 'città \u{1F680}',
  },
  { _id: 2, name: 'second', tags: [] },
]);

describe('formatDocuments', () => {
  it('has a label for each format', () => {
    expect(COPY_MANY_FORMATS.map((f) => f.id)).toEqual(['shell', 'ejson', 'jsonl', 'json', 'yaml', 'insert']);
  });

  it.each<CopyManyFormat>(['shell', 'ejson', 'jsonl', 'insert'])('writes %s text that the insert dialog reads back to the same documents', (format) => {
    const text = formatDocuments(docs, format, 'people');
    const back = parseDocuments(text);
    expect(back).toHaveLength(2);
    expect(values(back)).toEqual(values(docs));
    // Same types too: an Int32 stays an int, a Long a long.
    const typed = BSON.EJSON.deserialize(back[0] as BSON.Document, { relaxed: false });
    expect(typed.big).toBeInstanceOf(Long);
    expect(typed.price).toBeInstanceOf(Decimal128);
    expect(typed._id).toBeInstanceOf(ObjectId);
  });

  it('writes one document per line in JSON Lines', () => {
    const lines = formatDocuments(docs, 'jsonl', 'c').split('\n');
    expect(lines).toHaveLength(3);
    expect(lines[2]).toBe('');
    expect(JSON.parse(lines[1])).toEqual(docs[1]);
  });

  it('writes an insertMany command for the collection', () => {
    const text = formatDocuments(docs, 'insert', 'my coll');
    expect(text.startsWith('db.getCollection("my coll").insertMany([')).toBe(true);
    expect(text.endsWith(');')).toBe(true);
    expect(text).toContain('ObjectId("65a1b2c3d4e5f60718293a4b")');
  });

  it('writes plain JSON with ids and dates as strings, numbers as numbers when exact', () => {
    const [first, second] = JSON.parse(formatDocuments(docs, 'json', 'c'));
    expect(first).toMatchObject({
      _id: '65a1b2c3d4e5f60718293a4b',
      age: 36,
      big: '9223372036854775807',
      small: 5,
      price: 19.99,
      when: '2024-02-29T12:00:00.000Z',
      old: '1900-01-01T00:00:00.000Z',
      uuid: '01234567-89ab-cdef-0123-456789abcdef',
      nested: { deep: { flag: true, none: null } },
    });
    expect(second).toEqual({ _id: 2, name: 'second', tags: [] });
  });

  it('writes a YAML list of the documents', () => {
    const yaml = formatDocuments(docs, 'yaml', 'c');
    expect(yaml).toMatch(/^- _id: "?65a1b2c3d4e5f60718293a4b"?\n {2}name: "Ada \\"the first\\" Lovelace"\n/);
    expect(yaml).toContain('\n  when: 2024-02-29T12:00:00.000Z\n');
    expect(yaml).toContain('\n  note: |-\n    line one\n    line two\n');
    expect(yaml).toContain('\n- _id: 2\n  name: second\n  tags: []\n');
    expect(formatDocuments([], 'yaml', 'c')).toBe('[]\n');
  });

  it('writes empty selections as empty arrays', () => {
    expect(parseQuery(formatDocuments([], 'shell', 'c'))).toEqual([]);
    expect(formatDocuments([], 'ejson', 'c')).toBe('[]');
    expect(formatDocuments([], 'json', 'c')).toBe('[]');
    expect(formatDocuments([], 'jsonl', 'c')).toBe('\n');
  });
});
