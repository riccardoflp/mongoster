import { describe, expect, it } from 'vitest';
import type { Relation } from '../../src/shared/relations';
import { Reference, collectionReferences, isReferenceValue, referenceKeys, referenceTargets, referencingTargets } from '../../src/shared/references';

const oid = (n: number) => ({ $oid: n.toString(16).padStart(24, '0') });
const shellOid = (n: number) => `ObjectId("${n.toString(16).padStart(24, '0')}")`;

function rel(from: string, field: string, to: string, extra: Partial<Relation> = {}): Relation {
  const toField = extra.toField ?? '_id';
  return { id: `${from}.${field}→${to}.${toField}`, from, field, fieldLabel: field, to, toField, many: false, kind: 'reference', matched: 20, tested: 20, ...extra };
}

const relations: Relation[] = [
  rel('orders', 'userId', 'users'),
  rel('orders', 'items.productId', 'products', { fieldLabel: 'items[].productId', many: true }),
  rel('orders', 'customerEmail', 'customers', { toField: 'email' }),
  rel('posts', 'tagIds', 'tags', { fieldLabel: 'tagIds[]', many: true }),
  rel('posts', 'authorId', 'users'),
  rel('posts', 'authorId', 'admins'),
  rel('posts', 'author', 'users', { kind: 'dbref' }),
  rel('categories', 'parentId', 'categories'),
  rel('activeUsers', '', 'users', { kind: 'view', toField: '' }),
];

describe('collectionReferences', () => {
  it('splits the references leaving and reaching a collection, without views', () => {
    const users = collectionReferences(relations, 'users');
    expect(users.outgoing).toEqual([]);
    expect(users.incoming.map((r) => `${r.from}.${r.field}`)).toEqual(['orders.userId', 'posts.authorId', 'posts.author']);
    expect(users.incoming.find((r) => r.field === 'author')?.dbref).toBe(true);
    const orders = collectionReferences(relations, 'orders');
    expect(orders.outgoing.map((r) => r.to)).toEqual(['users', 'products', 'customers']);
    expect(orders.incoming).toEqual([]);
  });

  it('keeps self-references on both sides', () => {
    const c = collectionReferences(relations, 'categories');
    expect(c.outgoing).toHaveLength(1);
    expect(c.incoming).toHaveLength(1);
  });
});

describe('isReferenceValue', () => {
  it('accepts ids, UUIDs, strings and numbers', () => {
    expect(isReferenceValue(oid(1))).toBe(true);
    expect(isReferenceValue('abc')).toBe(true);
    expect(isReferenceValue(42)).toBe(true);
    expect(isReferenceValue({ $numberLong: '9007199254740993' })).toBe(true);
    expect(isReferenceValue({ $binary: { base64: 'AAAAAAAAAAAAAAAAAAAAAA==', subType: '04' } })).toBe(true);
    expect(isReferenceValue({ $uuid: '00000000-0000-0000-0000-000000000000' })).toBe(true);
  });

  it('rejects the rest', () => {
    for (const v of [null, undefined, '', true, { a: 1 }, [oid(1)], { $date: '2024-01-01T00:00:00Z' }, { $binary: { base64: 'AA==', subType: '00' } }, NaN]) {
      expect(isReferenceValue(v)).toBe(false);
    }
  });
});

describe('referenceTargets', () => {
  const orders = collectionReferences(relations, 'orders').outgoing;
  const posts = collectionReferences(relations, 'posts').outgoing;

  it('leads a single id to the referenced document', () => {
    expect(referenceTargets(orders, 'userId', oid(1), 'shop')).toEqual([{ collection: 'users', filter: `{ _id: ${shellOid(1)} }`, label: 'users._id', count: 1 }]);
  });

  it('leads an array of ids to all of them with $in, without duplicates', () => {
    const [t] = referenceTargets(posts, 'tagIds', [oid(1), oid(2), oid(1)], 'shop');
    expect(t).toEqual({ collection: 'tags', filter: `{ _id: { $in: [${shellOid(1)}, ${shellOid(2)}] } }`, label: 'tags._id', count: 2 });
  });

  it('leads a one-element array to that document', () => {
    expect(referenceTargets(posts, 'tagIds', [oid(3)], 'shop')[0].filter).toBe(`{ _id: ${shellOid(3)} }`);
  });

  it('follows the field of an expanded array element and the whole array of sub-documents not expanded', () => {
    // A cell of the expanded column items[].productId holds one element's value.
    expect(referenceTargets(orders, 'items.productId', oid(5), 'shop')[0]).toMatchObject({ collection: 'products', filter: `{ _id: ${shellOid(5)} }` });
    // The items column itself isn't a reference.
    expect(referenceTargets(orders, 'items', [{ productId: oid(5) }], 'shop')).toEqual([]);
  });

  it('filters on the unique field referenced', () => {
    expect(referenceTargets(orders, 'customerEmail', 'ann@example.com', 'shop')[0]).toEqual({
      collection: 'customers',
      filter: '{ email: "ann@example.com" }',
      label: 'customers.email',
      count: 1,
    });
  });

  it('gives several targets when the field references several collections', () => {
    expect(referenceTargets(posts, 'authorId', oid(7), 'shop').map((t) => t.label)).toEqual(['users._id', 'admins._id']);
  });

  it('has nothing for other fields and for values that are not references', () => {
    expect(referenceTargets(orders, 'total', 12, 'shop')).toEqual([]);
    expect(referenceTargets(orders, 'userId', null, 'shop')).toEqual([]);
    expect(referenceTargets(orders, 'userId', { name: 'x' }, 'shop')).toEqual([]);
    expect(referenceTargets(posts, 'tagIds', [], 'shop')).toEqual([]);
    expect(referenceTargets(posts, 'tagIds', [null, true], 'shop')).toEqual([]);
  });

  it('follows DBRefs to the collection they name, in this database only', () => {
    const ref = { $ref: 'users', $id: oid(9) };
    expect(referenceTargets(posts, 'author', ref, 'blog')).toEqual([{ collection: 'users', filter: `{ _id: ${shellOid(9)} }`, label: 'users._id', count: 1 }]);
    expect(referenceTargets(posts, 'author', { ...ref, $db: 'blog' }, 'blog')).toHaveLength(1);
    expect(referenceTargets(posts, 'author', { ...ref, $db: 'other' }, 'blog')).toEqual([]);
    expect(referenceTargets(posts, 'author', { $ref: 'unknown', $id: oid(9) }, 'blog')).toEqual([]);
    // The $id column of an expanded DBRef.
    expect(referenceTargets(posts, 'author.$id', oid(9), 'blog')[0].filter).toBe(`{ _id: ${shellOid(9)} }`);
  });

  it('keeps numbers and strings as they are', () => {
    const refs: Reference[] = [{ from: 'a', field: 'code', fieldLabel: 'code', to: 'b', toField: '_id', many: false, dbref: false }];
    expect(referenceTargets(refs, 'code', 12, 'x')[0].filter).toBe('{ _id: 12 }');
    expect(referenceTargets(refs, 'code', { $numberLong: '9007199254740993' }, 'x')[0].filter).toBe('{ _id: NumberLong("9007199254740993") }');
  });
});

describe('referencingTargets', () => {
  const users = collectionReferences(relations, 'users').incoming;

  it('finds the documents whose fields hold the _id of the row', () => {
    const targets = referencingTargets(users, { _id: oid(1), name: 'Ann' });
    expect(targets).toEqual([
      { collection: 'orders', filter: `{ userId: ${shellOid(1)} }`, label: 'orders.userId', count: 1 },
      { collection: 'posts', filter: `{ "author.$id": ${shellOid(1)} }`, label: 'posts.author', count: 1 },
      { collection: 'posts', filter: `{ authorId: ${shellOid(1)} }`, label: 'posts.authorId', count: 1 },
    ]);
  });

  it('matches arrays of references and fields of array elements on the element', () => {
    expect(referencingTargets(collectionReferences(relations, 'tags').incoming, { _id: oid(2) })).toEqual([
      { collection: 'posts', filter: `{ tagIds: ${shellOid(2)} }`, label: 'posts.tagIds[]', count: 1 },
    ]);
    expect(referencingTargets(collectionReferences(relations, 'products').incoming, { _id: 'p-1' })[0].filter).toBe('{ "items.productId": "p-1" }');
  });

  it('uses the unique field referenced, and skips rows without it', () => {
    const incoming = collectionReferences(relations, 'customers').incoming;
    expect(referencingTargets(incoming, { _id: oid(1), email: 'ann@example.com' })[0].filter).toBe('{ customerEmail: "ann@example.com" }');
    expect(referencingTargets(incoming, { _id: oid(1) })).toEqual([]);
  });

  it('has nothing for a row without an _id', () => {
    expect(referencingTargets(users, { name: 'Ann' })).toEqual([]);
  });
});

describe('referenceKeys', () => {
  it('lists the columns that can hold references, with the $id of DBRefs', () => {
    expect([...referenceKeys(collectionReferences(relations, 'posts').outgoing)].sort()).toEqual(['author', 'author.$id', 'authorId', 'tagIds']);
  });
});
