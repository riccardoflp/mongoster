import { describe, expect, it } from 'vitest';
import { FormatRule, MAX_FORMAT_RULES, TableFormat, conditionError, readFormatRules, withElement } from '../../src/shared/formatting';
import { parseQuery } from '../../src/shared/query';

const doc = (text: string) => parseQuery(text);
const rule = (id: string, condition: string, color: FormatRule['color'], extra: Partial<FormatRule> = {}): FormatRule => ({ id, condition, color, ...extra });

describe('query.format-table', () => {
  it('colors the row with the first matching row rule', () => {
    const format = new TableFormat([
      rule('a', '{ status: "failed" }', 'red'),
      rule('b', '{ amount: { $gt: 1000 } }', 'yellow'),
    ]);
    expect(format.rowColor(doc('{ status: "failed", amount: 5000 }'))).toBe('red');
    expect(format.rowColor(doc('{ status: "ok", amount: 5000 }'))).toBe('yellow');
    expect(format.rowColor(doc('{ status: "ok", amount: 5 }'))).toBeUndefined();
  });

  it('colors a field cell with the first matching rule of that field, whatever the row rules', () => {
    const format = new TableFormat([
      rule('row', '{ status: "failed" }', 'red'),
      rule('c1', '{ amount: { $gt: 1000 } }', 'green', { field: 'amount' }),
      rule('c2', '{ amount: { $gt: 0 } }', 'blue', { field: 'amount' }),
      rule('c3', '{ status: "failed" }', 'purple', { field: 'status' }),
    ]);
    const d = doc('{ status: "failed", amount: 5000 }');
    expect(format.rowColor(d)).toBe('red');
    expect(format.cellColor(d, 'amount')).toBe('green');
    expect(format.cellColor(d, 'status')).toBe('purple');
    expect(format.cellColor(d, 'other')).toBeUndefined();
    expect(format.cellColor(doc('{ amount: 5 }'), 'amount')).toBe('blue');
  });

  it('a cell rule may depend on another field of the document', () => {
    const format = new TableFormat([rule('c', '{ status: "failed" }', 'orange', { field: 'amount' })]);
    expect(format.cellColor(doc('{ status: "failed", amount: 1 }'), 'amount')).toBe('orange');
    expect(format.cellColor(doc('{ status: "ok", amount: 1 }'), 'amount')).toBeUndefined();
  });

  it('skips the rules turned off', () => {
    const format = new TableFormat([rule('a', '{}', 'red', { enabled: false }), rule('b', '{}', 'blue')]);
    expect(format.rowColor(doc('{ a: 1 }'))).toBe('blue');
    expect(new TableFormat([rule('a', '{}', 'red', { enabled: false })]).empty).toBe(true);
  });

  it('an invalid rule colors nothing and says why', () => {
    const format = new TableFormat([
      rule('bad', '{ status: ', 'red'),
      rule('expr', '{ $expr: { $gt: ["$a", 1] } }', 'red'),
      rule('ok', '{ a: 1 }', 'green'),
    ]);
    expect(format.rowColor(doc('{ a: 1 }'))).toBe('green');
    expect(format.errors.get('bad')).toMatch(/^Invalid syntax: /);
    expect(format.errors.get('expr')).toBe('$expr is not supported in a formatting rule.');
    expect(format.errors.has('ok')).toBe(false);
  });

  it('in an expanded array, matches a cell rule against each element on its own', () => {
    const format = new TableFormat([rule('c', '{ "items.qty": { $gt: 5 } }', 'yellow', { field: 'items.qty' })]);
    const d = doc('{ _id: 1, items: [ { sku: "a", qty: 1 }, { sku: "b", qty: 7 } ] }');
    expect(format.cellColor(d, 'items.qty', { array: 'items', index: 0 })).toBeUndefined();
    expect(format.cellColor(d, 'items.qty', { array: 'items', index: 1 })).toBe('yellow');
    // Without the element, the document as a whole matches.
    expect(format.cellColor(d, 'items.qty')).toBe('yellow');
  });

  it('replaces an array inside a sub-document by one element', () => {
    expect(withElement(doc('{ a: 1, o: { list: [ { x: 1 }, { x: 2 } ] } }'), { array: 'o.list', index: 1 })).toEqual({ a: 1, o: { list: { x: 2 } } });
    expect(withElement(doc('{ a: 1 }'), { array: 'o.list', index: 0 })).toEqual({ a: 1 });
  });
});

describe('query.format-rules: the stored rules', () => {
  it('reads back what it wrote', () => {
    const rules: FormatRule[] = [rule('a', '{ status: "failed" }', 'red'), rule('b', '{ amount: { $gt: 1 } }', 'blue', { field: 'amount', enabled: false })];
    expect(readFormatRules(JSON.parse(JSON.stringify(rules)))).toEqual(rules);
  });

  it('reads a value recorded from the first version', () => {
    const recorded = [
      { id: 'k3j9x0a1lmno', condition: '{ deletedAt: { $exists: true } }', color: 'purple' },
      { id: 'p8q7r6s5tuvw', condition: '{ amount: { $gt: 1000 } }', field: 'amount', color: 'yellow', enabled: false },
    ];
    expect(readFormatRules(recorded)).toEqual(recorded);
  });

  it('drops entries it can not use and properties it does not know', () => {
    const value = [
      { id: 'a', condition: '{}', color: 'red', note: 'kept without the note' },
      { id: 'b', condition: '{}', color: 'pink' },
      { id: 'c', condition: 1, color: 'red' },
      { condition: '{}', color: 'red' },
      { id: 'a', condition: '{ dup: 1 }', color: 'blue' },
      { id: 'd', condition: '{}', color: 'green', field: '  ', enabled: true },
      'text',
      null,
    ];
    expect(readFormatRules(value)).toEqual([
      { id: 'a', condition: '{}', color: 'red' },
      { id: 'd', condition: '{}', color: 'green' },
    ]);
  });

  it('reads anything but an array as no rules, and keeps at most the limit', () => {
    expect(readFormatRules(undefined)).toEqual([]);
    expect(readFormatRules({ rules: [] })).toEqual([]);
    const many = Array.from({ length: MAX_FORMAT_RULES + 5 }, (_, i) => rule(`r${i}`, '{}', 'red'));
    expect(readFormatRules(many)).toHaveLength(MAX_FORMAT_RULES);
  });

  it('says why a condition can not be used', () => {
    expect(conditionError('{ status: "failed" }')).toBeUndefined();
    expect(conditionError('  ')).toBe('Type a condition, such as { status: "failed" }.');
    expect(conditionError('{ a: { $where: 1 } }')).toBe('$where is not supported in a formatting rule.');
    expect(conditionError('"text"')).toBe('The condition must be a document: { field: value }.');
  });
});
