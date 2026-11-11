// MCP tools about the data model: how many documents match a filter, the distinct values of a field with
// their frequency, the references between collections (found as Mongoster's relationship diagram finds
// them) and a collection's definition (validator, view, capped, time series, collation, shard key).
// No vscode dependency, so the tools can be tested against a real mongod.
import type { Document } from 'mongodb';
import { McpTool, ToolError, boolArg, intArg, stringArg, truncate } from '../shared/mcp';
import { analyzeRelations } from '../relationsAnalysis';
import type { Relation } from '../shared/relations';
import { formatShardKey } from '../sharding';
import { COUNT_CAP, MAX_OUTPUT, MAX_TIME_MS, ToolContext, collectionProp, connectionProp, databaseProp, filterProp, message, plural, shell } from './context';

/** Documents sampled per collection by describe_relations: the diagram's default. */
export const RELATIONS_SAMPLE = 100;
const RELATIONS_SAMPLE_MAX = 2000;
/** Characters of a distinct value shown. */
const VALUE_MAX = 300;

const percent = (n: number, of: number) => `${Math.round((n / Math.max(1, of)) * 100)}%`;
const clip = (text: string) => (text.length > VALUE_MAX ? `${text.slice(0, VALUE_MAX)}…` : text);

/** The tools of the data model group. */
export function dataTools(ctx: ToolContext): McpTool[] {
  const { connection, client, required, target, query } = ctx;
  return [
    {
      name: 'count_documents',
      title: 'Count documents',
      description:
        `The exact number of documents that match a filter (counting stops at ${COUNT_CAP.toLocaleString('en-US')} unless exact is true); with no filter, also the fast estimate from the collection's metadata. Use it instead of find_documents when only the number matters.`,
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: databaseProp,
          collection: collectionProp,
          filter: filterProp,
          exact: { type: 'boolean', default: false, description: `Count past ${COUNT_CAP.toLocaleString('en-US')} (slower on big collections).` },
        },
        required: ['connection', 'database', 'collection'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const q = query({ filter: args.filter });
        const exact = boolArg(args, 'exact', false);
        const { database, collection, coll } = await target(args);
        const empty = !Object.keys(q.filter).length;
        const [count, estimated] = await Promise.all([
          coll.countDocuments(q.filter, { ...(!exact && { limit: COUNT_CAP }), maxTimeMS: MAX_TIME_MS }).catch((err) => {
            throw new ToolError(`The count failed: ${message(err)}`);
          }),
          empty ? coll.estimatedDocumentCount({ maxTimeMS: MAX_TIME_MS }).catch(() => undefined) : undefined,
        ]);
        const capped = !exact && count >= COUNT_CAP;
        const number = capped ? `at least ${plural(COUNT_CAP, 'document')}` : plural(count, 'document');
        const head = empty
          ? `${database}.${collection} has ${number}`
          : `${database}.${collection}: ${number} ${count === 1 && !capped ? 'matches' : 'match'} ${q.text.filter}`;
        const lines = [`${head}${capped ? ' (counting stopped there: pass exact: true for the exact number)' : ''}.`];
        if (estimated !== undefined) lines.push(`Estimate from the collection's metadata: ${plural(estimated, 'document')}.`);
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'distinct_values',
      title: 'Distinct values of a field',
      description:
        'The distinct values of a field (dotted path; arrays are unwound like distinct() does) in mongosh syntax, with how many documents have each, most frequent first; their BSON types when they are of several types; how many documents have null or lack the field; and the number of distinct values. Use it to learn the values of a status, type or category field before writing a filter.',
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: databaseProp,
          collection: collectionProp,
          field: { type: 'string', description: 'Field path, e.g. status or address.city or items.sku.' },
          filter: filterProp,
          limit: { type: 'integer', minimum: 1, maximum: 500, default: 50, description: 'Values returned (the most frequent).' },
        },
        required: ['connection', 'database', 'collection', 'field'],
        additionalProperties: false,
      },
      readOnly: true,
      documents: true,
      run: async (args) => {
        const field = required(args, 'field');
        if (field.startsWith('$') || field.split('.').some((p) => !p)) throw new ToolError(`field must be a field path like address.city, not ${JSON.stringify(field)}.`);
        const q = query({ filter: args.filter });
        const limit = intArg(args, 'limit', 50, 1, 500);
        const { database, collection, coll } = await target(args);
        let result: Document;
        try {
          [result] = await coll.aggregate(distinctPipeline(field, q.filter, limit), { maxTimeMS: MAX_TIME_MS, allowDiskUse: true, promoteLongs: false }).toArray();
        } catch (err) {
          throw new ToolError(`The aggregation failed: ${message(err)}`);
        }
        const values = (result?.values ?? []) as { _id: { v?: unknown }; n: unknown; types: string[] }[];
        const total = Number(result?.total?.[0]?.n ?? 0);
        const nulls = Number(result?.nulls?.[0]?.n ?? 0);
        const missing = Number(result?.missing?.[0]?.n ?? 0);
        const types = new Set(values.flatMap((v) => v.types));
        const where = `${database}.${collection}${q.text.filter ? ` (filter ${q.text.filter})` : ''}`;
        const lines = [
          `${where}, field ${field}: ${plural(total, 'distinct value')}${total > values.length ? `, the ${values.length.toLocaleString('en-US')} most frequent shown` : ''}${types.size > 1 ? `, of types ${[...types].sort().join(', ')}` : types.size ? ` (${[...types][0]})` : ''}.`,
          ...(values.length ? ['', 'Value: documents', ...values.map((v) => `- ${clip(shell(v._id.v))}${types.size > 1 ? ` (${v.types.join(', ')})` : ''}: ${Number(v.n).toLocaleString('en-US')}`)] : []),
          '',
          `null: ${plural(nulls, 'document')}. Missing or an empty array: ${plural(missing, 'document')}.`,
        ];
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'describe_relations',
      title: 'Describe the relations between collections',
      description:
        "The fields that reference other collections in a database (customerId → customers._id, arrays of ids, DBRefs, views), found as Mongoster's relationship diagram finds them: by sampling every collection and looking the values up in the others. With collection, only its outgoing and incoming references. Use it to write $lookup stages and to understand the data model.",
      inputSchema: {
        type: 'object',
        properties: {
          connection: connectionProp,
          database: databaseProp,
          collection: { type: 'string', description: 'Only the references from and to this collection.' },
          sample: { type: 'integer', minimum: 1, maximum: RELATIONS_SAMPLE_MAX, default: RELATIONS_SAMPLE, description: 'Documents sampled per collection.' },
        },
        required: ['connection', 'database'],
        additionalProperties: false,
      },
      readOnly: true,
      run: async (args) => {
        const info = connection(args);
        const database = required(args, 'database');
        const collection = stringArg(args, 'collection');
        const sample = intArg(args, 'sample', RELATIONS_SAMPLE, 1, RELATIONS_SAMPLE_MAX);
        const db = (await client(info)).db(database);
        const graph = await analyzeRelations(db, sample);
        if (!graph.collections.length) return `${database} has no collections.`;
        if (collection && !graph.collections.some((c) => c.name === collection)) throw new ToolError(`${database}.${collection} doesn't exist on ${info.name}: use list_collections.`);
        const views = graph.collections.filter((c) => c.view).length;
        const sampled = graph.collections.length - views;
        const relations = [...graph.relations].sort((a, b) => a.id.localeCompare(b.id));
        const head = `${database}: ${plural(sampled, 'collection')} sampled (up to ${plural(sample, 'document')} each)${views ? `, ${plural(views, 'view')}` : ''}.`;
        const lines = [head];
        if (graph.unreadable.length) lines.push(`Not readable: ${graph.unreadable.join(', ')}.`);
        if (collection) {
          const out = relations.filter((r) => r.from === collection);
          const into = relations.filter((r) => r.to === collection && r.from !== collection);
          lines.push('', `From ${collection}:`, ...(out.length ? out.map(relationLine) : ['- none found']));
          lines.push('', `To ${collection}:`, ...(into.length ? into.map(relationLine) : ['- none found']));
        } else {
          lines.push('', ...(relations.length ? relations.map(relationLine) : ['No field of the sampled documents refers to another collection.']));
        }
        lines.push(
          '',
          'References are inferred: ObjectId and UUID values are looked up in every collection with ids of that type; strings and numbers only in the collection the field is named after (customerId → customers) or in a unique field named like it.',
        );
        return truncate(lines.join('\n'), MAX_OUTPUT);
      },
    },
    {
      name: 'collection_options',
      title: 'Collection options',
      description:
        "A collection's definition: type (collection, view, time series), validator ($jsonSchema or query, in mongosh syntax) with its validationLevel and validationAction, a view's source and pipeline, capped size, time series options, clustered index, expireAfterSeconds, default collation, change stream pre- and post-images, and the shard key when sharded. Use it to find out why an insert or update is refused, or what a view does.",
      inputSchema: { type: 'object', properties: { connection: connectionProp, database: databaseProp, collection: collectionProp }, required: ['connection', 'database', 'collection'], additionalProperties: false },
      readOnly: true,
      run: async (args) => {
        const { info, database, collection } = await target(args);
        const c = await client(info);
        const [entry] = (await c.db(database).listCollections({ name: collection }, { nameOnly: false }).toArray()) as Document[];
        if (!entry) throw new ToolError(`${database}.${collection} doesn't exist on ${info.name}: use list_collections.`);
        // Ignored where config.collections can't be read; on a server that isn't a mongos it is empty.
        const sharded = await c
          .db('config')
          .collection('collections')
          .findOne({ _id: `${database}.${collection}`, dropped: { $ne: true } } as Document, { maxTimeMS: MAX_TIME_MS })
          .catch(() => null);
        return truncate(optionsText(`${database}.${collection}`, entry, sharded), MAX_OUTPUT);
      },
    },
  ];
}

/**
 * The aggregation of distinct_values: the field's values (an array's elements, each once per document)
 * grouped with their count and types; then the most frequent values, how many there are, and the
 * documents with null and without the field.
 */
export function distinctPipeline(field: string, filter: Document, limit: number): Document[] {
  const path = `$${field}`;
  return [
    ...(Object.keys(filter).length ? [{ $match: filter }] : []),
    { $project: { _id: 0, v: { $cond: [{ $isArray: path }, { $setUnion: [path] }, path] } } },
    { $unwind: { path: '$v', preserveNullAndEmptyArrays: true } },
    { $group: { _id: { v: '$v', missing: { $eq: [{ $type: '$v' }, 'missing'] } }, n: { $sum: 1 }, types: { $addToSet: { $type: '$v' } } } },
    {
      $facet: {
        values: [{ $match: { '_id.missing': false, '_id.v': { $ne: null } } }, { $sort: { n: -1, '_id.v': 1 } }, { $limit: limit }],
        total: [{ $match: { '_id.missing': false, '_id.v': { $ne: null } } }, { $count: 'n' }],
        nulls: [{ $match: { '_id.missing': false, '_id.v': null } }, { $group: { _id: null, n: { $sum: '$n' } } }],
        missing: [{ $match: { '_id.missing': true } }, { $group: { _id: null, n: { $sum: '$n' } } }],
      },
    },
  ];
}

/** "orders.customerId → customers._id (one per document; 20 of 20 sampled values found, 100%)". */
export function relationLine(r: Relation): string {
  if (r.kind === 'view') return `- ${r.from} is a view on ${r.to}`;
  const card = r.many ? 'an array of references' : 'one per document';
  const found = r.kind === 'dbref' ? 'DBRef' : `${r.matched} of ${r.tested} sampled values found, ${percent(r.matched, r.tested)}`;
  return `- ${r.from}.${r.field} → ${r.to}.${r.toField} (${card}; ${found})`;
}

const LEVELS: Record<string, string> = {
  strict: 'every insert and update is validated',
  moderate: 'inserts, and updates of documents that are already valid, are validated',
  off: 'nothing is validated',
};
const ACTIONS: Record<string, string> = {
  error: 'invalid writes are refused (error 121, Document failed validation)',
  warn: 'invalid writes are accepted and logged',
  errorAndLog: 'invalid writes are refused and logged',
};

/** collection_options' text, from a listCollections entry and the config.collections document when sharded. */
export function optionsText(name: string, entry: Document, sharded: Document | null): string {
  const o: Document = { ...(entry.options ?? {}) };
  const take = (key: string) => {
    const v = o[key];
    delete o[key];
    return v;
  };
  const view = entry.type === 'view';
  const timeseries = take('timeseries') as Document | undefined;
  const capped = take('capped');
  const clustered = take('clusteredIndex');
  const kind = view ? 'a view' : timeseries || entry.type === 'timeseries' ? 'a time series collection' : `a${capped ? ' capped' : ''}${clustered && !timeseries ? ' clustered' : ''} collection`;
  const lines = [`${name} is ${kind}.`];

  const viewOn = take('viewOn');
  const pipeline = take('pipeline');
  if (view) lines.push(`View on: ${String(viewOn)}`, `Pipeline: ${shell(pipeline ?? [], 2)}`);

  const validator = take('validator') as Document | undefined;
  const level = take('validationLevel') as string | undefined;
  const action = take('validationAction') as string | undefined;
  if (validator && Object.keys(validator).length) {
    const keys = Object.keys(validator);
    const what = keys.includes('$jsonSchema') ? (keys.length > 1 ? '$jsonSchema and query' : '$jsonSchema') : 'query';
    const lvl = level ?? 'strict';
    const act = action ?? 'error';
    lines.push(
      '',
      `Validator (${what}): ${shell(validator, 2)}`,
      `validationLevel: ${lvl}${level ? '' : ' (default)'}${LEVELS[lvl] ? `: ${LEVELS[lvl]}` : ''}.`,
      `validationAction: ${act}${action ? '' : ' (default)'}${ACTIONS[act] ? `: ${ACTIONS[act]}` : ''}.`,
    );
  } else if (!view) {
    lines.push('', 'No validator: any document is accepted.');
  }

  if (capped) {
    const size = take('size');
    const max = take('max');
    lines.push('', `Capped: ${size !== undefined ? `${Number(size).toLocaleString('en-US')} bytes` : 'size unknown'}${max ? `, at most ${plural(Number(max), 'document')}` : ''}; the oldest documents are removed to make room, and documents can't be deleted.`);
  }
  if (timeseries) {
    lines.push(
      '',
      `Time series: timeField ${String(timeseries.timeField)}${timeseries.metaField ? `, metaField ${String(timeseries.metaField)}` : ''}${timeseries.granularity ? `, granularity ${String(timeseries.granularity)}` : ''}${timeseries.bucketMaxSpanSeconds ? `, buckets of at most ${String(timeseries.bucketMaxSpanSeconds)} s` : ''}.`,
    );
  }
  if (clustered && !timeseries) {
    const ci = clustered === true ? {} : (clustered as Document);
    lines.push('', `Clustered index${ci.name ? ` ${String(ci.name)}` : ''}: ${shell(ci.key ?? { _id: 1 })}${ci.unique ? ' unique' : ''} (documents are stored in _id order).`);
  }
  const expire = take('expireAfterSeconds');
  if (expire !== undefined) {
    lines.push('', `expireAfterSeconds: ${String(expire)}: documents are deleted that long after their ${timeseries ? String(timeseries.timeField) : '_id'} date.`);
  }
  const collation = take('collation') as Document | undefined;
  if (collation) lines.push('', `Default collation (of its queries and indexes): ${shell(collation)}`);
  const images = take('changeStreamPreAndPostImages') as Document | undefined;
  if (images) lines.push('', `Change stream pre- and post-images: ${images.enabled ? 'enabled' : 'disabled'}.`);
  if (sharded?.key) lines.push('', `Sharded, shard key ${formatShardKey(sharded.key)}${sharded.unique ? ' (unique)' : ''}.`);
  if (Object.keys(o).length) lines.push('', `Other options: ${shell(o)}`);
  return lines.join('\n');
}
