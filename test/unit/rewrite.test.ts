import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RESOLVE_FN, RESULT_VAR, ScriptSyntaxError, rewritePlayground } from '../../src/playground/rewrite';

/** Runs the rewritten script with `globals`; RESOLVE_FN records what it awaited. */
async function run(source: string, globals: Record<string, unknown> = {}): Promise<{ value: unknown; resolved: unknown[] }> {
  const resolved: unknown[] = [];
  const context = vm.createContext({
    ...globals,
    [RESOLVE_FN]: async (v: unknown) => {
      const value = await v;
      resolved.push(value);
      return value;
    },
  });
  const value = await new vm.Script(rewritePlayground(source), { filename: 'script.js' }).runInContext(context);
  return { value, resolved };
}

const later = <T>(v: T) => new Promise<T>((r) => setTimeout(() => r(v), 1));

const RESULT = RESULT_VAR;
/** The rewritten script without the function around it, RESOLVE_FN written R. */
function body(source: string): string {
  const code = rewritePlayground(source);
  const prefix = `(async () => { let ${RESULT_VAR}; `;
  const suffix = `\n; return ${RESULT_VAR}; })()`;
  expect(code.startsWith(prefix) && code.endsWith(suffix)).toBe(true);
  return code.slice(prefix.length, -suffix.length).split(RESOLVE_FN).join('R');
}

describe('rewritePlayground', () => {
  it('returns the value of a final expression statement', async () => {
    expect((await run('1 + 1')).value).toBe(2);
    expect((await run('const a = 2;\na * 3;')).value).toBe(6);
  });

  it('returns undefined when the script does not end with an expression', async () => {
    expect((await run('const a = 1;')).value).toBeUndefined();
    expect((await run('1;\nif (true) { 2 }')).value).toBeUndefined();
    expect((await run('')).value).toBeUndefined();
  });

  it('awaits top-level expressions and variable initializers without `await`', async () => {
    const { value } = await run('const user = find();\nlet n = count(), m;\nuser.name + n', {
      find: () => later({ name: 'ada' }),
      count: () => later(3),
    });
    expect(value).toBe('ada3');
  });

  it('awaits every top-level statement in order', async () => {
    const log: string[] = [];
    await run('write("a");\nwrite("b");\nwrite("c")', {
      write: (s: string) => later(null).then(() => log.push(s)),
    });
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('leaves functions that are not async alone', async () => {
    const { value, resolved } = await run('function f() { return 41 }\nconst g = () => f() + 1;\ng()');
    expect(value).toBe(42);
    // Only the final g(): f() runs in a function that isn't async, the arrow function isn't awaited.
    expect(resolved).toEqual([42]);
    expect(body('[1, 2].map((x) => f(x))')).toBe(`${RESULT} = await R(([1, 2].map((x) => f(x))))`);
    // The function keeps the name it gets from the variable.
    expect((await run('const g = () => 1;\ng.name')).value).toBe('g');
  });

  it('keeps explicit await, for loops and destructuring working', async () => {
    const source = ['const { a, b: [c] } = obj();', 'let sum = 0;', 'for (const x of [a, c]) sum += await later(x);', 'sum'].join('\n');
    expect((await run(source, { obj: () => later({ a: 1, b: [2] }), later })).value).toBe(3);
  });

  it('does not treat a directive as the result', async () => {
    expect((await run('"use strict"')).value).toBeUndefined();
    expect((await run('"use strict";\n5')).value).toBe(5);
  });

  it('accepts a hashbang, and a top-level return that ends the script with its value', async () => {
    expect((await run('#!/usr/bin/env mongosh\n7')).value).toBe(7);
    expect((await run('if (true) return 1;\n2')).value).toBe(1);
  });

  it('keeps the script’s line numbers for runtime errors', async () => {
    const err = await run('const a = 1;\n\nnull.x').catch((e: Error) => e);
    expect(String((err as Error).stack)).toMatch(/script\.js:3/);
  });

  it('reports syntax errors with the script’s 1-based line and column', () => {
    let err: unknown;
    try {
      rewritePlayground('const a = 1;\nconst b = ;');
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ScriptSyntaxError);
    const { line, column, message } = err as ScriptSyntaxError;
    expect([line, column]).toEqual([2, 11]);
    expect(message).toBe('Unexpected token');
  });
});

/** A lazy cursor like the shell's: chain methods return it, nothing runs before a terminal method. */
class FakeCursor {
  executed = false;
  readonly ops: string[] = [];
  constructor(private readonly docs: { n: number }[]) {}
  sort(): this {
    this.ops.push('sort');
    return this;
  }
  limit(n: number): this {
    this.ops.push(`limit ${n}`);
    return this;
  }
  toArray() {
    this.executed = true;
    return later(this.docs);
  }
  async forEach(fn: (d: unknown) => unknown) {
    this.executed = true;
    for (const d of await later(this.docs)) await fn(d);
  }
  explain() {
    return later({ ops: this.ops });
  }
}

/** A `db` whose methods answer later, as the driver's do. */
function fakeDb(docs: { n: number; items?: { sku: string }[] }[] = [{ n: 1, items: [{ sku: 'a1' }] }, { n: 2 }]) {
  const coll = (list: typeof docs) => ({
    find: () => new FakeCursor(list),
    findOne: (filter: { n?: number } = {}) => later(list.find((d) => filter.n === undefined || d.n === filter.n) ?? null),
    countDocuments: () => later(list.length),
    insertOne: (d: { n: number }) => later(list.push(d)).then(() => ({ acknowledged: true })),
  });
  return { c: coll(docs), other: coll([{ n: 9 }]) };
}

describe('rewritePlayground: calls awaited where they are', () => {
  it('awaits a call before reading a property of its result or calling a method on it', async () => {
    expect(body('const n = x.findOne({}).n')).toBe('const n = (await R(((await R((x.findOne({})))).n)))');
    expect(body('a.find().toArray().length')).toBe(`${RESULT} = await R(((await R(((await R((a.find()))).toArray()))).length))`);
    const db = fakeDb();
    expect((await run('db.c.find().toArray().length', { db })).value).toBe(2);
    expect((await run('const n = db.c.findOne({}).n;\nn * 10', { db })).value).toBe(10);
    expect((await run('db.c.findOne({}).items[0].sku', { db })).value).toBe('a1');
    expect((await run('db.c.findOne({})?.items?.[0]?.sku', { db })).value).toBe('a1');
  });

  it('awaits the calls in arguments, arrays, objects and template literals', async () => {
    const printed: unknown[] = [];
    const db = fakeDb();
    await run('print(db.c.countDocuments({}))', { db, print: (v: unknown) => printed.push(v) });
    expect(printed).toEqual([2]);
    expect((await run('[db.c.countDocuments(), db.other.countDocuments()]', { db })).value).toEqual([2, 1]);
    expect((await run('({ c: db.c.countDocuments(), first: db.other.findOne().n })', { db })).value).toEqual({ c: 2, first: 9 });
    expect((await run('`${db.c.countDocuments()} documents`', { db })).value).toBe('2 documents');
    expect((await run('db.c.countDocuments() + db.other.countDocuments() > 2', { db })).value).toBe(true);
  });

  it('runs the calls of an expression in order, each once the previous is done', async () => {
    const log: string[] = [];
    const write = (s: string) => later(null).then(() => (log.push(s), s));
    const { value } = await run('[write("a"), write("b")].concat(write("c"))', { write });
    expect(value).toEqual(['a', 'b', 'c']);
    expect(log).toEqual(['a', 'b', 'c']);
  });

  it('awaits in the conditions and bodies of if, for, while, switch and try', async () => {
    const db = fakeDb();
    const source = [
      'let out = [];',
      'if (db.c.findOne({ n: 5 })) out.push("found"); else out.push(db.c.findOne({ n: 2 }).n);',
      'for (const d of db.c.find().toArray()) out.push(d.n);',
      'for (let i = 0; i < db.other.countDocuments(); i++) out.push(db.other.findOne().n);',
      'let k = 0;',
      'while (k < db.c.countDocuments()) k++;',
      'out.push(k);',
      'switch (db.c.findOne().n) { case db.other.countDocuments(): out.push("one"); break; default: out.push("other") }',
      'try { out.push(db.c.findOne({ n: 1 }).items[0].sku); missing.x } catch (e) { out.push(db.c.countDocuments()) } finally { out.push("end") }',
      'out',
    ].join('\n');
    expect((await run(source, { db })).value).toEqual([2, 1, 2, 9, 2, 'one', 'a1', 2, 'end']);
  });

  it('keeps cursor chains lazy until a terminal method', async () => {
    const db = fakeDb();
    const { value } = await run('db.c.find({}).sort({ n: -1 }).limit(5)', { db });
    expect(value).toBeInstanceOf(FakeCursor);
    expect(value).toMatchObject({ executed: false, ops: ['sort', 'limit 5'] });
    expect((await run('db.c.find().sort({ n: 1 }).limit(1).explain()', { db })).value).toEqual({ ops: ['sort', 'limit 1'] });
    const seen = await run('const seen = [];\nconst cur = db.c.find();\ncur.forEach((d) => seen.push(d.n));\nseen', { db });
    expect(seen.value).toEqual([1, 2]);
  });

  it('keeps optional chains short-circuiting', async () => {
    expect((await run('const a = null;\na?.find().toArray()')).value).toBeUndefined();
    expect((await run('const a = null;\na?.find().toArray().length')).value).toBeUndefined();
    expect((await run('db.c.findOne({ n: 7 })?.n', { db: fakeDb() })).value).toBeUndefined();
  });

  it('does not join a statement with the previous line when it has no semicolon', async () => {
    expect((await run('let x = 1\ndb.c.findOne({}).n\n', { db: fakeDb() })).value).toBe(1);
    expect((await run('const a = [1]\ndb.c.find().toArray().length', { db: fakeDb() })).value).toBe(2);
  });

  it('awaits inside functions that are async, and in withTransaction callbacks written in place', async () => {
    const db = fakeDb();
    expect((await run('async function first() { return db.c.findOne().n + 1 }\nfirst()', { db })).value).toBe(2);
    expect((await run('const f = async () => db.other.findOne().n;\nf()', { db })).value).toBe(9);
    const session = { withTransaction: async (fn: () => unknown) => fn() };
    const source = [
      'session.withTransaction(() => {',
      '  db.c.insertOne({ n: db.other.findOne().n });',
      '  if (db.c.countDocuments() > 2) return db.c.find().toArray().length;',
      '})',
    ].join('\n');
    expect(body(source)).toContain('session.withTransaction(async () => {');
    expect((await run(source, { db, session })).value).toBe(3);
    // An expression body is awaited too.
    expect((await run('session.withTransaction(() => db.c.findOne().n)', { db, session })).value).toBe(1);
  });

  it('keeps print and plain JavaScript working', async () => {
    const printed: unknown[] = [];
    const print = (...a: unknown[]) => printed.push(a.join(' '));
    const source = [
      'const xs = [3, 1, 2].sort((a, b) => a - b).map((x) => x * 2);',
      'print("xs", xs.join(","));',
      'class P { constructor(n) { this.n = n } twice() { return this.n * 2 } }',
      'new P(xs.length).twice()',
    ].join('\n');
    expect((await run(source, { print })).value).toBe(6);
    expect(printed).toEqual(['xs 2,4,6']);
    expect((await run('const { a = 1, b: [c] = [2] } = {};\nlet s = 0;\nfor (const k in { x: 1, y: 2 }) s++;\na + c + s')).value).toBe(5);
  });

  it('keeps line numbers when awaiting inside expressions', async () => {
    const source = 'const d = db.c.findOne({});\nprint(\n  db.c.findOne({ n: 7 }).n\n)';
    const err = await run(source, { db: fakeDb(), print: () => undefined }).catch((e: Error) => e);
    expect(String((err as Error).stack)).toMatch(/script\.js:3/);
  });
});
