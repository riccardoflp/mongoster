# Undo history

The undo history: what Mongoster keeps before a write to documents, the Undo History tab, undoing and redoing an
operation, the limits that keep the history small, and turning it off for one connection. The user's side is the
**Undo changes** entry of the [README's Features](../../README.md#features). The steps every write takes, of which
recording is the third, are in [Writing to a database](../02-architecture.md#writing-to-a-database).

### `undo.record` — Record an operation before a write

Before a write to documents, Mongoster keeps the documents it is about to change as they are, so that the write can be
undone later, also after restarting VS Code.

- **Kind**: Operation
- **Function**: `src/history.ts › UndoHistory.start`, then `Recorder.snapshot` / `Recorder.snapshotIds` /
  `Recorder.add` / `Recorder.addNew` before the write and `Recorder.commit` (which calls `UndoHistory.save`) after it.
- **Implemented in**: `src/shared/messages.ts` (`HistoryEntry`); the writes that record: `src/collectionPanel.ts`
  (insert, delete, inline edit, `writeMany` for Update many / Delete many, the selected rows and the column actions),
  `src/documentFs.ts` (editor saves), `src/docHistory.ts` (restore a version), `src/transfer.ts`
  (`insertDocuments`, import), `src/generate.ts`, `src/copy.ts`, `src/compare.ts` (Make like), `src/backup.ts`
  (restore with `Add documents`).
- **Entry points**: none of its own: every write listed under **Uses**.
- **Reads**: the documents the write will touch, with `find(filter, { promoteValues: false, bsonRegExp: true })` (or
  by `_id` in batches of 1,000 for `snapshotIds`), so that every value keeps its BSON type; after the write, the same
  documents again by `_id`, to keep a fingerprint of each.
- **Writes**: no database. Files under the extension's global storage, folder `history/`: one
  `<id>.json.gz` per operation (gzip of canonical Extended JSON `{ docs: [{ id, before, after }] }`, `before` being
  `null` for an inserted document and `after` the fingerprint of the document after the write, `null` when it no
  longer exists), and `index.json` with the list of operations, written to `index.json.tmp` and renamed.
- **Danger**: None.
- **Read-only**: Nothing is recorded through a read-only connection (`UndoHistory.recording` is false); the write
  itself is refused before, by the card of the write.
- **Undo**: Cannot be undone: it is what makes the other writes undoable. A recorded operation can be removed
  (`undo.remove`) or cleared (`undo.clear`).
- **After**: the Undo History tab, when open, shows the new operation (`onDidChange`); the write's result notification
  has `Undo` when an operation was recorded (`undo.notification`).
- **Settings**: `mongoster.history.enabled`, `mongoster.history.maxDocumentsPerOperation`,
  `mongoster.history.maxOperationSizeMB` (and the limits of `undo.limits`, applied right after the save).
- **Uses**: `undo.kept-documents`, `undo.limits`, `undo.per-connection`. Recorded by `document.insert`,
  `document.delete`, `document.inline-edit`, `document.edit-in-editor`, `document.update-many`,
  `document.delete-many`, `document.restore-version`, `field.rename`, `field.remove`, `field.convert-type`,
  `transfer.import`, `transfer.generate`, `transfer.copy-collection`, `compare.make-like`, `backup.restore`, and the
  undo itself (`undo.revert`).
- **Tested by**: *none*.
- **Differs**: (1) `UndoHistory.note` (`src/history.ts:217-222`) knows only the number of documents, so a
  confirmation says `It can be undone from the Undo History.` even when the documents turn out to take more than
  `mongoster.history.maxOperationSizeMB` while they are read. Update many, Delete many, the selected rows and the
  column actions then ask again (`src/collectionPanel.ts:697-704`); copy and generate say it only in the result after
  the write; `Make … like …` says nothing at all (`src/compare.ts:403-429`). (2) Each window of VS Code loads the list
  of operations once (`src/history.ts:239`, `286-294`) and writes the whole `index.json` at each save (`296-301`):
  with two windows open, the last one to save drops the other's operations from the index, and their files are deleted
  as orphans at the next start (`311-312`, `325-328`).

Acceptance:

- [ ] `UndoHistory.start` returns no recorder when `mongoster.history.enabled` is off, when the connection is unknown,
  read-only or has `Stop Keeping Undo History` on, or when the write announces more documents than
  `mongoster.history.maxDocumentsPerOperation` (default 10,000).
- [ ] The first image of a document wins: a document read twice in one operation keeps the value it had before the
  write.
- [ ] A document the write inserts is kept as its `_id` only.
- [ ] An operation of 10,000 documents is recorded; one of 10,001 is not, and its recorder's `overflow` is
  `more than 10,000 documents`.
- [ ] An operation whose documents take more than 20 MB (BSON size, before compression) is not recorded, and its
  recorder's `overflow` is `more than 20 MB`.
- [ ] The confirmation of a write says, from `UndoHistory.note`: `It can be undone from the Undo History.`; or
  `This can't be undone: the undo history keeps operations of up to 10,000 documents.`; or, with the history off
  globally or for the connection, `The undo history is off for this connection: this can't be undone.`
- [ ] (differs) When an operation is not recorded because its documents take more than 20 MB, its confirmation says it
  can't be undone.
- [ ] Documents the write left as they were (updated to the same values) are not kept (`undo.kept-documents`); a
  write that changed none records nothing and its notification has no `Undo`.
- [ ] The operation is listed with the time, connection, database, collection, label of the write and the numbers of
  documents inserted, updated and deleted, and the size of its compressed file.
- [ ] Labels name the write: `Insert document`, `Insert 3 documents`, `Delete document ObjectId("…")`,
  `Edit status of ObjectId("…")`, `Edit document ObjectId("…")`, `Update many { status: "old" } with { $set: … }`,
  `Delete many { … }` (cut to 300 characters), `Import <file>`, `Generate 100 documents like <collection>`,
  `Copy <connection> › <collection>`, `Make like <connection> › <database>.<collection>`.
- [ ] Not recorded: the playground, `$out` and `$merge`, indexes, users, GridFS files, dropping collections and
  databases, copying with `Drop and recreate`, restoring with `Drop and restore`, `Apply` of the structure comparison.
- [ ] When the file can't be written after the write, the write stays done and Mongoster warns `The change was made,
  but couldn't be saved in the undo history: <error>`.
- [ ] (differs) An operation recorded in one window of VS Code stays in the undo history when another window records
  one too.

### `undo.kept-documents` — Which documents an operation keeps

After the write, an operation keeps only the documents the write really changed, and counts them as inserted, updated
or deleted.

- **Kind**: Derivation
- **Function**: `src/history.ts › UndoHistory.save` (the filter and the counts at the top; no function of its own).
- **Implemented in**: `src/history.ts › Recorder.commit` (the fingerprints after the write), `fingerprint`.
- **Inputs**: the recorded documents `{ id, before, after }`: `before` the document as stored before the write (`null`
  when the write inserted it), `after` the fingerprint of the document read again after the write (`null` when it
  does not exist). A fingerprint is the SHA-1 of the document's BSON bytes, so the order of the fields and the numeric
  types count.
- **Output**: the documents kept, and `inserted`, `updated`, `deleted`.
- **Rules**:
  - a document with `before` is kept when `after` differs from the fingerprint of `before`;
  - a document without `before` is kept when `after` is not `null`;
  - `inserted` counts the kept documents without `before`; `deleted` those with `before` and `after` `null`;
    `updated` the others;
  - no document kept: no operation.
- **Uses**: `undo.record`.
- **Tested by**: *none*.

Examples:

| Write | Recorded | Kept |
| --- | --- | --- |
| `$set: { status: "b" }` on a document with `status: "a"` | before `{ status: "a" }`, after its new fingerprint | kept, updated |
| `$set: { status: "a" }` on a document already `"a"` | after equals the fingerprint of before | not kept |
| insert of a document that is then deleted before the commit | before `null`, after `null` | not kept |
| delete of a document | before the document, after `null` | kept, deleted |
| Update many matching 5, changing 3 | 5 recorded | 3 kept, `3 updated` |

An insert that fails on an existing `_id` is not given to the recorder by its writer (`insertDocuments` in
`src/transfer.ts` and the generator add only the inserts that succeeded): given, it would be kept as inserted, since
the document with that `_id` exists after the write, and undoing it would delete the document that was already there.

Acceptance:

- [ ] An Update many that matches 5 documents and modifies 3 records an operation with `3 updated`.
- [ ] An update that changes nothing records no operation, and its notification has no `Undo`.
- [ ] Replacing `{ a: 1, b: 2 }` with `{ b: 2, a: 1 }` counts as a change.
- [ ] Replacing an `Int32` `1` with a `Double` `1` counts as a change.

### `undo.show` — The Undo History tab

Lists the recorded operations, newest first, with what each one did and the space it takes; from here an operation is
undone, inspected or removed.

- **Kind**: View
- **Function**: `src/history.ts › HistoryPanel.show`
- **Implemented in**: `src/history.ts › HistoryPanel.receive`, `HistoryPanel.html`, `UndoHistory.list`,
  `UndoHistory.usage`; `src/webview/undoHistory.ts`; `media/undoHistory.css`, `media/monitor.css`;
  `src/shared/messages.ts` (`HistoryHostMessage`, `HistoryViewMessage`, `HistoryEntry`, `HistoryUsage`);
  `src/extension.ts` (command `mongoster.showHistory`, `WorkspaceHost.openHistory` for the MCP server).
- **Entry points**: `mongoster.showHistory` (**Show Undo History**): the clock icon in the connections view's title,
  the Command Palette; the MCP tool `open_history` (`mcp.server`).
- **Offered when**: always (`view == mongoster.connections` for the title button).
- **Reads**: the list of operations and the usage of the history (`UndoHistory.list`, `UndoHistory.usage`), with each
  operation's connection named as it is now.
- **After**: the tab follows every change of the history (a new operation, an undo, a removal, a clear, a change of the
  `mongoster.history` settings) by sending `init` again.
- **Settings**: `mongoster.history.enabled` (the notice), and the limits shown in the summary (`undo.limits`).
- **Uses**: `undo.details`, `undo.revert`, `undo.remove`, `undo.clear`, `undo.limits`.
- **Tested by**: `test/unit/mcpWorkspace.test.ts › 'open tools' › 'open_history opens the Undo History tab'` (the MCP
  tool with a stub host, not the tab).

Acceptance:

- [ ] There is one Undo History tab for all connections, titled **Undo History**; showing it again reveals it.
- [ ] The header has a filter input (`Filter by connection, collection or operation`), the summary, **Settings** (it
  opens the settings filtered on `mongoster.history`) and **Clear History…**.
- [ ] The summary reads `12 operations · 3.4 MB of 100 MB`; with a filter, `2 shown · 12 operations · …`. Its tooltip
  reads `Kept for 7 days, up to 200 operations and 100 MB; operations of more than 10,000 documents aren't recorded.`
- [ ] With `mongoster.history.enabled` off the tab shows `The undo history is off (setting mongoster.history.enabled):
  new changes aren't recorded.`
- [ ] The columns are **when**, **collection**, **operation**, **documents**, **size**: today's operations show
  `14:05:09`, yesterday's `yesterday 14:05`, older ones `10-08 14:05`; the collection is
  `<connection> › <database>.<collection>`; the documents read `1 inserted, 2 updated, 3 deleted`.
- [ ] The filter matches the connection's name, `<database>.<collection>` and the label, ignoring case, and is kept
  while the tab is hidden.
- [ ] Each row has **Undo** (`undo.revert`) and **✕** (`undo.remove`); an operation already undone shows `undone`
  (with the time in its tooltip), no size, and can't be expanded.
- [ ] Clicking a row that isn't undone expands it with what undoing does to its documents (`undo.details`).
- [ ] With no operations the tab says `No operations yet: changes made from Mongoster to documents show up here, to
  undo them.`; with none matching the filter, `No operations match the filter.`

### `undo.details` — What undoing an operation would do

Expanding a row of the Undo History tab shows, for each document of the operation, its value now and its value after
the undo, field by field.

- **Kind**: Read
- **Function**: `src/history.ts › UndoHistory.details`
- **Implemented in**: `src/history.ts › HistoryPanel.receive` (`details`); `src/webview/undoHistory.ts`
  (`detailContent`, `documentBox`, `diffTable`); `src/shared/compare.ts › fieldDiff`; `src/shared/messages.ts`
  (`HistoryDocument`).
- **Entry points**: a click on a row of the Undo History tab.
- **Offered when**: the operation is not undone.
- **Reads**: the operation's file, and the first 100 of its documents as they are now, by `_id`.
- **Uses**: `undo.changed-since`, `undo.revert-plan`.
- **Tested by**: *none*.

Acceptance:

- [ ] At most 100 documents are shown; with more, the box starts with `First 100 of 2,500 documents.`
- [ ] Each document shows its `_id` in mongosh syntax and what the operation did: `inserted: the undo deletes it`,
  `updated: the undo restores it`, `deleted: the undo inserts it again`; one changed since is marked `changed since`.
- [ ] When some changed since, the box says `3 documents changed after the operation: undoing overwrites those changes
  too.`
- [ ] The fields are compared in order and by type, in a table with **field**, **now**, **after the undo**; a value
  missing on one side shows `—` (`Missing now`, `Missing after the undo`); a document missing on one side is one row,
  `(document)`.
- [ ] A document already as the undo would leave it shows `Already as it was: the undo changes nothing.`; an inserted
  one already gone shows `Already deleted.`
- [ ] An operation no longer in the history, already undone or of a removed connection shows the error in the box:
  `This operation is no longer in the undo history.`, `This operation was already undone.`,
  `The connection <name> no longer exists.`

### `undo.changed-since` — Which documents changed since the operation

Before undoing, Mongoster finds the documents that someone changed after the operation, because undoing would
overwrite those changes; the answer chooses the buttons of the confirmation.

- **Kind**: Derivation
- **Function**: `src/history.ts › UndoHistory.undo` (the set `changed` and the buttons, lines 471-486; no function of
  its own); the same test is `changed` in `UndoHistory.details`.
- **Implemented in**: `src/history.ts › fingerprint`, `fetchByIds`.
- **Inputs**: the recorded documents `{ id, before, after }` (`undo.kept-documents`) and the documents with those
  `_id`s as they are now, read with `promoteValues: false, bsonRegExp: true`.
- **Output**: the documents changed since, and the buttons and detail of the confirmation.
- **Rules**:
  - a document changed since when the fingerprint of its current value (`null` when it does not exist) differs from
    `after`;
  - none changed: the button is `Undo`; all changed: `Undo Anyway`; some: `Undo All` and `Undo Unchanged Only`;
  - the detail adds `The document changed after the operation: undoing overwrites those changes too.` (one document,
    changed), `All of them changed after …` or `2 of them changed after …`.
- **Uses**: `undo.revert`, `undo.details`.
- **Tested by**: *none*.

Examples:

| Operation did | Since then | Changed since |
| --- | --- | --- |
| updated `status` to `"b"` | nothing | no |
| updated `status` to `"b"` | someone set `status: "c"` | yes |
| updated `status` to `"b"` | someone replaced it with the same fields in another order | yes |
| inserted it | someone deleted it | yes (`after` is a fingerprint, now `null`) |
| deleted it | nothing | no (`null` and `null`) |
| deleted it | someone inserted a document with the same `_id` | yes |

Acceptance:

- [ ] Undoing an Update many of 3 documents of which 1 changed since asks with `Undo All` and `Undo Unchanged Only`
  and says `1 of them changed after the operation: undoing overwrites those changes too.`
- [ ] Undoing a deletion of one document that someone inserted again asks with `Undo Anyway` and says `The document
  changed after the operation: undoing overwrites those changes too.`

### `undo.revert` — Undo an operation

Puts the documents of an operation back as they were: deletes those it inserted, restores those it changed, inserts
again those it deleted, with their BSON types. The undo is an operation too, so it can be undone (redo).

- **Kind**: Operation
- **Function**: `src/history.ts › UndoHistory.undo`
- **Implemented in**: `src/history.ts › UndoHistory.undoAndReport` (notification and command), `HistoryPanel.receive`
  (`undo`, the tab); `src/webview/undoHistory.ts` (the **Undo** button); `src/redisOplog.ts`.
- **Entry points**: **Undo** on a row of the Undo History tab; `Undo` in the notification of a write
  (`undo.notification`); `mongoster.undoLast` (`undo.last`).
- **Offered when**: the operation is not undone.
- **Asks**: a modal warning `Undo "<label>" in <connection> › <database>.<collection>?`, detail `The undo deletes 2
  inserted documents, restores 3 updated documents, inserts again 1 deleted document.` plus the line of
  `undo.changed-since`; buttons `Undo`, `Undo Anyway`, or `Undo All` / `Undo Unchanged Only`.
- **Reads**: the operation's file; the documents with its `_id`s as they are now.
- **Writes**: `bulkWrite` unordered, in batches of 1,000: `deleteOne({ _id })` for an inserted document,
  `replaceOne({ _id }, before, { upsert: true })` for the others (`undo.revert-plan`).
- **Danger**: Confirm: the modal warning above; it says when changes made since will be overwritten.
- **Read-only**: Refused on a read-only connection, with `The connection <name> is read-only: nothing can be undone
  through it.`
- **Undo**: Recorded in the undo history (`undo.record`) as `Undo: <label>`, `undoOf` the operation; undoing it is the
  redo.
- **redis-oplog**: Published (`oplog.publish`): the documents before and after the undo (`sink.changes`).
- **After**: on success the operation is marked undone, its file deleted and its size set to 0; the tree is refreshed
  (`mongoster.refresh`). From the tab, the result shows in the tab's message line; otherwise in a notification with
  `Undo` (the redo).
- **Refuses**: `This operation is no longer in the undo history.`, `This operation was already undone.`,
  `The connection <name> no longer exists.`, the read-only message above; any other error as `Undo failed: <error>`.
- **Settings**: those of `undo.record`, for the undo's own record.
- **Uses**: `undo.changed-since`, `undo.revert-plan`, `undo.record`, `oplog.publish`.
- **Tested by**: *none*.
- **Differs**: (1) only the tree is refreshed (`src/history.ts:540`, `610`): an open collection tab of the collection
  keeps showing the documents as they were before the undo until it is refreshed by hand. (2) The confirmation has no
  line of `UndoHistory.note` (`src/history.ts:478-487`): with the history off for the connection, or with more
  documents than `mongoster.history.maxDocumentsPerOperation`, the undo is not recorded and can't be redone, and the
  confirmation doesn't say so. (3) Cancelling the confirmation from the tab sends nothing back
  (`src/history.ts:606-610`), so the row's button stays `Undoing…`, disabled, until the tab is sent `init` again
  (`src/webview/undoHistory.ts:218-224`).

Acceptance:

- [ ] Undoing an Update many puts every changed field back with its BSON type (`Int32` stays `Int32`).
- [ ] Undoing a Delete many inserts the deleted documents again with their `_id`s.
- [ ] Undoing an insert deletes the inserted documents.
- [ ] `Undo Unchanged Only` leaves the documents changed since as they are, and the operation is still marked undone.
- [ ] On success the message is `Undid "<label>": 5 documents in <connection> › <database>.<collection>.`
- [ ] When some documents fail, the message is `Undo of "<label>" incomplete: 2 documents of 5 failed: <error>`, the
  operation stays in the history to try again, and what was undone is recorded as its own operation.
- [ ] The undo of `X` is labelled `Undo: X`, the undo of `Undo: X` is `Redo: X`, the undo of `Redo: X` is `Undo: X`.
- [ ] On a connection that publishes to redis-oplog, the undo is published like any other write.
- [ ] (differs) After an undo, the open collection tab of the collection shows the documents as they are now.
- [ ] (differs) The confirmation says when the undo itself can't be undone.
- [ ] (differs) Cancelling the confirmation from the tab leaves the row's **Undo** button as it was.

### `undo.revert-plan` — What undo does to each document

The writes an undo sends, and what it records of its own, from the operation's recorded documents.

- **Kind**: Derivation
- **Function**: `src/history.ts › UndoHistory.undo` (lines 489-500; no function of its own).
- **Inputs**: the recorded documents `{ id, before, after }`, the documents changed since (`undo.changed-since`), the
  button chosen, the operation's label.
- **Output**: the bulk writes, the documents the undo records, the undo's label.
- **Rules**:
  - `Undo Unchanged Only` takes the documents not changed since; every other button takes all of them;
  - a document without `before` (the operation inserted it): `deleteOne({ _id })`;
  - a document with `before`: `replaceOne({ _id }, before, { upsert: true })`, which also inserts again a deleted one;
  - the undo records each document taken as it is now (as inserted when it does not exist), so that undoing the undo
    puts it back;
  - the writes are idempotent: running them twice leaves the same documents.
- **Uses**: `undo.revert`.
- **Tested by**: *none*.

Examples:

| Recorded | Now | Write | Recorded by the undo |
| --- | --- | --- | --- |
| before `null` (inserted) | `{ _id: 1, a: 1 }` | `deleteOne({ _id: 1 })` | before `{ _id: 1, a: 1 }`, after `null`: deleted |
| before `{ _id: 2, a: 1 }` (updated) | `{ _id: 2, a: 2 }` | `replaceOne({ _id: 2 }, { _id: 2, a: 1 }, upsert)` | before `{ _id: 2, a: 2 }`: updated |
| before `{ _id: 3, a: 1 }` (deleted) | missing | `replaceOne({ _id: 3 }, { _id: 3, a: 1 }, upsert)` | `_id` 3 only: inserted |

Acceptance:

- [ ] Undoing the undo of an operation leaves the documents as the operation had left them.

### `undo.notification` — Undo from a write's notification

The notification that reports a recorded write has an `Undo` button, for undoing it at once.

- **Kind**: View
- **Function**: `src/history.ts › UndoHistory.notify`
- **Implemented in**: the callers of `UndoHistory.notify` in `src/collectionPanel.ts`, `src/docHistory.ts`,
  `src/transfer.ts`, `src/backup.ts`; `src/copy.ts` and `src/generate.ts`, which show `Open` and `Undo` in their own
  notification; `src/history.ts › UndoHistory.undoAndReport`.
- **Entry points**: the result notification of insert, delete of a document, Update many, Delete many, the selected
  rows, the column actions, restoring a version, import, generate, copy, a restore of one collection, and of an undo.
- **Offered when**: the write recorded an operation.
- **Uses**: `undo.revert`, `undo.record`.
- **Tested by**: *none*.

Acceptance:

- [ ] A write that recorded an operation shows its result with `Undo`; one that recorded nothing shows the result
  without it.
- [ ] `Undo` asks the confirmation of `undo.revert`; the result shows in a notification, with `Undo` again for the
  redo, or as an error message.
- [ ] A restore of several collections shows no `Undo` and says `Undo from the Undo History, one operation per
  collection`.

### `undo.last` — Undo Last Change

Undoes the newest operation that isn't undone yet, without opening the tab.

- **Kind**: Operation
- **Function**: `src/extension.ts` (command `mongoster.undoLast`), with `src/history.ts › UndoHistory.last` and
  `UndoHistory.undoAndReport`.
- **Entry points**: `mongoster.undoLast` (**Undo Last Change**): the connections view's `…` menu, the Command Palette.
- **Offered when**: always (`view == mongoster.connections` in the `…` menu).
- **Asks**: the confirmation of `undo.revert`.
- **Writes**: those of `undo.revert`.
- **Danger**: Confirm: the confirmation of `undo.revert`.
- **Read-only**: Refused on a read-only connection, as `undo.revert`.
- **Undo**: Recorded in the undo history (`undo.record`), as `undo.revert`.
- **redis-oplog**: Published (`oplog.publish`), as `undo.revert`.
- **After**: as `undo.revert` from a notification.
- **Refuses**: with no operation left to undo, `Nothing to undo: the undo history is empty.`
- **Uses**: `undo.revert`.
- **Tested by**: *none*.

Acceptance:

- [ ] It undoes the newest operation of any connection that isn't undone, which may be an `Undo: …` (then it redoes).
- [ ] It works from the Command Palette with no argument.
- [ ] With every operation undone, or none, it says `Nothing to undo: the undo history is empty.`
- [ ] When the newest operation is on a connection made read-only since, it says the read-only message and undoes
  nothing, also the next time.

### `undo.clear` — Clear the undo history

Deletes every recorded operation and its file.

- **Kind**: Operation
- **Function**: `src/history.ts › UndoHistory.clear`
- **Implemented in**: `src/history.ts › HistoryPanel.receive` (`clear`); `src/extension.ts` (command
  `mongoster.clearHistory`); `src/webview/undoHistory.ts` (the button).
- **Entry points**: **Clear History…** in the Undo History tab; `mongoster.clearHistory` (**Clear Undo History**) in
  the Command Palette.
- **Asks**: a modal warning `Clear the undo history?`, detail `12 operations can then no longer be undone.`, button
  `Clear History`.
- **Writes**: no database: deletes the files of the operations and writes `index.json`.
- **Danger**: Confirm: the warning above.
- **Read-only**: Allowed, because it writes nothing to the database (operations of read-only connections are cleared
  too).
- **Undo**: Cannot be undone: the files are deleted, and the confirmation says the operations can no longer be undone.
- **After**: the Undo History tab shows the empty list.
- **Refuses**: from the command, with an empty history, `The undo history is already empty.`; from the tab, nothing
  happens.
- **Tested by**: *none*.

Acceptance:

- [ ] The count in the confirmation includes the operations already undone.
- [ ] After `Clear History` the folder `history/` holds only `index.json`, with an empty list.
- [ ] It works from the Command Palette with no argument.

### `undo.remove` — Remove one operation

Deletes one operation from the undo history, so that its file no longer takes space.

- **Kind**: Operation
- **Function**: `src/history.ts › UndoHistory.clear` (with the operation's `id`)
- **Implemented in**: `src/history.ts › HistoryPanel.receive` (`remove`); `src/webview/undoHistory.ts` (the **✕**
  button).
- **Entry points**: **✕** on a row of the Undo History tab (tooltip `Remove from the history (the operation can no
  longer be undone)`).
- **Offered when**: on every row, also an undone one.
- **Writes**: no database: deletes the operation's file and writes `index.json`.
- **Danger**: None: no confirmation; the tooltip says it can no longer be undone.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: the file is deleted.
- **After**: the row disappears.
- **Tested by**: *none*.

Acceptance:

- [ ] A click on **✕** removes the row and its file at once, without asking.

### `undo.limits` — Limits and pruning

The undo history keeps at most a size, an age and a number of operations, deleting the oldest first, so that its
folder stays small.

- **Kind**: Operation
- **Function**: `src/history.ts › UndoHistory.prune`
- **Implemented in**: `src/history.ts › historyLimits`, `UndoHistory.load`, `UndoHistory.save`, the constructor
  (`onDidChangeConfiguration`); `package.json` (`contributes.configuration`).
- **Entry points**: none: it runs when the history is loaded (with the orphans), after each save, and when a
  `mongoster.history` setting changes.
- **Writes**: no database: deletes the files of the operations dropped and writes `index.json`.
- **Danger**: Destructive: operations beyond the limits can no longer be undone, without asking.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: the files are deleted.
- **After**: the Undo History tab shows what is left.
- **Settings**: `mongoster.history.maxSizeMB` (100), `mongoster.history.maxDays` (7),
  `mongoster.history.maxOperations` (200); a value that isn't a number of 0 or more takes the default.
- **Uses**: `undo.prune-order`.
- **Tested by**: *none*.
- **Differs**: an operation whose compressed file is larger than `mongoster.history.maxSizeMB` stops the walk at the
  newest operation (`src/history.ts:317-318`): it is dropped as soon as it is saved, and every older operation with
  it, instead of the oldest only.

Acceptance:

- [ ] With the defaults, the 201st operation drops the oldest one.
- [ ] An operation older than 7 days is dropped at the next start, save or change of the settings.
- [ ] Lowering `mongoster.history.maxOperations` to 10 keeps the newest 10 at once, and the tab shows them.
- [ ] At start, operations whose file is missing are dropped (undone ones have no file and stay), and files with no
  operation are deleted.
- [ ] Undone operations count towards `mongoster.history.maxOperations` and `mongoster.history.maxDays`, with no size.
- [ ] (differs) An operation larger than `mongoster.history.maxSizeMB` on its own leaves the older operations in the
  history.

### `undo.prune-order` — Which operations the limits keep

Given the operations and the limits, which ones stay.

- **Kind**: Derivation
- **Function**: `src/history.ts › UndoHistory.prune` (the loop; no function of its own).
- **Inputs**: the operations with their `time` and `size` (bytes of the compressed file, 0 once undone); now; the
  limits `maxBytes`, `maxDays`, `maxEntries`.
- **Output**: the operations kept; the others are dropped with their files.
- **Rules**:
  - walk the operations from the newest to the oldest;
  - stop at the first one older than now minus `maxDays` days, or when `maxEntries` are already kept, or when its size
    added to those kept exceeds `maxBytes`;
  - keep every operation before the stop, drop it and every older one, even one that would still fit.
- **Uses**: `undo.limits`.
- **Tested by**: *none*.

Examples (`maxBytes` 100 MB, `maxDays` 7, `maxEntries` 200 unless said):

| Operations, newest first | Kept |
| --- | --- |
| 250 of 100 KB in the last 3 days | the newest 200 |
| 60 MB, 30 MB, 20 MB, 1 KB | 60 MB and 30 MB: the 20 MB one stops the walk, and the 1 KB one goes with it |
| 1 day old, 8 days old, 2 days old (clock changed) | the first only |
| `maxBytes` 1 MB: a new one of 2 MB, then 10 of 10 KB | none (see the Differs of `undo.limits`) |
| `maxDays` 0: a new one | none: it is already older than now when the save prunes |

Acceptance:

- [ ] Operations of 60 MB, 30 MB, 20 MB and 1 KB, newest first, keep the first two.

### `undo.writes-of` — Mongoster's writes to one document

Which recorded operations wrote one document between two times, and what each did to it: the document history uses
it to say that a write in the oplog was made by Mongoster.

- **Kind**: Derivation
- **Function**: `src/history.ts › UndoHistory.writesOf`
- **Implemented in**: `src/docHistory.ts` (the document history, which asks with the times of the oplog entries
  widened).
- **Inputs**: the connection, database and collection; the document's `_id`; a time range (epoch ms).
- **Output**: `{ label, time, kind }` per operation, `kind` being `inserted`, `updated` or `deleted`.
- **Rules**:
  - an operation counts when it is on the same collection and its time is in the range;
  - an operation not undone is read from its own file: no `before` is `inserted`, `after` `null` is `deleted`,
    otherwise `updated`;
  - an undone operation has no file: it is read from its undo (the operation with `undoOf` its `id`), where the
    document went the other way: no `before` is `deleted`, `after` `null` is `inserted`, otherwise `updated`;
  - an operation whose undo was undone in turn (its file gone too), or whose file can't be read, is left out.
- **Uses**: `undo.revert-plan`, `document.restore-version`.
- **Tested by**: *none*.

Examples:

| Operation | Read from | Kind |
| --- | --- | --- |
| `Delete document 1`, not undone | its file: before the document, after `null` | deleted |
| `Insert document`, undone | its undo: before the document, after `null` | inserted |
| `Edit status of 1`, undone | its undo: before and after both set | updated |

Acceptance:

- [ ] A document deleted from Mongoster and then restored by an undo shows the deletion as Mongoster's, and the undo
  as Mongoster's too.

### `undo.per-connection` — Stop or keep the undo history of a connection

Turns the undo history off for one connection, for example one whose bulk writes are too large to keep, and back on.

- **Kind**: Operation
- **Function**: `src/extension.ts` (commands `mongoster.disableHistory` and `mongoster.enableHistory`, through
  `updateConnection` with `noHistory`)
- **Implemented in**: `src/connections.ts` (`ConnectionInfo.noHistory`); `src/tree.ts` (the `.nohistory` part of the
  connection node's context value and its tooltip); `src/history.ts › UndoHistory.recording`.
- **Entry points**: `mongoster.disableHistory` (**Stop Keeping Undo History**) and `mongoster.enableHistory`
  (**Keep Undo History**) in a connection's context menu.
- **Offered when**: **Stop Keeping Undo History** on a connection that keeps it
  (`viewItem =~ /^connection(\.connected)?$/`); **Keep Undo History** on one that doesn't
  (`viewItem =~ /^connection(\.connected)?\.nohistory$/`); neither on a read-only connection. Not in the Command
  Palette (`when: false`); with no argument the commands do nothing.
- **Writes**: no database: the connection's `noHistory` in Mongoster's saved connections.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database (not offered on a read-only connection, which
  records nothing anyway).
- **Undo**: Cannot be undone from the undo history; the other command turns it back.
- **After**: the connection's tooltip says `Changes aren't kept in the undo history`; the open tabs of the connection
  get the new connection (`connectionChanged`).
- **Uses**: `undo.record`, `connection.read-only`.
- **Tested by**: *none*.

Acceptance:

- [ ] After **Stop Keeping Undo History**, writes through the connection are not recorded and their confirmations say
  `The undo history is off for this connection: this can't be undone.`
- [ ] The operations recorded before stay, and can still be undone; that undo is not recorded.
- [ ] **Keep Undo History** records the next writes again.
- [ ] A read-only connection records nothing and undoes nothing, whatever this setting.

### `undo.forget-connection` — Removing a connection deletes its operations

When a connection is removed, its recorded operations are deleted with it, since they could no longer be undone.

- **Kind**: Operation
- **Function**: `src/extension.ts` (command `mongoster.removeConnection`), calling `src/history.ts ›
  UndoHistory.clear` with the connection's id.
- **Entry points**: **Remove Connection** in a connection's context menu.
- **Asks**: the confirmation of removing the connection, `Remove connection "<name>"?` with `Remove`; it doesn't
  mention the undo history.
- **Writes**: no database: deletes the files of the connection's operations and writes `index.json`.
- **Danger**: Confirm: the confirmation of the removal.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: the files are deleted.
- **After**: the Undo History tab no longer lists them.
- **Uses**: `undo.clear`.
- **Tested by**: *none*.

Acceptance:

- [ ] After removing a connection, none of its operations are in the undo history or in its folder.
- [ ] The operations of the other connections stay.
