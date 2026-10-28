import { describe, expect, it } from 'vitest';
import { CallAt, argumentKind, callAt, databaseAt, memberAt } from '../../src/playground/context';

/** The text without the `‸`, and the caret's offset. */
function caret(textWithCaret: string): [string, number] {
  const offset = textWithCaret.indexOf('‸');
  if (offset < 0) throw new Error('no caret');
  return [textWithCaret.replace('‸', ''), offset];
}
const call = (t: string) => callAt(...caret(t));
const member = (t: string) => memberAt(...caret(t));

describe('callAt', () => {
  it('finds the collection method and the argument at the caret', () => {
    const text = 'db.users.find({ ‸ })';
    expect(call(text)).toEqual({ collection: 'users', method: 'find', cursorOf: undefined, argIndex: 0, argStart: 'db.users.find('.length });
    const second = call('db.users.find({}, { ‸ })')!;
    expect(second.argIndex).toBe(1);
    expect(second.argStart).toBe('db.users.find({},'.length);
  });

  it('does not count commas inside nested objects, arrays and strings', () => {
    expect(call('db.users.find({ a: [1, 2], b: "x, y", ‸ })')?.argIndex).toBe(0);
    expect(call('db.users.aggregate([{ $match: { a: "x(" } }, ‸])')).toMatchObject({ method: 'aggregate', argIndex: 0 });
  });

  it('tells regex literals from division', () => {
    expect(call('db.users.find({ a: /\\(,/, ‸ })')).toMatchObject({ method: 'find', argIndex: 0 });
    expect(call('db.users.find({ a: 4 / 2 }, ‸)')).toMatchObject({ method: 'find', argIndex: 1 });
  });

  it('follows cursors back to the call that created them', () => {
    expect(call('db.users.find({}).sort({ ‸ })')).toMatchObject({ collection: 'users', method: 'sort', cursorOf: 'find' });
    expect(call('db.users.find({}).sort({}).limit(‸)')).toMatchObject({ method: 'limit', cursorOf: 'find' });
    expect(call('db.orders.aggregate([]).toArray(‸)')).toMatchObject({ collection: 'orders', cursorOf: 'aggregate' });
  });

  it('reads the collection names mongosh accepts', () => {
    expect(call('db.getCollection("my coll").find(‸)')?.collection).toBe('my coll');
    expect(call(`db['my-coll'].find(‸)`)?.collection).toBe('my-coll');
    expect(call('db.system.views.find(‸)')?.collection).toBe('system.views');
    expect(call('db . users . find(‸)')?.collection).toBe('users');
  });

  it('gives db methods without a collection', () => {
    expect(call('db.runCommand({ ‸ })')).toMatchObject({ collection: undefined, method: 'runCommand' });
  });

  it('works across lines and inside a string argument', () => {
    expect(call('use("x")\nconst a = db.users.find(\n  {\n    ‸\n  }\n)')).toMatchObject({ collection: 'users', method: 'find' });
    expect(call('db.users.distinct("na‸")')).toMatchObject({ method: 'distinct', argIndex: 0 });
  });

  it('is null outside db calls and in comments', () => {
    expect(call('print(‸)')).toBeNull();
    expect(call('foo.bar.find(‸)')).toBeNull();
    expect(call('db.users.find({ // ‸\n })')).toBeNull();
    expect(call('db.users.find({}) ‸')).toBeNull();
    expect(call('‸')).toBeNull();
  });
});

describe('memberAt', () => {
  it('after db. suggests db members (or collections)', () => {
    expect(member('db.‸')).toEqual({ kind: 'db', prefix: '', start: 3 });
    expect(member('x = db.us‸')).toEqual({ kind: 'db', prefix: 'us', start: 7 });
  });

  it('after a collection suggests collection methods', () => {
    expect(member('db.users.fi‸')).toEqual({ kind: 'collection', collection: 'users', prefix: 'fi', start: 9 });
    expect(member('db.getCollection("a b").‸')).toMatchObject({ kind: 'collection', collection: 'a b' });
  });

  it('after a call that returns a cursor suggests cursor methods', () => {
    expect(member('db.users.find({ a: 1 }).so‸')).toMatchObject({ kind: 'cursor', prefix: 'so' });
  });

  it('is null in strings and after other receivers', () => {
    expect(member('"db.‸')).toBeNull();
    expect(member('foo.‸')).toBeNull();
    expect(member('db‸')).toBeNull();
  });
});

describe('databaseAt', () => {
  it('is the last use() before the caret', () => {
    const text = 'use("a");\ndb.x.find()\nuse(\'b\')\ndb.y.find()\nuse("c")';
    expect(databaseAt(text, text.indexOf('db.y'))).toBe('b');
    expect(databaseAt(text, text.indexOf('db.x'))).toBe('a');
    expect(databaseAt(text, text.length)).toBe('c');
    expect(databaseAt('db.x.find()', 5)).toBeUndefined();
    expect(databaseAt('reuse("a")', 10)).toBeUndefined();
  });
});

describe('argumentKind', () => {
  const at = (c: Partial<CallAt>, arg = ''): ReturnType<typeof argumentKind> =>
    argumentKind({ method: 'find', argIndex: 0, argStart: 0, ...c }, arg);

  it('maps collection method arguments', () => {
    expect(at({ collection: 'u', method: 'find' })).toBe('filter');
    expect(at({ collection: 'u', method: 'find', argIndex: 1 })).toBe('project');
    expect(at({ collection: 'u', method: 'find', argIndex: 2 })).toBeNull();
    expect(at({ collection: 'u', method: 'updateMany', argIndex: 1 })).toBe('update');
    expect(at({ collection: 'u', method: 'distinct' })).toBe('field');
    expect(at({ collection: 'u', method: 'distinct', argIndex: 1 })).toBe('filter');
    expect(at({ collection: 'u', method: 'createIndex' })).toBe('index');
    expect(at({ collection: 'u', method: 'drop' })).toBeNull();
    expect(at({ collection: undefined, method: 'find' })).toBeNull();
  });

  it('maps cursor method arguments', () => {
    expect(at({ collection: 'u', method: 'sort', cursorOf: 'find' })).toBe('sort');
    expect(at({ collection: 'u', method: 'projection', cursorOf: 'find' })).toBe('project');
    expect(at({ collection: 'u', method: 'hint', cursorOf: 'find' })).toBe('index');
    expect(at({ collection: 'u', method: 'limit', cursorOf: 'find' })).toBeNull();
    expect(at({ collection: 'u', method: 'sort', cursorOf: 'find', argIndex: 1 })).toBeNull();
  });

  it('tells a pipeline array from stages passed as arguments', () => {
    expect(at({ collection: 'u', method: 'aggregate' }, ' [{ $match')).toBe('pipeline');
    expect(at({ collection: 'u', method: 'aggregate' }, '')).toBe('pipeline');
    expect(at({ collection: 'u', method: 'aggregate' }, '{ $match: {} }')).toBe('stageObject');
    expect(at({ collection: 'u', method: 'aggregate', argIndex: 1 }, ' ')).toBe('stageObject');
    // db.aggregate([...]) too.
    expect(at({ collection: undefined, method: 'aggregate' }, '[')).toBe('pipeline');
  });
});
