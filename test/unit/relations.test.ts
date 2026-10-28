import { describe, expect, it } from 'vitest';
import {
  GAP_X,
  HEAD_H,
  NODE_W,
  ROWS_MAX,
  ROW_H,
  RelCollection,
  RelField,
  RelGraph,
  Relation,
  VALUES_TESTED,
  boxHeight,
  candidates,
  describe as describeRelation,
  edgePath,
  idType,
  isReference,
  layout,
  namesMatch,
  refKey,
  rowLabel,
  rowY,
  sampleFields,
  shownFields,
  singular,
  stem,
  toMermaid,
  toSvg,
} from '../../src/shared/relations';

const oid = (n: number) => ({ $oid: n.toString(16).padStart(24, '0') });
const int = (n: number) => ({ $numberInt: String(n) });

describe('sampleFields', () => {
  const docs = [
    { _id: oid(1), name: 'a', customerId: oid(10), address: { city: 'x', zip: int(1) }, items: [{ productId: oid(20) }, { productId: oid(21) }] },
    { _id: oid(2), customerId: oid(11), tags: [], ref: { $ref: 'things', $id: oid(5), $db: 'other' } },
  ];
  const { fields, values, dbrefs } = sampleFields(docs);
  const field = (path: string) => fields.find((f) => f.path === path)!;

  it('lists the fields in order of first appearance, _id first, nested ones dotted', () => {
    expect(fields.map((f) => f.path)).toEqual(['_id', 'name', 'customerId', 'address', 'address.city', 'address.zip', 'items', 'items.productId', 'tags', 'ref']);
  });

  it('gives each field its presence ratio, depth, types and whether it is in an array', () => {
    expect(field('name')).toMatchObject({ ratio: 0.5, depth: 0, types: ['string'], many: false });
    expect(field('customerId')).toMatchObject({ ratio: 1, types: ['objectId'] });
    expect(field('address.zip')).toMatchObject({ depth: 1, label: 'address.zip', types: ['int'] });
    expect(field('items.productId')).toMatchObject({ label: 'items[].productId', many: true, ratio: 0.5 });
    // Presence counts documents, not array elements.
    expect(field('items')).toMatchObject({ ratio: 0.5, many: false, types: ['array', 'object'] });
    expect(field('tags').types).toEqual(['array']);
    expect(field('ref').types).toEqual(['dbref']);
  });

  it('keeps reference-like values by type, and DBRef targets', () => {
    expect(values.get('customerId')?.get('objectId')).toEqual([oid(10), oid(11)]);
    expect(values.get('items.productId')?.get('objectId')).toEqual([oid(20), oid(21)]);
    expect(values.get('address.zip')?.get('number')).toEqual([int(1)]);
    expect(values.get('name')?.get('string')).toEqual(['a']);
    expect(dbrefs.get('ref')).toEqual(new Set(['other.things']));
  });

  it('keeps distinct values only, up to a limit', () => {
    const many = Array.from({ length: VALUES_TESTED * 10 }, (_, i) => ({ x: i % 3 === 0 ? 'same' : `v${i}` }));
    const list = sampleFields(many).values.get('x')!.get('string')!;
    expect(new Set(list.map((v) => JSON.stringify(v))).size).toBe(list.length);
    expect(list.length).toBe(VALUES_TESTED * 5);
  });

  it('ignores what is not a document', () => {
    expect(sampleFields([null, 3, 'x', []]).fields).toEqual([]);
  });
});

describe('names', () => {
  it('stems field names', () => {
    expect(stem('customerId')).toBe('customer');
    expect(stem('user_ids')).toBe('user');
    expect(stem('authorRef')).toBe('author');
    expect(stem('order-key')).toBe('order');
  });

  it('makes collection names singular', () => {
    expect(singular('customers')).toBe('customer');
    expect(singular('categories')).toBe('category');
    expect(singular('addresses')).toBe('address');
    expect(singular('boxes')).toBe('box');
    expect(singular('people')).toBe('person');
    expect(singular('status')).toBe('statu');
    expect(singular('class')).toBe('class');
  });

  it('matches a field to a collection named after it', () => {
    expect(namesMatch('customerId', 'customers')).toBe(true);
    expect(namesMatch('items.productId', 'products')).toBe(true);
    expect(namesMatch('category_id', 'categories')).toBe(true);
    expect(namesMatch('person', 'people')).toBe(true);
    expect(namesMatch('user', 'app.users')).toBe(true);
    expect(namesMatch('customerId', 'orders')).toBe(false);
    expect(namesMatch('id', 'ids')).toBe(false);
  });
});

describe('candidates', () => {
  const sampled = (name: string, docs: unknown[], unique: string[] = []) => ({ name, unique, ...sampleFields(docs) });

  it('points ObjectId fields at every collection with ObjectId ids, and string fields only at the one they are named after', () => {
    const list = candidates([
      sampled('orders', [{ _id: oid(1), customerId: oid(10), code: 'c1', productCode: 'p1' }]),
      sampled('customers', [{ _id: oid(10) }]),
      sampled('products', [{ _id: 'p1' }]),
      sampled('coupons', [{ _id: 'c1' }]),
    ]);
    const byField = new Map(list.map((c) => [`${c.from}.${c.field.path}`, c]));
    expect(byField.get('orders.customerId')?.targets).toEqual([
      { to: 'orders', toField: '_id' },
      { to: 'customers', toField: '_id' },
    ]);
    expect(byField.get('orders.productCode')).toBeUndefined();
    expect(byField.get('orders.code')).toBeUndefined();
    // A document's own _id is never a candidate.
    expect(list.some((c) => c.field.path === '_id')).toBe(false);
  });

  it('points a string field at the collection named after it', () => {
    const list = candidates([sampled('orders', [{ _id: 1, customer: 'bob' }]), sampled('customers', [{ _id: 'bob' }])]);
    expect(list).toHaveLength(1);
    expect(list[0]).toMatchObject({ from: 'orders', type: 'string', values: ['bob'], targets: [{ to: 'customers', toField: '_id' }] });
  });

  it('points a field at a unique field of another collection named like it', () => {
    const list = candidates([
      sampled('orders', [{ _id: 1, customerEmail: 'a@b', email: 'x@y' }]),
      sampled('customers', [{ _id: 2, email: 'a@b' }], ['email']),
    ]);
    const targets = Object.fromEntries(list.map((c) => [c.field.path, c.targets]));
    expect(targets.customerEmail).toEqual([{ to: 'customers', toField: 'email' }]);
    expect(targets.email).toEqual([{ to: 'customers', toField: 'email' }]);
    // The unique field itself does not point at its own collection.
    expect(list.some((c) => c.from === 'customers' && c.field.path === 'email')).toBe(false);
  });

  it('finds the _id type of a collection', () => {
    expect(idType(sampled('a', [{ _id: oid(1) }, { _id: oid(2) }, { _id: 'x' }]).values)).toBe('objectId');
    expect(idType(new Map())).toBeUndefined();
  });
});

describe('refKey and isReference', () => {
  it('compares numbers of any type alike', () => {
    expect(refKey({ $numberInt: '5' })).toBe(refKey({ $numberLong: '5' }));
    expect(refKey({ $numberDouble: '5.0' })).toBe(refKey(5));
    expect(refKey({ $oid: 'ab' })).toBe('oid:ab');
    expect(refKey({ $binary: { base64: 'AAA=', subType: '04' } })).toBe('bin:AAA=');
    expect(refKey('5')).not.toBe(refKey(5));
  });

  it('needs fewer matches for ids than for values that can match by chance', () => {
    expect(isReference('objectId', 4, 20)).toBe(true);
    expect(isReference('objectId', 3, 20)).toBe(false);
    expect(isReference('string', 12, 20)).toBe(true);
    expect(isReference('string', 11, 20)).toBe(false);
    expect(isReference('number', 1, 1)).toBe(true);
    expect(isReference('number', 1, 3)).toBe(false);
    expect(isReference('uuid', 0, 0)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Layout and exports

const f = (path: string, types: string[] = ['string'], extra: Partial<RelField> = {}): RelField => ({
  path,
  label: path,
  depth: path.split('.').length - 1,
  types,
  ratio: 1,
  many: false,
  ...extra,
});

const collection = (name: string, fields: RelField[], extra: Partial<RelCollection> = {}): RelCollection => ({ name, sampled: 10, fields, unique: [], ...extra });

const rel = (from: string, field: string, to: string, extra: Partial<Relation> = {}): Relation => ({
  id: `${from}.${field}→${to}._id`,
  from,
  field,
  fieldLabel: field,
  to,
  toField: '_id',
  many: false,
  kind: 'reference',
  matched: 20,
  tested: 20,
  ...extra,
});

const graph: RelGraph = {
  database: 'shop',
  sample: 10,
  collections: [
    collection('orders', [f('_id', ['objectId']), f('customerId', ['objectId']), f('items', ['array']), f('items.productId', ['objectId'], { label: 'items[].productId', many: true }), f('total', ['double'])]),
    collection('customers', [f('_id', ['objectId']), f('email'), f('address', ['object']), f('address.city')], { unique: ['email'], documents: 1234 }),
    collection('products', [f('_id', ['objectId']), f('name', ['null', 'string'])]),
    collection('recent_orders', [f('_id', ['objectId'])], { view: true, viewOn: 'orders' }),
    collection('logs', [f('_id', ['objectId']), f('msg')]),
  ],
  relations: [
    rel('orders', 'customerId', 'customers'),
    rel('orders', 'items.productId', 'products', { many: true, fieldLabel: 'items[].productId' }),
    rel('recent_orders', '_id', 'orders', { kind: 'view', toField: '_id' }),
  ],
};

describe('shownFields and rowLabel', () => {
  it('shows keys and plain fields, sub-documents through their fields', () => {
    const c = graph.collections[1];
    expect(shownFields(c, graph.relations, false).rows.map((r) => r.path)).toEqual(['_id', 'email', 'address.city']);
    expect(shownFields(c, graph.relations, true).rows.map((r) => r.path)).toEqual(['_id', 'email']);
    expect(shownFields(graph.collections[0], graph.relations, true).rows.map((r) => r.path)).toEqual(['_id', 'customerId', 'items.productId']);
  });

  it('keeps keys over the row limit and counts the rest', () => {
    const fields = [f('_id', ['objectId']), ...Array.from({ length: 30 }, (_, i) => f(`f${i}`)), f('ownerId', ['objectId'])];
    const c = collection('big', fields);
    const { rows, more } = shownFields(c, [rel('big', 'ownerId', 'users')], false);
    expect(rows).toHaveLength(ROWS_MAX);
    expect(rows.map((r) => r.path)).toContain('ownerId');
    expect(rows.length + more).toBe(fields.length);
    expect(boxHeight(c, [rel('big', 'ownerId', 'users')], false)).toBe(HEAD_H + (ROWS_MAX + 1) * ROW_H + 8);
  });

  it('indents a field under its shown parent, else shows its whole path', () => {
    const parent = f('a', ['string']);
    const child = f('a.b', ['string']);
    expect(rowLabel(child, [parent, child])).toEqual({ text: 'b', indent: 1 });
    expect(rowLabel(child, [child])).toEqual({ text: 'a.b', indent: 0 });
    expect(rowLabel(parent, [parent])).toEqual({ text: 'a', indent: 0 });
  });
});

describe('layout', () => {
  const { boxes, width, height } = layout(graph, false);
  const box = (name: string) => boxes.find((b) => b.name === name)!;

  it('places every collection once, without overlaps', () => {
    expect(boxes.map((b) => b.name).sort()).toEqual(graph.collections.map((c) => c.name).sort());
    for (const a of boxes) {
      for (const b of boxes) {
        if (a === b) continue;
        const overlap = a.x < b.x + b.w && b.x < a.x + a.w && a.y < b.y + b.h && b.y < a.y + a.h;
        expect(overlap, `${a.name} overlaps ${b.name}`).toBe(false);
      }
    }
    expect(width).toBe(Math.max(...boxes.map((b) => b.x + b.w)));
    expect(height).toBe(Math.max(...boxes.map((b) => b.y + b.h)));
  });

  it('puts referenced collections left of the ones referencing them, unrelated ones below', () => {
    expect(box('customers').x).toBe(0);
    expect(box('products').x).toBe(0);
    expect(box('orders').x).toBe(NODE_W + GAP_X);
    expect(box('recent_orders').x).toBe(2 * (NODE_W + GAP_X));
    const related = ['customers', 'products', 'orders', 'recent_orders'].map(box);
    expect(box('logs').y).toBeGreaterThan(Math.max(...related.map((b) => b.y + b.h)));
  });

  it('survives cycles and self-references', () => {
    const cyclic: RelGraph = {
      ...graph,
      collections: [collection('a', [f('_id'), f('bId')]), collection('b', [f('_id'), f('aId')])],
      relations: [rel('a', 'bId', 'b'), rel('b', 'aId', 'a'), rel('a', '_id', 'a')],
    };
    const out = layout(cyclic, true);
    expect(out.boxes).toHaveLength(2);
    for (const b of out.boxes) expect(Number.isFinite(b.x) && Number.isFinite(b.y)).toBe(true);
  });

  it('lays out an empty graph', () => {
    expect(layout({ ...graph, collections: [], relations: [] }, false)).toEqual({ boxes: [], width: 0, height: 0 });
  });

  it('places edges at the rows of their fields', () => {
    const orders = graph.collections[0];
    const b = box('orders');
    expect(rowY(b, orders, graph.relations, false, 'customerId')).toBe(b.y + HEAD_H + ROW_H + ROW_H / 2 + 2);
    expect(rowY(b, orders, graph.relations, false, 'missing')).toBe(b.y + HEAD_H / 2);
    const e = edgePath(b, 10, box('customers'), 20);
    // From the left side of orders to the right side of customers.
    expect(e.sx).toBe(b.x);
    expect(e.ex).toBe(box('customers').x + NODE_W);
    expect(e.d.startsWith(`M ${b.x} 10 C`)).toBe(true);
    const loop = edgePath(b, 10, b, 30);
    expect(loop.sx).toBe(b.x + b.w);
    expect(loop.ex).toBe(b.x + b.w);
  });
});

describe('toMermaid', () => {
  it('writes an erDiagram with keys and cardinalities', () => {
    const text = toMermaid(graph, true);
    const lines = text.split('\n');
    expect(lines[0]).toBe('erDiagram');
    expect(text.endsWith('\n')).toBe(true);
    expect(lines).toContain('  orders {');
    expect(lines).toContain('    objectId _id PK');
    expect(lines).toContain('    objectId customerId FK');
    // Array markers are left out of the attribute name.
    expect(lines).toContain('    objectId items_productId FK');
    expect(lines).toContain('    string email UK');
    // The first type that isn't null.
    expect(toMermaid(graph, false)).toContain('    string name\n');
    expect(lines).toContain('  orders }o--|| customers : "customerId"');
    expect(lines).toContain('  orders }o--o{ products : "items[].productId"');
    expect(lines).toContain('  recent_orders ||--|| orders : "view of"');
  });

  it('makes names and labels safe for Mermaid', () => {
    const g: RelGraph = {
      database: 'd',
      sample: 1,
      collections: [collection('my coll.v2', [f('_id', ['objectId'])]), collection('x', [f('_id', ['objectId'])])],
      relations: [rel('my coll.v2', '_id', 'x', { fieldLabel: 'say "hi"' })],
    };
    const text = toMermaid(g, true);
    expect(text).toContain('  my_coll_v2 {');
    expect(text).toContain(`  my_coll_v2 }o--|| x : "say 'hi'"`);
  });
});

describe('toSvg and describe', () => {
  it('draws every box and edge, escaping text', () => {
    const g: RelGraph = { ...graph, collections: [...graph.collections, collection('a<b>&"c"', [f('_id')])] };
    const { boxes } = layout(g, false);
    const svg = toSvg(g, boxes, false);
    expect(svg.startsWith('<?xml')).toBe(true);
    expect(svg.trim().endsWith('</svg>')).toBe(true);
    expect(svg.match(/<g>/g)).toHaveLength(g.collections.length);
    expect(svg.match(/marker-end=/g)).toHaveLength(g.relations.length);
    expect(svg).toContain('stroke-dasharray');
    expect(svg).toContain('a&lt;b&gt;&amp;&quot;c&quot;');
    expect(svg).not.toContain('a<b>');
    expect(svg).toContain('1,234 docs');
    expect(svg).toContain('recent_orders (view)');
  });

  it('describes a relation', () => {
    expect(describeRelation(rel('orders', 'customerId', 'customers', { matched: 18 }))).toBe(
      'orders.customerId → customers._id · many-to-one · 18 of 20 sampled values found',
    );
    expect(describeRelation(rel('a', 'r', 'b', { kind: 'dbref', many: true }))).toBe('a.r → b._id · many-to-many (an array of references) · DBRef');
    expect(describeRelation(rel('v', '_id', 'o', { kind: 'view' }))).toBe('v is a view of o');
  });
});
