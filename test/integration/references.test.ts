// Following references from the table against the standalone mongod: the analysis of a database, its cache,
// and the filters of the links finding the referenced and the referencing documents.
import { BSON, Document, MongoClient } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import type { ConnectionManager } from '../../src/connections';
import { toBson } from '../../src/queries';
import { RelationsCache, analyzeRelations } from '../../src/relationsAnalysis';
import { relaxEjson } from '../../src/shared/query';
import { collectionReferences, referenceTargets, referencingTargets } from '../../src/shared/references';

const { EJSON, ObjectId } = BSON;
const DB = 'mongoster_references';

let client: MongoClient;
const users = [new ObjectId(), new ObjectId(), new ObjectId()];
const tags = [new ObjectId(), new ObjectId()];

/** A document as the table has it: relaxed EJSON. */
const relaxed = (doc: Document) => relaxEjson(EJSON.serialize(doc, { relaxed: false })) as Record<string, unknown>;

beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
  const db = client.db(DB);
  await db.dropDatabase();
  await db.collection('users').insertMany(users.map((_id, i) => ({ _id, name: `user ${i}`, email: `u${i}@example.com` })));
  await db.collection('users').createIndex({ email: 1 }, { unique: true });
  await db.collection('tags').insertMany(tags.map((_id, i) => ({ _id, label: `tag ${i}` })));
  await db.collection('products').insertMany([{ _id: 'p-1' }, { _id: 'p-2' }, { _id: 'p-3' }] as Document[]);
  await db.collection('orders').insertMany(
    Array.from({ length: 12 }, (_, i) => ({
      userId: users[i % 3],
      tagIds: [tags[i % 2], tags[(i + 1) % 2]],
      items: [{ productId: `p-${(i % 3) + 1}`, qty: 1 }],
      userEmail: `u${i % 3}@example.com`,
      total: i * 10,
    })),
  );
  await db.createCollection('bigOrders', { viewOn: 'orders', pipeline: [{ $match: { total: { $gte: 50 } } }] });
});

afterAll(async () => {
  await client?.db(DB).dropDatabase();
  await client?.close();
});

describe('analysis', () => {
  it('finds the references of the database, single and arrays, on _id and on a unique field', async () => {
    const graph = (await analyzeRelations(client.db(DB), 100))!;
    const ids = graph.relations.filter((r) => r.kind !== 'view').map((r) => r.id);
    expect(ids).toEqual(
      expect.arrayContaining(['orders.userId→users._id', 'orders.tagIds→tags._id', 'orders.items.productId→products._id', 'orders.userEmail→users.email']),
    );
    expect(graph.collections.find((c) => c.name === 'bigOrders')?.viewOn).toBe('orders');
  });
});

describe('links', () => {
  it('find the referenced documents and the documents referencing a row', async () => {
    const db = client.db(DB);
    const graph = (await analyzeRelations(db, 100))!;
    const order = relaxed((await db.collection('orders').findOne({ total: 40 }))!);
    const outgoing = collectionReferences(graph.relations, 'orders').outgoing;
    const find = async (collection: string, filter: string) => db.collection(collection).find(toBson(filter, 'Filter')!).toArray();

    const [user] = referenceTargets(outgoing, 'userId', order.userId, DB);
    expect(user.collection).toBe('users');
    expect((await find(user.collection, user.filter)).map((d) => d._id)).toEqual([users[1]]);

    const [tagged] = referenceTargets(outgoing, 'tagIds', order.tagIds, DB);
    expect(tagged.count).toBe(2);
    expect(await find(tagged.collection, tagged.filter)).toHaveLength(2);

    const element = (order.items as Record<string, unknown>[])[0].productId;
    const [product] = referenceTargets(outgoing, 'items.productId', element, DB);
    expect(await find(product.collection, product.filter)).toEqual([{ _id: 'p-2' }]);

    const [byEmail] = referenceTargets(outgoing, 'userEmail', order.userEmail, DB);
    expect((await find(byEmail.collection, byEmail.filter)).map((d) => d._id)).toEqual([users[1]]);

    // Back from a user and from a tag.
    const incoming = collectionReferences(graph.relations, 'users').incoming;
    const row = relaxed((await db.collection('users').findOne({ _id: users[1] }))!);
    const back = referencingTargets(incoming, row);
    expect(back.map((t) => t.label)).toEqual(['orders.userEmail', 'orders.userId']);
    for (const t of back) expect(await find(t.collection, t.filter)).toHaveLength(4);
    const tag = relaxed((await db.collection('tags').findOne({ _id: tags[0] }))!);
    const [byTag] = referencingTargets(collectionReferences(graph.relations, 'tags').incoming, tag);
    expect(await find(byTag.collection, byTag.filter)).toHaveLength(12);
  });
});

describe('cache', () => {
  it('analyzes a database once, and again in the background after a refresh', async () => {
    let connects = 0;
    const connections = {
      getClient: async () => {
        connects++;
        return client;
      },
    } as unknown as ConnectionManager;
    const updates: string[] = [];
    const listener = RelationsCache.onDidUpdate((e) => updates.push(e.database));
    try {
      const [a, b] = await Promise.all([RelationsCache.get(connections, 'test', DB), RelationsCache.get(connections, 'test', DB)]);
      expect(a).toBeDefined();
      expect(b).toBe(a);
      expect(connects).toBe(1);
      expect(await RelationsCache.get(connections, 'test', DB)).toBe(a);
      expect(connects).toBe(1);
      expect(updates).toEqual([DB]);

      // Stale after a refresh: still given at once, found again behind.
      RelationsCache.invalidate('test', DB);
      expect(await RelationsCache.get(connections, 'test', DB)).toBe(a);
      expect(connects).toBe(2);
      await expect.poll(() => updates.length).toBe(2);
      expect(RelationsCache.peek('test', DB)).not.toBe(a);

      // A disconnection forgets it.
      RelationsCache.retain(() => false);
      expect(RelationsCache.peek('test', DB)).toBeUndefined();
    } finally {
      listener.dispose();
    }
  });
});
