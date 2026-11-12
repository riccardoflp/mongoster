# Writing documents

Changing the documents of a collection from its tab and from editor tabs: editing a value in its cell, the document
dialog, editing and inserting in an editor tab, the insert dialog, duplicating, deleting one document or the selected
rows, **Update many** and **Delete many**, and putting a document back as it was in a version of its document
history. The user's side is in the README's [Features](../../README.md#features), under **Inline editing**, **JSON
document**, **Copying a document**, **Selecting rows**, **Editing**, **Insert**, **Duplicate / Delete**, **Update
many / Delete many** and **Document history**.

The collection tab is `CollectionPanel` in `src/collectionPanel.ts`, with `src/webview/main.ts` and the dialogs of
`src/webview/bulk.ts`, `src/webview/insertDialog.ts` and `src/webview/cellEditor.ts`; its messages are `WebviewMessage`
and `HostMessage` in `src/shared/messages.ts`. Editor tabs of documents are the `mongoster://` file system,
`DocumentFileSystem` in `src/documentFs.ts`. The document history tab is `DocumentHistoryPanel` in `src/docHistory.ts`.
Every write here follows [the write pipeline](../02-architecture.md#writing-to-a-database). A "collection that can be
changed" below is one that is neither a view nor a collection of a read-only connection (`CollectionTarget`), and
`readOnlyMessage` says why one can't: `The connection <name> is read-only.` or `Views are read-only.`

### `document.inline-edit` — Edit a value in its cell

Changes one value of one document from the table, in mongosh syntax, without opening the document.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.updateField`
- **Implemented in**: `src/webview/main.ts › editTarget`, `startEdit` (which cell, its path and value);
  `src/webview/cellEditor.ts › CellEditor` (the editor over the cell, its keys and hint); `src/shared/messages.ts`
  (`UpdateFieldRequest`, answered by `{ type: 'fieldResult', requestId, ok, message }`);
  `src/documentFs.ts › restoreTypes`; `src/shared/oplog.ts › updatedFields`.
- **Entry points**: double-click a cell, or `F2` on the selected cell, in the table of the collection tab.
- **Offered when**: in **Find**, on a collection that can be changed, on a row whose document has an
  `_id`, on any cell but `_id` and its sub-fields, a `… N more` cell or a filler. An empty cell edits a missing field;
  a cell of an expanded array edits that element (`items.2.qty`). A double-click where editing isn't possible opens the
  document dialog (`document.dialog`).
- **Asks**: the new value, in the editor over the cell: the current value in mongosh syntax (a string with the inside
  of its quotes selected; an object or array formatted), with the hint `Enter to save · Shift+Enter new line · Esc to
  cancel`. Text that doesn't parse shows the parser's error in place of the hint and is not sent. If the value in the
  database is no longer the one shown, a modal `<path> was changed to <value> in the database after it was loaded.
  Overwrite it?` (or `<path> was removed in the database after it was loaded. Overwrite it?`), button **Overwrite**.
- **Reads**: the document by `_id`, only its top-level field, with `promoteValues: false`.
- **Writes**: `updateOne({ _id: <id>, <path>: <value read> }, { $set: { <path>: <new value> } })`, with
  `{ <path>: { $exists: false } }` in the filter when the field was missing: the write applies only if the value is
  still the one read.
- **Danger**: None: one value, saved by an explicit `Enter`; a click elsewhere cancels.
- **Read-only**: Refused on a view and on a read-only connection: the editor doesn't open, and a message sent anyway
  is answered with `readOnlyMessage` under the editor.
- **Undo**: Recorded in the undo history (`undo.record`) as `Edit <path> of <id>`, with the document as it was.
- **redis-oplog**: Published (`oplog.publish`): an update of the document with the fields of the `$set`, cut at an
  array position (`items.2.qty` → `items`), only when the document was modified.
- **After**: the editor closes and the tab runs its query again; the row and cell stay selected.
- **Refuses**: `_id cannot be changed.`; `Document not found: it may have been deleted.`; `Not saved: the value changed
  in the database.` when the overwrite is declined (and the tab refreshes); `<path> changed again in the database:
  refresh and retry.` when the conditional update matched nothing. MongoDB's errors are shown under the editor, which
  stays open.
- **Uses**: `document.keep-numeric-types`, `undo.record`, `oplog.publish`, `connection.read-only`.
- **Tested by**: *none*.

Acceptance:

- [ ] Double-clicking `qty` of a document, typing `5` and `Enter` sets `qty` to 5 and the table shows it.
- [ ] A `Double` field edited to `6` stays a `Double`; a `Long` field edited to `7` stays a `Long`; `NumberLong(8)` on
  an `Int32` field makes it a `Long`.
- [ ] Editing an empty cell adds the field to that document only.
- [ ] Editing `items[].qty` of the third element sets `items.2.qty` and leaves the other elements as they were.
- [ ] `Esc`, or a click outside the editor, writes nothing.
- [ ] `Shift+Enter` adds a new line instead of saving.
- [ ] When another client changed the value after the table was loaded, saving asks `qty was changed to 9 in the
  database after it was loaded. Overwrite it?`; declining writes nothing and says `Not saved: the value changed in the
  database.`
- [ ] Cells of `_id` and of rows without `_id` don't open the editor; in **Aggregate**, on a view and on a read-only
  connection no cell does.
- [ ] The edit is in the undo history as `Edit qty of <id>`, and undoing it puts the old value back.
- [ ] On a connection that publishes to redis-oplog, the edit publishes `{ e: 'u', d: { _id }, f: ['qty'] }`.

### `document.keep-numeric-types` — Keep the numeric type of an edited value

A number typed as plain text can't say whether it is an `Int32`, a `Double` or a `Long`; the value keeps the type it
had in the database, unless the user wrote another type explicitly.

- **Kind**: Derivation
- **Function**: `src/documentFs.ts › restoreTypes(next, prev)`
- **Implemented in**: used by `CollectionPanel.updateField` (`document.inline-edit`) with the value read from the
  database, and by `DocumentFileSystem.writeFile` (`document.edit-in-editor`) with the document as it was opened.
- **Tested by**: *none*.
- **Differs**: only a `Long` counts as an explicit type (`src/documentFs.ts:243`), and a plain integer beyond 32 bits
  is already a `Long` when parsed: typing `5000000000` in a `Double` field makes it a `Long`, and `NumberInt(5)` in a
  `Double` field gives a `Double`. The README says numeric types stay the original ones and that `NumberLong(…)` and
  similar force a type.

Inputs: `next`, the value parsed from the user's text (BSON values: a plain integer is an `Int32`, or a `Long` beyond
32 bits; a decimal number is a `Double`; `NumberLong(…)` is a `Long`, `NumberInt(…)` an `Int32`); `prev`, the value as
stored, read with `promoteValues: false`, or `undefined`.

Rules:

1. When both are numbers of the types `Int32`, `Double` or `Long`:
   - a `Long` in `next` is kept: `NumberLong(…)` is an explicit choice;
   - when `next` reads the same as `prev` (`String(next) === String(prev)`), `prev` is returned unchanged;
   - when `prev` is a `Double`, the result is a `Double` of the new value;
   - when `prev` is a `Long` and the new value is a safe integer, the result is a `Long`;
   - otherwise `next`.
2. An array is restored element by element, each against the element at the same index of `prev`.
3. A plain object is restored field by field, each against the field of the same name in `prev`.
4. Anything else (strings, dates, `Decimal128`, a `prev` that isn't a number) is `next`.

Examples:

| `prev` | text typed | result |
| --- | --- | --- |
| `Double(5.5)` | `6` | `Double(6)` |
| `Long(5)` | `7` | `Long(7)` |
| `Int32(1)` | `1.5` | `Double(1.5)` |
| `Int32(1)` | `NumberLong(2)` | `Long(2)` |
| `"5"` | `5` | `Int32(5)` |
| `{ a: Double(1), b: [Long(2)] }` | `{ a: 2, b: [3], c: 4 }` | `{ a: Double(2), b: [Long(3)], c: Int32(4) }` |

Acceptance:

- [ ] Each row of the table above gives its result.
- [ ] A value that isn't changed keeps its exact BSON value, whatever its type.
- [ ] (differs) `5000000000` typed in a `Double` field gives `Double(5000000000)`.
- [ ] (differs) `NumberInt(5)` typed in a `Double` field gives `Int32(5)`.

### `document.dialog` — The document dialog

Shows one document of the table as an expandable tree, and offers what can be done with it.

- **Kind**: View
- **Function**: `src/webview/main.ts › openDocument`
- **Implemented in**: `src/webview/main.ts › jsonNode`, `closeDocument`, the buttons' listeners; the dialog's HTML in
  `src/collectionPanel.ts › CollectionPanel.html` (`#modal`); `media/webview.css` (`body.mode-aggregate .doc-write`).
- **Entry points**: click the row number, `Enter` on the selected cell, or **Open document** in a row's right-click
  menu; a double-click on a cell that can't be edited in place.
- **Offered when**: always, in **Find** and **Aggregate**.
- **Reads**: nothing: the document as the table has it (relaxed EJSON, with the query's projection).

The title is `Document <n> · <_id>` (`n` counts from the first row of the query, across pages). The tree opens down to
three levels; a container shows `<n> fields` or `<n> items` when folded. `‹` / `›` and `↑` / `↓` (also `←` / `→`)
move to the previous and next document of the page, `⊞` / `⊟` expand and collapse everything, `Esc`, `✕` or a click
outside close it. **Copy ▾** opens the copy formats. **History…** opens the document history (not on a view).
**Duplicate** is `document.duplicate`, **Delete** is `document.delete`, **Edit** is `document.edit-in-editor`.
**History…**, **Duplicate**, **Delete** and **Edit** are hidden in **Aggregate**; **Duplicate** and **Delete** are
hidden on a view and on a read-only connection; **Edit**, **Delete** and **History…** are disabled on a document
without `_id`, with the tooltip `Not available: the document has no _id (excluded by the projection?)`.

- **Uses**: `document.edit-in-editor`, `document.duplicate`, `document.delete`, `document.restore-version`.
- **Tested by**: *none*.

Acceptance:

- [ ] Clicking the row number of the third row of the second page of 50 opens `Document 53 · <_id>`.
- [ ] `↓` shows the next document; on the last document of the page `›` is disabled.
- [ ] Sub-documents deeper than three levels are folded, and `⊞` unfolds them.
- [ ] With a projection that leaves out `_id`, **Edit**, **Delete** and **History…** are disabled with the tooltip
  above.
- [ ] On a read-only connection the dialog has no **Duplicate** and no **Delete**, and **Edit** opens the document
  read-only.

### `document.edit-in-editor` — Edit a document in an editor tab

Opens a document as JSON in an editor tab; saving it (`Ctrl+S`) replaces the document in MongoDB.

- **Kind**: Operation
- **Function**: `src/documentFs.ts › DocumentFileSystem.writeFile` (saving); `DocumentFileSystem.open` and
  `readFile` (opening).
- **Implemented in**: `src/collectionPanel.ts › CollectionPanel.onMessage` (`editDocument`); `src/webview/main.ts`
  (**Edit** of the document dialog); `src/extension.ts` (registers the `mongoster` file system, and refreshes the
  collection tab on `onDidSave`); `src/documentFs.ts › restoreTypes`, `formatDocument`, `byId`;
  `src/shared/oplog.ts › documentFields`; `src/connectionColors.ts › ConnectionDecorations` (the tab name's color).
- **Entry points**: **Edit** in the document dialog (`document.dialog`); **Open Document** in the document history
  tab; `Ctrl+S` in the editor tab.
- **Offered when**: the document has an `_id`; in **Find**. On a view or a read-only connection the tab opens
  read-only.
- **Asks**: nothing to open. On saving, when the document changed in the database since it was opened, a modal
  `This document was changed in the database after you opened it.` with the detail `Overwrite replaces those changes
  with yours. Revert the file to load the latest version instead.`, button **Overwrite**; when it was deleted, a modal
  `This document was deleted from the database after you opened it.`, button **Insert Again**.
- **Reads**: the document by `_id` with `promoteValues: false` when the tab opens (shown as relaxed Extended JSON,
  indented by two spaces), and again before saving, to compare it with the one opened.
- **Writes**: `replaceOne({ _id }, <document>)`; after **Insert Again**, `insertOne(<document with the same _id>)`.
  The URI is `mongoster://<connection id>/<database>/<collection>/<_id>.json?id=<canonical EJSON of { _id }>`, with
  `&ro=1` when the tab is read-only.
- **Danger**: Confirm, only when the document changed or was deleted in the database meanwhile (texts above).
- **Read-only**: Refused on a view and on a read-only connection: the tab is read-only, and a save is refused with
  `Read-only: a view, or a read-only connection`. (differs: decided when the tab opens)
- **Undo**: Recorded in the undo history (`undo.record`) as `Edit document <_id>`, with the document as it was (a
  document inserted again is recorded as new).
- **redis-oplog**: Published (`oplog.publish`): an update with every field of the document before and after (but
  `_id`), only when it was modified; an insert after **Insert Again**.
- **After**: the tab reads the document again; the open collection tab of the collection runs its query again. No
  message.
- **Refuses**: `Invalid document: <parser error>`; `A document must be a JSON object`; `_id cannot be changed. Use
  Duplicate to create a copy with a new _id.`; `Save cancelled: the document changed in the database.` and `Save
  cancelled: the document no longer exists.` when the modal is closed. The text stays in the tab, unsaved.
- **Settings**: `mongoster.history.*` (whether the edit is recorded).
- **Uses**: `document.keep-numeric-types`, `undo.record`, `oplog.publish`, `connection.read-only`.
- **Tested by**: *none*.
- **Differs**: the read-only state is taken from the URI written when the tab was opened (`src/documentFs.ts:50`,
  `:84`, `:173`): a document opened before **Make Read-Only** still saves through the connection, and one opened on a
  read-only connection stays read-only after **Allow Changes** until it is opened again.

Acceptance:

- [ ] **Edit** opens a tab named after the `_id` beside the collection tab, with the document as indented JSON.
- [ ] Changing `status` and saving replaces the document; the collection tab shows the new value.
- [ ] A field that was a `Long` or a `Double` keeps its type when its number changes; `NumberLong(…)` forces a
  `Long`; `ObjectId(…)` and `ISODate(…)` are accepted.
- [ ] Changing `_id` and saving is refused with `_id cannot be changed. Use Duplicate to create a copy with a new
  _id.`, and nothing is written.
- [ ] When another client changed the document after it was opened, saving asks **Overwrite**; closing the modal
  writes nothing.
- [ ] When the document was deleted meanwhile, saving asks **Insert Again**, which inserts it with the same `_id`.
- [ ] On a view or a read-only connection the tab can't be saved.
- [ ] (differs) After **Make Read-Only** on the connection, saving a document tab opened before is refused.
- [ ] The edit is in the undo history as `Edit document <_id>`, and undoing it puts the document back.
- [ ] On a connection that publishes to redis-oplog, saving publishes an update with the fields of the document.

### `document.insert` — Insert documents from the insert dialog

Inserts one or more documents typed or pasted in a dialog of the collection tab, without an editor tab.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.insertDocuments`
- **Implemented in**: `src/webview/insertDialog.ts › InsertDialog` (the dialog: count while typing, **Template**,
  **Keep open**, **Open in Editor**, the kept draft); `src/shared/formats.ts › parseDocuments`, `insertTemplate`;
  `src/extension.ts` (`mongoster.insertDocument`); `src/shared/messages.ts` (`{ type: 'insertDocuments', requestId,
  text }`, answered by `insertResult`; `showInsert`).
- **Entry points**: **Insert** in the toolbar of the collection tab (`Ctrl+Enter` or the dialog's **Insert** button
  inserts); the command `mongoster.insertDocument` (**Insert Document**), as `+` on a collection in the tree and in its
  context menu. Not in the Command Palette (`when: false`).
- **Offered when**: on a collection that can be changed: **Insert** is hidden on a view and on a read-only connection;
  the tree's entry is on collections (`viewItem == collection`).
- **Asks**: the documents, in the dialog `Insert into <collection>`: one document, an array, one document per line, or
  a pasted `db.<collection>.insertOne(…)` / `insertMany(…)`, in mongosh syntax or Extended JSON
  (`document.parse-insert-text`). While typing it says `<n> document(s) to insert` or the parser's error; the button
  reads `Insert <n> documents` for several. **Template** fills it from the collection's fields
  (`document.insert-template`). The dialog opens with the text left in it when it was last closed without inserting.
- **Reads**: nothing before writing.
- **Writes**: `insertOne(<document>)` for one document, `insertMany(<documents>)` (ordered) for several. Without
  `_id`, the driver gives each document an `ObjectId`.
- **Danger**: None.
- **Read-only**: Refused on a view and on a read-only connection: the command says `readOnlyMessage` with
  `showErrorMessage`, the button is hidden, and a message sent anyway is answered with `readOnlyMessage` in the dialog.
- **Undo**: Recorded in the undo history (`undo.record`) as `Insert document` or `Insert <n> documents`, with the
  `_id` of each inserted document.
- **redis-oplog**: Published (`oplog.publish`): an insert for each document inserted.
- **After**: the dialog closes and forgets its text, unless **Keep open** is checked: then it stays open with the text
  and says the result. A notification `Inserted document <_id> into <collection>.` or `Inserted <n> documents into
  <collection>.` with **Undo**; the tab runs its query again; `mongoster.refresh` refreshes the tree.
- **Refuses**: text that doesn't parse (the dialog shows the error and nothing is sent: `Enter a document, e.g. { name:
  "Ada" }` when empty). When one document is refused (duplicate key, validation), the ones before it stay inserted, the
  dialog says `Inserted <k> of <n> documents, then: <error>` and keeps the text, and the notification says `Inserted
  <k> of <n> documents into <collection>.`; when none was inserted it shows MongoDB's error. A duplicate `_id` adds `.
  Remove _id to insert a copy with a new one.`
- **Settings**: `mongoster.history.enabled`, `mongoster.history.maxDocumentsPerOperation`,
  `mongoster.history.maxOperationSizeMB` (whether the insert is recorded).
- **Uses**: `document.parse-insert-text`, `document.insert-template`, `document.insert-in-editor`, `undo.record`,
  `undo.limits`, `oplog.publish`, `connection.read-only`.
- **Tested by**: `test/unit/formats.test.ts › formatDocuments › 'writes %s text that the insert dialog reads back to
  the same documents'` (the parsing only).
- **Differs**: an insert that can't be recorded says nothing about it: with more documents than
  `mongoster.history.maxDocumentsPerOperation` (`UndoHistory.start` returns undefined,
  `src/collectionPanel.ts:421`), more than `mongoster.history.maxOperationSizeMB`, or the undo history off for the
  connection, the documents are inserted, the notification has no **Undo**, and nothing says why. The README says
  inserts can be undone.

Acceptance:

- [ ] `{ name: "Ada" }` and `Ctrl+Enter` inserts one document with a new `ObjectId` and says `Inserted document
  ObjectId("…") into people.`
- [ ] `[ { a: 1 }, { a: 2 } ]` shows `2 documents to insert`, the button `Insert 2 documents`, and inserts both with
  `insertMany`.
- [ ] Pasting what **Copy** gives as `mongosh`, `Extended JSON` or an `insertOne command` inserts the same documents
  with the same types.
- [ ] Inserting `{ _id: 1 }` where `_id` 1 exists says the duplicate key error followed by `. Remove _id to insert a
  copy with a new one.`, and the text stays in the dialog.
- [ ] Of `[ { _id: 5 }, { _id: 1 }, { _id: 6 } ]` with `_id` 1 existing, `_id` 5 is inserted and the dialog says
  `Inserted 1 of 3 documents, then: …`.
- [ ] With **Keep open** checked, the dialog stays open after inserting and says the result.
- [ ] Closing the dialog without inserting keeps its text for the next **Insert**.
- [ ] `+` on a collection of a read-only connection says `The connection <name> is read-only.` and opens nothing.
- [ ] The insert is in the undo history, and undoing it deletes the inserted documents.
- [ ] (differs) Inserting more documents than `mongoster.history.maxDocumentsPerOperation` says that the insert
  can't be undone.
- [ ] On a connection that publishes to redis-oplog, each inserted document publishes `{ e: 'i', d: { _id } }`.

### `document.parse-insert-text` — Read the documents of the insert dialog

Turns the text of the insert dialog into the documents to insert, accepting what Mongoster's copy formats and
mongoexport write.

- **Kind**: Derivation
- **Function**: `src/shared/formats.ts › parseDocuments(text)`
- **Implemented in**: `unwrapInsertCall`, `matchingClose` (same file); `src/shared/query.ts › parseQuery`.
- **Tested by**: `test/unit/formats.test.ts › formatDocuments › 'writes %s text that the insert dialog reads back to
  the same documents'`.

Input: the dialog's text. Output: the documents as relaxed EJSON objects, in order; or an error, whose message the
dialog shows.

Rules:

1. A whole `db.<name>.insertOne(…)`, `db.<name>.insertMany(…)`, `db.<name>.insert(…)`,
   `db.getCollection("…").insert…(…)` or `db["…"].insert…(…)` (with or without a final `;`) is replaced by its first
   argument; options after it (`{ ordered: false }`) are dropped.
2. The text is parsed as mongosh syntax (`parseQuery`). If that fails and the text has at least two non-empty lines,
   each of the form `{ … }` with an optional final comma, each line is parsed as one document (mongoexport's JSON
   Lines); otherwise the parser's error is the result.
3. An array gives its elements; anything else is one document.
4. Empty text: `Enter a document, e.g. { name: "Ada" }`. An empty array: `The array is empty: add the documents to
   insert`. An element that isn't a plain object, or is an Extended JSON value such as `{ $oid: … }`:
   `Item <i> is not a document: each must be an object { … }` (several) or `A document must be an object { … }` (one).

Examples:

| Text | Result |
| --- | --- |
| `{ name: "Ada" }` | one document |
| `[ { a: 1 }, { a: 2 } ]` | two documents |
| `{"a":1}` and `{"a":2}` on two lines | two documents |
| `db.people.insertMany([ { a: 1 } ], { ordered: false })` | one document `{ a: 1 }` |
| `[ { a: 1 }, 2 ]` | `Item 2 is not a document: each must be an object { … }` |
| `{ $oid: "65a1b2c3d4e5f60718293a4b" }` | `A document must be an object { … }` |

Acceptance:

- [ ] Each row of the table above gives its result.
- [ ] Text written by `formatDocuments` as `shell`, `ejson`, `jsonl` or `insert` reads back to the same documents,
  `Int32`, `Long`, `Decimal128` and `ObjectId` included.

### `document.insert-template` — Template of the insert dialog

Starts the insert dialog from a document shaped like most of the collection's.

- **Kind**: Derivation
- **Function**: `src/shared/formats.ts › insertTemplate(fields)`
- **Implemented in**: `src/webview/insertDialog.ts` (**Template**, titled `Start from the fields most documents of the
  collection have`); the fields come from `src/collectionPanel.ts › CollectionPanel.loadFields` (a `$sample` of 500
  documents, `fieldHints` of `src/shared/complete.ts`).
- **Tested by**: *none*.

Input: the sampled fields, each with its path, its types (most frequent first) and the share of documents that have
it. Output: mongosh text.

Rules:

1. Only top-level fields (no `.` in the path), not `_id`, present in at least half of the documents (`ratio >= 0.5`),
   at most 30, in the order given.
2. Each gets an empty value of its most frequent type: `""` for `string`, `0` for `int`, `double`, `long` and
   `decimal`, `false` for `bool`, `ISODate()` for `date` (the time of the insert), `{}` for `object`, `[]` for
   `array`, `null` for any other type.
3. No such field: `{\n  \n}`, the empty document.

Example: fields `_id` (objectId, 1), `name` (string, 1), `age` (int, 0.9), `address.city` (string, 0.8), `nickname`
(string, 0.2), `createdAt` (date, 1) → `{ name: "", age: 0, createdAt: ISODate() }`, formatted on several lines.

Acceptance:

- [ ] The example above gives those three fields, without `_id`, `address.city` and `nickname`.
- [ ] A collection without fields in half of its documents gives the empty document.

### `document.insert-in-editor` — Insert a document from an editor tab

Moves the text of the insert dialog to an editor tab; saving the tab inserts it.

- **Kind**: Operation
- **Function**: `src/documentFs.ts › DocumentFileSystem.writeFile` (a new document); `DocumentFileSystem.openNew`
  (opening).
- **Implemented in**: `src/webview/insertDialog.ts` (**Open in Editor**); `src/collectionPanel.ts ›
  CollectionPanel.onMessage` (`insertInEditor`); `src/shared/messages.ts` (`{ type: 'insertInEditor', text }`).
- **Entry points**: **Open in Editor** in the insert dialog; `Ctrl+S` in the tab.
- **Offered when**: the dialog holds at most one document; with several the button is disabled, with the tooltip `An
  editor tab inserts one document: use Insert for several`.
- **Asks**: nothing.
- **Reads**: nothing before inserting.
- **Writes**: `insertOne(<document>)`. The tab is `mongoster://<connection id>/<database>/<collection>/new-<n>.json?new=1`
  and starts with the dialog's text, or the empty document.
- **Danger**: None.
- **Read-only**: Refused on a view and on a read-only connection: **Open in Editor** answers with `readOnlyMessage`,
  and a tab opened before the connection became read-only refuses to save with `Read-only: a view, or a read-only
  connection`.
- **Undo**: Recorded in the undo history (`undo.record`) as `Insert document`.
- **redis-oplog**: Published (`oplog.publish`): an insert.
- **After**: `Inserted document <_id>`; the tab stays open on the inserted document, and saving it again replaces it
  (`document.edit-in-editor`); the open collection tab runs its query again.
- **Refuses**: `Invalid document: <parser error>`; `A document must be a JSON object` (an array, for one).
- **Uses**: `document.insert`, `document.edit-in-editor`, `document.keep-numeric-types`, `undo.record`,
  `oplog.publish`.
- **Tested by**: *none*.

Acceptance:

- [ ] **Open in Editor** with `{ name: "Ada" }` opens `new-1.json` with that text and closes the dialog.
- [ ] Saving the tab inserts the document and says `Inserted document ObjectId("…")`; saving it again changes that
  document and inserts no other.
- [ ] With two documents in the dialog, **Open in Editor** is disabled.
- [ ] The insert is in the undo history and, on a connection that publishes, published as an insert.

### `document.duplicate` — Duplicate a document

Opens the insert dialog with a copy of a document without its `_id`, to insert it as a new one.

- **Kind**: View
- **Function**: `src/webview/main.ts › duplicate`
- **Implemented in**: `src/webview/insertDialog.ts › InsertDialog.open`; the document dialog's **Duplicate** and the
  row menu's **Duplicate…** in `src/webview/main.ts`.
- **Entry points**: **Duplicate** in the document dialog (tooltip `Insert a copy without _id`); **Duplicate…** in the
  right-click menu of a row.
- **Offered when**: in **Find**, on a collection that can be changed.
- **Writes**: nothing by itself: **Insert** in the dialog does (`document.insert`).
- **Uses**: `document.insert`.
- **Tested by**: *none*.
- **Differs**: the copy is the document as the table holds it (`src/webview/main.ts:1006-1010`): relaxed values, with
  the query's projection. A `Double` with an integral value (`5.0`) or a `Long` in the safe integer range becomes a
  plain number and is inserted as an `Int32`, and the fields the projection leaves out are not copied. The product
  promises that a copied value keeps its BSON type.

Acceptance:

- [ ] **Duplicate** closes the document dialog and opens `Insert into <collection>` with the document in mongosh
  syntax, indented by two spaces, without `_id`.
- [ ] Inserting it gives a new document with a new `_id` and the same fields.
- [ ] (differs) A `Double` field of value `5.0` and a `Long` field of value `7` are a `Double` and a `Long` in the
  copy.
- [ ] (differs) With a projection in the query, the copy still has every field of the document.
- [ ] On a view, on a read-only connection and in **Aggregate** there is no **Duplicate**.

### `document.delete` — Delete a document

Deletes one document after a confirmation.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.deleteDocument`
- **Implemented in**: `src/webview/main.ts` (the dialog's **Delete**, the row menu's **Delete document**, the `Delete`
  key, `deleteRows` for a selection of one); `src/shared/messages.ts` (`{ type: 'deleteDocument', id }`).
- **Entry points**: **Delete** in the document dialog; **Delete document** in the right-click menu of a row; the
  `Delete` key on a selected cell, or while one row is selected.
- **Offered when**: in **Find**, on a collection that can be changed, on a document with an `_id`.
- **Asks**: a modal `Delete document <_id> from <collection>?`, button **Delete**.
- **Reads**: the document, for the undo history.
- **Writes**: `deleteOne({ _id })`.
- **Danger**: Destructive: the document is gone. Confirm: the text above.
- **Read-only**: Refused on a view and on a read-only connection, with `readOnlyMessage` (`showErrorMessage`).
- **Undo**: Recorded in the undo history (`undo.record`) as `Delete document <_id>`, with the document. (differs: the
  confirmation doesn't say whether it can be undone)
- **redis-oplog**: Published (`oplog.publish`): a removal, when a document was deleted.
- **After**: `Deleted document <_id> from <collection>.` with **Undo**, only when the delete was recorded; the tab
  runs its query again.
- **Refuses**: `Document not found: it may have been deleted already.` (a warning) when nothing was deleted; `Delete
  failed: <error>`.
- **Settings**: `mongoster.history.enabled`, `mongoster.history.maxOperationSizeMB`.
- **Uses**: `undo.record`, `oplog.publish`, `connection.read-only`.
- **Tested by**: *none*.
- **Differs**: the confirmation has no detail (`src/collectionPanel.ts:460-464`): it doesn't carry
  `UndoHistory.note`, so with the undo history off for the connection nothing says the delete can't be undone, and
  afterwards no message is shown at all.

Acceptance:

- [ ] **Delete** in the document dialog asks `Delete document 7 from people?`; **Delete** removes the document and the
  table no longer shows it.
- [ ] Closing the confirmation deletes nothing.
- [ ] (differs) The confirmation says `It can be undone from the Undo History.`, or why it can't be undone.
- [ ] A document deleted meanwhile by another client gives `Document not found: it may have been deleted already.`
- [ ] The `Delete` key on a cell asks the same confirmation; in **Aggregate**, on a view and on a read-only connection
  it does nothing.
- [ ] After the delete, **Undo** in the notification puts the document back with the same `_id`.
- [ ] On a connection that publishes to redis-oplog, the delete publishes `{ e: 'r', d: { _id } }`.

### `document.delete-selected` — Delete the selected rows

Deletes the documents of the rows selected in the table, after one confirmation.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.deleteDocuments`
- **Implemented in**: `CollectionPanel.writeMany` (the write, the undo history, redis-oplog); `src/webview/main.ts ›
  selectionItems`, `selectionKey`, `deleteRows`, `canWriteRows`; `src/shared/messages.ts` (`{ type:
  'deleteDocuments', ids }`).
- **Entry points**: **Delete <n> documents…** (tooltip `After a confirmation (Delete)`) in the right-click menu of a
  selected row; the `Delete` key while rows are selected. A selection of one row is `document.delete`.
- **Offered when**: in **Find**, on a collection that can be changed, when every selected document has an `_id`.
- **Asks**: a modal `Delete <n> documents from <collection>?` with the detail `The <n> documents selected in the
  table. <undo note>`, button **Delete**. When the documents are more than the undo history keeps, a second modal
  `Delete without the possibility to undo?` with the detail `The documents matching the filter are <more than 10,000
  documents | more than 20 MB>: too many for the undo history (settings mongoster.history).`, button **Delete Without
  Undo**.
- **Reads**: the documents, for the undo history; their `_id`s for redis-oplog.
- **Writes**: `deleteMany({ _id: { $in: [<ids>] } })`.
- **Danger**: Destructive: the documents are gone. Confirm: the texts above.
- **Read-only**: Refused on a view and on a read-only connection, with `readOnlyMessage`.
- **Undo**: Recorded in the undo history (`undo.record`) as `Delete <n> documents <id>, <id>, …` (cut at 300
  characters), up to `mongoster.history.maxDocumentsPerOperation` documents; the confirmation says when it can't be.
- **redis-oplog**: Published (`oplog.publish`): a removal for each document deleted.
- **After**: `Deleted <n> documents from <collection>.`, or `Deleted <k> of <n> documents from <collection>: the others
  were already gone.`, with **Undo** when recorded; the tab runs its query again (the selection is kept by `_id`);
  `mongoster.refresh` refreshes the tree.
- **Refuses**: `Delete failed: <error>`.
- **Settings**: `mongoster.history.*`.
- **Uses**: `document.delete`, `undo.record`, `undo.limits`, `oplog.publish`, `connection.read-only`.
- **Tested by**: *none*.

Acceptance:

- [ ] With three rows selected, `Delete` asks `Delete 3 documents from people?` with `The 3 documents selected in the
  table. It can be undone from the Undo History.`; **Delete** removes the three.
- [ ] A sub-row of an expanded array deletes its document once.
- [ ] When one of the three was deleted meanwhile, the result says `Deleted 2 of 3 documents from people: the others
  were already gone.`
- [ ] In **Aggregate**, on a view and on a read-only connection the menu has no **Delete 3 documents…** and `Delete`
  deletes nothing.
- [ ] **Undo** puts the three documents back.
- [ ] On a connection that publishes to redis-oplog, each deleted document publishes a removal.

### `document.update-selected` — Update the selected rows

Opens **Update many** on exactly the documents selected in the table.

- **Kind**: View
- **Function**: `src/webview/main.ts › selectionItems` (the entry **Update <n> documents…**, tooltip `Update many,
  with the filter on their _id`)
- **Implemented in**: `src/webview/main.ts › idFilter`, `canWriteRows`; `src/webview/bulk.ts › BulkDialog.open`.
- **Entry points**: **Update <n> documents…** in the right-click menu of a selected row, when more than one row is
  selected.
- **Offered when**: in **Find**, on a collection that can be changed, when every selected document has an `_id`.
- **Writes**: nothing by itself: the dialog's **Update** does (`document.update-many`), with the filter `{ _id: { $in:
  [<ids>] } }` in mongosh syntax.
- **Uses**: `document.update-many`.
- **Tested by**: *none*.

Acceptance:

- [ ] With rows 2, 3 and 5 selected, **Update 3 documents…** opens `Update many · <collection>` showing `{ _id: { $in:
  [ … ] } }` and `3 documents match the filter.`
- [ ] Applying `{ $set: { status: "archived" } }` changes those three documents only, whatever the tab's filter is.

### `document.update-many` — Update many

Applies update operators or an update pipeline to every document matching the filter.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.bulkApply` (with `op: 'update'`)
- **Implemented in**: `CollectionPanel.writeMany` (undo history, redis-oplog, the write); `confirmEmptyFilter`;
  `src/queries.ts › toUpdate`, `toBson`; `src/webview/bulk.ts › BulkDialog`; `src/webview/main.ts › openBulk`;
  `src/shared/messages.ts` (`bulkCount`, `BulkRequest`, `bulkResult`).
- **Entry points**: **Update many…** next to **Explain** in **Find** (tooltip `Update every document matching the
  filter`); **Update <n> documents…** on selected rows (`document.update-selected`). `Ctrl+Enter` in the dialog
  applies.
- **Offered when**: in **Find**, not in the **Schema** and **Chart** tabs, on a collection that can be changed (hidden
  on a view and on a read-only connection). The filter must parse: otherwise `Invalid query syntax — check the
  highlighted field.` and no dialog. When the filter differs from the last query run, the query runs first so that the
  table shows the documents concerned.
- **Asks**: the dialog `Update many · <collection>`: the filter (or `{ }  — no filter: every document of the
  collection`), `Counting matching documents…` then `<n> documents match the filter.` (`1 document matches the
  filter.`, `No documents match the filter.`), and the update, written as operators (`{ $set: { status: "archived" },
  $inc: { version: 1 } }`) or a pipeline (`[ { $set: … } ]`). The button reads `Update <n> documents` and is disabled
  when nothing matches. With an empty filter, a modal `Update all <n> documents of <collection>?` with the detail `The
  filter is empty, so every document of the collection is affected.`, button **Update All**. When the documents are
  more than the undo history keeps, a modal `Update without the possibility to undo?` with the detail `The documents
  matching the filter are <more than 10,000 documents | more than 20 MB>: too many for the undo history (settings
  mongoster.history).`, button **Update Without Undo**.
- **Reads**: `countDocuments(<filter>)` for the dialog; the matching documents, for the undo history; their `_id`s for
  redis-oplog.
- **Writes**: `updateMany(<filter>, <update>)`.
- **Danger**: Confirm: the dialog with the count; the empty-filter and no-undo modals above.
- **Read-only**: Refused on a view and on a read-only connection: the button is hidden, and a message sent anyway is
  answered in the dialog with `readOnlyMessage`.
- **Undo**: Recorded in the undo history (`undo.record`) as `Update many <filter> with <update>` (on one line, cut at
  300 characters), up to `mongoster.history.maxDocumentsPerOperation` documents and
  `mongoster.history.maxOperationSizeMB`. (differs: the dialog doesn't say when it can't be undone)
- **redis-oplog**: Published (`oplog.publish`): an update of each matched document with the fields of the update
  (`oplog.updated-fields`), or, for a pipeline whose fields aren't known, every field of each document as it is after
  the update; nothing when no document was modified.
- **After**: the dialog closes; `Updated <collection>: <m> matched, <k> modified.` with **Undo** when recorded; the
  tab runs its query again; `mongoster.refresh` refreshes the tree.
- **Refuses**: in the dialog: `Enter the changes, e.g. { $set: { field: "value" } }` (empty, before sending); `Update:
  use update operators like { $set: { field: "value" } } (a plain document would replace whole documents)`; `Update: a
  pipeline is a list of stages like { $set: { … } }`; `Update: <parser error>`; `Filter: <parser error>`; MongoDB's
  error. Closing a modal leaves the dialog open with nothing written.
- **Settings**: `mongoster.history.enabled`, `mongoster.history.maxDocumentsPerOperation`,
  `mongoster.history.maxOperationSizeMB`.
- **Uses**: `undo.record`, `undo.limits`, `oplog.publish`, `oplog.updated-fields`, `connection.read-only`.
- **Tested by**: `test/unit/queries.test.ts › toUpdate › 'accepts update operators and keeps their types'`, `'accepts
  an update pipeline'`, `'rejects what is not an update'` (the update text only).
- **Differs**: the dialog and the host don't add `UndoHistory.note` (`src/collectionPanel.ts:654-682`,
  `src/webview/bulk.ts`): with the undo history off for the connection, or `mongoster.history.enabled` off, nothing
  says the update can't be undone. Only the case of too many documents is said, by the second modal.

Acceptance:

- [ ] With the filter `{ status: "new" }` matching 12 documents, the dialog says `12 documents match the filter.` and
  the button `Update 12 documents`.
- [ ] `{ $set: { status: "archived" } }` changes the 12 documents and says `Updated orders: 12 matched, 12 modified.`
- [ ] `[ { $set: { total: { $add: ["$a", "$b"] } } } ]` is applied as an update pipeline.
- [ ] `{ status: "archived" }` is refused with the message on plain documents, and nothing is written.
- [ ] With an empty filter, **Update All** is asked after the dialog; declining writes nothing.
- [ ] With no matching document the button is disabled.
- [ ] (differs) With the undo history off for the connection, the dialog says the update can't be undone.
- [ ] Above `mongoster.history.maxDocumentsPerOperation` documents, **Update Without Undo** is asked; declining writes
  nothing.
- [ ] **Undo** in the notification puts the 12 documents back as they were.
- [ ] On a connection that publishes to redis-oplog, each modified document publishes `{ e: 'u', d: { _id }, f:
  ['status'] }`.
- [ ] On a view and on a read-only connection there is no **Update many…**.

### `document.delete-many` — Delete many

Deletes every document matching the filter.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.bulkApply` (with `op: 'delete'`)
- **Implemented in**: `CollectionPanel.writeMany`; `confirmEmptyFilter`; `src/queries.ts › toBson`;
  `src/webview/bulk.ts › BulkDialog`; `src/webview/main.ts › openBulk`; `src/shared/messages.ts`.
- **Entry points**: **Delete many…** next to **Explain** in **Find** (tooltip `Delete every document matching the
  filter`).
- **Offered when**: as `document.update-many`.
- **Asks**: the dialog `Delete many · <collection>` with the filter and the count, as `document.update-many`, without
  an update; the button reads `Delete <n> documents`. With an empty filter, a modal `Delete all <n> documents of
  <collection>?` with the detail `The filter is empty, so every document of the collection is affected.`, button
  **Delete All**. When the documents are more than the undo history keeps, a modal `Delete without the possibility to
  undo?`, button **Delete Without Undo**.
- **Reads**: `countDocuments(<filter>)` for the dialog; the matching documents, for the undo history; their `_id`s for
  redis-oplog.
- **Writes**: `deleteMany(<filter>)`.
- **Danger**: Destructive: the documents are gone. Confirm: the dialog with the count, and the modals above.
- **Read-only**: Refused on a view and on a read-only connection, as `document.update-many`.
- **Undo**: Recorded in the undo history (`undo.record`) as `Delete many <filter>`, within the same limits. (differs:
  the dialog doesn't say when it can't be undone)
- **redis-oplog**: Published (`oplog.publish`): a removal for each document deleted; when fewer were deleted than
  matched, only those gone.
- **After**: the dialog closes; `Deleted <n> documents from <collection>.` (`Deleted 1 document from …`) with **Undo**
  when recorded; the tab runs its query again; `mongoster.refresh` refreshes the tree.
- **Refuses**: `Filter: <parser error>`; MongoDB's error, in the dialog.
- **Settings**: `mongoster.history.enabled`, `mongoster.history.maxDocumentsPerOperation`,
  `mongoster.history.maxOperationSizeMB`.
- **Uses**: `document.update-many`, `undo.record`, `undo.limits`, `oplog.publish`, `connection.read-only`.
- **Tested by**: *none*.
- **Differs**: as `document.update-many`: no undo note in the dialog (`src/collectionPanel.ts:654-682`), so with the
  undo history off nothing says the delete can't be undone.

Acceptance:

- [ ] With the filter `{ status: "draft" }` matching 4 documents, the dialog says `4 documents match the filter.`;
  **Delete 4 documents** deletes them and says `Deleted 4 documents from orders.`
- [ ] With an empty filter, `Delete all <n> documents of orders?` is asked; declining deletes nothing.
- [ ] (differs) With the undo history off for the connection, the dialog says the delete can't be undone.
- [ ] **Undo** in the notification puts the 4 documents back with their `_id`s.
- [ ] On a connection that publishes to redis-oplog, each deleted document publishes a removal.
- [ ] On a view and on a read-only connection there is no **Delete many…**.

### `document.restore-version` — Restore a version from the document history

Puts a document back as it was in one of its versions in the document history, or inserts again a deleted one.

- **Kind**: Operation
- **Function**: `src/docHistory.ts › DocumentHistoryPanel.restore`
- **Implemented in**: `src/webview/docHistory.ts › restoreButton` (the buttons); `src/shared/messages.ts`
  (`{ type: 'restore', key }`, answered by `{ type: 'restored', ok, message }`); `src/shared/compare.ts › fieldDiff`
  (how many fields differ); `src/shared/docHistory.ts` (the versions and their `state`).
- **Entry points**: in the document history tab (opened by **History…** in the document dialog or a row's menu, or by
  `mongoster.documentHistory`, **Document History**, on a document's editor tab): **Restore this version…** under an
  open version, **Restore…** on a row of the list; **Insert again…** in their place when the document no longer
  exists.
- **Offered when**: on a version whose fields are all known (`state` `exact`), with its document, that isn't the
  current one. Disabled while the history loads and on a read-only connection, with the tooltip `The connection
  <name> is read-only.`
- **Asks**: a modal `Restore <_id> as of <date and time>?` with the detail `It replaces the document as it is now in
  <database>.<collection>: <n> fields differ.` and the undo note, button **Restore**; for a deleted document `Insert
  <_id> as of <date and time> again?` with `The document was deleted: it is inserted again in
  <database>.<collection>.` and the undo note, button **Insert Again**.
- **Reads**: the document as it is now (`promoteValues: false`), to count the fields that differ; again after the
  write, for redis-oplog.
- **Writes**: `replaceOne({ _id }, <version>)`, or `insertOne(<version>)` when the document was deleted.
- **Danger**: Confirm: the texts above; a restore replaces the current document.
- **Read-only**: Refused on a read-only connection: `The connection <name> is read-only: nothing can be restored
  through it.`
- **Undo**: Recorded in the undo history (`undo.record`) as `Restore <_id> as of <date and time>`; the confirmation
  carries `UndoHistory.note`.
- **redis-oplog**: Published (`oplog.publish`): the events of the document before and after (`oplog.changes`): an
  update with the fields that differ, or an insert.
- **After**: the tab says `Restored <_id> as of <date and time>.` or `Inserted <_id> as of <date and time> again.`; a
  notification with the same text and **Undo**; the collection tab runs its query again; `mongoster.refresh`; the
  history is read again.
- **Refuses**: `The connection no longer exists.`; `Only a version whose fields are all known can be restored.`; `The
  document is already as it was in this version.`; `Restore failed: The document was deleted meanwhile: restore again
  to insert it.`; `Restore failed: <error>`.
- **Settings**: `mongoster.history.*`.
- **Uses**: `undo.record`, `oplog.publish`, `oplog.changes`, `connection.read-only`.
- **Tested by**: *none*. (`test/integration/docHistory.test.ts › DocumentOplog` covers the versions it restores
  from, not the restore.)

Acceptance:

- [ ] On an exact version of a document changed since, **Restore this version…** asks `Restore 7 as of …?` with `…: 2
  fields differ.` and `It can be undone from the Undo History.`; **Restore** makes the document equal to that version,
  types included.
- [ ] On a deleted document, **Insert again…** inserts the version with its `_id`.
- [ ] A version marked `partial`, and the current version, have no button.
- [ ] Restoring a version equal to the current document says `The document is already as it was in this version.`
- [ ] Closing the confirmation writes nothing.
- [ ] On a read-only connection the buttons are disabled and a restore sent anyway is refused with the message above.
- [ ] The restore is in the undo history, and undoing it puts the document back as it was before the restore.
- [ ] On a connection that publishes to redis-oplog, the restore publishes an update with the fields that differ.
