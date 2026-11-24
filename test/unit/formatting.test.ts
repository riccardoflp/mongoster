import { describe, expect, it } from 'vitest';
import { ConditionRule, FormatColor, FormatRule, MAX_FORMAT_RULES, TableFormat, conditionError, readFormatRules, withElement } from '../../src/shared/formatting';
import { FieldRule, paintLevel, readFormattingPane } from '../../src/shared/formatting';
import { SHADES, VALUE_COLORS, fieldLegend, fieldMode, fieldPaint, paletteOf, resolveField, valuesOf } from '../../src/shared/formatField';
import { parseQuery } from '../../src/shared/query';

const doc = (text: string) => parseQuery(text);
const rule = (id: string, condition: string, color: FormatColor, extra: Partial<ConditionRule> = {}): FormatRule => ({ id, condition, color, ...extra });

describe('query.format-table', () => {
  it('colors the row with the first matching row rule', () => {
    const format = new TableFormat([
      rule('a', '{ status: "failed" }', 'red'),
      rule('b', '{ amount: { $gt: 1000 } }', 'yellow'),
    ]);
    expect(format.rowPaint(doc('{ status: "failed", amount: 5000 }'))?.color).toBe('red');
    expect(format.rowPaint(doc('{ status: "ok", amount: 5000 }'))?.color).toBe('yellow');
    expect(format.rowPaint(doc('{ status: "ok", amount: 5 }'))?.color).toBeUndefined();
  });

  it('colors a field cell with the first matching rule of that field, whatever the row rules', () => {
    const format = new TableFormat([
      rule('row', '{ status: "failed" }', 'red'),
      rule('c1', '{ amount: { $gt: 1000 } }', 'green', { field: 'amount' }),
      rule('c2', '{ amount: { $gt: 0 } }', 'blue', { field: 'amount' }),
      rule('c3', '{ status: "failed" }', 'purple', { field: 'status' }),
    ]);
    const d = doc('{ status: "failed", amount: 5000 }');
    expect(format.rowPaint(d)?.color).toBe('red');
    expect(format.cellPaint(d, 'amount')?.color).toBe('green');
    expect(format.cellPaint(d, 'status')?.color).toBe('purple');
    expect(format.cellPaint(d, 'other')?.color).toBeUndefined();
    expect(format.cellPaint(doc('{ amount: 5 }'), 'amount')?.color).toBe('blue');
  });

  it('a cell rule may depend on another field of the document', () => {
    const format = new TableFormat([rule('c', '{ status: "failed" }', 'orange', { field: 'amount' })]);
    expect(format.cellPaint(doc('{ status: "failed", amount: 1 }'), 'amount')?.color).toBe('orange');
    expect(format.cellPaint(doc('{ status: "ok", amount: 1 }'), 'amount')?.color).toBeUndefined();
  });

  it('skips the rules turned off', () => {
    const format = new TableFormat([rule('a', '{}', 'red', { enabled: false }), rule('b', '{}', 'blue')]);
    expect(format.rowPaint(doc('{ a: 1 }'))?.color).toBe('blue');
    expect(new TableFormat([rule('a', '{}', 'red', { enabled: false })]).empty).toBe(true);
  });

  it('an invalid rule colors nothing and says why', () => {
    const format = new TableFormat([
      rule('bad', '{ status: ', 'red'),
      rule('expr', '{ $expr: { $gt: ["$a", 1] } }', 'red'),
      rule('ok', '{ a: 1 }', 'green'),
    ]);
    expect(format.rowPaint(doc('{ a: 1 }'))?.color).toBe('green');
    expect(format.errors.get('bad')).toMatch(/^Invalid syntax: /);
    expect(format.errors.get('expr')).toBe('$expr is not supported in a formatting rule.');
    expect(format.errors.has('ok')).toBe(false);
  });

  it('in an expanded array, matches a cell rule against each element on its own', () => {
    const format = new TableFormat([rule('c', '{ "items.qty": { $gt: 5 } }', 'yellow', { field: 'items.qty' })]);
    const d = doc('{ _id: 1, items: [ { sku: "a", qty: 1 }, { sku: "b", qty: 7 } ] }');
    expect(format.cellPaint(d, 'items.qty', { array: 'items', index: 0 })?.color).toBeUndefined();
    expect(format.cellPaint(d, 'items.qty', { array: 'items', index: 1 })?.color).toBe('yellow');
    // Without the element, the document as a whole matches.
    expect(format.cellPaint(d, 'items.qty')?.color).toBe('yellow');
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
      { id: 'b', condition: '{}', color: 'magenta' },
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

const by = (field: string, extra: Partial<FieldRule> = {}): FieldRule => ({ id: field, kind: 'field', field, target: 'cell', mode: 'auto', ...extra });
const docs = (...texts: string[]) => texts.map(doc);

describe('query.format-field', () => {
  it('decides the mode from the values: booleans, numbers or dates, anything else', () => {
    expect(fieldMode([true, false])).toBe('boolean');
    expect(fieldMode([1, { $numberLong: '5' }, { $numberDecimal: '2.5' }])).toBe('scale');
    expect(fieldMode([{ $date: '2026-01-01T00:00:00Z' }])).toBe('scale');
    expect(fieldMode([1, { $date: '2026-01-01T00:00:00Z' }])).toBe('values');
    expect(fieldMode(['a', 1])).toBe('values');
    expect(fieldMode([])).toBe('values');
  });

  it('colors true green and false red, the other way when swapped, and nothing else', () => {
    const rule = by('active');
    const resolved = resolveField(rule, docs('{ active: true }', '{ active: false }', '{ other: 1 }', '{ active: null }'));
    expect(resolved.mode).toBe('boolean');
    expect(fieldPaint(rule, resolved, true)?.color).toBe('green');
    expect(fieldPaint(rule, resolved, false)?.color).toBe('red');
    expect(fieldPaint(rule, resolved, 'yes')).toBeUndefined();
    expect(fieldPaint(rule, resolved, null)).toBeUndefined();
    const swapped = by('active', { scale: { from: 'green', to: 'red' } });
    expect(fieldPaint(swapped, resolved, true)?.color).toBe('red');
    expect(fieldPaint(swapped, resolved, false)?.color).toBe('green');
  });

  it('places a number between the ends of the scale, and a value outside at the end', () => {
    const rule = by('amount', { mode: 'scale', min: 0, max: 200, scale: { to: 'orange' } });
    const resolved = resolveField(rule, []);
    expect(fieldPaint(rule, resolved, 50)).toEqual({ color: 'orange', strength: 0.25 });
    expect(fieldPaint(rule, resolved, { $numberLong: '200' })).toEqual({ color: 'orange', strength: 1 });
    expect(fieldPaint(rule, resolved, 900)?.strength).toBe(1);
    expect(fieldPaint(rule, resolved, -5)?.strength).toBe(0);
    expect(fieldPaint(rule, resolved, 'text')).toBeUndefined();
  });

  it('goes from one color to another through yellow', () => {
    const rule = by('score', { mode: 'scale', min: 0, max: 100, scale: { from: 'red', to: 'green' } });
    const resolved = resolveField(rule, []);
    expect(fieldPaint(rule, resolved, 0)).toMatchObject({ color: 'red', toward: { color: 'yellow', share: 0 } });
    expect(fieldPaint(rule, resolved, 25)).toMatchObject({ color: 'red', toward: { color: 'yellow', share: 0.5 } });
    expect(fieldPaint(rule, resolved, 100)).toMatchObject({ color: 'yellow', toward: { color: 'green', share: 1 } });
  });

  it('takes the ends of the page when the rule has none, and keeps its own', () => {
    const page = docs('{ n: 10 }', '{ n: 30 }', '{ n: null }', '{}');
    expect(resolveField(by('n'), page)).toEqual({ mode: 'scale', min: 10, max: 30 });
    expect(resolveField(by('n', { min: 0, max: 100 }), page)).toEqual({ mode: 'scale', min: 0, max: 100 });
    const dates = docs('{ at: ISODate("2026-01-01T00:00:00Z") }', '{ at: ISODate("2026-01-02T00:00:00Z") }');
    expect(resolveField(by('at'), dates)).toEqual({ mode: 'scale', min: Date.UTC(2026, 0, 1), max: Date.UTC(2026, 0, 2), dates: true });
  });

  it('gives a distinct value the same color wherever it is', () => {
    const rule = by('status');
    const a = fieldPaint(rule, { mode: 'values' }, 'failed');
    expect(a).toEqual(fieldPaint(rule, { mode: 'values' }, 'failed'));
    expect(VALUE_COLORS).toContain(a!.color);
    expect(VALUE_COLORS).not.toContain('gray');
    expect(fieldPaint(rule, { mode: 'values' }, null)).toBeUndefined();
  });

  it('gives a pinned value its color and no other value that color', () => {
    const rule = by('place', { pinned: [{ value: '"home"', color: 'green' }] });
    expect(fieldPaint(rule, { mode: 'values' }, 'home')).toEqual({ color: 'green', strength: 1 });
    expect(paletteOf(rule).map((p) => p.color)).not.toContain('green');
    for (let i = 0; i < 200; i++) expect(fieldPaint(rule, { mode: 'values' }, `place ${i}`)?.color).not.toBe('green');
  });

  it('takes the other values from the shades of one color when that is the palette', () => {
    const rule = by('place', { palette: 'gray', pinned: [{ value: '"home"', color: 'green' }] });
    expect(paletteOf(rule)).toEqual(SHADES.map((strength) => ({ color: 'gray', strength })));
    expect(fieldPaint(rule, { mode: 'values' }, 'office')?.color).toBe('gray');
    expect(fieldPaint(rule, { mode: 'values' }, 'home')?.color).toBe('green');
    const same = by('place', { palette: 'green', pinned: [{ value: '"home"', color: 'green' }] });
    expect(fieldPaint(same, { mode: 'values' }, 'home')).toEqual({ color: 'green', strength: 1, outlined: true });
  });

  it('mixes a row fainter than a cell', () => {
    expect([paintLevel({ color: 'red' }, 'row'), paintLevel({ color: 'red' }, 'cell')]).toEqual([12, 28]);
    expect([paintLevel({ color: 'red', strength: 0 }, 'cell'), paintLevel({ color: 'red', strength: 1 }, 'cell')]).toEqual([6, 45]);
    expect([paintLevel({ color: 'red', strength: 0 }, 'row'), paintLevel({ color: 'red', strength: 1 }, 'row')]).toEqual([4, 22]);
  });

  it('reads the values of a field through arrays of sub-documents', () => {
    expect(valuesOf(doc('{ items: [{ qty: 1 }, { qty: 7 }, {}], tags: ["a", "b"] }'), 'items.qty')).toEqual([1, 7]);
    expect(valuesOf(doc('{ tags: ["a", "b"] }'), 'tags')).toEqual([['a', 'b']]);
  });

  it('lists the values of the page with their counts, the pinned ones first', () => {
    const rule = by('status', { pinned: [{ value: '"gone"', color: 'red' }] });
    const legend = fieldLegend(rule, docs('{ status: "ok" }', '{ status: "ok" }', '{ status: "failed" }', '{}'));
    expect(legend.mode).toBe('values');
    expect(legend.entries.map((e) => [e.text, e.count, e.pinned])).toEqual([
      ['"gone"', 0, true],
      ['"ok"', 2, false],
      ['"failed"', 1, false],
    ]);
    expect(legend.colors).toBe(9);
    expect(fieldLegend(by('on'), docs('{ on: true }')).entries.map((e) => [e.text, e.count])).toEqual([
      ['true', 1],
      ['false', 0],
    ]);
  });
});

describe('query.format-table: field rules', () => {
  it('a field rule colors its cell, or the row, of the documents that have the field', () => {
    const page = docs('{ status: "ok", n: 1 }', '{ n: 2 }');
    const cells = new TableFormat([by('status')], page);
    expect(cells.cellPaint(page[0], 'status')).toBeDefined();
    expect(cells.cellPaint(page[1], 'status')).toBeUndefined();
    expect(cells.rowPaint(page[0])).toBeUndefined();
    const rows = new TableFormat([by('status', { target: 'row' }), rule('r', '{ n: 2 }', 'purple')], page);
    expect(rows.rowPaint(page[0])).toBeDefined();
    expect(rows.rowPaint(page[1])?.color).toBe('purple');
    expect(rows.cellPaint(page[0], 'status')).toBeUndefined();
  });

  it('the first rule that gives a color wins, of either kind', () => {
    const page = docs('{ status: "failed" }');
    const format = new TableFormat([rule('c', '{ status: "failed" }', 'red', { field: 'status' }), by('status')], page);
    expect(format.cellPaint(page[0], 'status')).toEqual({ color: 'red' });
    expect(new TableFormat([by('status', { enabled: false })], page).empty).toBe(true);
  });

  it('in an expanded array, a field rule colors each element by its own value', () => {
    const page = docs('{ items: [{ qty: 0 }, { qty: 10 }] }');
    const format = new TableFormat([by('items.qty')], page);
    expect(format.cellPaint(page[0], 'items.qty', { array: 'items', index: 0 })?.strength).toBe(0);
    expect(format.cellPaint(page[0], 'items.qty', { array: 'items', index: 1 })?.strength).toBe(1);
  });
});

describe('query.format-rules: field rules and the pane', () => {
  it('reads back a field rule and a name', () => {
    const rules: FormatRule[] = [
      by('amount', { mode: 'scale', min: 0, max: 10, scale: { from: 'red', to: 'green' }, target: 'row', name: 'Heat' }),
      by('status', { pinned: [{ value: '"failed"', color: 'red' }], palette: 'gray', enabled: false }),
      rule('c', '{ a: 1 }', 'teal', { name: 'Ones' }),
    ];
    expect(readFormatRules(JSON.parse(JSON.stringify(rules)))).toEqual(rules);
  });

  it('keeps what it can of a field rule and drops the kinds it does not know', () => {
    const value = [
      { id: 'a', kind: 'field', field: ' n ', target: 'column', mode: 'rainbow', min: 'x', scale: { to: 'nope' }, pinned: [{ value: 1, color: 'red' }, { value: '1', color: 'red' }, { value: '1', color: 'blue' }], palette: 'neon', name: '  ' },
      { id: 'b', kind: 'field', field: '' },
      { id: 'c', kind: 'gradient', field: 'n' },
    ];
    expect(readFormatRules(value)).toEqual([{ id: 'a', kind: 'field', field: 'n', target: 'cell', mode: 'auto', pinned: [{ value: '1', color: 'red' }] }]);
  });

  it('reads the state of the pane, closed and shown by default', () => {
    expect(readFormattingPane(undefined)).toEqual({ open: false, width: 320, hidden: false });
    expect(readFormattingPane({ open: true, width: 5000, hidden: true })).toEqual({ open: true, width: 700, hidden: true });
    expect(readFormattingPane('x')).toEqual({ open: false, width: 320, hidden: false });
  });
});
