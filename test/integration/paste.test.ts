// Pasting collections and views against the standalone mongod: whole collections with their indexes and options,
// views as views, what exists in the destination by the mode chosen, cancelling, moving instead of copying, and the
// events for redis-oplog.
import { Int32, Long, MongoClient } from 'mongodb';
import { afterAll, beforeAll, beforeEach, describe, expect, inject, it } from 'vitest';
import { MoveOptions, PasteHooks, existingNames, pasteCollections, pasteSources } from '../../src/copy';
import { OplogEvent, meteorId } from '../../src/shared/oplog';
import { ExistingMode, planPaste } from '../../src/shared/paste';

const FROM = 'mongoster_paste_from';
const TO = 'mongoster_paste_to';

let client: MongoClient;
beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
});
afterAll(async () => {
  await client?.db(FROM).dropDatabase();
  await client?.db(TO).dropDatabase();
  await client?.close();
});

beforeEach(async () => {
  await client.db(FROM).dropDatabase();
  await client.db(TO).dropDatabase();
  const db = client.db(FROM);
  await db.createCollection('orders', { validator: { $jsonSchema: { bsonType: 'object', required: ['status'] } } });
  await db.collection('orders').insertMany([
    { _id: 1 as never, status: 'open', total: new Int32(5), big: Long.fromString('9007199254740993') },
    { _id: 2 as never, status: 'paid', total: 7.5 },
    { _id: 3 as never, status: 'open', total: 1 },
  ]);
  await db.collection('orders').createIndex({ status: 1 }, { name: 'byStatus' });
  await db.collection('people').insertMany([{ _id: 'a' as never, name: 'Ada' }]);
  await db.createCollection('open', { viewOn: 'orders', pipeline: [{ $match: { status: 'open' } }] });
});

const hooks = (cancelled: () => boolean = () => false): PasteHooks & { started: string[] } => {
  const started: string[] = [];
  return { started, starting: (item) => started.push(item.target), progress: () => undefined, cancelled };
};

async function paste(to: string, mode: ExistingMode, sources?: { name: string; isView: boolean }[], h = hooks(), batchSize?: number, move?: MoveOptions) {
  const items = planPaste(sources ?? (await pasteSources(client, FROM)), await existingNames(client, to), to === FROM);
  return { ...(await pasteCollections(client, FROM, client, to, items, mode, h, batchSize, move)), started: h.started };
}
const names = async (database: string) => [...(await existingNames(client, database))].filter(([name]) => !name.startsWith('system.')).sort();

describe('pasting a database', () => {
  it('lists its collections and views, without the system ones', async () => {
    expect(await pasteSources(client, FROM)).toEqual([
      { name: 'open', isView: true },
      { name: 'orders', isView: false },
      { name: 'people', isView: false },
    ]);
  });

  it('copies the collections with documents, indexes and options, then the views as views', async () => {
    const run = await paste(TO, 'skip');
    expect(run.cancelled).toBe(false);
    expect(run.started).toEqual(['orders', 'people', 'open']);
    expect(run.outcomes.map((o) => [o.item.target, o.action, o.error, o.result?.copied])).toEqual([
      ['orders', 'create', undefined, 3],
      ['people', 'create', undefined, 1],
      ['open', 'create', undefined, undefined],
    ]);
    const to = client.db(TO);
    const infos = await to.listCollections({}, { nameOnly: false }).toArray();
    const info = (name: string) => infos.find((c) => c.name === name)!;
    expect(info('orders').options).toMatchObject({ validator: { $jsonSchema: { required: ['status'] } } });
    expect(info('open')).toMatchObject({ type: 'view', options: { viewOn: 'orders', pipeline: [{ $match: { status: 'open' } }] } });
    expect((await to.collection('orders').listIndexes().toArray()).map((i) => i.name)).toEqual(['_id_', 'byStatus']);
    expect(await to.collection('open').countDocuments()).toBe(2);
    // The types stay: an Int32 is not read back as a Double, a Long keeps its digits.
    const first = await to.collection('orders').findOne({ _id: 1 as never }, { promoteValues: false });
    expect(first!.total).toBeInstanceOf(Int32);
    expect(String(first!.big)).toBe('9007199254740993');
  });
});

describe('pasting collections', () => {
  it('gives _copy names in the same database, views included', async () => {
    const run = await paste(FROM, 'skip', [
      { name: 'orders', isView: false },
      { name: 'open', isView: true },
    ]);
    expect(run.outcomes.map((o) => [o.item.target, o.error])).toEqual([
      ['orders_copy', undefined],
      ['open_copy', undefined],
    ]);
    const db = client.db(FROM);
    expect(await db.collection('orders_copy').countDocuments()).toBe(3);
    expect(await db.collection('open_copy').countDocuments()).toBe(2);
  });

  describe('when the destination has them', () => {
    beforeEach(async () => {
      const to = client.db(TO);
      await to.collection('orders').insertMany([
        { _id: 2 as never, status: 'old' },
        { _id: 9 as never, status: 'kept' },
      ]);
      await to.createCollection('open', { viewOn: 'orders', pipeline: [] });
    });
    const statuses = async () => (await client.db(TO).collection('orders').find().sort({ _id: 1 }).toArray()).map((d) => `${d._id}:${d.status}`);
    const viewPipeline = async () => (await client.db(TO).listCollections({ name: 'open' }, { nameOnly: false }).toArray())[0].options?.pipeline;

    it('skips them and pastes the others', async () => {
      const run = await paste(TO, 'skip');
      expect(run.outcomes.map((o) => [o.item.target, o.action])).toEqual([
        ['orders', 'skip'],
        ['people', 'create'],
        ['open', 'skip'],
      ]);
      expect(run.started).toEqual(['people']);
      expect(await statuses()).toEqual(['2:old', '9:kept']);
    });

    it('appends the documents whose _id is missing, leaving an existing view', async () => {
      const run = await paste(TO, 'append');
      expect(run.outcomes[0].result).toMatchObject({ copied: 2, skipped: 1, failed: 0 });
      expect(run.outcomes[2]).toMatchObject({ action: 'skip', why: 'the view exists' });
      expect(await statuses()).toEqual(['1:open', '2:old', '3:open', '9:kept']);
      expect(await viewPipeline()).toEqual([]);
    });

    it('replaces the documents with the same _id', async () => {
      await paste(TO, 'upsert');
      expect(await statuses()).toEqual(['1:open', '2:paid', '3:open', '9:kept']);
    });

    it('drops and recreates collections and views', async () => {
      const run = await paste(TO, 'drop');
      expect(run.outcomes.map((o) => [o.action, o.error])).toEqual([
        ['drop', undefined],
        ['create', undefined],
        ['drop', undefined],
      ]);
      expect(await statuses()).toEqual(['1:open', '2:paid', '3:open']);
      expect(await viewPipeline()).toEqual([{ $match: { status: 'open' } }]);
    });
  });

  it('goes on after a collection that fails, and reports it', async () => {
    const run = await paste(TO, 'skip', [
      { name: 'missing_view', isView: true },
      { name: 'people', isView: false },
    ]);
    expect(run.outcomes.map((o) => [o.item.target, o.error])).toEqual([
      ['people', undefined],
      ['missing_view', 'missing_view is not a view any more'],
    ]);
  });

  it('stops after the batch being written when it is cancelled', async () => {
    let cancel = false;
    const h = hooks(() => cancel);
    h.progress = () => (cancel = true);
    const run = await paste(TO, 'skip', undefined, h, 2);
    expect(run.cancelled).toBe(true);
    expect(run.started).toEqual(['orders']);
    expect(await client.db(TO).collection('orders').countDocuments()).toBe(2);
    expect(await existingNames(client, TO)).toEqual(new Map([['orders', 'collection']]));
  });
});

describe('moving instead of copying', () => {
  it('renames the collections into the other database on the same deployment, and moves the views', async () => {
    const run = await paste(TO, 'skip', undefined, hooks(), undefined, { sameDeployment: true });
    expect(run.outcomes.map((o) => [o.item.target, o.moved, o.error])).toEqual([
      ['orders', 'renamed', undefined],
      ['people', 'renamed', undefined],
      ['open', 'copied', undefined],
    ]);
    expect(await names(FROM)).toEqual([]);
    expect(await names(TO)).toEqual([
      ['open', 'view'],
      ['orders', 'collection'],
      ['people', 'collection'],
    ]);
    // Renamed whole: the index and the validation rules came along.
    const to = client.db(TO);
    expect((await to.collection('orders').listIndexes().toArray()).map((i) => i.name)).toEqual(['_id_', 'byStatus']);
    expect((await to.listCollections({ name: 'orders' }, { nameOnly: false }).toArray())[0].options).toHaveProperty('validator');
    expect(await to.collection('open').countDocuments()).toBe(2);
  });

  it('copies and drops between deployments, with the documents, the indexes and the options', async () => {
    const run = await paste(TO, 'skip', [{ name: 'orders', isView: false }], hooks(), undefined, { sameDeployment: false });
    expect(run.outcomes.map((o) => [o.moved, o.result?.copied])).toEqual([['copied', 3]]);
    expect(await names(FROM)).toEqual([
      ['open', 'view'],
      ['people', 'collection'],
    ]);
    expect((await client.db(TO).collection('orders').listIndexes().toArray()).map((i) => i.name)).toEqual(['_id_', 'byStatus']);
  });

  it('replaces what exists with Drop and recreate, and leaves source and destination with Skip', async () => {
    await client.db(TO).collection('orders').insertOne({ _id: 9 as never, status: 'kept' });
    const skipped = await paste(TO, 'skip', [{ name: 'orders', isView: false }], hooks(), undefined, { sameDeployment: true });
    expect(skipped.outcomes.map((o) => [o.action, o.moved])).toEqual([['skip', undefined]]);
    expect(await client.db(FROM).collection('orders').countDocuments()).toBe(3);

    const dropped = await paste(TO, 'drop', [{ name: 'orders', isView: false }], hooks(), undefined, { sameDeployment: true });
    expect(dropped.outcomes.map((o) => [o.action, o.moved])).toEqual([['drop', 'renamed']]);
    expect((await client.db(TO).collection('orders').find().toArray()).map((d) => d._id)).toEqual([1, 2, 3]);
    expect(await names(FROM)).toEqual([
      ['open', 'view'],
      ['people', 'collection'],
    ]);
  });

  it('appends to what exists by copying, then drops the source', async () => {
    await client.db(TO).collection('orders').insertOne({ _id: 2 as never, status: 'old' });
    const run = await paste(TO, 'append', [{ name: 'orders', isView: false }], hooks(), undefined, { sameDeployment: true });
    expect(run.outcomes[0]).toMatchObject({ action: 'append', moved: 'copied', result: { copied: 2, skipped: 1 } });
    expect((await names(FROM)).map(([name]) => name)).not.toContain('orders');
  });

  it('keeps the source when its copy is cancelled', async () => {
    let cancel = false;
    const h = hooks(() => cancel);
    h.progress = () => (cancel = true);
    const run = await paste(TO, 'skip', [{ name: 'orders', isView: false }], h, 2, { sameDeployment: false });
    expect(run.cancelled).toBe(true);
    expect(run.outcomes[0]).toMatchObject({ kept: 'its copy was cancelled' });
    expect(await client.db(FROM).collection('orders').countDocuments()).toBe(3);
  });
});

describe('the events for redis-oplog', () => {
  const published = () => {
    const events: Record<string, OplogEvent[]> = {};
    const h = hooks();
    // The ids are read with their BSON types (an Int32 stays one): as Meteor reads them, they are the numbers.
    h.published = (item, batch) => (events[item.target] = [...(events[item.target] ?? []), ...batch.map((e) => ({ ...e, id: meteorId(e.id) }))]);
    return { h, events };
  };

  it('are an insert for each document pasted, and none for a view', async () => {
    const { h, events } = published();
    await paste(TO, 'skip', undefined, h);
    expect(events).toEqual({
      orders: [1, 2, 3].map((id) => ({ e: 'i', id })),
      people: [{ e: 'i', id: 'a' }],
    });
  });

  it('leave out the documents skipped by Append, and say which fields Replace matching wrote', async () => {
    const seed = () =>
      client
        .db(TO)
        .collection('orders')
        .insertOne({ _id: 2 as never, status: 'old' });
    await seed();
    const appended = published();
    await paste(TO, 'append', [{ name: 'orders', isView: false }], appended.h);
    expect(appended.events.orders).toEqual([1, 3].map((id) => ({ e: 'i', id })));

    await client.db(TO).collection('orders').drop();
    await seed();
    const replaced = published();
    await paste(TO, 'upsert', [{ name: 'orders', isView: false }], replaced.h);
    expect(replaced.events.orders).toEqual([
      { e: 'i', id: 1 },
      { e: 'u', id: 2, fields: ['status', 'total'] },
      { e: 'i', id: 3 },
    ]);
  });
});
