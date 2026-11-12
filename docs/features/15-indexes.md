# Indexes

The `Indexes` tab of the collection tab lists a collection's indexes and its Atlas Search and Vector Search indexes,
and changes them. Only the writes have cards for now: creating, editing, duplicating, hiding and dropping an index,
creating, editing and dropping a search index, and the pure checks that decide what a change takes or what is
refused. The list itself (properties, sizes, usage, builds in progress, search index statuses) is written when the
area is next changed. The user's side is in the README's [Features](../../README.md#features), under **Indexes**.

The host is `CollectionPanel` in `src/collectionPanel.ts` (the messages `saveIndex`, `dropIndex`, `hideIndex`,
`saveSearchIndex`, `dropSearchIndex` of `src/shared/messages.ts`), which calls `src/indexes.ts` and
`src/searchIndexes.ts`. The webview parts are `src/webview/indexes.ts` (the list), `src/webview/indexDialog.ts`,
`src/webview/searchIndexes.ts` and `src/webview/searchIndexDialog.ts`, wired in `src/webview/main.ts`. The pure parts
are `src/shared/indexes.ts` and `src/shared/searchIndexes.ts`.

Everywhere in this area, the actions are hidden when the tab is read-only (their `editable` class), the `_id_`
index has no actions, and views have no `Indexes` tab (`mongoster.openIndexes` does nothing on a view). Index writes
change no document: none is in the undo history or published to redis-oplog.

### `index.create` — Create an index

Creates an index on the collection from a dialog that edits its fields and options as a form, or its keys and options
as `createIndex` takes them, and shows the command while editing.

- **Kind**: Operation
- **Function**: `src/indexes.ts › saveIndex` (with no original index), which calls `createIndex` in the same file.
- **Implemented in**: `src/collectionPanel.ts › CollectionPanel.saveIndex` (the refusals), `src/webview/indexDialog.ts
  › IndexDialog` (the dialog), `src/webview/main.ts` (`indexDialog`, `{ type: 'saveIndex', requestId, original, keys,
  options }` answered by `{ type: 'indexResult', requestId, ok, message }`), `src/shared/indexes.ts › normalizeSpec`,
  `indexCommand`, `indexName`, `wildcardWarnings`.
- **Entry points**: **Create index…** in the `Indexes` tab; **Create…** next to the index suggested by **Explain**,
  which opens the `Indexes` tab with the dialog filled with the suggested keys. The index advisor's and the server
  monitor's **Create Index…** create an index too, with their own confirmation and the driver's `createIndex`
  (`src/advisor.ts`, `src/monitor.ts`); they belong to `analysis.` and `monitor.` and have no card here.
- **Offered when**: the collection tab is on a collection of a connection that is not read-only.
- **Asks**: the dialog `Create index · <collection>`. **Form**: one row per field (the names of the documents'
  fields are suggested; `1 (ascending)`, `-1 (descending)`, `text`, `2dsphere`, `2d`, `hashed`; a weight for a
  `text` field; `↑`, `↓`, `✕`; **+ Field**), **Name** (the generated one as placeholder), **Unique**, **Sparse**,
  **Hidden**, **TTL** (a whole number and `seconds`, `minutes`, `hours` or `days`, default `days`), **Partial** (a
  filter), **Collation**, **Language** (text indexes), **More options** (any other option as an object). **Text**:
  **Keys** and **Options** as objects in mongosh syntax. Below: **Command** (the `createIndex` it runs), the wildcard
  warnings (`index.wildcard-checks`) and a note. **Copy command**, **Cancel**, **Create index** (`Ctrl+Enter`).
- **Reads**: the collection's indexes and number of documents already in the tab, for the note.
- **Writes**: `db.runCommand({ createIndexes: <collection>, indexes: [{ key, name, ...options }] })`, with
  `commitQuorum` moved out of the index to the command. The options are sent as given, not through the driver's
  `createIndex`, which would leave out an option it doesn't know: the server refuses it instead. The name is the one
  given, or the one MongoDB generates (`field_1_other_-1`).
- **Danger**: None: nothing is lost. The note says `The build reads the N documents of the collection: it can take a
  while and loads the server.` from 100,000 documents.
- **Read-only**: Refused on a read-only connection with `The connection <name> is read-only.`, and on a view with
  `Views have no indexes of their own.`, shown in the dialog.
- **Undo**: Cannot be undone from the undo history: an index is not a document. `index.drop` removes it.
- **redis-oplog**: Not published: no document is written. A TTL index makes the server delete documents later, which
  Mongoster does not publish.
- **After**: the dialog closes and the tab shows `Created index <name>.` or `An identical index already exists:
  nothing was created.`; the list is read again and shows the index as `building` with its progress while it is
  built. **Cancel** becomes **Close** while saving: the build goes on and the tab shows its outcome.
- **Refuses**: in the dialog, before sending: `Add at least one field to index.`, `The field <field> is listed
  twice.`, `The weight of <field> must be a whole number from 1.`, `TTL: enter after how long the documents
  expire.`, `Partial: enter the filter of the documents to index, e.g. { status: "active" }`, `Collation: enter at
  least the locale, e.g. { locale: "en", strength: 2 }`, `<input>: <parse error>`, `<input> must be an object, e.g. {
  … }`, `Keys: enter the fields to index, e.g. { status: 1, createdAt: -1 }`; switching to **Form** with keys it
  can't show: `These keys can only be edited as text: the form takes a direction (1, -1) or an index type for each
  field.` From the host: `Keys: enter the fields to index, e.g. { status: 1, age: -1 }`, `Keys must be an object`,
  `Options must be an object`; and the server's error (an unknown option, duplicate values for `unique`, a wildcard
  written wrong), shown in the dialog, which stays open.
- **Uses**: `index.wildcard-checks`, `index.change-plan` (`normalizeSpec`).
- **Tested by**: *none* for the write (`saveIndex` and `createIndex` have no test). The pure parts:
  `test/unit/indexes.test.ts › 'defaultIndexName and indexName'` › `'names an index as MongoDB does'`, `'uses the
  given name, or the generated one'`; `'indexCommand'` › `'writes a createIndex that parses back to the
  definition'`, `'leaves out empty options'`; `'TTL units'` › both tests.

Acceptance:

- [ ] Fields `status` `1` and `createdAt` `-1` with **Unique** show the command
  `db.getCollection("orders").createIndex({ status: 1, createdAt: -1 }, { unique: true })` and create the index
  `status_1_createdAt_-1`.
- [ ] **TTL** `2` `hours` on a date field creates the index with `expireAfterSeconds: 7200`.
- [ ] An option MongoDB doesn't know, typed in **More options** (`{ uniqe: true }`), is refused with the server's
  error, and no index is created.
- [ ] A name already used shows `The collection already has an index named <name>.`; keys already indexed show `The
  index <name> already has these keys: MongoDB takes a second one only with a different collation, partial filter,
  sparse or unique.`
- [ ] Creating an index identical to an existing one says `An identical index already exists: nothing was created.`
- [ ] **Text** shows the keys and options of the form, and back; keys the form can't show stay in **Text**.
- [ ] Closing the dialog while the index is built leaves the build running, and the tab says `Created index <name>.`
  when it ends.
- [ ] On a read-only connection, **Create index…** is not shown, and a `saveIndex` message is answered with `The
  connection <name> is read-only.` and creates nothing.

### `index.duplicate` — Duplicate an index

Opens the index dialog on a copy of an existing index without its name, to create a variant of it.

- **Kind**: View
- **Function**: `src/webview/indexes.ts › IndexesView` (the **Duplicate…** button), which calls `IndexDialog.open`
  with the index's keys and options without `name`.
- **Implemented in**: `src/shared/indexes.ts › editableSpec` (the definition as `createIndex` takes it).
- **Entry points**: **Duplicate…** on a row of the `Indexes` tab (tooltip `Create another index starting from this
  one`).
- **Offered when**: every index but `_id_`, when the tab is not read-only.
- **Uses**: `index.create`, which does the write.
- **Tested by**: `test/unit/indexes.test.ts › 'editableSpec'` › `'turns what listIndexes reports back into
  createIndex arguments'`, `'puts the fields of a text index back in its keys'`.

Acceptance:

- [ ] **Duplicate…** on `byEmail { email: 1 }` unique opens `Create index · <collection>` with the field `email`,
  **Unique** ticked and an empty **Name**, whose placeholder is `email_1`.
- [ ] Saving it unchanged creates nothing: the server refuses the same keys and options under another name, and
  an index identical to one with the generated name gives `An identical index already exists: nothing was created.`

### `index.edit` — Edit an index

Changes an existing index: hiding it and changing its TTL in place; anything else by dropping it and building it
again, after a confirmation, never leaving the collection without the index when that can be avoided.

- **Kind**: Operation
- **Function**: `src/indexes.ts › saveIndex` (with the original index's name).
- **Implemented in**: `src/collectionPanel.ts › CollectionPanel.saveIndex`, `src/webview/indexDialog.ts ›
  IndexDialog` (title `Edit index · <name>`, button **Save changes**), `src/shared/indexes.ts › planIndexChange`,
  `editableSpec`, `ttlParts`, `indexCommand`.
- **Entry points**: **Edit…** on a row of the `Indexes` tab (tooltip `Change the definition of the index`).
- **Offered when**: every index but `_id_`, when the tab is not read-only.
- **Asks**: the index dialog on the current definition. Its note says what saving takes: `No changes yet.` (and
  **Save changes** is disabled), `Applied to the existing index: nothing is built again.`, or `MongoDB can't change
  the <what> of an existing index: it will be dropped and built again, after a confirmation.` For a rebuild, a modal
  `Drop and recreate the index <name> of <collection>?` with the detail `MongoDB can't change the <keys, name and
  unique> of an existing index: it is dropped and built again with the new definition. Building reads the whole
  collection, and until it ends queries can't use the index` (and, for a unique index, `and duplicate values aren't
  rejected`), and the button **Drop and Recreate**.
- **Reads**: `listIndexes`, for the index as it is now.
- **Writes**: in place, `collMod: { index: { name, hidden } }` and `collMod: { index: { name, expireAfterSeconds } }`.
  A rebuild under another name: `createIndexes` with the new definition, then `dropIndex(<old name>)`; when the
  server refuses the two side by side (code 85 or 86), or under the same name: `dropIndex(<old name>)`, then
  `createIndexes`. When the new definition is refused after the drop, `createIndexes` with the old definition as
  `listIndexes` reported it.
- **Danger**: Confirm, for a rebuild: the text above. Until the new index is built, queries can't use it; under the
  same name, a unique index doesn't reject duplicates in the meantime. In place: None.
- **Read-only**: Refused on a read-only connection with `The connection <name> is read-only.`; on a view with `Views
  have no indexes of their own.`
- **Undo**: Cannot be undone from the undo history; the rebuild's confirmation does not say so.
- **redis-oplog**: Not published: no document is written.
- **After**: the dialog closes and the tab says `Index <name>: hidden, documents expire after 2 hours.` (or `no
  longer hidden`), `Created index <new> and dropped <old>.`, `Recreated index <name>.` or `No changes to the index
  <name>.`; the list is read again. Cancelling the confirmation leaves the dialog open, with no message.
- **Refuses**: `The _id index can't be changed.`; `The index <name> no longer exists.`; a new definition the server
  refuses, with its error and `The index <name> was created again as it was.`, or, if that fails too, `The index
  <name> was dropped and could not be created again as it was (<error>). Its definition:` and its `createIndex`
  command.
- **Uses**: `index.change-plan`, `index.create` (the dialog and `createIndex`).
- **Tested by**: *none* for the write; `test/unit/indexes.test.ts › 'planIndexChange'` (the decision).
- **Differs**: the rebuild drops the index after a confirmation that does not say it can't be undone from the undo
  history, as the confirmation of `structure.apply` does (`src/indexes.ts:154-162`).

Acceptance:

- [ ] Ticking **Hidden** saves with `collMod` and says `Index <name>: hidden.`, and the index is not built again.
- [ ] Changing a TTL from `1` `days` to `2` `hours` says `Index <name>: documents expire after 2 hours.`
- [ ] Adding **Unique** asks `Drop and recreate the index <name> of <collection>?` and, after **Drop and Recreate**,
  the index is unique under the same name: `Recreated index <name>.`
- [ ] Changing the keys and the name builds the new index first and drops the old one afterwards: `Created index
  <new> and dropped <old>.`
- [ ] Adding **Unique** on a field with duplicate values fails with the server's error and `The index <name> was
  created again as it was.`, and the index is there as before.
- [ ] Under another name with the same keys and options as before, the old index is dropped first, since MongoDB
  refuses the two side by side.
- [ ] Without changes, **Save changes** is disabled and the note says `No changes yet.`
- [ ] (differs) The rebuild's confirmation says that the change can't be undone from the undo history.

### `index.hide` — Hide or unhide an index

Hides an index from the query planner without dropping it, to find out whether it is still needed, or lets queries
use it again.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.receive` (case `hideIndex`), through
  `CollectionPanel.indexCommand`.
- **Implemented in**: `src/webview/indexes.ts › IndexesView` (the button), `src/webview/main.ts` (`{ type:
  'hideIndex', name, hidden }`).
- **Entry points**: **Hide** (tooltip `Stop queries from using this index without dropping it`) or **Unhide**
  (`Let queries use this index again`) on a row of the `Indexes` tab. **Hidden** in the index dialog does the same
  through `index.edit`.
- **Offered when**: every index but `_id_`, when the tab is not read-only.
- **Writes**: `runCommand({ collMod: <collection>, index: { name, hidden: true | false } })`.
- **Danger**: None: the index is kept up to date and comes back at once with **Unhide**.
- **Read-only**: Refused on a read-only connection with `The connection <name> is read-only.` and on a view with
  `Views are read-only.`, as an error notification.
- **Undo**: Cannot be undone from the undo history; **Unhide** reverses it.
- **redis-oplog**: Not published: no document is written.
- **After**: the list is read again, with the index marked `hidden` or not; a refusal of the server is an error
  notification.
- **Tested by**: *none*.

Acceptance:

- [ ] **Hide** on `status_1` sends `collMod` with `hidden: true`, with no confirmation, and the row then offers
  **Unhide**.
- [ ] **Unhide** sends `hidden: false`.
- [ ] On a read-only connection, a `hideIndex` message shows `The connection <name> is read-only.` and changes
  nothing.

### `index.drop` — Drop an index

Drops an index after a confirmation that suggests hiding it first.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.dropIndex`
- **Implemented in**: `src/collectionPanel.ts › CollectionPanel.indexCommand`, `src/webview/indexes.ts ›
  IndexesView` (the button), `src/webview/main.ts` (`{ type: 'dropIndex', name }`).
- **Entry points**: **Drop** on a row of the `Indexes` tab.
- **Offered when**: every index but `_id_`, when the tab is not read-only.
- **Asks**: a modal `Drop index <name> on <collection>?` with the detail `Queries that use it will fall back to other
  indexes or a collection scan. Hiding the index first lets you check the impact without losing it.` and the button
  **Drop**.
- **Writes**: `dropIndex(<name>)`.
- **Danger**: Destructive: the index is gone, and building it again reads the whole collection.
- **Read-only**: Refused on a read-only connection with `The connection <name> is read-only.` and on a view with
  `Views are read-only.`, as an error notification.
- **Undo**: Cannot be undone from the undo history; the confirmation does not say so.
- **redis-oplog**: Not published: no document is written.
- **After**: the list is read again; a refusal of the server is an error notification.
- **Refuses**: `_id_`, quietly: no confirmation, nothing sent.
- **Tested by**: *none*.
- **Differs**: the confirmation does not say that the drop can't be undone from the undo history, as the confirmation
  of `structure.apply` does (`src/collectionPanel.ts:936-939`).

Acceptance:

- [ ] **Drop** on `status_1` asks `Drop index status_1 on orders?` and, after **Drop**, the index is gone from the
  list.
- [ ] Closing the confirmation drops nothing.
- [ ] A `dropIndex` message for `_id_` does nothing.
- [ ] On a read-only connection, a `dropIndex` message shows `The connection <name> is read-only.` and drops nothing.
- [ ] (differs) The confirmation says that the drop can't be undone from the undo history.

### `index.create-search` — Create a search index

Creates an Atlas Search or Vector Search index from its name, type and definition, written as text or filled in from
the sampled fields.

- **Kind**: Operation
- **Function**: `src/searchIndexes.ts › saveSearchIndex` (with no original index).
- **Implemented in**: `src/collectionPanel.ts › CollectionPanel.saveSearchIndex` and `searchIndexRefusal`,
  `src/webview/searchIndexDialog.ts › SearchIndexDialog`, `src/webview/main.ts` (`{ type: 'saveSearchIndex',
  requestId, original, name, searchType, definition }` answered by `searchIndexResult`), `src/shared/searchIndexes.ts`
  (`DEFAULT_NAMES`, `definitionTypeMismatch`, `staticDefinition`, `setMapped`, `writeVectorForm`,
  `searchIndexCommand`).
- **Entry points**: **Create search index…** under **Search indexes** in the `Indexes` tab.
- **Offered when**: the tab is not read-only.
- **Asks**: the dialog `Create search index · <collection>`: **Name** (empty means `default` for search,
  `vector_index` for vector search), the type **Search** or **Vector Search**, the definition as text (colored, with
  suggestions), and a form that follows it: **Dynamic mapping** and **Static mappings** with the sampled fields to
  tick, or, for a vector index, the path, the dimensions (filled in from the sampled arrays), the similarity
  (`cosine`, `euclidean`, `dotProduct`), the quantization (`none`, `scalar`, `binary`) and the filter fields. Its
  notes warn, without refusing, of `The collection already has a search index named <name>.`, vectors of another
  length than the dimensions, a path that isn't an array of numbers, and `No field is mapped: the index would find
  nothing. Turn on the dynamic mapping or tick some fields.` Button **Create search index**.
- **Reads**: `listSearchIndexes(<name>)`, to refuse a name already taken.
- **Writes**: `createSearchIndex({ name, type, definition })`.
- **Danger**: None.
- **Read-only**: Refused on a read-only connection with `The connection <name> is read-only.`; on a view with `Views
  have no indexes of their own: manage the search indexes from the Indexes tab of the source collection.`
- **Undo**: Cannot be undone from the undo history; `index.drop-search` removes it.
- **redis-oplog**: Not published: no document is written.
- **After**: the dialog closes, the tab says `Created search index <name>: it is being built, and can be queried once
  its status is READY.`, and the list is read again every 5 seconds while an index is being built.
- **Refuses**: `Unknown search index type <type>: it is search or vectorSearch.`; `Definition: <parse error>`; `The
  definition must be an object, e.g. { mappings: { dynamic: true } }`; a definition of the other type
  (`index.search-checks`); `A search index named <name> already exists: open it in the list to change its definition,
  or choose another name.`; the server's errors, without the command's path, and with what the server lacks when it
  has no search or can't reach mongot.
- **Uses**: `index.search-checks`.
- **Tested by**: `test/integration/searchIndexes.test.ts › 'search indexes on a server with search'` › `'creates
  search and vector search indexes and follows them until they are ready'`, `'refuses a taken name, a definition of
  the other type and an invalid one, saying why'` (run only when `MONGOSTER_SEARCH_URI` gives a server with search);
  `test/unit/searchIndexes.test.ts › 'searchIndexCommand'`, `'static mappings'`, `'vector search form'`.

Acceptance:

- [ ] An empty name with `{ mappings: { dynamic: true } }` creates the search index `default`; an empty name for a
  vector index creates `vector_index`.
- [ ] A name already taken is refused with `A search index named <name> already exists: …`, and nothing is created.
- [ ] A **Search** index given `{ fields: [ … ] }` is refused with `A search index is defined by its mappings, …`.
- [ ] An invalid field type (`{ type: "strin" }`) is refused with the server's message starting with
  `"mappings.fields.title.type" must be one of`.
- [ ] On a server without search, the error starts with `Search indexes need MongoDB Atlas, an Atlas local deployment
  (atlas deployments setup --type local) or MongoDB Community 8.3 or later with mongot: this server has no search.`
- [ ] On a read-only connection, a `saveSearchIndex` message is answered with `The connection <name> is read-only.`
  and creates nothing.

### `index.edit-search` — Change a search index's definition

Gives a search index a new definition; the server builds it in the background, and queries use the old one until
then.

- **Kind**: Operation
- **Function**: `src/searchIndexes.ts › saveSearchIndex` (with the original index's name).
- **Implemented in**: `src/collectionPanel.ts › CollectionPanel.saveSearchIndex`,
  `src/webview/searchIndexDialog.ts › SearchIndexDialog` (title `Edit search index · <name>`, button **Save
  changes**), `src/webview/searchIndexes.ts` (the button).
- **Entry points**: **Edit…** on a row of **Search indexes** (tooltip `Change the definition of the index: it is
  built again in the background`).
- **Offered when**: the index is not `DELETING` and the tab is not read-only.
- **Asks**: the dialog on the current definition, with the name and the type fixed (`A search index keeps its name: to
  rename it, create another one and drop this one`). Its note: `No changes yet.` (and **Save changes** disabled), or
  `The index is built again with the new definition, in the background: queries keep using the current one until it
  is ready.`
- **Writes**: `updateSearchIndex(<name>, definition)`.
- **Danger**: None: the old definition answers queries until the new one is ready.
- **Read-only**: Refused as `index.create-search`.
- **Undo**: Cannot be undone from the undo history.
- **redis-oplog**: Not published: no document is written.
- **After**: the tab says `Search index <name>: the new definition is being built. Queries keep using the previous
  one until it is ready.`, and follows the build.
- **Refuses**: as `index.create-search` (except the name), and the server's error for an index that no longer exists.
- **Uses**: `index.search-checks`.
- **Tested by**: `test/integration/searchIndexes.test.ts › 'search indexes on a server with search' › 'changes a
  definition: the previous one answers until the new one is ready'`.

Acceptance:

- [ ] Saving a new definition of `titles` says `Search index titles: the new definition is being built. …`, and
  while its status is `BUILDING` the index is still queryable.
- [ ] Changing an index that no longer exists fails with the server's error naming it.

### `index.drop-search` — Drop a search index

Drops a search index after a confirmation; the server removes it in the background.

- **Kind**: Operation
- **Function**: `src/searchIndexes.ts › dropSearchIndex`
- **Implemented in**: `src/collectionPanel.ts › CollectionPanel.dropSearchIndex` and `searchIndexRefusal`,
  `src/webview/searchIndexes.ts` (the button), `src/webview/main.ts` (`{ type: 'dropSearchIndex', name }`).
- **Entry points**: **Drop** on a row of **Search indexes**.
- **Offered when**: the index is not `DELETING` and the tab is not read-only.
- **Asks**: a modal `Drop search index <name> on <collection>?` with the detail `The $search, $searchMeta and
  $vectorSearch stages that use it will return no results. The server removes it in the background.` and the button
  **Drop**.
- **Writes**: `dropSearchIndex(<name>)`.
- **Danger**: Destructive: the index is gone, and the stages that use it return nothing.
- **Read-only**: Refused on a read-only connection with `The connection <name> is read-only.`, on a view with `Views
  have no indexes of their own: manage the search indexes from the Indexes tab of the source collection.`, as an
  error notification.
- **Undo**: Cannot be undone from the undo history; the confirmation does not say so.
- **redis-oplog**: Not published: no document is written.
- **After**: the list is read again and shows the index as `DELETING` until it is gone; an error is an error
  notification.
- **Tested by**: `test/integration/searchIndexes.test.ts › 'search indexes on a server with search' › 'drops
  indexes'`.
- **Differs**: the confirmation does not say that the drop can't be undone from the undo history, as the confirmation
  of `structure.apply` does (`src/searchIndexes.ts:106-110`).

Acceptance:

- [ ] **Drop** on `titles` asks `Drop search index titles on movies?` and, after **Drop**, the index is `DELETING`
  and then gone.
- [ ] Dropping an index that no longer exists shows the server's error naming it.
- [ ] On a read-only connection, a `dropSearchIndex` message shows `The connection <name> is read-only.` and drops
  nothing.
- [ ] (differs) The confirmation says that the drop can't be undone from the undo history.

### `index.change-plan` — What changing an index takes

Decides whether an index edited in the dialog is unchanged, changed in place with `collMod`, or dropped and built
again, and lists what changed. `index.edit` and `structure.steps` both use it.

- **Kind**: Derivation
- **Function**: `src/shared/indexes.ts › planIndexChange`
- **Implemented in**: `src/shared/indexes.ts › normalizeSpec`, `editableSpec`, `defaultIndexName`, `indexName`,
  `stable`.
- **Tested by**: `test/unit/indexes.test.ts` › `'planIndexChange'` › `'ignores the order of options but not the order
  of keys'`, `'hides or shows an index in place'`, `'changes a TTL in place, but adding or removing one rebuilds the
  index'`, `'rebuilds for anything else, listing what changed'`; `'normalizeSpec'` › both tests; `'editableSpec'` ›
  all four tests.

Inputs: the index as it is (from `listIndexes`, through `editableSpec`) and the new definition, each as keys and
`createIndex` options. Output: `none`; `modify` with `hidden` and/or `expireAfterSeconds`; or `recreate` with the list
of what changed (`keys`, `name`, and option names).

Rules:

1. Both sides are normalized first: false `unique`, `sparse` and `hidden`, `background`, `null` options, the name
   MongoDB would generate, and text weights of 1 are left out. From `listIndexes`, `v`, `ns`, `textIndexVersion`,
   `2dsphereIndexVersion`, the collation's `version`, the text defaults (`default_language: "english"`,
   `language_override: "language"`) are left out, and a text index's `_fts` / `_ftsx` become its fields with
   `"text"`.
2. The keys are compared in order; the options by value, whatever their order.
3. Only `hidden` and `expireAfterSeconds` changed, and a TTL is on both sides when it changed → `modify`.
4. Anything else, including adding or removing a TTL, → `recreate`.
5. The generated name is `<field>_<value>` joined by `_`: `{ a: 1, "b.c": -1 }` → `a_1_b.c_-1`; `{ loc: "2dsphere",
   name: "text" }` → `loc_2dsphere_name_text`.

Worked examples (current → new: result):

| Current | New | Result |
| --- | --- | --- |
| `{ a: 1 }`, collation `{ locale: "fr", strength: 1 }` | the same collation as `{ strength: 1, locale: "fr" }` | none |
| `{ a: 1, b: 1 }` | `{ b: 1, a: 1 }` | recreate: `keys`, `name` |
| `{ a: 1 }` | `{ a: 1 }` hidden | modify: hidden |
| `{ a: 1 }` hidden | `{ a: 1 }` | modify: not hidden |
| `{ a: 1 }` TTL 60 | `{ a: 1 }` TTL 120, hidden | modify: hidden, TTL 120 |
| `{ a: 1 }` | `{ a: 1 }` TTL 60 | recreate: `expireAfterSeconds` |
| `{ a: 1 }` | `{ a: 1 }` unique, hidden | recreate: `unique`, `hidden` |
| `{ a: 1 }` | `{ a: 1 }` named `renamed` | recreate: `name` |
| `a_1 { a: 1 }` TTL 60, as `listIndexes` reports it with `v: 2` | `{ a: 1 }` TTL 60, `unique: false` | none |

`editableSpec("cat_1_title_text_body_text", { cat: 1, _fts: "text", _ftsx: 1 }, { weights: { title: 1, body: 3 },
default_language: "english", language_override: "language", textIndexVersion: 3 })` → keys `{ cat: 1, title: "text",
body: "text" }`, options `{ weights: { body: 3 } }`.

Acceptance:

- [ ] The examples above give the results shown.
- [ ] An index read back from `listIndexes` and saved unchanged is `none`: the dialog says `No changes yet.`

### `index.wildcard-checks` — Wildcards written wrong

Points out, while the index dialog is edited and on the list's rows, a wildcard written so that MongoDB would index
something else than meant, or given options a wildcard index can't have. The checks only warn: the server decides.

- **Kind**: Derivation
- **Function**: `src/shared/indexes.ts › wildcardWarnings`
- **Implemented in**: `src/shared/indexes.ts › isWildcard`, `misspelledWildcards`; `src/webview/indexDialog.ts ›
  IndexDialog.update` (the warnings above the note); `src/webview/indexes.ts` (the badge `not a wildcard`).
- **Tested by**: `test/unit/indexes.test.ts › 'wildcards'` › `'recognizes wildcard keys'`, `'finds keys that look
  like wildcards but are not'`, `'warns about wrong wildcard definitions'`, `'accepts correct wildcard and text
  definitions'`.

Inputs: the keys and options of the dialog. Output: the warnings, in English, in order.

Rules:

1. A wildcard is `$**` or `path.$**`, with no `*` and no part starting with `$` in the path.
2. A key with a `*` that isn't a wildcard: `<field> isn't a wildcard: MongoDB would index a field with that very
   name. Write $** for every field, or path.$** for every field below a path.` (or, when a part starts with `$`,
   `… write $** for every field or path.$** for every field below a path, with nothing after it.`). The list marks
   an existing index with such a key `not a wildcard`.
3. More than one wildcard: `An index can have only one wildcard field.`
4. `{ "$**": "text" }` is a text index on every string field: none of the rules below apply to it.
5. A wildcard not `1` or `-1`: `<field>: a wildcard field is ascending or descending (1 or -1).`
6. A wildcard with `unique`, `sparse` or a TTL: `A wildcard index can't be unique or TTL.` (the options named).
7. `wildcardProjection` with `path.$**`: `wildcardProjection only goes with $**: <field> already says which fields
   are indexed.`; without any wildcard: `wildcardProjection is only for wildcard indexes.`
8. `$**` with other fields and no `wildcardProjection`: `A compound index with $** needs a wildcardProjection that
   leaves out its other fields, e.g. wildcardProjection: { <first other field>: 0 }.`

Worked examples (keys, options → warnings):

| Keys | Options | Warnings |
| --- | --- | --- |
| `{ "address.*": 1 }` | | `address.* isn't a wildcard: …` |
| `{ "$**": 1, "a.$**": 1 }` | | `An index can have only one wildcard field.` |
| `{ "$**": "hashed" }` | | `$**: a wildcard field is ascending or descending (1 or -1).` |
| `{ "$**": 1 }` | `{ unique: true, expireAfterSeconds: 5 }` | `A wildcard index can't be unique or TTL.` |
| `{ "a.$**": 1 }` | `{ wildcardProjection: { b: 1 } }` | `wildcardProjection only goes with $**: …` |
| `{ a: 1 }` | `{ wildcardProjection: { b: 1 } }` | `wildcardProjection is only for wildcard indexes.` |
| `{ "$**": 1, status: 1 }` | | `… e.g. wildcardProjection: { status: 0 }.` |
| `{ "$**": 1, status: 1 }` | `{ wildcardProjection: { status: 0 } }` | none |
| `{ "$**": 1 }`, `{ "a.$**": -1 }`, `{ "$**": "text" }`, `{ a: 1 }` | | none |

Acceptance:

- [ ] The examples above give the warnings shown, while typing, above the dialog's note.
- [ ] A definition with warnings can still be saved; the server's answer is shown.

### `index.search-checks` — What a search index definition is refused for

The checks Mongoster makes before sending a search index, and how a refusal of the server is said.

- **Kind**: Derivation
- **Function**: `src/shared/searchIndexes.ts › definitionTypeMismatch`
- **Implemented in**: `src/shared/searchIndexes.ts › definitionType`, `DEFAULT_NAMES`, `searchErrorText`,
  `isSearchUnsupported`, `isSearchUnreachable`, `SEARCH_UNSUPPORTED_HELP`, `SEARCH_UNREACHABLE_HELP`;
  `src/searchIndexes.ts › explain` and `saveSearchIndex`.
- **Tested by**: `test/unit/searchIndexes.test.ts` › `'search index types'` › `'tells the type by the shape of the
  definition'`, `'refuses a definition of the other type with what the type takes'`; `'isSearchUnsupported'` ›
  `'recognizes servers without search by code or message'`, `'leaves real errors as errors'`;
  `'isSearchUnreachable'` › `'tells a mongot that does not answer from a server without search'`;
  `'searchErrorText'` › `'drops the path of the command from the validation errors of mongot'`.

Inputs: the chosen type, the definition, and the server's error. Output: a refusal message, or none.

Rules:

1. The type of a definition is `search` when it has a `mappings` object, `vectorSearch` when it has a `fields` list,
   unknown otherwise.
2. A definition of the other type is refused: for **Search**, `A search index is defined by its mappings, e.g. {
   mappings: { dynamic: true } }; this definition has a fields list, as a vector search index has.`; for **Vector
   Search**, `A vector search index is defined by a fields list, e.g. { fields: [{ type: "vector", path: "embedding",
   numDimensions: 1536, similarity: "cosine" }] }; this definition has mappings, as a search index has.` A definition
   of unknown type is sent, and the server judges it.
3. An empty name is `default` for **Search** and `vector_index` for **Vector Search**.
4. A server without search (codes 31082, 59, 115, 40324, 6047401, or messages such as `Unrecognized pipeline stage
   name: '$listSearchIndexes'`): the error is preceded by `Search indexes need MongoDB Atlas, an Atlas local
   deployment (atlas deployments setup --type local) or MongoDB Community 8.3 or later with mongot: this server has
   no search.`
5. A server that can't reach mongot (code 508, `SearchIndexManagementHostUnreachable`): preceded by `The server is set
   up for search but cannot reach mongot, the process that builds and queries the search indexes: check that it is
   running and that mongotHost and searchIndexManagementHostAndPort point to it.`
6. A validation error of mongot loses the path of the command: `"userCommand.indexes[0].mappings" is required` →
   `"mappings" is required`.

Acceptance:

- [ ] `definitionTypeMismatch('search', { mappings: { dynamic: true } })`, `('vectorSearch', { fields: [] })` and
  `('search', {})` refuse nothing.
- [ ] `definitionTypeMismatch('search', { fields: [{ type: 'vector' }] })` starts with `A search index is defined by
  its mappings`, and `('vectorSearch', { mappings: { dynamic: true } })` with `A vector search index is defined by a
  fields list`.
- [ ] A mongot that does not answer is never reported as a server without search.
