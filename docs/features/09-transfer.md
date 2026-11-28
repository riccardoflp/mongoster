# Transfer

Moving documents in and out of a collection: exporting them to a JSON, JSON Lines or CSV file, importing such a file,
copying a collection to another database or connection, pasting databases and collections copied in the tree, and generating test documents that look like a collection's.
The user's side is in the [README › Features](../../README.md#features), items **Export**, **Import**, **Generating
test documents** and **Copying collections**. Backups in mongodump's formats are in [10-backup.md](10-backup.md).

### `transfer.export` — Export documents to a file

Writes what the table shows, the documents of a collection or view, or the selected rows to a JSON, JSON Lines or CSV
file, to read elsewhere or to import again ([README › Export](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/transfer.ts › exportDocuments`, which streams through `writeExport`; `exportSource` checks the
  query or pipeline and opens the cursor.
- **Implemented in**: `src/extension.ts` (`mongoster.exportCollection`), `src/collectionPanel.ts` (`receive`, case
  `export`), `src/webview/main.ts` (the `Export` button and `exportRows` for the selection), `src/shared/messages.ts`
  (`{ type: 'export'; source; expanded; layout; page?; count }`), `src/queries.ts › buildPipeline`, `src/shared/csv.ts`
  and `src/shared/columns.ts` for CSV (`transfer.csv-write`), `FileWriter` and `RemoteWriter` in `src/transfer.ts`.
- **Entry points**: the `Export` button of the collection tab (hidden on the `Indexes`, `Schema` and `Chart` tabs);
  `Export N documents…` in the menu of a selected row (offered when every selected row has an `_id`); the command
  `mongoster.exportCollection` **Export Collection…** on a collection or view in the connections view. The command is
  hidden from the Command Palette (`when: false`) and does nothing without a tree node.
- **Offered when**: `viewItem =~ /^(collection|view)/` for the command.
- **Asks**:
  1. the format, quick pick titled `Export <collection>` with the placeholder `Format`: **JSON**, **JSON Lines**,
     **CSV**;
  2. from the `Export` button only, the scope: `All results (<count> documents)` (without the count when unknown) or
     `Current page (<first>–<last>)`;
  3. the file, in a save dialog titled `Export <collection>`, `<collection>.<json|jsonl|csv>` in the first workspace
     folder or the home folder.
- **Reads**: `find(filter, { sort, projection, skip, limit, promoteLongs: false, batchSize: 1000 })` for a query;
  `aggregate(pipeline [+ $skip, $limit], { allowDiskUse: true, promoteLongs: false, batchSize: 1000 })` for a pipeline
  up to the stage shown. From the tree: the whole collection, no filter, sort or projection. The selection: the
  query's filter replaced by `{ _id: { $in: [...] } }`, or a `$match` on the `_id`s after the stage shown.
- **Writes**: the file. JSON: `[`, then each document as relaxed Extended JSON indented by 2 spaces, separated by
  `,\n`, then `]` (`[]` when empty). JSON Lines: one canonical Extended JSON document per line. CSV: a UTF-8 BOM, then
  the table of `transfer.csv-write`, written once every document has been read.
- **Danger**: None. An existing file is replaced only after the save dialog's own confirmation.
- **Read-only**: Allowed, because it writes nothing to the database; also on views.
- **Undo**: Cannot be undone, and needs none: it writes a file, not a database.
- **After**: `Exported <n> documents to <file name>.` with `Open` (opens the file) and `Reveal` (`revealFileInOS`).
- **Refuses**: a pipeline whose last stage shown is `$out` or `$merge`, before asking anything: `Export failed: A
  pipeline ending with $out writes to the database and can't be exported. Select an earlier stage to export its
  output.` A filter, sort, projection or stage that does not parse: `Export failed: <error>`.
- **Uses**: `transfer.csv-write`.
- **Tested by**: `test/unit/queries.test.ts › buildPipeline › 'returns the final write stage'` and `› 'requires $out
  and $merge to be the last stage'`; `test/integration/scheduledTasks.test.ts › scheduled tasks › 'exports a
  collection with a filter and a projection, keeping the last two'` and `› 'exports CSV with the columns given, and
  fails without leaving a file'` (`exportSource` and `writeExport` through `runTask`); `exportDocuments`: none.
- **Differs**: a JSON Lines export is read with `promoteValues` left on (`src/transfer.ts:48`, `:53`), so a `Double`
  with a whole value (`42.0`) is written as `{"$numberInt":"42"}` by `EJSON.stringify` (`src/transfer.ts:93`) and is
  imported again as an `Int32`; a whole `Double` beyond the 32-bit range becomes `$numberLong`. The README and the
  format's own description promise that JSON Lines keeps every type.

Acceptance:

- [ ] The format picker shows **JSON** `Array of documents, readable (relaxed Extended JSON)`, **JSON Lines** `One
  document per line, canonical Extended JSON: keeps every type, re-importable` and **CSV** `The columns shown in the
  table; expanded arrays give one row per element`.
- [ ] From the `Export` button with a page of 50 from document 101 and 1,234 results, the scope picker offers `All
  results (1,234 documents)` and `Current page (101–150)`; the page exports exactly those 50 documents.
- [ ] `Export Collection…` on a view exports all its documents, with no scope picker.
- [ ] A JSON export of no documents is the text `[]` and a newline.
- [ ] A JSON Lines export keeps `Int32`, `Int64`, `Decimal128`, dates and ObjectIds as canonical Extended JSON, and a
  `Double` stays a `Double` when imported again (differs).
- [ ] A CSV file starts with the bytes `EF BB BF` and has the visible columns of the collection tab, in its order.
- [ ] Every 1,000 documents the notification `Exporting <collection>` says `<n> documents`.
- [ ] `Cancel` in the notification removes the partial local file and says `Export cancelled.`
- [ ] With the pipeline up to a `$merge` stage, nothing is asked and the error names `$merge`.
- [ ] The export works on a read-only connection.

### `transfer.csv-write` — Documents as CSV

How documents become the rows and cells of a CSV export, the same way the table shows them, so that a spreadsheet reads
them ([README › Export](../../README.md#features)).

- **Kind**: Derivation
- **Function**: `src/shared/csv.ts › csvTable`, `› csvValue`, `› toCsv`.
- **Implemented in**: `src/shared/columns.ts` (`buildColumns`, `applyLayout`, `leaves`); `src/transfer.ts ›
  writeExport`; `src/webview/main.ts` (`CSV` in the selection's copy menu).
- **Used by**: `transfer.export`, `task.run`, copying selected rows as CSV.
- **Tested by**: `test/unit/csv.test.ts › csvValue › 'turns relaxed EJSON into spreadsheet text'`; `› toCsv / parseCsv
  › 'quotes only what needs it and ends rows with CRLF'`, `› 'round trips awkward fields'`; `› csvTable › 'has one
  column per leaf and one row per document when nothing is expanded'`, `› 'flattens expanded sub-documents and repeats
  document values on each array element row'`, `› 'round trips through CSV text into documents'`.

Rules:

- Input: relaxed Extended JSON documents and the columns of the table (`buildColumns` of the documents with the
  expanded paths, then the user's layout: hidden columns left out, the chosen order). Output: rows of text cells, the
  header first.
- The header has one cell per leaf column, its dotted path (`address.city`). A column that is not expanded is one leaf.
- A document gives one row. An expanded array gives one row per element; the document's other values are repeated on
  each of those rows. An empty array is one row.
- A value that is not an object at an expanded path goes in the first column of the group.
- Cells (`csvValue`): missing, `undefined` and `null` are empty; strings as they are; numbers and booleans as text;
  `$oid`, `$numberDecimal`, `$numberLong`, `$numberInt`, `$numberDouble` as their inner text; `$date` as its ISO text
  (`{ $numberLong }` dates converted to ISO); anything else as compact JSON.
- Text (`toCsv`): a cell is quoted when it holds `"`, `,`, CR or LF, or starts or ends with white space; `"` inside
  is doubled; cells are joined by `,` and every row ends with CRLF.

Worked examples:

- `{ $date: { $numberLong: '0' } }` → `1970-01-01T00:00:00.000Z`; `{ a: 1 }` → `{"a":1}`; `[1, 'x']` → `[1,"x"]`.
- `[['a', 'b'], ['1', 'x,y']]` → `a,b\r\n1,"x,y"\r\n`.
- With `address` and `items` expanded, `{ _id: 1, name: 'a', address: { city: 'Rome' }, items: [{ sku: 'x', qty: 1 },
  { sku: 'y' }] }` → header `_id,name,address.city,items.sku,items.qty` and rows `1,a,Rome,x,1` and `1,a,Rome,y,`.

### `transfer.import` — Import documents from a file

Inserts the documents of a JSON, JSON Lines or CSV file, or of a file in mongosh syntax, into a collection
([README › Import](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/transfer.ts › importDocuments`, which inserts through `insertDocuments`.
- **Implemented in**: `src/extension.ts` (`mongoster.importDocuments`, refreshes the tab and the tree); `parseImport`
  in `src/transfer.ts` (`transfer.import-files`); `src/shared/csv.ts` (`transfer.csv-read`); `src/history.ts`.
- **Entry points**: `mongoster.importDocuments` **Import Documents…** on a collection in the connections view. Hidden
  from the Command Palette (`when: false`); without a tree node it does nothing.
- **Offered when**: `viewItem == collection`: not on views, not on collections of read-only connections.
- **Asks**:
  1. the file, in an open dialog titled `Import into <database>.<collection>`, filters `JSON, JSON Lines, CSV`
     (`json`, `jsonl`, `ndjson`, `csv`) and `All files`;
  2. the modal confirmation `Import <n> documents from <file> into <database>.<collection>?` with the detail
     `<k> of them have an _id: documents whose _id already exists are skipped.` or `New _id values will be
     generated.`, then the line of `UndoHistory.note`; button `Import`.
- **Reads**: the file, through `vscode.workspace.fs`.
- **Writes**: `insertMany(batch, { ordered: false })` in batches of 1000. While the undo history records, documents
  without `_id` get a new ObjectId before they are inserted.
- **Danger**: Confirm: the modal above.
- **Read-only**: Refused on a read-only connection and on a view: `<database>.<collection> is read-only.`
- **Undo**: Recorded in the undo history (`undo.record`) as one operation `Import <file name>`, holding the `_id`s of
  the inserted documents; not recorded beyond `mongoster.history.maxDocumentsPerOperation` documents, and the
  confirmation says so.
- **redis-oplog**: Not published (differs).
- **After**: the collection tab and the tree are refreshed when something was inserted. Success: `Imported <i> of <n>
  documents into <collection>.` with `Undo`. With failures, a warning: `Imported <i> of <n> documents into
  <collection>. <f> failed: <first error>`.
- **Refuses**: a file that does not parse: `Can't import <file>: <error>`; a file without documents: the warning
  `<file> contains no documents.`; an error of the server other than a write error: `Import failed: <error>`.
- **Settings**: `mongoster.history.enabled`, `mongoster.history.maxDocumentsPerOperation`.
- **Uses**: `transfer.import-files`, `transfer.csv-read`, `undo.record`, `undo.limits`, `connection.read-only`.
- **Tested by**: `test/unit/csv.test.ts › csvToDocs` (the CSV part only); `importDocuments`, `insertDocuments` and
  `parseImport`: none.
- **Differs**: no `RedisOplog.sink(…)` is called (`src/transfer.ts:301-333`), so Meteor apps using redis-oplog don't
  see the imported documents. AGENTS.md's write steps and the product's promise want every write to documents
  published; the README lists import among the writes that are not.

Acceptance:

- [ ] A file of 2,500 documents is inserted in 3 batches; the notification `Importing <file>` says `1,000 of 2,500`,
  `2,000 of 2,500`, `2,500 of 2,500`.
- [ ] Of 10 documents of which 2 have an `_id` already in the collection, 8 are inserted and the warning ends with `2
  failed: E11000 duplicate key error …`; the 8 are still inserted after the duplicates.
- [ ] `Undo` in the result notification deletes exactly the inserted documents.
- [ ] Import is not in the menu of a view or of a collection of a read-only connection; run on one, it says
  `<database>.<collection> is read-only.` and opens no dialog.
- [ ] Imported documents are published to redis-oplog on a connection that publishes (differs).
- [ ] `Cancel` in the notification stops between batches; the documents already inserted stay.

### `transfer.import-files` — What an import file holds

How the text of an import file becomes documents ([README › Import](../../README.md#features)).

- **Kind**: Derivation
- **Function**: `src/transfer.ts › parseImport` (pure, though its module imports `vscode`).
- **Implemented in**: `src/shared/csv.ts` (`transfer.csv-read`), `src/shared/query.ts › parseQuery` for mongosh
  syntax.
- **Used by**: `transfer.import`.
- **Tested by**: *none* for `parseImport`; its CSV part by `test/unit/csv.test.ts › csvToDocs`.

Rules:

- A file whose name ends with `.csv` (any case) is CSV (`transfer.csv-read`). Any other file is JSON-like.
- JSON-like: a leading BOM is removed and the text trimmed; empty text gives no documents.
  - Text starting with `[` is one array of documents. It is read as JSON; if that fails, as mongosh syntax; if both
    fail, the JSON error is reported. A value that is not an array: `Expected an array of documents`.
  - Otherwise each non-blank line is a document (JSON Lines), JSON first, mongosh syntax second. If the first line
    fails, the whole text is tried as one document (a pretty-printed document). Otherwise the error is `Line <n>:
    <error>`.
- Every value must be an object: `Document <n> is not an object`.
- Values are turned into BSON with `EJSON.deserialize(…, { relaxed: false })`: canonical and relaxed Extended JSON
  keep their types; a plain whole number becomes an `Int32` (or `Int64` beyond 32 bits), another number a `Double`.

Worked examples:

- `[{ "_id": { "$oid": "64b000000000000000000001" } }]` → one document with an ObjectId `_id`.
- `{ "a": 1 }` and `{ "a": 2 }` on two lines → two documents.
- `{ when: ISODate("2024-01-01T00:00:00Z") }` → one document with a date.
- `[1, 2]` → `Document 1 is not an object`.

### `transfer.csv-read` — CSV rows as documents

How CSV text is read and turned into documents for an import ([README › Import](../../README.md#features)).

- **Kind**: Derivation
- **Function**: `src/shared/csv.ts › parseCsv`, `› csvToDocs`.
- **Used by**: `transfer.import-files`.
- **Tested by**: `test/unit/csv.test.ts › toCsv / parseCsv › 'round trips awkward fields'`, `› 'parses LF and CRLF, a
  BOM, and a last row without a newline'`, `› 'skips blank lines but keeps rows of empty fields'`, `› 'keeps a quote in
  the middle of an unquoted field'`, `› 'throws on an unterminated quoted field'`; `› csvToDocs › 'infers types from
  the text'`, `› 'only turns 24-hex text into an ObjectId for _id'`, `› 'builds sub-documents from dotted headers and
  leaves empty cells out'`, `› 'rejects rows with more fields than the header'`, `› 'returns nothing without a
  header'`; `› csvTable › 'round trips through CSV text into documents'`.

Rules:

- Parsing (RFC 4180): a leading BOM is skipped; a field starting with `"` is quoted until the next lone `"`, `""`
  inside it is one `"`; a `"` in the middle of an unquoted field is kept; rows end at LF, CR or CRLF; a last row without
  a newline counts; blank lines are dropped, a row of empty fields is kept. An open quote at the end: `Unterminated
  quoted field`.
- The first row is the header. A header with dots builds sub-documents (`address.city` → `{ address: { city } }`).
- A row with more fields than the header: `Row <n> has <k> fields, the header has <h>` (`n` counts the header as row
  1). Empty cells are left out of the document.
- Values, in this order: an integer (`-?(0|[1-9]\d*)`) is a number when it is a safe integer, otherwise
  `{ $numberLong }`; a decimal or exponent number is a number; `true` / `false`; `null`; an ISO date ending in `Z`
  (`YYYY-MM-DDTHH:MM:SS[.fff]Z`) is a date; 24 hexadecimal characters under the header `_id` are an ObjectId; text
  starting with `[` or `{` that parses as JSON is that JSON; anything else is a string.

Worked examples:

- `00123` → the string `00123`; `12345678901234567890` → `{ $numberLong: '12345678901234567890' }`; `1e3` → `1000`;
  `2024-01-02` → the string `2024-01-02`; `{nope` → the string `{nope`.
- Header `a.b,a.c,d`, row `1,,x` → `{ a: { b: 1 }, d: 'x' }`; a row of empty cells → `{}`.
- `64b000000000000000000001` under `ref` stays a string; under `_id` it is an ObjectId.

### `transfer.copy-collection` — Copy a collection to another database or connection

Copies the documents of a collection or view, optionally filtered, with its indexes and options, into a collection of
any database on any connection, for example from production to a local server
([README › Copying collections](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/copy.ts › Copier.start`, which asks and confirms, then `copyCollection` copies.
- **Implemented in**: `src/extension.ts` (`mongoster.copyCollection`, opens the copy's tab on `Open`);
  `src/manage.ts` (`databaseNameError`, `collectionNameError`); `src/queries.ts › toBson` for the filter;
  `src/history.ts`.
- **Entry points**: `mongoster.copyCollection` **Copy Collection To…** on a collection or view in the connections
  view. Hidden from the Command Palette (`when: false`); without a tree node it does nothing.
- **Offered when**: `viewItem =~ /^(collection|view)/`, also on read-only connections (they can be the source).
- **Asks**, each with the title `Copy <database>.<collection>: <step>`:
  1. `destination connection`: the source's connection first (`same connection`), then the others, read-only ones
     marked `read-only` with a lock icon;
  2. `database on <connection>`: the source's database name first if it exists there, the others except `admin`,
     `local` and `config`, and `$(add) New database…` (an input box, `This database already exists` when it does);
  3. `destination collection`: `<collection>_copy` in the same database, otherwise `<collection>`; refused names: `That
     is the collection being copied`, `A view has this name`;
  4. when the collection exists, `<collection> exists in <connection> › <database>`: **Append** (`insert the documents;
     those whose _id already exists are skipped`), **Replace matching** (`documents with the same _id are replaced, the
     others inserted`), **Drop and recreate** (`the <count> documents and indexes of <collection> are deleted first`);
  5. `filter (optional)` in mongosh syntax, checked as it is typed; empty copies everything;
  6. `also copy`, not for a view, both checked: **Indexes** (`<n> besides _id`, when there are any) and, for a new or
     recreated collection, **Collection options** (`validation rules, capped size, collation, time series…`);
  7. the modal confirmation `Copy <n> documents of <source connection> › <database>.<collection> to <destination>?`
     with the lines `Destination: <into the new collection | appending to | replacing matching documents in | dropping
     and recreating> <destination>.`, `Filter: <filter>` or `All documents.`, `Indexes are created after the
     documents.`, `The collection is created with the options of the source.`, and `Dropping the destination can't be
     undone.` or the line of `UndoHistory.note`; button `Copy`.
- **Reads**: `listDatabases` and `listCollections` of the destination; `listIndexes` and, for options,
  `listCollections` of the source; the count: `countDocuments(filter, { maxTimeMS: 60000 })` with a filter or on a
  view, `estimatedDocumentCount()` otherwise; then `find(filter, { promoteValues: false, bsonRegExp: true, batchSize:
  1000 })`.
- **Writes**: Drop and recreate: `drop()` of the destination. New or recreated: `createCollection(name, options)`,
  where `options` is empty unless **Collection options** is checked, and then holds only `validator`,
  `validationLevel`, `validationAction`, `capped`, `size`, `max`, `collation`, `timeseries`, `expireAfterSeconds`, `clusteredIndex`, `changeStreamPreAndPostImages`. Then per batch of 1000: `insertMany(batch,
  { ordered: false })`, or for Replace matching `bulkWrite` of `replaceOne({ _id }, doc, { upsert: true })` (and
  `insertOne` for a document without `_id`), `{ ordered: false }`. Last, unless cancelled, `createIndexes([spec])` for
  each index except `_id_` and a clustered one, without `v` and `ns`.
- **Danger**: Confirm: the modal above. Destructive with Drop and recreate: the destination's documents and indexes are
  lost.
- **Read-only**: Refused when the destination connection is read-only: `The connection <name> is read-only: it can't
  receive a copy.` A read-only connection can be the source.
- **Undo**: Recorded in the undo history (`undo.record`) for Append and Replace matching, as `Copy [filtered ]<source
  connection> › <database>.<collection>` on the destination: the `_id`s of the inserted documents and, for Replace
  matching, the replaced documents as they were. Not recorded for Drop and recreate, and the confirmation says
  `Dropping the destination can't be undone.` Not recorded beyond `mongoster.history.maxDocumentsPerOperation`
  documents, which the confirmation says, or beyond the operation's size, which the result says: `It can't be undone:
  <reason>, too many for the undo history`.
- **redis-oplog**: Not published (differs).
- **After**: `mongoster.refresh` refreshes the tree. `Copied <n> documents[ and <k> indexes] to <destination> in <s>
  s.`, followed by `<k> skipped (their _id already existed)`, `<f> failed: <first error>`, `Index not created —
  <name>: <error>` when they apply (then as a warning); buttons `Open` (the copy's tab) and `Undo` when recorded.
- **Refuses**: a destination that cannot be reached: `Could not connect to <name>: <error>`; a count that fails: its
  error; an error while copying: `Copy failed: <error>`.
- **Settings**: `mongoster.history.enabled`, `mongoster.history.maxDocumentsPerOperation`,
  `mongoster.history.maxOperationSizeMB`.
- **Uses**: `undo.record`, `undo.limits`, `connection.read-only`.
- **Tested by**: *none*.
- **Differs**: no `RedisOplog.sink(…)` is called in `src/copy.ts`, so Meteor apps don't see the copied documents (the
  README lists copy among the writes not published). An open tab of the destination collection is not refreshed: only
  the tree is (`src/copy.ts:364`), against step 5 of the write pipeline.

Acceptance:

- [ ] Copying 2,500 documents of `shop.orders` to a new collection on another connection writes 3 batches, with the
  notification `Copying shop.orders → <destination>` saying `1,000 of 2,500 documents` and so on.
- [ ] `Int32`, `Double`, `Int64`, `Decimal128` and regular expressions with their flags are identical in the copy.
- [ ] With Append, documents whose `_id` exists are counted as skipped, not failed, and the existing ones are unchanged.
- [ ] With Replace matching, a document with the same `_id` is replaced and `Undo` puts the old one back.
- [ ] With Drop and recreate and options checked, a capped source with a validator gives a capped destination with the
  same validator; its old documents and indexes are gone.
- [ ] The filter `{ status: "active" }` copies only those documents, and the confirmation shows `Filter: { status:
  "active" }`.
- [ ] Indexes other than `_id_` are created after the documents; one that fails is listed, the others are created.
- [ ] `Cancel` stops after the current batch: `Copy cancelled after <n> of <total> documents; those stay in
  <destination>.`, and no index is created.
- [ ] Choosing a read-only destination connection shows `The connection <name> is read-only: it can't receive a copy.`
  and asks nothing more.
- [ ] A view is copied as a collection with its documents, without indexes or options being offered.
- [ ] The copied documents are published to redis-oplog on a destination that publishes (differs).
- [ ] An open tab of the destination collection shows the copied documents (differs).

### `transfer.paste` — Paste a database, collections or views

Copies what the tree clipboard holds to where it is pasted: a database to a connection, collections and views to a
database, whole and several at once ([README › Copy and Paste in the tree](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/paste.ts › TreeClipboard.paste`, which asks and confirms (`pasteInto`), then `src/copy.ts ›
  pasteCollections` copies, each collection with `copyCollection`.
- **Implemented in**: `src/extension.ts` (`mongoster.pasteNode`, the tab opened by `Open`, `CollectionPanel.refresh`);
  `src/copy.ts` (`pasteSources`, `existingNames`); `src/shared/paste.ts` (`tree.paste-plan`); `src/manage.ts ›
  databaseNameError`; `src/history.ts`
- **Entry points**: `mongoster.pasteNode` (**Paste**) in the context menu, group `0_clipboard`; `Ctrl+V` (`Cmd+V` on
  macOS) with the focus in the connections view, on the first selected node. Hidden from the Command Palette (`when:
  false`).
- **Offered when**: with databases copied, `viewItem =~ /^(connection|database)(?!.*readonly)/`; with collections
  copied, `viewItem =~ /^(connection|database|collection|view)(?!.*readonly)/`.
- **Asks**:
  1. for each copied database, an input box `Paste the database <database> on <connection>`, `Name of the copy (an
     existing database receives the collections)`: `<database>` when the connection has none of that name, otherwise
     the free `_copy` name; refused: an invalid name (`manage.name-rules`), `That is the database being copied`;
  2. for collections pasted on a connection, `Paste on <connection>: database`: the copied collections' database first
     if it exists there, the others except `admin`, `local` and `config`, and `$(add) New database…` (an input box,
     `This database already exists` when it does). Pasted on a database, a collection, a view or a bucket, the
     database is that node's;
  3. when names exist in the destination, `<name> exists in <connection> › <database>` or `<k> of the <n> collections
     exist in …`, with the names as placeholder: **Skip**, **Append**, **Replace matching**, **Drop and recreate**;
  4. the modal confirmation `Paste <the database <database> | <database>.<collection> | <n> collections of <database>>
     from <source connection> into <connection> › <database>?`, with the names pasted (`<source> → <target>` when
     renamed, the first 8 `and <k> more`), `<n> collection[s] with <d> document[s], the indexes and the collection
     options.`, `<n> view[s], created with <its definition | their definitions>.`, `<k> existing one[s] skipped.`,
     the line of the mode, `Dropped first: <names>. That can't be undone.` and the line of `UndoHistory.note` for the
     largest collection; button `Paste`.
- **Reads**: `listDatabases` of the destination; `listCollections` of the copied database (for a database: all but
  the `system.` ones) and of the destination database; `estimatedDocumentCount()` of each collection pasted; then
  what `transfer.copy-collection` reads, with no filter, and `listCollections({ name })` for a view's definition.
- **Writes**: the collections first, then the views. A collection as `transfer.copy-collection` with indexes and
  options checked and the mode `tree.paste-plan` gives it. A view: `drop()` when it is dropped, then
  `createCollection(name, { viewOn, pipeline, collation })`.
- **Danger**: Confirm: the modal above. Destructive with Drop and recreate: the documents and indexes of what exists
  under the pasted names are lost.
- **Read-only**: Refused when the destination connection is read-only: `The connection <name> is read-only: nothing
  can be pasted on it.` A read-only connection can be copied from.
- **Undo**: Recorded in the undo history (`undo.record`), one operation per collection, `Paste <source connection> ›
  <database>.<collection>` on the destination, as `transfer.copy-collection` records Append and Replace matching; a new
  collection is emptied by its undo, not dropped. Not recorded for a dropped collection, which the confirmation says,
  nor for a view.
- **redis-oplog**: Not published (differs).
- **After**: `mongoster.refresh` refreshes the tree and the open tabs of the destination collections are refreshed.
  `Pasted <n> collection[s] (<d> document[s])[ and <k> view[s]] into <connection> › <database> in <s> s.`, followed by
  `<name> failed: <error>`, `<k> documents skipped (their _id already existed)`, `<f> documents failed: <first
  error>`, `Index of <name> not created — <index>: <error>`, `<name> can't be undone: <reason>, too many for the undo
  history` when they apply (then as a warning), and `Each collection can be undone from the Undo History` when several
  were recorded; buttons `Open` when one collection or view was pasted and `Undo` when one operation was recorded.
  The next copied database is asked for without waiting for the notification.
- **Refuses**: nothing copied: `Nothing to paste: copy a connection, a database or collections in the connections view
  first.`; the copied nodes' connection removed: `The connection of what was copied has been removed.`; a folder or
  nothing selected: `Select the connection[ or the database] to paste on.`; a connection that cannot be reached:
  `Could not connect to <name>: <error>`; a database without collections: `The database <database> has no collections
  to copy.`; everything skipped: `Nothing to paste: everything exists in <connection> › <database>.`; an error outside
  a collection's copy: `Paste failed: <error>`.
- **Settings**: `mongoster.history.enabled`, `mongoster.history.maxDocumentsPerOperation`,
  `mongoster.history.maxOperationSizeMB`.
- **Uses**: `tree.copy`, `tree.paste-plan`, `transfer.copy-collection`, `manage.name-rules`, `undo.record`,
  `undo.limits`, `connection.read-only`.
- **Tested by**: `test/integration/paste.test.ts › 'pasting a database' › 'lists its collections and views, without
  the system ones'`, `› 'copies the collections with documents, indexes and options, then the views as views'`; `›
  'pasting collections' › 'gives _copy names in the same database, views included'`, `› 'when the destination has
  them' › 'skips them and pastes the others'`, `› 'appends the documents whose _id is missing, leaving an existing
  view'`, `› 'replaces the documents with the same _id'`, `› 'drops and recreates collections and views'`, `› 'goes on
  after a collection that fails, and reports it'`, `› 'stops after the batch being written when it is cancelled'`.
  The questions, the confirmation and the undo history: *none*.
- **Differs**: no `RedisOplog.sink(…)` is called, as in `transfer.copy-collection`: Meteor apps don't see the pasted
  documents (the README says so).

Acceptance:

- [ ] `shop` copied and pasted on its own connection proposes `shop_copy`; confirmed, `shop_copy` has every collection
  of `shop` with its documents, indexes and validation rules, and every view as a view with the same pipeline.
- [ ] `orders` and the view `paid` of `shop`, copied and pasted on the database `crm`, say `Pasted 1 collection (2,500
  documents) and 1 view into <connection> › crm in <s> s.`
- [ ] Pasted on `shop` itself, `orders` becomes `orders_copy` and nothing is asked but the confirmation.
- [ ] Where `orders`, `paid` and `people` exist, **Append** adds to `orders` and `people` the documents whose `_id`
  they lack, leaves the view `paid` and says `1 existing one skipped.` in the confirmation.
- [ ] `Int32`, `Int64` and the other BSON types are identical in the pasted collections.
- [ ] A collection that fails is named with its error and the ones after it are pasted.
- [ ] `Cancel` stops after the current batch; the collections already pasted stay, and the views are not created.
- [ ] `Paste` is not offered on a read-only connection, and `Ctrl+V` on one says it is read-only.
- [ ] The pasted documents are published to redis-oplog on a destination that publishes (differs).

### `transfer.generate` — Generate test documents

Inserts fake documents that look like a collection's, into it or into another collection on any connection
([README › Generating test documents](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/generate.ts › Generator.start` (the destination: `Generator.pickTarget`).
- **Implemented in**: `src/extension.ts` (`mongoster.generateDocuments`); `src/collectionPanel.ts` (`receive`, case
  `generateDocuments`); `src/webview/schemaView.ts` (the `Generate…` button); `src/shared/messages.ts` (`{ type:
  'generateDocuments'; schema; filter }`); `src/shared/schema.ts › analyzeSchema`; `src/shared/generate.ts`
  (`transfer.generate-values`); `src/history.ts`.
- **Entry points**: `mongoster.generateDocuments` **Generate Test Documents…** on a collection or view in the
  connections view; `Generate…` in the `Schema` tab, enabled once an analysis with documents is shown. Hidden from the
  Command Palette (`when: false`); without an argument it does nothing.
- **Offered when**: `viewItem =~ /^(collection|view)/`, also on read-only connections (they can be imitated).
- **Asks**, each with the title `Generate documents like <database>.<collection>: <step>`:
  1. from the tree, nothing yet: a random sample of 1,000 documents is analyzed first (`Analyzing a sample of
     <database>.<collection>`); from the `Schema` tab, the analysis shown and its filter are used;
  2. `how many`: `100` by default, a whole number from 1 to 1,000,000 (spaces, `,`, `_` and `'` between digits are
     accepted), otherwise `A whole number from 1 to 1,000,000`;
  3. `destination`, only when the source can be written to (not a view, not read-only): `$(database) This collection`
     or `$(arrow-right) Another collection…`; another collection: the connection (the source's first), the database
     (as in `transfer.copy-collection`, with `$(add) New database…`) and the collection, `<collection>_generated` in
     the same database, otherwise `<collection>`; a view's name is refused with `A view has this name: views are
     read-only`;
  4. `seed (optional)`, placeholder `e.g. 42`;
  5. the modal confirmation `Insert <n> generated documents into <destination>?` with `They look like the <k> documents
     analyzed in <connection> › <database>.<collection>[ matching <filter>][, seed <seed>]. For example:`, the first 3
     documents in mongosh syntax (each cut at 400 characters), `Like Import, the inserts are not published to Redis for
     redis-oplog.` when the destination publishes, and the line of `UndoHistory.note`; button `Insert`.
- **Reads**: `aggregate([{ $sample: { size: 1000 } }], { promoteValues: false, maxTimeMS: 120000, allowDiskUse: true
  })` from the tree; for an `int` or `long` `_id`, the largest numeric `_id` of the destination (`find({ _id: { $type:
  'number' } })` sorted descending, limit 1).
- **Writes**: `insertMany(batch, { ordered: false })` in batches of 1000; the 3 documents shown are the first ones
  inserted.
- **Danger**: Confirm: the modal above.
- **Read-only**: Refused: the destination is never a view or a collection of a read-only connection. Choosing a
  read-only connection says `The connection <name> is read-only.`
- **Undo**: Recorded in the undo history (`undo.record`) as `Generate <n> documents like <database>.<collection>`, the
  `_id`s of the inserted documents; not when `<n>` is above `mongoster.history.maxDocumentsPerOperation` (10,000 by
  default), which the confirmation says.
- **redis-oplog**: Not published (differs); the confirmation says so when the destination publishes.
- **After**: the destination's tab and the tree are refreshed. `Inserted <i> generated documents into <destination> in
  <s> s.` (a warning with `<f> failed: <first error>` when some failed), with `Open` and `Undo` when recorded.
- **Refuses**: nothing to imitate: `<database>.<collection> has no documents to imitate.` (from the tree) or `No
  documents match the filter: there is nothing to imitate.` (from the `Schema` tab); the sample fails: `Could not
  analyze <database>.<collection>: <error>`; the destination can't be reached: `Could not connect to <name>: <error>`;
  an error while inserting: `Generating documents failed after <i> inserted: <error>`.
- **Settings**: `mongoster.history.enabled`, `mongoster.history.maxDocumentsPerOperation`.
- **Uses**: `transfer.generate-values`, `undo.record`, `undo.limits`, `connection.read-only`.
- **Tested by**: `Generator`: *none*; what it inserts: the tests of `transfer.generate-values`.
- **Differs**: no `RedisOplog.sink(…)` is called in `src/generate.ts`; the confirmation warns about it
  (`src/generate.ts:131`), and the README lists generated documents among the writes not published, but the product's
  promise and AGENTS.md's write steps want writes to documents published.

Acceptance:

- [ ] `Generate Test Documents…` on a collection of 5,000 documents analyzes 1,000 of them and proposes `100`.
- [ ] `0`, `1000001` and `12a` are refused; `1,000` and `10 000` mean 1,000.
- [ ] On a view or a read-only connection, `This collection` is not offered and the destination connection is asked
  directly.
- [ ] The confirmation shows 3 documents in mongosh syntax, and the first 3 inserted documents are those.
- [ ] 2,500 documents are inserted in 3 batches; `Cancel` stops after the current batch with `Generation cancelled
  after <i> of 2,500 documents; those stay in <destination>.`
- [ ] With integer `_id`s up to 7 in the destination, the generated `_id`s are 8, 9, 10…
- [ ] `Undo` deletes exactly the generated documents; for 20,000 documents the confirmation says `This can't be undone:
  the undo history keeps operations of up to 10,000 documents.`
- [ ] The same seed and analysis give the same documents except the ObjectId `_id`s.
- [ ] The generated documents are published to redis-oplog on a destination that publishes (differs).

### `transfer.generate-values` — Fake documents from a schema analysis

The rules that make a generated document look like the analyzed ones, field by field
([README › Generating test documents](../../README.md#features)).

- **Kind**: Derivation
- **Function**: `src/shared/generate.ts › DocumentGenerator.next` (one document at a time), `› generateDocuments`,
  `› seededRandom`.
- **Implemented in**: `src/shared/schema.ts` (the analysis: `SchemaSummary`, `FieldSchema`, `TypeSchema`).
- **Used by**: `transfer.generate`.
- **Tested by**: `test/unit/generate.test.ts › seededRandom › 'gives the same numbers for the same seed, in [0, 1)'`,
  `› 'gives other numbers for another seed, and numbers and strings alike'`; `› generateDocuments: reproducibility ›
  'gives the same documents for the same seed and time'`, `› 'streams the same documents as generateDocuments'`, `›
  'gives as many documents as asked'`; `› generateDocuments: documents like the analyzed ones › 'produces valid
  canonical Extended JSON'`, `› 'keeps the fields, each present about as often as in the analysis'`, `› 'keeps the
  BSON types of the values'`, `› 'mixes the types of a field in the same proportions'`, `› 're-samples the values of a
  field with few of them, as often as seen'`, `› 'draws numbers and dates within the observed ranges, with integers
  kept integers'`, `› 'keeps the decimals of doubles and decimals, and dates at midnight when they all were'`, `›
  'follows the lengths of the arrays'`, `› 'makes strings shaped like the examples'`, `› 'creates referenced ObjectIds
  within the time span of those seen'`; `› generateDocuments: _id › 'gives new ObjectIds created now, all different'`,
  `› 'continues integer _ids after the largest one, or from nextId'`, `› 'gives string _ids that do not repeat, shaped
  like the ones seen'`, `› 'gives UUID _ids as UUIDs'`; `› generateDocuments: empty and minimal schemas › 'gives
  documents with only an ObjectId _id for an empty analysis'`, `› 'works on an analysis without details'`, `› 'copies a
  field with a single value, and empty objects and arrays'`, `› 'keeps null-only fields null and booleans booleans'`.

Rules:

- Input: a schema analysis (with or without details), and options: a random source (`Math.random`, or
  `seededRandom(seed)`: sfc32 over a cyrb128 hash of the seed's text), `nextId` and `now`. Output: canonical Extended
  JSON documents, `_id` first. Nothing else is read: the same analysis, seed and `now` give the same documents.
- Presence: a field is in a document with the probability `count / of` of the analysis. Its type is chosen weighted by
  the counts of its types. Sub-documents are generated the same way; `null` stays `null`.
- Few values: when every value of a type is known (the details, or top values that are all of them) and the field is
  not `_id`, the values are re-used weighted by how often they were seen, if the type is boolean, or there is one
  value, or the type was seen at least twice as often as it has values. Numbers and dates with more than 50 values
  use their range instead.
- Numbers: a bin of the histogram chosen by its count, then a value in it, within the minimum and maximum. `int` and
  `long` stay integers (`int` within 32 bits); `decimal` with the decimals seen (2 when unknown, at most 20); `double`
  rounded to the decimals seen when they are few.
- Dates: like numbers, in milliseconds; at UTC midnight when every date seen was.
- ObjectIds other than `_id`: new ones whose time is between the earliest and the latest seen.
- Arrays: a length drawn from the lengths seen (or uniform between the minimum and maximum), elements by the elements'
  analysis. Binary: random bytes of the example's size and subtype (a 16-byte subtype 4 is a version-4 UUID).
  Timestamps: `now` with an increasing counter. Other types: the example value.
- Strings, the first rule that fits, from the field's name (lower case without separators) and its examples: UUIDs
  (80% of the examples, or a name with `uuid`/`guid`); emails (with the domains seen, else `example.com`, `.org`,
  `.net`); URLs (same host, the path segments that take few values kept); ISO dates in strings; phone numbers; values
  with a common prefix and digits (`user1234`, `ORD-2024-…`); first, last and user names; full names of people; cities;
  countries (2-letter codes when the examples are); streets; ids; hexadecimal ids of one length; codes; single words or
  slugs; text with spaces of a similar length. Empty strings keep their share.
- Shaped values: a random example with its digits and letters replaced by others of the same kind, except the
  positions where all the examples of that length (at least 3) have the same character; a phone keeps its `+<country>`
  prefix.
- `_id`: none in the analysis, or `objectId`: a new ObjectId with the time `now` and a counter, all different. `int` or
  `long`: counting up from `nextId` (the host passes the destination's largest + 1), or from the largest analyzed + 1;
  an `int` beyond 32 bits becomes a `long`. Other types: values like the field's, retried up to 20 times so that they
  don't repeat.

Worked examples:

- Analysis of `_id`s 1, 7, 3 → `_id`s `{ $numberInt: '8' }`, `9`, `10`; with `nextId: 100` → `100`, `101`; with
  `nextId: 2 ** 31` → `{ $numberLong: '2147483648' }`.
- 50 `_id`s `ORD-1000`, `ORD-1007`… → 300 different `_id`s matching `ORD-\d{4}`.
- `status` seen 60% `active`, 30% `pending`, 10% `closed` → the same three values in about the same shares.
- `email` seen as `user<i>@example.org` → every generated email ends with `@example.org`.
- An empty analysis → documents with only an ObjectId `_id` created at `now`.
