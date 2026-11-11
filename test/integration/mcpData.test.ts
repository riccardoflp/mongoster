// The MCP tools of the data model (count_documents, distinct_values, describe_relations,
// collection_options) against the standalone mongod.
import { Db, Decimal128, Long, MongoClient, ObjectId } from 'mongodb';
import { afterAll, beforeAll, describe, expect, inject, it } from 'vitest';
import { dataTools } from '../../src/mcp/data';
import type { McpTool } from '../../src/shared/mcp';
import { TEST_CONNECTION, callTool, testContext } from './mcpHelpers';

const DB = `mcp_data_${process.pid}`;
const REL_DB = `mcp_data_rel_${process.pid}`;

let client: MongoClient;
let db: Db;
let tools: McpTool[];
const call = (name: string, args: Record<string, unknown>) => callTool(tools, name, { connection: TEST_CONNECTION, database: DB, ...args });

beforeAll(async () => {
  client = await MongoClient.connect(inject('mongoUri'));
  db = client.db(DB);
  tools = dataTools(testContext(client));
  await db.collection('items').insertMany([
    { status: 'active', tags: ['a', 'b', 'a'], n: 1, price: 5 },
    { status: 'active', tags: ['a'], n: 2, price: '5' },
    { status: 'inactive', tags: [], n: 3, price: new Decimal128('5.5') },
    { status: null, tags: 'a', n: 4, price: new Long(7) },
    { n: 5, items: [{ sku: 'x' }, { sku: 'y' }, { sku: 'x' }] },
  ]);
  await db.createCollection('people', {
    validator: { $jsonSchema: { bsonType: 'object', required: ['name'], properties: { name: { bsonType: 'string' } } } },
    validationAction: 'warn',
  });
  await db.createCollection('strict', { validator: { age: { $gte: 0 } }, validationLevel: 'moderate' });
  await db.createCollection('log', { capped: true, size: 65536, max: 100 });
  await db.createCollection('activeItems', { viewOn: 'items', pipeline: [{ $match: { status: 'active' } }] });
  await db.createCollection('metrics', { timeseries: { timeField: 't', metaField: 'm', granularity: 'minutes' }, expireAfterSeconds: 3600 });
  await db.createCollection('accented', { collation: { locale: 'fr', strength: 2 } });

  const rel = client.db(REL_DB);
  const customers = Array.from({ length: 10 }, () => ({ _id: new ObjectId(), name: 'c' }));
  const products = Array.from({ length: 5 }, (_, i) => ({ _id: `p${i}`, sku: `sku${i}` }));
  await rel.collection('customers').insertMany(customers);
  await rel.collection<{ _id: string; sku: string }>('products').insertMany(products);
  await rel.collection('orders').insertMany(
    Array.from({ length: 30 }, (_, i) => ({ customerId: customers[i % 10]._id, productIds: [products[i % 5]._id, products[(i + 1) % 5]._id], note: `n${i}` })),
  );
  await rel.collection('lonely').insertOne({ x: 1 });
});

afterAll(async () => {
  await db?.dropDatabase();
  await client?.db(REL_DB).dropDatabase();
  await client?.close();
});

describe('count_documents', () => {
  it('counts all the documents, with the estimate', async () => {
    const r = await call('count_documents', { collection: 'items' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`${DB}.items has 5 documents.`);
    expect(r.text).toContain("Estimate from the collection's metadata: 5 documents.");
  });

  it('counts the documents that match a filter, without the estimate', async () => {
    const r = await call('count_documents', { collection: 'items', filter: '{ status: "active" }' });
    expect(r.text).toBe(`${DB}.items: 2 documents match { status: "active" }.`);
    const one = await call('count_documents', { collection: 'items', filter: '{ n: { $gt: 4 } }' });
    expect(one.text).toContain('1 document matches');
    const exact = await call('count_documents', { collection: 'items', filter: '{ n: { $gt: 1 } }', exact: true });
    expect(exact.text).toBe(`${DB}.items: 4 documents match { n: { $gt: 1 } }.`);
  });

  it('counts a view', async () => {
    const r = await call('count_documents', { collection: 'activeItems' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('has 2 documents.');
  });

  it('refuses a bad filter and a missing collection', async () => {
    const bad = await call('count_documents', { collection: 'items', filter: '{ status: ' });
    expect(bad.isError).toBe(true);
    const op = await call('count_documents', { collection: 'items', filter: '{ $bogus: 1 }' });
    expect(op.isError).toBe(true);
    expect(op.text).toMatch(/^The count failed: /);
    const missing = await call('count_documents', { collection: 'nope' });
    expect(missing.isError).toBe(true);
    expect(missing.text).toContain(`${DB}.nope doesn't exist`);
  });
});

describe('distinct_values', () => {
  it('counts the values of a field, unwinding arrays once per document', async () => {
    const r = await call('distinct_values', { collection: 'items', field: 'tags' });
    expect(r.isError).toBe(false);
    expect(r.text).toContain('field tags: 2 distinct values (string).');
    // "a" is twice in the first document but counted once; the plain string "a" counts too.
    expect(r.text).toContain('- "a": 3');
    expect(r.text).toContain('- "b": 1');
    expect(r.text).toContain('Missing or an empty array: 2 documents.');
    expect(r.text.indexOf('"a"')).toBeLessThan(r.text.indexOf('"b"'));
  });

  it('shows the types of mixed values, and null and missing', async () => {
    const r = await call('distinct_values', { collection: 'items', field: 'price' });
    expect(r.text).toContain('4 distinct values, of types decimal, int, long, string.');
    expect(r.text).toContain('- "5" (string): 1');
    expect(r.text).toContain('- 7 (long): 1');
    const s = await call('distinct_values', { collection: 'items', field: 'status' });
    expect(s.text).toContain('null: 1 document. Missing or an empty array: 1 document.');
  });

  it('follows a path into an array of documents, with a filter and a limit', async () => {
    const r = await call('distinct_values', { collection: 'items', field: 'items.sku' });
    expect(r.text).toContain('- "x": 1');
    expect(r.text).toContain('- "y": 1');
    const f = await call('distinct_values', { collection: 'items', field: 'status', filter: '{ n: { $lte: 2 } }' });
    expect(f.text).toContain('(filter { n: { $lte: 2 } }), field status: 1 distinct value');
    const l = await call('distinct_values', { collection: 'items', field: 'n', limit: 2 });
    expect(l.text).toContain('5 distinct values, the 2 most frequent shown');
  });

  it('refuses a bad field and a bad filter', async () => {
    expect((await call('distinct_values', { collection: 'items', field: '$status' })).isError).toBe(true);
    expect((await call('distinct_values', { collection: 'items', field: 'a..b' })).isError).toBe(true);
    const bad = await call('distinct_values', { collection: 'items', field: 'status', filter: '{ $bogus: 1 }' });
    expect(bad.isError).toBe(true);
    expect(bad.text).toMatch(/^The aggregation failed: /);
  });

  it('returns document values, so it is flagged', () => {
    expect(tools.find((t) => t.name === 'distinct_values')!.documents).toBe(true);
    expect(tools.filter((t) => t.documents).map((t) => t.name)).toEqual(['distinct_values']);
  });
});

describe('describe_relations', () => {
  const rel = (args: Record<string, unknown>) => callTool(tools, 'describe_relations', { connection: TEST_CONNECTION, database: REL_DB, ...args });

  it('finds ObjectId references and arrays of named string ids', async () => {
    const r = await rel({});
    expect(r.isError).toBe(false);
    expect(r.text).toContain(`${REL_DB}: 4 collections sampled (up to 100 documents each).`);
    expect(r.text).toContain('- orders.customerId → customers._id (one per document; 10 of 10 sampled values found, 100%)');
    expect(r.text).toContain('- orders.productIds → products._id (an array of references; 5 of 5 sampled values found, 100%)');
    expect(r.text).not.toContain('lonely.');
  });

  it("shows only a collection's outgoing and incoming references", async () => {
    const r = await rel({ collection: 'customers', sample: 50 });
    expect(r.text).toContain('From customers:\n- none found');
    expect(r.text).toMatch(/To customers:\n- orders\.customerId → customers\._id/);
    expect(r.text).not.toContain('products._id');
    const missing = await rel({ collection: 'nope' });
    expect(missing.isError).toBe(true);
  });

  it('shows views on their collection', async () => {
    const r = await callTool(tools, 'describe_relations', { connection: TEST_CONNECTION, database: DB, collection: 'items' });
    expect(r.text).toContain('- activeItems is a view on items');
  });
});

describe('collection_options', () => {
  it('shows a $jsonSchema validator with its level and action', async () => {
    const r = await call('collection_options', { collection: 'people' });
    expect(r.text).toContain(`${DB}.people is a collection.`);
    expect(r.text).toContain('Validator ($jsonSchema): {');
    expect(r.text).toContain('required: [');
    expect(r.text).toContain('validationLevel: strict');
    expect(r.text).toContain('validationAction: warn: invalid writes are accepted and logged.');
  });

  it('shows a query validator', async () => {
    const r = await call('collection_options', { collection: 'strict' });
    expect(r.text).toContain('Validator (query): {');
    expect(r.text).toContain('$gte: 0');
    expect(r.text).toContain('validationLevel: moderate');
    expect(r.text).toContain('validationAction: error');
  });

  it('shows a plain collection, a capped one and a collation', async () => {
    expect((await call('collection_options', { collection: 'items' })).text).toBe(`${DB}.items is a collection.\n\nNo validator: any document is accepted.`);
    const capped = await call('collection_options', { collection: 'log' });
    expect(capped.text).toContain('is a capped collection.');
    expect(capped.text).toContain('Capped: 65,536 bytes, at most 100 documents');
    const fr = await call('collection_options', { collection: 'accented' });
    expect(fr.text).toContain('Default collation (of its queries and indexes): { locale: "fr"');
  });

  it('shows a view and a time series collection', async () => {
    const view = await call('collection_options', { collection: 'activeItems' });
    expect(view.text).toContain('is a view.');
    expect(view.text).toContain('View on: items');
    expect(view.text).toContain('$match');
    expect(view.text).not.toContain('No validator');
    const ts = await call('collection_options', { collection: 'metrics' });
    expect(ts.text).toContain('is a time series collection.');
    expect(ts.text).toContain('Time series: timeField t, metaField m, granularity minutes');
    expect(ts.text).toContain('expireAfterSeconds: 3600: documents are deleted that long after their t date.');
  });

  it('refuses a missing collection', async () => {
    const r = await call('collection_options', { collection: 'nope' });
    expect(r.isError).toBe(true);
    expect(r.text).toContain("doesn't exist");
  });
});
