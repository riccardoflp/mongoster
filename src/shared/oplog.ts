// The messages of redis-oplog (the Meteor package cultofcoders:redis-oplog): a Meteor app with it only
// sees the writes announced on Redis, so Mongoster publishes its own writes as the package would. An event
// goes to the collection's channel (and its namespaces) and to the document's dedicated channel, as EJSON
// { e, d: { _id }, f }; the app then reads the document again from MongoDB.

/** Redis-oplog options of a connection; the Redis URL is secret. */
export interface RedisOplogSettings {
  /** redis-oplog's globalRedisPrefix, before every channel name. */
  prefix?: string;
  /** Namespaces: the events also go to "<namespace>::<collection>". */
  namespaces?: string[];
  /** Databases ("app") and collections ("app.users", "app.*", "*.logs") whose writes are published: empty, all. */
  scope?: string[];
}

export type OplogEvent = { e: 'i' | 'r'; id: unknown } | { e: 'u'; id: unknown; fields: string[] };

const glob = (pattern: string) => new RegExp(`^${pattern.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replace(/\*/g, '.*')}$`);

/** Whether the writes on database.collection are published. A pattern without a dot is a whole database. */
export function inScope(scope: string[] | undefined, database: string, collection: string): boolean {
  if (!scope?.length) return true;
  return scope.some((p) => {
    const dot = p.indexOf('.');
    return dot < 0 ? glob(p).test(database) : glob(p.slice(0, dot)).test(database) && glob(p.slice(dot + 1)).test(collection);
  });
}

/** The _id as EJSON for Meteor (ObjectId as { $type: 'oid' }); undefined for the types Meteor ids can't be. */
export function meteorId(id: unknown): unknown {
  if (typeof id === 'string' || (typeof id === 'number' && Number.isFinite(id))) return id;
  const bson = (id as { _bsontype?: string } | null)?._bsontype;
  if (bson === 'ObjectId' || bson === 'ObjectID') return { $type: 'oid', $value: (id as { toHexString(): string }).toHexString() };
  if (bson === 'Int32' || bson === 'Double') return (id as { valueOf(): number }).valueOf();
  if (bson === 'Long') {
    const n = (id as { toNumber(): number }).toNumber();
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

/** Meteor's MongoID.idStringify of an id given by meteorId: the suffix of the dedicated channel. */
export function idStringify(id: unknown): string {
  if (id && typeof id === 'object') return (id as { $value: string }).$value;
  if (typeof id === 'string') return id && (/^[-~{]/.test(id) || /^[0-9a-f]{24}$/.test(id)) ? `-${id}` : id;
  return `~${JSON.stringify(id)}`;
}

/** The channels and message of an event; undefined when its _id can't be a Meteor id. */
export function oplogMessage(settings: RedisOplogSettings, collection: string, event: OplogEvent): { channels: string[]; message: string } | undefined {
  const id = meteorId(event.id);
  if (id === undefined) return undefined;
  const prefix = settings.prefix ?? '';
  const channels = [collection, ...(settings.namespaces ?? []).map((ns) => `${ns}::${collection}`), `${collection}::${idStringify(id)}`];
  const message = event.e === 'u' ? { e: 'u', d: { _id: id }, f: event.fields } : { e: event.e, d: { _id: id } };
  return { channels: channels.map((c) => prefix + c), message: JSON.stringify(message) };
}

/**
 * The fields an update changes, as redis-oplog's getFields: the paths of the operators, cut at an array
 * position (a.1.b → a, a.$.b → a); a replacement document, its fields. Undefined when an update pipeline
 * doesn't tell (a $project or $replaceWith stage).
 */
export function updatedFields(update: unknown): string[] | undefined {
  const fields = new Set<string>();
  const path = (field: string) => {
    const at = /\.(\d+|\$[^.]*)(\.|$)/.exec(field);
    fields.add(at ? field.slice(0, at.index) : field);
  };
  if (Array.isArray(update)) {
    for (const stage of update) {
      const [op, body] = Object.entries((stage ?? {}) as Record<string, unknown>)[0] ?? [];
      if ((op === '$set' || op === '$addFields') && body && typeof body === 'object') Object.keys(body).forEach(path);
      else if (op === '$unset') (Array.isArray(body) ? body : [body]).forEach((f) => typeof f === 'string' && path(f));
      else return undefined;
    }
    return [...fields];
  }
  for (const [op, body] of Object.entries((update ?? {}) as Record<string, unknown>)) {
    if (!op.startsWith('$')) fields.add(op);
    else if (body && typeof body === 'object') Object.keys(body).forEach(path);
  }
  fields.delete('_id');
  return [...fields];
}

/** The fields of the documents (but _id): what a replacement may have changed. */
export function documentFields(...docs: (object | null | undefined)[]): string[] {
  return [...new Set(docs.flatMap((d) => (d ? Object.keys(d) : [])))].filter((f) => f !== '_id');
}
