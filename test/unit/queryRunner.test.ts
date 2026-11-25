import { describe, expect, it } from 'vitest';
import { DEFAULT_TIMEOUT_SECONDS, MAX_TIMEOUT_SECONDS, QueryRun, timeoutSeconds } from '../../src/queryRunner';

describe('query.timeout: the setting', () => {
  it('takes whole seconds from 0 to a day', () => {
    expect(timeoutSeconds(300)).toBe(300);
    expect(timeoutSeconds(0)).toBe(0);
    expect(timeoutSeconds(12.9)).toBe(12);
    expect(timeoutSeconds(10_000_000)).toBe(MAX_TIMEOUT_SECONDS);
  });

  it('gives the default for what is not a number of seconds', () => {
    for (const value of [undefined, null, '120', -5, Number.NaN, Number.POSITIVE_INFINITY, {}]) {
      expect(timeoutSeconds(value), String(value)).toBe(DEFAULT_TIMEOUT_SECONDS);
    }
  });

  it('gives each operation the limit in milliseconds, and none for 0', () => {
    expect(new QueryRun(90).options().maxTimeMS).toBe(90_000);
    expect(new QueryRun(90).options(10_000).maxTimeMS).toBe(10_000);
    expect('maxTimeMS' in new QueryRun(0).options()).toBe(false);
  });

  it('names the setting when MongoDB stops a query for its time', () => {
    const run = new QueryRun(90);
    expect(run.describe(Object.assign(new Error('operation exceeded time limit'), { code: 50 }))).toBe(
      'Stopped after 90 seconds, the time limit of the setting mongoster.query.timeout. Raise it, or narrow the query.',
    );
    expect(run.describe(new Error('unknown operator: $foo'))).toBeUndefined();
  });
});

describe('query.cancel: a run', () => {
  it('tags its operations with a comment of its own and an abort signal', () => {
    const a = new QueryRun();
    const b = new QueryRun();
    expect(a.comment).toMatch(/^mongoster:[0-9a-f-]{36}$/);
    expect(a.comment).not.toBe(b.comment);
    expect(a.options().comment).toBe(a.comment);
    expect(a.options().signal.aborted).toBe(false);
    expect(a.cancelled).toBe(false);
  });
});
