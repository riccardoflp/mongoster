# redis-oplog

Publishing the writes made in Mongoster to Redis, as the Meteor package `cultofcoders:redis-oplog` does, so that the
publications of Meteor apps using it see them at once: which writes are published, the event and its channels, the
databases and collections a connection publishes, the playground's writes, and the warning when Redis fails. The
user's side is in the README's [Features](../../README.md#features), under **Connections › redis-oplog**.

A connection publishes when its connection form has the `redis-oplog` section filled in: the Redis URL (kept in the
secret storage, `connection.secrets`), the channel prefix, the namespaces and the databases and collections. That form,
`Test Connection` for Redis and the `redis-oplog` label of the connection in the tree belong to the connections area
and the tree; this file starts where a write has been made. The settings are `RedisOplogSettings` in
`src/shared/oplog.ts`, kept as `ConnectionInfo.redisOplog`.

The code is `src/redisOplog.ts` (`RedisOplog`, the sink `OplogSink`, a small RESP client `RedisConnection`), the pure
part `src/shared/oplog.ts`, and `src/playground/oplogWrites.ts` for the playground. A write asks
`RedisOplog.sink(target)` for its sink, which is `undefined` when the writes on that collection aren't published, and
tells it what it changed: `inserted(ids)`, `updated(ids, fields)`, `removed(ids)`, `changes(before, after)`,
`updatedBy(coll, ids, update)`, `removedOf(coll, ids, deleted)`.

### `oplog.publish` — Publish the events of a write to Redis

After a write to documents, sends one event per document changed to the channels redis-oplog listens on, so that a
Meteor app reads those documents again.

- **Kind**: Operation
- **Function**: `src/redisOplog.ts › RedisOplog.sink` (whether a write is published) and `RedisOplog.publish` (the
  sending, through `RedisOplog.enqueue`).
- **Implemented in**: `src/redisOplog.ts › OplogSink` (the events of a write), `RedisOplog.connection`,
  `RedisConnection` (the Redis connection, `AUTH`, the replies), `parseRedisUrl`; `src/shared/oplog.ts ›
  oplogMessage`, `inScope`, `updatedFields`, `documentFields`; `src/connections.ts › ConnectionManager.redisUrl`;
  `src/extension.ts` (`RedisOplog.init`). The callers are the writes listed in the acceptance.
- **Entry points**: none of its own: it runs after each write that is published.
- **Offered when**: the connection has `redisOplog` settings and the write's database and collection are in its scope
  (`oplog.scope`).
- **Reads**: the Redis URL from the secret storage at each batch; for `updatedBy` with an update whose fields aren't
  known, and for `removedOf` when fewer documents were deleted than matched, the documents by `_id` in batches of 1000.
- **Writes**: to Redis, nothing to MongoDB: `PUBLISH <channel> <message>` for each channel of each event
  (`oplog.message`), sent in pipelines of at most 1000 commands; on connecting, `AUTH <password>` or `AUTH <user>
  <password>` when the URL has them, and `CLIENT SETNAME mongoster` (its error ignored). `rediss://` connects with TLS.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database; a read-only connection makes no writes to
  publish.
- **Undo**: Cannot be undone: an event sent can't be withdrawn. Undoing the write publishes the events of the undo
  (`undo.revert`).
- **After**: nothing is shown when the events are sent; a failure shows `oplog.publish-error`.
- **Refuses**: never refuses a write: the events go out in the background after it, and a Redis error doesn't fail it.
- **Uses**: `oplog.scope`, `oplog.message`, `oplog.updated-fields`, `oplog.changes`, `oplog.publish-error`,
  `connection.secrets`, `undo.revert`.
- **Tested by**: `test/unit/oplog.test.ts` (the pure part: `updatedFields`, `documentFields`, `inScope`, `meteorId and
  idStringify`, `oplogMessage`); `test/integration/shell.test.ts › 'playground writes published for redis-oplog'` (the
  events of an `OplogSink`, with its queue replaced). The sending, the Redis connection and the order: *none*.
- **Differs**: some writes to documents made from the UI are not published (no `RedisOplog.sink`), which the README
  lists as not published but `AGENTS.md` and the product's promise ("Writes to documents reach redis-oplog") don't
  allow: importing documents (`transfer.import`), generated documents (`transfer.generate`), restoring a backup
  (`backup.restore`), and the writes of the compare tab
  (`compare.copy-document`, `compare.make-like`). A Meteor app doesn't see them until it reads the documents again.

Acceptance:

- [ ] These writes are published, on a connection that publishes and a collection in its scope: `document.inline-edit`,
  `document.edit-in-editor`, `document.insert`, `document.insert-in-editor`, `document.delete`,
  `document.delete-selected`, `document.update-many`, `document.delete-many`, `document.restore-version`,
  `field.rename`, `field.remove`, `field.convert-type`, `undo.revert`, `transfer.copy-collection`, `transfer.paste`,
  and the playground's writes
  (`oplog.playground-writes`).
- [ ] An edit of `qty` in the document `"abc"` of `shop.orders`, with the prefix `app:` and the namespace `tenant1`,
  publishes `{"e":"u","d":{"_id":"abc"},"f":["qty"]}` on `app:orders`, `app:tenant1::orders` and `app:orders::abc`.
- [ ] An insert publishes `{ e: 'i', d: { _id } }` for each document inserted; a delete `{ e: 'r', d: { _id } }` for
  each document deleted.
- [ ] An update by operators publishes the fields of its operators (`oplog.updated-fields`) for each document it
  matched, when at least one was modified; an update pipeline with `$replaceWith` or `$project` publishes, for each
  document, its fields as they are after the update.
- [ ] A delete that deleted fewer documents than it matched publishes a removal only for those no longer in the
  collection.
- [ ] The events of one connection go out in the order of the writes, also when they come from different
  collections.
- [ ] A connection without redis-oplog, or a collection outside its scope, publishes nothing and opens no connection to
  Redis.
- [ ] One Redis connection is kept per connection and reused; a new Redis URL opens a new one; removing the
  connection or emptying its redis-oplog section closes it.
- [ ] A Redis that doesn't answer in 5 seconds gives the error `Redis <host>:<port> didn't answer in 5 seconds`; a
  missing URL gives `The Redis URL is missing: set it again in the connection.`; in both cases the write to MongoDB is
  done.
- [ ] A document whose `_id` can't be a Meteor id (not a string, an `ObjectId` or a number) publishes nothing.
- [ ] Not published, as the README says: GridFS, `$out` / `$merge`, `runCommand`, dropping collections.
- [ ] (differs) Importing, generating, copying, restoring and the compare tab's writes publish the documents they
  insert, replace or delete.

### `oplog.scope` — Which databases and collections publish

The `Databases and collections` of the connection form, one pattern per line, decide which writes are published.

- **Kind**: Derivation
- **Function**: `src/shared/oplog.ts › inScope(scope, database, collection)`
- **Implemented in**: `src/redisOplog.ts › RedisOplog.sink`; the MCP tool `redis_oplog_status` says it in words.
- **Tested by**: `test/unit/oplog.test.ts › inScope › 'publishes everything with an empty scope'`, `'matches whole
  databases, collections and globs'`, `'keeps the collection part after the first dot, and dots literal'`.

Inputs: the patterns (`RedisOplogSettings.scope`), the database and the collection of a write. Output: whether it is
published.

Rules:

1. No pattern (missing or empty): everything is published.
2. A pattern without a dot is a database: it matches every collection of the databases it matches.
3. A pattern with a dot is `<database>.<collection>`, split at the first dot: both parts must match. The collection
   part may contain dots.
4. `*` matches any characters, also none; every other character is literal (`.`, `+`, `?` included). A pattern
   matches the whole name.
5. One matching pattern is enough.

Examples:

| Patterns | Database, collection | Published |
| --- | --- | --- |
| *(empty)* | `app`, `users` | yes |
| `app` | `app`, `users` / `other`, `users` | yes / no |
| `app.users` | `app`, `users` / `app`, `orders` | yes / no |
| `app.*` | `app`, `orders` | yes |
| `*.logs` | `any`, `logs` / `any`, `logs2` | yes / no |
| `app.users`, `shop` | `shop`, `x` | yes |
| `app.logs.2024` | `app`, `logs.2024` / `app`, `logsX2024` | yes / no |
| `a+b` | `a+b`, `c` / `aab`, `c` | yes / no |

Acceptance:

- [ ] Each row of the table above gives its result.

### `oplog.message` — The event of a document and its channels

What is sent for one document changed: the message redis-oplog expects, on the collection's channel, on its
namespaces and on the document's dedicated channel.

- **Kind**: Derivation
- **Function**: `src/shared/oplog.ts › oplogMessage(settings, collection, event)`
- **Implemented in**: `meteorId`, `idStringify` (same file); `src/redisOplog.ts › RedisOplog.publish`.
- **Tested by**: `test/unit/oplog.test.ts › oplogMessage › 'sends an update to the collection, its namespaces and the
  document channel, with the prefix'`, `'sends inserts and removals without fields, ObjectIds as EJSON'`, `'is
  undefined for an id Meteor cannot have'`; `› 'meteorId and idStringify' › 'converts the ids Meteor can have'`,
  `'refuses the ids Meteor cannot have'`, `"stringifies as Meteor's MongoID.idStringify"`.

Inputs: the connection's settings (prefix, namespaces), the collection's name, and an event: `{ e: 'i' | 'r', id }` or
`{ e: 'u', id, fields }`. Output: the channels and the message, or `undefined`.

Rules:

1. The Meteor id (`meteorId`): a string, or a finite number, as it is; an `Int32` or a `Double` as a number; a `Long`
   as a number when it is a safe integer; an `ObjectId` as `{ $type: 'oid', $value: <24 hex> }`. Any other `_id`
   (`UUID`, a document, `null`, `NaN`, a `Long` beyond 2^53) has none, and nothing is sent.
2. The message is JSON: `{ "e": "u", "d": { "_id": <id> }, "f": [<fields>] }` for an update, `{ "e": "i" | "r", "d":
   { "_id": <id> } }` for an insert or a removal.
3. The channels, in this order: `<collection>`; `<namespace>::<collection>` for each namespace; the dedicated channel
   `<collection>::<idStringify(id)>`. The prefix (redis-oplog's `globalRedisPrefix`) goes before each one. The
   database is not part of any channel.
4. `idStringify` is Meteor's `MongoID.idStringify`: an `ObjectId` is its hex; a string is itself, with `-` before it
   when it starts with `-`, `~` or `{`, or is 24 hexadecimal characters; an empty string stays empty; a number is `~`
   and its JSON (`~5`).

Examples:

| Settings, collection, event | Channels | Message |
| --- | --- | --- |
| prefix `p:`, namespaces `ns1`, `ns2`; `users`; `u` of `'abc'`, fields `a`, `b.c` | `p:users`, `p:ns1::users`, `p:ns2::users`, `p:users::abc` | `{"e":"u","d":{"_id":"abc"},"f":["a","b.c"]}` |
| none; `users`; `i` of `ObjectId("0123456789abcdef01234567")` | `users`, `users::0123456789abcdef01234567` | `{"e":"i","d":{"_id":{"$type":"oid","$value":"0123456789abcdef01234567"}}}` |
| none; `c`; `r` of `3` | `c`, `c::~3` | `{"e":"r","d":{"_id":3}}` |
| none; `c`; `i` of `{ a: 1 }` | — | `undefined` |

`idStringify`: `'abc'` → `abc`; `'-x'` → `--x`; `'~x'` → `-~x`; `'{x'` → `-{x`; `'0123456789abcdef01234567'` →
`-0123456789abcdef01234567`; `5` → `~5`.

Acceptance:

- [ ] Each row and example above gives its result.

### `oplog.updated-fields` — The fields an update changes

The `f` of an update event: the fields a Meteor app re-reads, computed as redis-oplog's `getFields` does.

- **Kind**: Derivation
- **Function**: `src/shared/oplog.ts › updatedFields(update)`, `documentFields(...docs)`
- **Implemented in**: `src/redisOplog.ts › OplogSink.updatedBy`, `OplogSink.changes`;
  `src/collectionPanel.ts › CollectionPanel.updateField`; `src/documentFs.ts › DocumentFileSystem.writeFile`;
  `src/playground/oplogWrites.ts`.
- **Tested by**: `test/unit/oplog.test.ts › updatedFields` (all eight tests: `'lists the fields of the update
  operators, without _id'`, `'keeps dotted paths but cuts them at an array position'`, `'does not cut at a field whose
  name only contains digits after other characters'`, `'includes both the old and the new name of a $rename'`, `'gives
  the fields of a replacement document'`, `'reads update pipelines made of $set, $addFields and $unset'`, `"is undefined
  when a pipeline stage doesn't tell the fields"`, `'copes with empty or missing updates'`); `› documentFields ›
  'unites the fields of the documents, without _id'`.

Rules of `updatedFields`:

1. An update by operators: the keys of every operator's body; for `$rename`, also its new names.
2. A replacement document: its keys.
3. A path is cut at its first part that is a number or starts with `$` (`items.1.qty`, `tags.$`, `list.$[el].v` →
   `items`, `tags`, `list`); a part that only contains digits after other characters is not a position (`a.b1`,
   `a.1b`).
4. An update pipeline: the keys of `$set` and `$addFields`, the names of `$unset` (a string or an array); any other
   stage (`$project`, `$replaceWith`, …) makes the result `undefined`: the fields aren't known, and the caller uses
   `documentFields` of the documents instead.
5. `_id` is never a field; each field once, in the order met; no update gives `[]`.

`documentFields(...docs)`: every key of the documents given, once, but `_id`; `null` and `undefined` are skipped.

Examples:

| Update | Fields |
| --- | --- |
| `{ $set: { a: 1, b: 2 }, $inc: { n: 1 }, $unset: { c: '' }, $setOnInsert: { _id: 1 } }` | `a`, `b`, `n`, `c` |
| `{ $set: { 'address.city': 'x', 'items.1.qty': 2, 'tags.$': 'y', 'list.$[el].v': 1, 'a.b.0': 1 } }` | `address.city`, `items`, `tags`, `list`, `a.b` |
| `{ $rename: { old: 'new', 'a.b': 'c.d', 'list.0': 'x' } }` | `old`, `a.b`, `list`, `new`, `c.d`, `x` |
| `{ _id: 1, name: 'x', age: 3 }` | `name`, `age` |
| `[{ $set: { a: 1 } }, { $addFields: { 'b.c': 2 } }, { $unset: ['d', 'e.1'] }, { $unset: 'f' }]` | `a`, `b.c`, `d`, `e`, `f` |
| `[{ $set: { a: 1 } }, { $replaceWith: '$b' }]` | `undefined` |
| `{}`, `undefined`, `[]` | none |

`documentFields({ _id: 1, a: 1, b: 2 }, { _id: 1, b: 3, c: 4 }, null, undefined)` → `a`, `b`, `c`.

Acceptance:

- [ ] Each row and example above gives its result.

### `oplog.changes` — The events of a write from the documents before and after

For writes whose effect isn't known in advance (a restore, an undo, a playground `bulkWrite`), the events come from
the documents they may have touched, read by `_id` before and after.

- **Kind**: Derivation
- **Function**: `src/redisOplog.ts › OplogSink.changes(before, after)`
- **Implemented in**: `src/docHistory.ts › DocumentHistoryPanel.restore`; `src/history.ts` (undo);
  `src/playground/oplogWrites.ts › publishedWrites` (`bulkWrite`); `src/shared/oplog.ts › documentFields`.
- **Tested by**: `test/integration/shell.test.ts › 'playground writes published for redis-oplog' › 'compares the
  documents before and after a bulkWrite'`.

Inputs: the documents before, the documents after (each by `_id`). Output: the events, then published.

Rules:

1. A document after whose `_id` wasn't before: an insert.
2. A document before whose `_id` isn't after: a removal.
3. A document in both: an update with the fields (`documentFields` of both) whose values differ, compared as canonical
   Extended JSON; none when nothing differs.
4. A document after that appears twice counts once. Inserts and updates come in the order of the documents after,
   then the removals.

Examples: before `[{ _id: 1, a: 1 }, { _id: 2, a: 1 }]`, after `[{ _id: 1, a: 2, b: 1 }, { _id: 3 }]` → `u` of 1 with
`a`, `b`; `i` of 3; `r` of 2. Before `[{ _id: 1, a: 1 }]`, after `[{ _id: 1, a: 1 }]` → nothing.

Acceptance:

- [ ] The examples above give their events.

### `oplog.playground-writes` — Publish the playground's writes

The writes of a playground script are published like the UI's, and those of a transaction only once it commits.

- **Kind**: Operation
- **Function**: `src/playground/oplogWrites.ts › publishedWrites(coll, sink)`
- **Implemented in**: `src/playground/shell.ts` (the collection's write methods use `publishedWrites` when there is a
  sink; `ShellSession.sink`, `commitTransaction`, `abortTransaction`, `withTransaction`, `endSession` keep or drop the
  events of a transaction); `src/playground/playground.ts` (gives the run `RedisOplog.sink` of each collection);
  `src/redisOplog.ts › OplogSink.deferred`.
- **Entry points**: `mongoster.runPlayground` (**Run Playground**) and the playground's CodeLens and `Ctrl+Enter`,
  when the script writes.
- **Offered when**: the playground's connection publishes and the written collection is in its scope, whatever the
  database the script uses (`db.getSiblingDB`, `session.getDatabase`).
- **Reads**: before a write of one document (`updateOne`, `replaceOne`, `deleteOne`, `findOneAndUpdate`,
  `findOneAndReplace`, `findOneAndDelete`), `findOne(<filter>)` with the write's `sort`, for its `_id` (the whole
  document for a replacement); before `updateMany` and `deleteMany`, the `_id`s of the matching documents; for
  `bulkWrite`, the documents each operation may touch, before and after. With a session in the write's options, these
  reads run in it, so a transaction sees its own writes.
- **Writes**: the script's write, restricted to the document found: its filter with `_id: <found>` (inside `$and` when
  the filter already has `_id`), as redis-oplog does; unchanged when nothing was found (an upsert).
- **Danger**: None: the playground asks nothing before writing.
- **Read-only**: Refused on a read-only connection by the playground itself (writes throw), so nothing is published;
  read-only transactions work.
- **Undo**: Cannot be undone from the undo history: the playground's writes aren't recorded
  ([02-architecture](../02-architecture.md#writing-to-a-database)).
- **redis-oplog**: Published (`oplog.publish`): this card is how.
- **After**: nothing more than the playground's result.
- **Uses**: `oplog.publish`, `oplog.changes`, `oplog.updated-fields`.
- **Tested by**: `test/integration/shell.test.ts › 'playground writes published for redis-oplog' › 'announces inserted
  documents, with the _id the driver gave them'`, `'announces the inserts that ran when an ordered insertMany fails'`,
  `'runs updateOne only on the document it found, and announces the fields of the update'`, `'announces nothing for an
  update that changes nothing, and an insert for an upsert'`, `'announces updateMany and deleteMany for each document
  they matched'`, `'announces the fields a replacement changes, added or removed'`, `'announces findOneAndUpdate,
  findOneAndDelete and an upserting findOneAndReplace'`, `'compares the documents before and after a bulkWrite'`,
  `'publishes nothing without a sink'`; `test/integration/transactions.test.ts › 'playground transactions' › 'makes the
  writes visible to others only once committed'`, `'leaves nothing behind, and publishes nothing, when aborted'`, `'runs
  withTransaction with a callback written without await, and publishes after the commit'`.

Acceptance:

- [ ] `insertOne({ _id: 10 })` and `insertMany([{ _id: 11 }, { _id: 12 }])` publish inserts of 10, 11 and 12;
  `insertOne({ x: 1 })` publishes an insert with the `ObjectId` the driver gave it.
- [ ] An ordered `insertMany([{ _id: 20 }, { _id: 1 }, { _id: 21 }])` failing on `_id` 1 publishes only the insert
  of 20.
- [ ] `updateOne({ n: { $gte: 2 } }, { $set: { name: "B", "tags.0": "y" }, $inc: { n: 1 } }, { sort: { n: -1 } })`
  changes only the document found first in that order, and publishes `{ e: 'u', id: 3, fields: ['name', 'tags', 'n']
  }`.
- [ ] An update that modifies nothing publishes nothing; an upsert publishes an insert of the new `_id`.
- [ ] `updateMany` and `deleteMany` publish one event for each document they matched.
- [ ] `replaceOne` publishes the fields of the document before and after, added or removed.
- [ ] `findOneAndUpdate`, `findOneAndDelete` and an upserting `findOneAndReplace` publish an update, a removal and an
  insert.
- [ ] `bulkWrite` publishes the events of `oplog.changes` for the documents it touched, also when some operations
  failed.
- [ ] In a transaction, nothing is published before the commit; after `commitTransaction()` the events go out in the
  order of the writes; after `abortTransaction()`, a failed commit, or a session ended with its transaction open,
  nothing is published.
- [ ] With `withTransaction`, a retried callback publishes only the events of the attempt that committed.
- [ ] Without redis-oplog on the connection, the writes run unchanged and nothing is published.

### `oplog.publish-error` — The warning when Redis fails

Tells the user that a write was saved but couldn't be published, without repeating it at every write.

- **Kind**: View
- **Function**: `src/redisOplog.ts › RedisOplog.warn`
- **Implemented in**: `RedisOplog.enqueue` (catches the error of a publish); `RedisOplog.lastError`, read by the MCP
  tool `redis_oplog_status` through `WorkspaceHost.redisLastError` in `src/extension.ts`.
- **Entry points**: any published write whose events can't be sent: Redis not reachable, refused `AUTH`, an error
  reply, the URL missing or invalid.
- **Offered when**: at most once every 30 seconds for each connection; the errors in between are only kept as the
  connection's last error.
- **Tested by**: *none*. (`test/unit/mcpWorkspace.test.ts › redis_oplog_status` shows a last error given to it, not
  this warning.)

The warning is `The change was saved, but couldn't be published to Redis for redis-oplog (<connection name>):
<error>`. The error of an invalid URL is `Invalid Redis URL` or `The Redis URL must start with redis:// or rediss://`
or `The Redis URL has no host`, never the URL itself, which can hold a password. The events of the failed batch are
not sent again; the next write tries a new Redis connection.

Acceptance:

- [ ] With Redis stopped, an edit is saved in MongoDB and the warning names the connection and the error.
- [ ] Ten edits within 30 seconds with Redis stopped show one warning; an edit 30 seconds after the warning shows it
  again.
- [ ] Two connections failing at the same time each show their warning.
- [ ] The warning never contains the Redis URL or its password.
- [ ] Once Redis answers again, the next write is published without restarting Mongoster.
