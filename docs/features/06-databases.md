# Databases and collections

Creating, renaming and dropping databases and collections from the connections view, editing the definition of a view,
and editing the validation rules of a collection, with the `$jsonSchema` proposed for a collection that has none. The
user's side is in the entries **Managing databases and collections**, **Views** and **Validation rules** of the
[README's Features](../../README.md#features).

None of these writes is recorded in the undo history or published to redis-oplog: they act on whole databases and
collections, or on their options. They all live in the connections view's context menus, and are hidden from the
Command Palette (`when: false`), where they would have no node to act on: run with no argument, each command does
nothing.

### `manage.create-database` — Create a database

Creates a database with its first collection, since MongoDB creates a database only together with a collection, and
opens that collection.

- **Kind**: Operation
- **Function**: `src/manage.ts › Manager.createDatabase`
- **Implemented in**: `src/extension.ts` (command `mongoster.createDatabase`: refreshes the tree, opens the collection
  tab); `src/manage.ts › databaseNameError`, `collectionNameError`.
- **Entry points**: `mongoster.createDatabase` (**Create Database…**) in a connection's context menu.
- **Offered when**: `viewItem =~ /^connection(\.connected)?(\.nohistory)?$/`: any connection that isn't read-only,
  connected or not. Not in the Command Palette (`when: false`); with no argument it does nothing.
- **Asks**:
  1. an input box **Create Database (1/2)**, `Database name on <connection>`, checked by `manage.name-rules` and
     against the databases listed (`This database already exists`);
  2. an input box **Create Database (2/2)**, `Name of its first collection (MongoDB creates a database together with
     a collection)`, checked by `manage.name-rules`.
- **Reads**: `listDatabases({ nameOnly: true, authorizedDatabases: true })` (an empty list when it fails).
- **Writes**: `db(<database>).createCollection(<collection>)`.
- **Danger**: None.
- **Read-only**: Refused on a read-only connection, with `The connection <name> is read-only.`, before asking anything.
- **Undo**: Cannot be undone: creating a collection is not a write to documents; nothing says so.
- **redis-oplog**: Not published.
- **After**: the tree is refreshed and the new collection's tab opens.
- **Refuses**: the error of MongoDB, in an error message.
- **Uses**: `manage.name-rules`.
- **Tested by**: *none*.

Acceptance:

- [ ] Names are trimmed; an empty name, a name with a space or one of `/ \ . " $ * < > : | ?`, or a name longer than
  63 bytes can't be accepted.
- [ ] The name of a database that exists can't be accepted.
- [ ] Escape at either step creates nothing.
- [ ] After the two names, the database is listed in the tree and the collection's tab is open.

### `manage.create-collection` — Create a collection

Creates a collection in a database, with options such as capped or time series.

- **Kind**: Operation
- **Function**: `src/manage.ts › Manager.createCollection`
- **Implemented in**: `src/extension.ts` (command `mongoster.createCollection`); `src/queries.ts › toBson` (the
  options in mongosh syntax); `src/manage.ts › collectionNameError`.
- **Entry points**: `mongoster.createCollection` (**Create Collection…**) in a database's context menu, and its `+`
  button on the database node.
- **Offered when**: `viewItem == database` (a database of a connection that isn't read-only). Not in the Command
  Palette (`when: false`); with no argument it does nothing.
- **Asks**:
  1. an input box **Create Collection in <database> (1/2)**, `Collection name`, checked by `manage.name-rules` and
     against the collections of the database (`This collection already exists`);
  2. an input box **Create Collection <database>.<name> (2/2)**, `Options, optional: leave empty for a regular
     collection`, placeholder `{ capped: true, size: 1048576 }  or  { timeseries: { timeField: "ts" } }`, checked
     while typing: `Options: <parse error>` or `Options must be an object`.
- **Reads**: `listCollections({}, { nameOnly: true, authorizedCollections: true })`.
- **Writes**: `db(<database>).createCollection(<name>, <options>)`, the options as BSON (`NumberLong`, `Decimal128`
  kept).
- **Danger**: None.
- **Read-only**: Refused on a read-only connection, with `The connection <name> is read-only.`, before asking anything.
- **Undo**: Cannot be undone: creating a collection is not a write to documents; nothing says so.
- **redis-oplog**: Not published.
- **After**: the tree is refreshed; no tab opens.
- **Refuses**: the error of MongoDB (invalid options), in an error message.
- **Uses**: `manage.name-rules`.
- **Tested by**: *none*.

Acceptance:

- [ ] Empty options create a regular collection.
- [ ] `{ capped: true, size: 1048576 }` creates a capped collection of 1 MB.
- [ ] `{ timeseries: { timeField: "ts" } }` creates a time series collection.
- [ ] Escape at either step creates nothing.

### `manage.rename-collection` — Rename a collection

Renames a collection within its database; its open tab, its recent and saved queries, its column layout and its
expanded columns follow the new name.

- **Kind**: Operation
- **Function**: `src/manage.ts › Manager.renameCollection`
- **Implemented in**: `src/extension.ts` (command `mongoster.renameCollection`); `src/collectionPanel.ts ›
  moveCollectionState`, `CollectionPanel.close`, `CollectionPanel.show`; `src/queryHistory.ts ›
  QueryHistory.stateKeys`; `src/relationsAnalysis.ts` (`RelationsCache.invalidate`).
- **Entry points**: `mongoster.renameCollection` (**Rename Collection…**) in a collection's context menu.
- **Offered when**: `viewItem == collection`: not on views, not on read-only connections. Not in the Command Palette
  (`when: false`); with no argument, or on a view, it does nothing.
- **Asks**: an input box **Rename Collection <database>.<collection>**, `New name`, filled with the current name,
  checked by `manage.name-rules` and against the other collections (`A collection with this name already exists`).
- **Reads**: `listCollections({}, { nameOnly: true, authorizedCollections: true })`.
- **Writes**: `db(<database>).renameCollection(<collection>, <name>)`.
- **Danger**: None.
- **Read-only**: Refused on a read-only connection, with `The connection <name> is read-only.`, before asking anything.
- **Undo**: Cannot be undone from the undo history; renaming back undoes it. Nothing says so.
- **redis-oplog**: Not published.
- **After**: the recent and saved queries, the column layout and the expanded columns (the `globalState` keys
  `mongoster.history.<key>`, `mongoster.saved.<key>`, `mongoster.expanded.<key>`, `mongoster.layout.<key>`) move to the
  new name; the references found for the database are forgotten; the collection's tab, when open, is closed and opened
  again under the new name; the tree is refreshed.
- **Refuses**: the error of MongoDB, in an error message.
- **Uses**: `manage.name-rules`.
- **Tested by**: *none*.

Acceptance:

- [ ] The same name, or Escape, renames nothing.
- [ ] After a rename, the tab of the collection is open under the new name with the same recent queries, saved
  queries, columns and expansions; a tab that wasn't open isn't opened.
- [ ] Opening the old name again (a new collection with that name) shows no recent queries and the default columns.
- [ ] What stays under the old name: the saved queries of the project (files in `.mongoster/queries`), the operations
  of the undo history (undoing one writes to a collection with the old name), the open documents in editor tabs, and
  the other tabs on the collection (watch, compare, document history).
- [ ] A view can't be renamed: the entry isn't in its menu.

### `manage.rename-database` — Rename a database

Gives a database another name. MongoDB has no such command: its collections and views are moved to a new database
and the old one is dropped ([README › Managing databases and collections](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/paste.ts › TreeClipboard.renameDatabase`, which asks, then moves as `transfer.move` on the same
  connection and drops the emptied database (`dropMoved`).
- **Implemented in**: `src/extension.ts` (`mongoster.renameDatabase`); `src/copy.ts` (`pasteSources`,
  `pasteCollections`); `src/manage.ts › databaseNameError`
- **Entry points**: `mongoster.renameDatabase` **Rename Database…** in a database's context menu, group `3_manage`.
  Hidden from the Command Palette (`when: false`); without a tree node it does nothing.
- **Offered when**: `viewItem =~ /^database(\.excluded)?$/`: not on a read-only connection.
- **Asks**: an input box `Rename the database <database>`, `New name`, with the current name; refused: an invalid
  name (`manage.name-rules`), `Enter another name`, `This database already exists`. Then the modal `Rename the
  database <database> of <connection> to <name>?` with the names moved, the counts of `transfer.paste`, `MongoDB can't
  rename a database: its collections are moved to the new database <name>, then <database> is dropped.` and the two
  lines of `transfer.move`; button `Rename`.
- **Reads**: `listDatabases`; `listCollections` of the database, without the `system.` ones;
  `estimatedDocumentCount()` of each collection.
- **Writes**: what `transfer.move` writes on the same connection: `renameCollection` across databases for each
  collection (copy and drop for one the server refuses), each view created in the new database and dropped from the
  old, then `dropDatabase()` of the old one when nothing but `system.` collections is left in it.
- **Danger**: Confirm: the modal above. Destructive only for what fails halfway: the database is then in two parts,
  and the result names what stayed.
- **Read-only**: Refused on a read-only connection: `The connection <name> is read-only: the database <database>
  can't be renamed.`
- **Undo**: Cannot be undone, and the confirmation says so; renaming it back undoes it.
- **redis-oplog**: Not published: no document is written, as `manage.rename-collection`.
- **After**: what `transfer.move` does for each collection, and for the dropped database. `Renamed the database
  <database> to <name>: moved <n> collection[s] (<d> document[s])[ and <k> view[s]] in <s> s.`
- **Refuses**: `admin`, `local` and `config`: `The database <name> is the server's own: it can't be renamed.`; a
  database without collections: `The database <database> has no collections: there is nothing to rename.`; a
  connection that cannot be reached: `Could not connect to <name>: <error>`.
- **Uses**: `transfer.move`, `tree.paste-plan`, `manage.name-rules`, `connection.read-only`.
- **Tested by**: `test/integration/paste.test.ts › 'moving instead of copying' › 'renames the collections into the
  other database on the same deployment, and moves the views'` (the move); the command and the drop of the old
  database: *none*.
- **Differs**: the database's own color, its exclusion from searches and its formatting rules are forgotten with the
  old name instead of following the new one, unlike a renamed collection's.

Acceptance:

- [ ] `shop` renamed to `store`: `store` has every collection of `shop` with its documents, indexes and options, and
  every view; `shop` is no longer listed.
- [ ] The documents are not copied: each collection is moved by `renameCollection`.
- [ ] A name that exists on the connection is refused in the input box.
- [ ] The open tabs of `shop`'s collections are closed; opened again from `store`, they have their columns and saved
  queries.
- [ ] (differs) The color given to `shop` is on `store`.

### `manage.drop-collection` — Drop a collection or a view

Drops a collection, with its documents and indexes, after the user types its name; or drops a view after a
confirmation.

- **Kind**: Operation
- **Function**: `src/manage.ts › Manager.dropCollection`
- **Implemented in**: `src/extension.ts` (command `mongoster.dropCollection`: closes the tabs, refreshes the tree);
  `src/manage.ts › Manager.typeToConfirm`; `src/collectionPanel.ts › CollectionPanel.close`.
- **Entry points**: `mongoster.dropCollection` (**Drop…**) in the context menu of a collection or a view.
- **Offered when**: `viewItem =~ /^(collection|view)$/`: not on read-only connections. Not in the Command Palette
  (`when: false`); with no argument it does nothing.
- **Asks**:
  - a collection: an input box **Drop Collection <database>.<collection>**, prompt `Deletes 1,234 documents and 2
    indexes. This cannot be undone. Type "<collection>" to confirm.`, placeholder the name, refusing anything else
    with `Type "<collection>" to confirm`;
  - a view: a modal warning `Drop view <database>.<view>?`, detail `The documents of its source collection are not
    affected.`, button `Drop`.
- **Reads**: a collection's `estimatedDocumentCount()` and `listIndexes()`; either is left out of the prompt when it
  fails (then the prompt starts at `This cannot be undone.`).
- **Writes**: `db(<database>).dropCollection(<name>)`.
- **Danger**: Destructive: every document and index of the collection, without a copy. For a view, Confirm: its
  definition is lost, its source collection's documents are not.
- **Read-only**: Refused on a read-only connection, with `The connection <name> is read-only.`, before asking anything.
- **Undo**: Cannot be undone: nothing is recorded. The prompt of a collection says `This cannot be undone.`; the
  confirmation of a view doesn't.
- **redis-oplog**: Not published.
- **After**: the references found for the database are forgotten; the collection tab of the dropped collection or view
  is closed; the tree is refreshed.
- **Refuses**: the error of MongoDB, in an error message.
- **Uses**: `manage.drop-database`.
- **Tested by**: *none*.

Acceptance:

- [ ] Dropping a collection asks to type its exact name; Escape or another text drops nothing.
- [ ] The prompt says how many documents and indexes are deleted: `Deletes 1 document and 1 index. This cannot be
  undone. Type "orders" to confirm.`
- [ ] Dropping a view asks with a modal warning, without typing.
- [ ] After the drop, the collection's tab is closed and the collection is gone from the tree.
- [ ] What stays: the recent and saved queries, the column layout and the expansions of the collection (a new
  collection with the same name finds them), its operations in the undo history (undoing one recreates the collection
  with the documents of that operation), the open documents in editor tabs, and other tabs on it.

### `manage.drop-database` — Drop a database

Drops a database with all its collections, after the user types its name.

- **Kind**: Operation
- **Function**: `src/manage.ts › Manager.dropDatabase`
- **Implemented in**: `src/extension.ts` (command `mongoster.dropDatabase`: closes the tabs, refreshes the tree);
  `src/manage.ts › Manager.typeToConfirm`; `src/collectionPanel.ts › CollectionPanel.close`; `src/gridfs.ts ›
  GridFSPanel.close`.
- **Entry points**: `mongoster.dropDatabase` (**Drop Database…**) in a database's context menu.
- **Offered when**: `viewItem == database`: not on read-only connections. Not in the Command Palette (`when: false`);
  with no argument it does nothing.
- **Asks**: an input box **Drop Database <database>**, prompt `Deletes 3 collections with all their documents. This
  cannot be undone. Type "<database>" to confirm.`, placeholder the name, refusing anything else with
  `Type "<database>" to confirm`.
- **Reads**: `listCollections({}, { nameOnly: true, authorizedCollections: true })`, leaving out `system.*`; when it
  fails, the prompt starts at `This cannot be undone.`
- **Writes**: `db(<database>).dropDatabase()`.
- **Danger**: Destructive: every collection, view, document and index of the database, without a copy.
- **Read-only**: Refused on a read-only connection, with `The connection <name> is read-only.`, before asking anything.
- **Undo**: Cannot be undone: nothing is recorded; the prompt says `This cannot be undone.`
- **redis-oplog**: Not published.
- **After**: the references found for the database are forgotten; the collection tabs and the GridFS tabs of the
  database are closed; the tree is refreshed.
- **Refuses**: the error of MongoDB, in an error message.
- **Uses**: `manage.drop-collection`.
- **Tested by**: *none*.

Acceptance:

- [ ] Dropping a database asks to type its exact name; Escape or another text drops nothing.
- [ ] The number in the prompt counts the collections and views of the database, without `system.*`.
- [ ] After the drop, every collection tab and GridFS tab of the database is closed and the database is gone from the
  tree.
- [ ] What stays: the recent and saved queries, layouts and expansions of its collections, their operations in the
  undo history, the open documents in editor tabs, and the other tabs on the database (watch, compare structure,
  relationship diagram).

### `manage.name-rules` — Valid names of databases and collections

The names Mongoster refuses while they are typed, before asking MongoDB, whose messages say less.

- **Kind**: Derivation
- **Function**: `src/manage.ts › databaseNameError`, `collectionNameError`
- **Implemented in**: the input boxes of `manage.create-database`, `manage.create-collection`,
  `manage.rename-collection`.
- **Inputs**: the name typed, trimmed.
- **Output**: the message shown under the input box, or none when the name is valid.
- **Rules**:
  - a database: empty → `Enter a name`; one of space, `/`, `\`, `.`, `"`, `$`, `*`, `<`, `>`, `:`, `|`, `?` or the NUL
    character → `A database name cannot contain spaces or / \ . " $ * < > : | ?`; more than 63 bytes (UTF-8) →
    `A database name is at most 63 bytes`;
  - a collection: empty → `Enter a name`; `$` or NUL → `A collection name cannot contain $`; starting with
    `system.` → `Names starting with "system." are reserved`; starting or ending with `.` →
    `A collection name cannot start or end with a dot`;
  - the rules are checked in that order; the checks against existing names come after them, in the cards that use
    them.
- **Uses**: `manage.create-database`, `manage.create-collection`, `manage.rename-collection`.
- **Tested by**: *none*.

Examples:

| Name | As | Message |
| --- | --- | --- |
| `shop` | database | none |
| `my shop` | database | `A database name cannot contain spaces or / \ . " $ * < > : \| ?` |
| 64 × `a` | database | `A database name is at most 63 bytes` |
| `orders.2024` | collection | none |
| `system.users` | collection | `Names starting with "system." are reserved` |
| `orders.` | collection | `A collection name cannot start or end with a dot` |
| `$orders` | collection | `A collection name cannot contain $` |

Acceptance:

- [ ] Each name of the examples gives its message.

### `manage.edit-view` — Edit a view's definition

Opens the source and the pipeline of a view as JSON in an editor tab; saving applies them to the view.

- **Kind**: Operation
- **Function**: `src/definitionFs.ts › DefinitionFileSystem.writeFile` (saving); `DefinitionFileSystem.open` and
  `readFile` (opening).
- **Implemented in**: `src/extension.ts` (command `mongoster.editView`, `definitionRef`, the `mongoster-def` file
  system and `onDidSave` → `CollectionPanel.refresh`); `src/shared/query.ts › parseQuery`, `relaxEjson`.
- **Entry points**: `mongoster.editView` (**Edit View Definition…**) in a view's context menu; `Ctrl+S` in the editor
  tab `mongoster-def://<connection id>/<database>/<view>/view.json`.
- **Offered when**: `viewItem =~ /^view/`, also on a read-only connection, where the tab opens read-only. Not in the
  Command Palette (`when: false`); with no argument it does nothing.
- **Reads**: `listCollections({ name: <view> })`: the view's `viewOn` and `pipeline`.
- **Writes**: `db(<database>).command({ collMod: <view>, viewOn, pipeline })`.
- **Danger**: None: saving applies at once, as a file is saved.
- **Read-only**: Refused on a read-only connection: the tab opens read-only, and a save is refused with
  `The connection is read-only`. (differs: see Differs)
- **Undo**: Cannot be undone: the definition before is not kept; nothing says so.
- **redis-oplog**: Not published.
- **After**: `Saved view <database>.<view>.`; the view's collection tab, when open, runs its query again.
- **Refuses**: text that isn't mongosh syntax → `Invalid definition: <error>`; not an object → `The definition must
  be a JSON object`; `viewOn` missing or empty → `viewOn: the name of the source collection or view`; `pipeline` not
  an array → `pipeline: an array of stages`; another field → `Unknown field <field>: a view has viewOn and pipeline`;
  an error of MongoDB → `Not applied: <error>`. The tab stays unsaved.
- **Tested by**: *none*.
- **Differs**: whether the tab is read-only is decided when it opens and written in its URI (`?ro=1`,
  `src/extension.ts:52-55`, `src/definitionFs.ts:42`); a save checks only that flag (`src/definitionFs.ts:103`), not
  the connection: a tab opened before the connection was made read-only still applies its changes.

Acceptance:

- [ ] The tab shows `{ "viewOn": "<source>", "pipeline": [ … ] }`, two-space indented, values as relaxed Extended
  JSON.
- [ ] Changing a `$match` of the pipeline and saving changes what the view returns, and its open tab shows it.
- [ ] Values may be written in mongosh syntax (`ISODate("…")`, `ObjectId("…")`); they are applied with their types.
- [ ] Each refusal above leaves the view as it was and says why.
- [ ] (differs) A save through a connection that is read-only now is refused, whenever the tab was opened.

### `manage.edit-validation` — Edit a collection's validation rules

Opens the validator, validation level and validation action of a collection as JSON in an editor tab; saving applies
them. A collection without rules gets a `$jsonSchema` generated from its documents, to review before saving.

- **Kind**: Operation
- **Function**: `src/definitionFs.ts › DefinitionFileSystem.writeFile` (saving); `DefinitionFileSystem.readFile` and
  `open` (opening, and the generated rules).
- **Implemented in**: `src/extension.ts` (command `mongoster.editValidation`, `definitionRef`, the `mongoster-def` file
  system and `onDidSave` → `CollectionPanel.refresh`); `src/collectionPanel.ts` (the `editValidation` message, with
  `readOnly` the connection's); `src/webview/main.ts` (the button); `src/shared/schema.ts › analyzeSchema`,
  `toJsonSchema`.
- **Entry points**: `mongoster.editValidation` (**Edit Validation Rules…**) in a collection's context menu; **Validation
  rules…** in the collection tab's `Schema` section (not on views); `Ctrl+S` in the editor tab
  `mongoster-def://<connection id>/<database>/<collection>/validation.json`.
- **Offered when**: `viewItem =~ /^collection/`, also on a read-only connection, where the tab opens read-only. Not in
  the Command Palette (`when: false`); with no argument it does nothing.
- **Reads**: `listCollections({ name: <collection> })`: its `validator`, `validationLevel`, `validationAction`. When the
  validator is missing or empty: `aggregate([{ $sample: { size: 1000 } }], { promoteValues: false, maxTimeMS: 60000 })`
  for `manage.generate-json-schema`.
- **Writes**: `db(<database>).command({ collMod: <collection>, validator, validationLevel, validationAction })`, with
  only the fields present in the file.
- **Danger**: None: saving applies at once, as a file is saved. The rules apply to later writes, not to the documents
  already there.
- **Read-only**: Refused on a read-only connection: the tab opens read-only, and a save is refused with
  `The connection is read-only`. (differs: see Differs)
- **Undo**: Cannot be undone: the rules before are not kept; nothing says so.
- **redis-oplog**: Not published.
- **After**: `Applied the validation rules of <database>.<collection>.`; the collection's tab, when open, runs its
  query again.
- **Refuses**: text that isn't mongosh syntax → `Invalid definition: <error>`; not an object → `The definition must
  be a JSON object`; a field other than the three → `Unknown field <field>: use validator, validationLevel,
  validationAction`; `validator` not an object → `validator must be an object ({} removes the rules)`; an error of
  MongoDB → `Not applied: <error>`. The tab stays unsaved.
- **Uses**: `manage.generate-json-schema`.
- **Tested by**: *none* (the generated schema: see `manage.generate-json-schema`).
- **Differs**: as `manage.edit-view`: read-only is the `?ro=1` of the tab's URI, set when it opened
  (`src/extension.ts:52-55`, `src/collectionPanel.ts:320`), and a save checks only that (`src/definitionFs.ts:103`).

Acceptance:

- [ ] A collection with rules shows `validator`, `validationLevel` (`strict` when unset) and `validationAction`
  (`error` when unset).
- [ ] A collection without rules shows a generated `$jsonSchema` with `validationLevel: "strict"` and
  `validationAction: "error"`, and Mongoster says `<collection> has no validation rules: this $jsonSchema was generated
  from 1,000 documents. Review it, then save (Ctrl+S) to apply it. validationAction "warn" only logs invalid
  documents.` (the number is the documents sampled: fewer in a smaller collection).
- [ ] An empty collection without rules shows `validator: {}` and no message.
- [ ] Saving `validator: {}` removes the rules.
- [ ] After saving rules with `validationAction: "error"`, an insert that breaks them is refused by MongoDB.
- [ ] Each refusal above leaves the rules as they were and says why.
- [ ] (differs) A save through a connection that is read-only now is refused, whenever the tab was opened.

### `manage.generate-json-schema` — The `$jsonSchema` proposed from a sample

The validation rules proposed for a collection without any: the BSON types seen for each field, nested and in arrays,
and as required the fields present in every document.

- **Kind**: Derivation
- **Function**: `src/shared/schema.ts › toJsonSchema`
- **Implemented in**: `src/shared/schema.ts › analyzeSchema` (the summary it starts from); `src/definitionFs.ts ›
  DefinitionFileSystem.readFile` (the sample of 1,000).
- **Inputs**: the summary of a sample of documents in canonical Extended JSON (`analyzeSchema`): for each field, the
  number of objects it could appear in (`of`), the number where it is present, `null` included (`count`), its BSON
  types by frequency, its sub-fields, the elements of its arrays.
- **Output**: `{ bsonType: "object", required?, properties }`.
- **Rules**:
  - each field is `{ bsonType: <type> }`, or `{ bsonType: [<types>] }` with several types, most frequent first, using
    MongoDB's aliases (`objectId`, `string`, `int`, `long`, `double`, `decimal`, `bool`, `date`, `null`, `binData`,
    `regex`, `timestamp`, …);
  - `required` lists the fields present in every object that could have them (`count === of`), `null` values counting
    as present; there is no `required` when none is;
  - a field with object values has `properties` (and `required`) of their sub-fields, merged across documents;
  - a field with array values has `items`, the schema of their elements; arrays that are always empty give no `items`;
  - no `additionalProperties`: fields not seen are allowed;
  - fields beyond the 500 first different keys of an object are not analyzed, so not in the schema.
- **Uses**: `manage.edit-validation`.
- **Tested by**: `test/unit/schema.test.ts › 'toJsonSchema' › 'requires the fields present in every document and lists
  their types'`, `› 'describes nested objects and array elements'`, `› 'has no required list when no field is always
  present'`, `› 'describes objects inside arrays'`.

Examples:

| Sample | Schema |
| --- | --- |
| `{ _id: 1, name: "a", age: 3 }`, `{ _id: 2, name: "b", age: "x" }`, `{ _id: 3, name: null }` | `required: ["_id", "name"]`; `_id: { bsonType: "int" }`, `name: { bsonType: ["string", "null"] }`, `age: { bsonType: ["int", "string"] }` |
| `{ a: { b: 1, c: true }, tags: ["x"] }`, `{ a: { b: 2 }, tags: [] }` | `a: { bsonType: "object", required: ["b"], properties: { b: int, c: bool } }`, `tags: { bsonType: "array", items: { bsonType: "string" } }` |
| `{ a: 1 }`, `{ b: 1 }` | no `required` |
| `{ items: [{ sku: "x", qty: 1 }, { sku: "y" }] }` | `items: { bsonType: "array", items: { bsonType: "object", required: ["sku"], properties: { sku: string, qty: int } } }` |

Acceptance:

- [ ] Each sample of the examples gives its schema.
- [ ] A schema generated from a collection and saved unchanged accepts every document of the sample.
