// The pure helpers of the change stream and oplog MCP tools: times, update changes, resume tokens.
import { describe, expect, it } from 'vitest';
import { clipped, parseTime, resumeToken, updateChanges } from '../../src/mcp/changes';

describe('parseTime', () => {
  const now = Date.parse('2024-05-01T12:00:00Z');
  it('reads ISO dates and times ago', () => {
    expect(parseTime('2024-04-30T10:00:00Z', 'since', now).toISOString()).toBe('2024-04-30T10:00:00.000Z');
    expect(parseTime('15m', 'since', now).toISOString()).toBe('2024-05-01T11:45:00.000Z');
    expect(parseTime('2h', 'since', now).toISOString()).toBe('2024-05-01T10:00:00.000Z');
    expect(parseTime('1d', 'since', now).toISOString()).toBe('2024-04-30T12:00:00.000Z');
    expect(parseTime('30s', 'since', now).toISOString()).toBe('2024-05-01T11:59:30.000Z');
  });
  it('refuses anything else', () => {
    expect(() => parseTime('yesterday', 'until', now)).toThrow(/^until must be an ISO date/);
  });
});

describe('updateChanges', () => {
  it('reads a $v 2 diff with nested objects and arrays', () => {
    const diff = { diff: { u: { status: 'done' }, i: { added: 1 }, d: { old: false }, sa: { u: { b: 2 } }, sitems: { a: true, l: 2, u1: 'x' } } };
    expect(updateChanges(diff)).toEqual({ set: { status: 'done', added: 1, 'a.b': 2, 'items.1': 'x' }, unset: ['old'], truncated: ['items to 2'] });
  });
  it('reads the older $set / $unset form, and says undefined for a replacement', () => {
    expect(updateChanges({ $set: { a: 1 }, $unset: { b: true } })).toEqual({ set: { a: 1 }, unset: ['b'], truncated: [] });
    expect(updateChanges({ _id: 1, a: 1 })).toBeUndefined();
  });
});

describe('resumeToken', () => {
  it('accepts the _data string or { _data }', () => {
    expect(resumeToken('82ABCDEF')).toEqual({ _data: '82ABCDEF' });
    expect(resumeToken('{ _data: "82abcdef" }')).toEqual({ _data: '82abcdef' });
    expect(resumeToken({ _data: '82ab' })).toEqual({ _data: '82ab' });
    expect(resumeToken('')).toBeUndefined();
  });
  it('refuses anything else', () => {
    expect(() => resumeToken('not a token')).toThrow(/^resumeAfter must be/);
    expect(() => resumeToken({ data: '82' })).toThrow(/^resumeAfter must be/);
  });
});

describe('clipped', () => {
  it('cuts long values saying how much is left out', () => {
    expect(clipped({ a: 'x'.repeat(50) }, 20)).toMatch(/^\{ a: "x{14}… \(39 more characters\)$/);
    expect(clipped({ a: 1 })).toBe('{ a: 1 }');
  });
});
