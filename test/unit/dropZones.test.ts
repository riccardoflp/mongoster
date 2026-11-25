import { describe, expect, it } from 'vitest';
import { DragPayload, optionApplied, projectionZones, sortZones } from '../../src/shared/dropZones';

const header: DragPayload = { kind: 'column', key: 'amount' };
const cell: DragPayload = { kind: 'cell', key: 'amount', value: 275 };
const elementCell: DragPayload = { kind: 'cell', key: 'items.qty', value: 7, within: 'items' };

describe('query.drop-options: Sort', () => {
  it('offers ascending and descending for a header and for a cell alike', () => {
    for (const p of [header, cell]) {
      expect(sortZones(p, 'find', {}).map((z) => [z.label, z.value])).toEqual([
        ['▲ ascending', 1],
        ['▼ descending', -1],
      ]);
    }
  });

  it('uses the dotted path of a cell of an array element', () => {
    expect(sortZones(elementCell, 'find', {})[1].title).toBe('items.qty: -1 (after the fields already in the sort)');
  });

  it('offers to remove a field already in the sort', () => {
    expect(sortZones(cell, 'find', { amount: -1 }).map((z) => z.value)).toEqual([1, -1, null]);
  });

  it('offers nothing in Aggregate', () => {
    expect(sortZones(cell, 'aggregate', {})).toEqual([]);
  });
});

describe('query.drop-options: Project', () => {
  it('offers include and exclude for a header and for a cell alike', () => {
    for (const p of [header, cell]) {
      expect(projectionZones(p, 'find', {}).map((z) => [z.label, z.value])).toEqual([
        ['include', 1],
        ['exclude', 0],
      ]);
    }
  });

  it('offers to remove a field already in the projection', () => {
    expect(projectionZones(elementCell, 'find', { 'items.qty': 1 }).map((z) => z.value)).toEqual([1, 0, null]);
  });

  it('offers nothing in Aggregate', () => {
    expect(projectionZones(header, 'aggregate', {})).toEqual([]);
  });
});

describe('query.drop-options: running the query', () => {
  it('runs the query for a drop on Sort', () => {
    expect(sortZones(cell, 'find', { amount: 1 }).map((z) => z.runs)).toEqual([true, true, true]);
  });

  it('leaves the query to Find for a drop on Project, also for a removal', () => {
    expect(projectionZones(header, 'find', { amount: 1 }).map((z) => z.runs)).toEqual([false, false, false]);
  });

  it('says whether the text of a box is the one the table was read with', () => {
    expect(optionApplied('{ amount: 1 }', '{ amount: 1 }')).toBe(true);
    expect(optionApplied('  { amount: 1 } ', '{ amount: 1 }')).toBe(true);
    expect(optionApplied('{ amount: 1, name: 1 }', '{ amount: 1 }')).toBe(false);
    expect(optionApplied('', '{ amount: 1 }')).toBe(false);
    expect(optionApplied('', '')).toBe(true);
  });
});
