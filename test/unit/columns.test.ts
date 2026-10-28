import { describe, expect, it } from 'vitest';
import {
  ColumnNode,
  MISSING,
  applyLayout,
  buildColumns,
  expandableBelow,
  getAt,
  leafCount,
  leaves,
  moveColumn,
  pinnedLeafCount,
  rowHeight,
  valueAtPath,
} from '../../src/shared/columns';

const docs: Record<string, unknown>[] = [
  { name: 'a', _id: { $oid: '64b000000000000000000001' }, address: { city: 'Rome', zip: '00100' }, items: [{ sku: 'x', qty: 1 }] },
  { _id: { $oid: '64b000000000000000000002' }, address: { city: 'Milan', geo: { lat: 1 } }, items: [{ sku: 'y', price: 2 }, { sku: 'z' }], tags: ['t'] },
];

const keys = (nodes: ColumnNode[]) => nodes.map((n) => n.key);

describe('getAt / valueAtPath', () => {
  it('reads nested values and reports missing segments', () => {
    expect(getAt(docs[0], ['address', 'city'])).toBe('Rome');
    expect(getAt(docs[0], ['address', 'nope'])).toBe(MISSING);
    expect(getAt(docs[0], ['name', 'length'])).toBe(MISSING);
    // EJSON wrappers are values, not sub-documents.
    expect(getAt(docs[0], ['_id', '$oid'])).toBe(MISSING);
    // Arrays are not stepped into by getAt.
    expect(getAt(docs[1], ['items', '0'])).toBe(MISSING);
  });

  it('valueAtPath steps into arrays with numeric segments', () => {
    expect(valueAtPath(docs[1], ['items', '1', 'sku'])).toBe('z');
    expect(valueAtPath(docs[1], ['items', '5', 'sku'])).toBe(MISSING);
    expect(valueAtPath(docs[1], ['tags', '0'])).toBe('t');
  });
});

describe('buildColumns', () => {
  it('lists top-level fields of all documents with _id first', () => {
    const cols = buildColumns(docs, new Set());
    expect(keys(cols)).toEqual(['_id', 'name', 'address', 'items', 'tags']);
    const byKey = Object.fromEntries(cols.map((c) => [c.key, c]));
    expect(byKey._id.expandable).toBe(false);
    expect(byKey.address).toMatchObject({ expandable: true, array: false });
    expect(byKey.items).toMatchObject({ expandable: true, array: true });
    // An array of scalars is not expandable.
    expect(byKey.tags).toMatchObject({ expandable: false, array: false });
    expect(cols.every((c) => !c.children)).toBe(true);
  });

  it('expands sub-documents into dotted child columns merged across documents', () => {
    const cols = buildColumns(docs, new Set(['address', 'address.geo']));
    const address = cols.find((c) => c.key === 'address')!;
    expect(keys(address.children!)).toEqual(['address.city', 'address.zip', 'address.geo']);
    const geo = address.children!.find((c) => c.key === 'address.geo')!;
    expect(keys(geo.children!)).toEqual(['address.geo.lat']);
    expect(geo.children![0].path).toEqual(['address', 'geo', 'lat']);
  });

  it('expands arrays of sub-documents into element columns with their array depth', () => {
    const cols = buildColumns(docs, new Set(['items']));
    const items = cols.find((c) => c.key === 'items')!;
    expect(keys(items.children!)).toEqual(['items.sku', 'items.qty', 'items.price']);
    expect(items.children!.every((c) => c.arrayDepth === 1)).toBe(true);
  });

  it('does not expand arrays nested inside expanded arrays', () => {
    const rows = [{ orders: [{ lines: [{ n: 1 }] }] }];
    const cols = buildColumns(rows, new Set(['orders', 'orders.lines']));
    const lines = cols[0].children![0];
    expect(lines.key).toBe('orders.lines');
    expect(lines.array).toBe(false);
    expect(lines.expandable).toBe(false);
    expect(lines.children).toBeUndefined();
  });
});

describe('leaves and counts', () => {
  it('marks where expanded groups start and end', () => {
    const cols = buildColumns(docs, new Set(['address']));
    const list = leaves(cols);
    expect(list.map((l) => l.node.key)).toEqual(['_id', 'name', 'address.city', 'address.zip', 'address.geo', 'items', 'tags']);
    const city = list.find((l) => l.node.key === 'address.city')!;
    const geo = list.find((l) => l.node.key === 'address.geo')!;
    expect(city.starts).toEqual(['address']);
    expect(geo.ends).toEqual(['address']);
    expect(leafCount(cols.find((c) => c.key === 'address')!)).toBe(3);
  });

  it('nested groups open and close outermost first', () => {
    const cols = buildColumns([{ a: { b: { c: 1 } } }], new Set(['a', 'a.b']));
    const [leaf] = leaves(cols);
    expect(leaf.starts).toEqual(['a', 'a.b']);
    expect(leaf.ends).toEqual(['a', 'a.b']);
  });
});

describe('rowHeight', () => {
  it('is one sub-row per element of expanded arrays, capped with a "more" row', () => {
    const cols = buildColumns(docs, new Set(['items']));
    expect(rowHeight(docs[0], cols)).toBe(1);
    expect(rowHeight(docs[1], cols)).toBe(2);
    const many = { items: Array.from({ length: 30 }, (_, i) => ({ sku: String(i) })) };
    const c2 = buildColumns([many], new Set(['items']));
    expect(rowHeight(many, c2, 20)).toBe(21);
    expect(rowHeight(many, c2, 50)).toBe(30);
  });

  it('is 1 when arrays are collapsed', () => {
    expect(rowHeight(docs[1], buildColumns(docs, new Set()))).toBe(1);
  });
});

describe('expandableBelow', () => {
  it('lists the key and every expandable path under it', () => {
    const rows = [{ a: { b: { c: 1 }, list: [{ d: { e: 1 } }] } }];
    const [a] = buildColumns(rows, new Set());
    expect(expandableBelow(rows, a)).toEqual(['a', 'a.b', 'a.list', 'a.list.d']);
  });
});

describe('applyLayout', () => {
  const cols = buildColumns(docs, new Set(['address']));

  it('hides columns, and drops a group whose children are all hidden', () => {
    const out = applyLayout(cols, { hidden: ['name', 'address.city', 'address.zip', 'address.geo'] });
    expect(keys(out)).toEqual(['_id', 'items', 'tags']);
  });

  it('orders siblings by the user order, others keep their natural order after them', () => {
    const out = applyLayout(cols, { order: ['tags', 'address.zip', 'address.city'] });
    expect(keys(out)).toEqual(['tags', '_id', 'name', 'address', 'items']);
    expect(keys(out.find((c) => c.key === 'address')!.children!)).toEqual(['address.zip', 'address.city', 'address.geo']);
  });

  it('puts pinned top-level columns first and counts their leaves', () => {
    const layout = { pinned: ['address'] };
    const out = applyLayout(cols, layout);
    expect(keys(out)[0]).toBe('address');
    expect(pinnedLeafCount(out, layout)).toBe(3);
    expect(pinnedLeafCount(out, {})).toBe(0);
  });

  it('does not mutate the input nodes', () => {
    const before = JSON.stringify(cols);
    applyLayout(cols, { hidden: ['address.city'], order: ['items'] });
    expect(JSON.stringify(cols)).toBe(before);
  });
});

describe('moveColumn', () => {
  const cols = buildColumns(docs, new Set(['address']));

  it('moves a column before or after a sibling', () => {
    const before = moveColumn(cols, {}, 'tags', 'name', false)!;
    expect(keys(applyLayout(cols, before))).toEqual(['_id', 'tags', 'name', 'address', 'items']);
    const after = moveColumn(cols, {}, '_id', 'items', true)!;
    expect(keys(applyLayout(cols, after))).toEqual(['name', 'address', 'items', '_id', 'tags']);
  });

  it('accepts a target inside a sibling group', () => {
    const layout = moveColumn(cols, {}, 'tags', 'address.zip', false)!;
    expect(keys(applyLayout(cols, layout))).toEqual(['_id', 'name', 'tags', 'address', 'items']);
  });

  it('moves among children of a group without touching pins', () => {
    const layout = moveColumn(cols, { pinned: ['_id'] }, 'address.geo', 'address.city', false)!;
    expect(layout.pinned).toEqual(['_id']);
    const address = applyLayout(cols, layout).find((c) => c.key === 'address')!;
    expect(keys(address.children!)).toEqual(['address.geo', 'address.city', 'address.zip']);
  });

  it('pins next to a pinned column and unpins next to an unpinned one', () => {
    const pinned = moveColumn(cols, { pinned: ['_id'] }, 'tags', '_id', true)!;
    expect(pinned.pinned).toEqual(['_id', 'tags']);
    const unpinned = moveColumn(cols, pinned, 'tags', 'items', true)!;
    expect(unpinned.pinned).toEqual(['_id']);
  });

  it('refuses targets at another level and moves onto itself', () => {
    expect(moveColumn(cols, {}, 'address.city', 'name', false)).toBeUndefined();
    expect(moveColumn(cols, {}, 'name', 'name', false)).toBeUndefined();
    expect(moveColumn(cols, {}, 'nope', 'name', false)).toBeUndefined();
  });
});
