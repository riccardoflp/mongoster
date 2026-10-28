import * as vm from 'node:vm';
import { describe, expect, it } from 'vitest';
import { RESOLVE_FN, ScriptSyntaxError, rewritePlayground } from '../../src/playground/rewrite';

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

  it('leaves nested code alone (only top-level statements are rewritten)', async () => {
    const { value, resolved } = await run('function f() { return 41 }\nconst g = () => f() + 1;\ng()');
    expect(value).toBe(42);
    // The initializer of g (an arrow function) and the final g().
    expect(resolved).toHaveLength(2);
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
