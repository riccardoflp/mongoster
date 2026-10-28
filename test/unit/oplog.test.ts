import { describe, expect, it } from 'vitest';
import { BSON } from 'mongodb';
import { documentFields, idStringify, inScope, meteorId, oplogMessage, updatedFields } from '../../src/shared/oplog';

const { ObjectId, Long, Int32, Double, UUID } = BSON;

describe('updatedFields', () => {
  it('lists the fields of the update operators, without _id', () => {
    expect(updatedFields({ $set: { a: 1, b: 2 }, $inc: { n: 1 }, $unset: { c: '' }, $setOnInsert: { _id: 1 } })).toEqual(['a', 'b', 'n', 'c']);
  });

  it('keeps dotted paths but cuts them at an array position', () => {
    expect(updatedFields({ $set: { 'address.city': 'x', 'items.1.qty': 2, 'tags.$': 'y', 'list.$[el].v': 1, 'a.b.0': 1 } })).toEqual([
      'address.city',
      'items',
      'tags',
      'list',
      'a.b',
    ]);
  });

  it('does not cut at a field whose name only contains digits after other characters', () => {
    expect(updatedFields({ $set: { 'a.b1': 1, 'a.1b': 2 } })).toEqual(['a.b1', 'a.1b']);
  });

  it('gives the fields of a replacement document', () => {
    expect(updatedFields({ _id: 1, name: 'x', age: 3 })).toEqual(['name', 'age']);
  });

  it('reads update pipelines made of $set, $addFields and $unset', () => {
    expect(updatedFields([{ $set: { a: 1 } }, { $addFields: { 'b.c': 2 } }, { $unset: ['d', 'e.1'] }, { $unset: 'f' }])).toEqual(['a', 'b.c', 'd', 'e', 'f']);
  });

  it("is undefined when a pipeline stage doesn't tell the fields", () => {
    expect(updatedFields([{ $set: { a: 1 } }, { $replaceWith: '$b' }])).toBeUndefined();
    expect(updatedFields([{ $project: { a: 1 } }])).toBeUndefined();
  });

  it('copes with empty or missing updates', () => {
    expect(updatedFields({})).toEqual([]);
    expect(updatedFields(undefined)).toEqual([]);
    expect(updatedFields([])).toEqual([]);
  });
});

describe('documentFields', () => {
  it('unites the fields of the documents, without _id', () => {
    expect(documentFields({ _id: 1, a: 1, b: 2 }, { _id: 1, b: 3, c: 4 }, null, undefined)).toEqual(['a', 'b', 'c']);
    expect(documentFields()).toEqual([]);
  });
});

describe('inScope', () => {
  it('publishes everything with an empty scope', () => {
    expect(inScope(undefined, 'app', 'users')).toBe(true);
    expect(inScope([], 'app', 'users')).toBe(true);
  });

  it('matches whole databases, collections and globs', () => {
    expect(inScope(['app'], 'app', 'users')).toBe(true);
    expect(inScope(['app'], 'other', 'users')).toBe(false);
    expect(inScope(['app.users'], 'app', 'users')).toBe(true);
    expect(inScope(['app.users'], 'app', 'orders')).toBe(false);
    expect(inScope(['app.*'], 'app', 'orders')).toBe(true);
    expect(inScope(['*.logs'], 'any', 'logs')).toBe(true);
    expect(inScope(['*.logs'], 'any', 'logs2')).toBe(false);
    expect(inScope(['app.users', 'shop'], 'shop', 'x')).toBe(true);
  });

  it('keeps the collection part after the first dot, and dots literal', () => {
    expect(inScope(['app.logs.2024'], 'app', 'logs.2024')).toBe(true);
    expect(inScope(['app.logs.2024'], 'app', 'logsX2024')).toBe(false);
    expect(inScope(['a+b'], 'a+b', 'c')).toBe(true);
    expect(inScope(['a+b'], 'aab', 'c')).toBe(false);
  });
});

describe('meteorId and idStringify', () => {
  it('converts the ids Meteor can have', () => {
    const oid = new ObjectId('0123456789abcdef01234567');
    expect(meteorId('abc')).toBe('abc');
    expect(meteorId(5)).toBe(5);
    expect(meteorId(oid)).toEqual({ $type: 'oid', $value: '0123456789abcdef01234567' });
    expect(meteorId(new Int32(7))).toBe(7);
    expect(meteorId(new Double(1.5))).toBe(1.5);
    expect(meteorId(Long.fromNumber(42))).toBe(42);
  });

  it('refuses the ids Meteor cannot have', () => {
    expect(meteorId(Long.fromString('9223372036854775807'))).toBeUndefined();
    expect(meteorId(NaN)).toBeUndefined();
    expect(meteorId({ a: 1 })).toBeUndefined();
    expect(meteorId(null)).toBeUndefined();
    expect(meteorId(new UUID())).toBeUndefined();
  });

  it("stringifies as Meteor's MongoID.idStringify", () => {
    expect(idStringify('abc')).toBe('abc');
    expect(idStringify('')).toBe('');
    expect(idStringify('-x')).toBe('--x');
    expect(idStringify('~x')).toBe('-~x');
    expect(idStringify('{x')).toBe('-{x');
    // A string that looks like an ObjectId's hex.
    expect(idStringify('0123456789abcdef01234567')).toBe('-0123456789abcdef01234567');
    expect(idStringify({ $type: 'oid', $value: '0123456789abcdef01234567' })).toBe('0123456789abcdef01234567');
    expect(idStringify(5)).toBe('~5');
  });
});

describe('oplogMessage', () => {
  it('sends an update to the collection, its namespaces and the document channel, with the prefix', () => {
    const msg = oplogMessage({ prefix: 'p:', namespaces: ['ns1', 'ns2'] }, 'users', { e: 'u', id: 'abc', fields: ['a', 'b.c'] });
    expect(msg?.channels).toEqual(['p:users', 'p:ns1::users', 'p:ns2::users', 'p:users::abc']);
    expect(JSON.parse(msg!.message)).toEqual({ e: 'u', d: { _id: 'abc' }, f: ['a', 'b.c'] });
  });

  it('sends inserts and removals without fields, ObjectIds as EJSON', () => {
    const id = new ObjectId('0123456789abcdef01234567');
    const msg = oplogMessage({}, 'users', { e: 'i', id });
    expect(msg?.channels).toEqual(['users', 'users::0123456789abcdef01234567']);
    expect(JSON.parse(msg!.message)).toEqual({ e: 'i', d: { _id: { $type: 'oid', $value: '0123456789abcdef01234567' } } });
    expect(JSON.parse(oplogMessage({}, 'c', { e: 'r', id: 3 })!.message)).toEqual({ e: 'r', d: { _id: 3 } });
    expect(oplogMessage({}, 'c', { e: 'r', id: 3 })!.channels).toEqual(['c', 'c::~3']);
  });

  it('is undefined for an id Meteor cannot have', () => {
    expect(oplogMessage({}, 'c', { e: 'i', id: { a: 1 } })).toBeUndefined();
  });
});
