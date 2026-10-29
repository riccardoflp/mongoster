import { describe, expect, it } from 'vitest';
import { CONVERT_TYPES, and, convertField, fieldPathError, noArrayParents, removeField, renameError, renameField, typeCounts } from '../../src/fieldActions';

const notArray = { $not: { $type: 'array' } };

describe('field paths', () => {
  it('refuses empty parts, $ names and _id', () => {
    expect(fieldPathError('')).toBe('Enter a field name');
    expect(fieldPathError('a..b')).toMatch(/empty part/);
    expect(fieldPathError('a.')).toMatch(/empty part/);
    expect(fieldPathError('$a')).toMatch(/can't start with \$/);
    expect(fieldPathError('a.$b')).toMatch(/can't start with \$/);
    expect(fieldPathError('_id')).toBe("_id can't be changed");
    expect(fieldPathError('_id.x')).toBe("_id can't be changed");
    expect(fieldPathError('a._id')).toBeUndefined();
    expect(fieldPathError('address.city')).toBeUndefined();
  });

  it('refuses a rename to the same name or along the same path', () => {
    expect(renameError('a', 'a')).toBe('Enter a different name');
    expect(renameError('a', 'a.b')).toMatch(/same path/);
    expect(renameError('a.b', 'a')).toMatch(/same path/);
    expect(renameError('a', 'ab')).toBeUndefined();
    expect(renameError('a', '')).toBe('Enter a field name');
    expect(renameError('a.b', 'c.d')).toBeUndefined();
  });

  it('keeps out documents where a parent of the path is an array', () => {
    expect(noArrayParents('a')).toEqual([]);
    expect(noArrayParents('a.b.c')).toEqual([{ a: notArray }, { 'a.b': notArray }]);
  });

  it('joins conditions, without the empty ones', () => {
    expect(and()).toEqual({});
    expect(and({}, {})).toEqual({});
    expect(and({ a: 1 }, {})).toEqual({ a: 1 });
    expect(and({ a: 1 }, { b: 2 })).toEqual({ $and: [{ a: 1 }, { b: 2 }] });
  });
});

describe('renameField', () => {
  it('renames in the documents of the filter that have the field', () => {
    expect(renameField({}, 'old', 'new')).toEqual({
      filter: { old: { $exists: true } },
      update: { $rename: { old: 'new' } },
      reached: { old: { $exists: true } },
      overwrites: { $and: [{ old: { $exists: true } }, { new: { $exists: true } }] },
    });
  });

  it('leaves out documents with an array on either path', () => {
    const op = renameField({ status: 'a' }, 'a.b', 'c.d.e');
    expect(op.reached).toEqual({ $and: [{ status: 'a' }, { 'a.b': { $exists: true } }] });
    expect(op.filter).toEqual({ $and: [{ $and: [{ status: 'a' }, { 'a.b': { $exists: true } }] }, { a: notArray }, { c: notArray }, { 'c.d': notArray }] });
    expect(op.update).toEqual({ $rename: { 'a.b': 'c.d.e' } });
    expect(op.overwrites).toEqual({ $and: [op.filter, { 'c.d.e': { $exists: true } }] });
  });
});

describe('removeField', () => {
  it('unsets the field where no parent is an array', () => {
    expect(removeField({ x: 1 }, 'a.b')).toEqual({
      filter: { $and: [{ $and: [{ x: 1 }, { 'a.b': { $exists: true } }] }, { a: notArray }] },
      update: { $unset: { 'a.b': '' } },
      reached: { $and: [{ x: 1 }, { 'a.b': { $exists: true } }] },
    });
  });

  it('removes a field of array elements from every element', () => {
    expect(removeField({}, 'items.sku', 'items')).toEqual({
      filter: { $and: [{ 'items.sku': { $exists: true } }, { items: { $type: 'array' } }] },
      update: { $unset: { 'items.$[].sku': '' } },
      reached: { 'items.sku': { $exists: true } },
    });
    expect(removeField({}, 'order.items.meta.sku', 'order.items').update).toEqual({ $unset: { 'order.items.$[].meta.sku': '' } });
    expect(removeField({}, 'order.items.sku', 'order.items').filter).toEqual({
      $and: [{ 'order.items.sku': { $exists: true } }, { order: notArray }, { 'order.items': { $type: 'array' } }],
    });
  });
});

describe('convertField', () => {
  it('converts with $convert, keeping values that fail, null and arrays', () => {
    const op = convertField({ k: 1 }, 'price', 'decimal');
    const notYet = { price: { $exists: true, $not: { $type: ['decimal', 'null', 'array'] } } };
    expect(op).toEqual({
      filter: { $and: [{ k: 1 }, notYet] },
      update: [{ $set: { price: { $convert: { input: '$price', to: 'decimal', onError: '$price', onNull: '$price' } } } }],
      reached: { $and: [{ k: 1 }, notYet] },
    });
    expect(convertField({}, 'a.b', 'int').filter).toEqual({ $and: [{ a: notArray }, { 'a.b': { $exists: true, $not: { $type: ['int', 'null', 'array'] } } }] });
  });

  it('offers the types $convert knows', () => {
    expect(CONVERT_TYPES.map((t) => t.type)).toEqual(['string', 'int', 'long', 'double', 'decimal', 'bool', 'date', 'objectId']);
  });

  it('counts the types of the field', () => {
    expect(typeCounts({ x: 1 }, 'a.b')).toEqual([
      { $match: { $and: [{ x: 1 }, { a: notArray }, { 'a.b': { $exists: true } }] } },
      { $group: { _id: { $type: '$a.b' }, n: { $sum: 1 } } },
      { $sort: { n: -1 } },
    ]);
  });
});
