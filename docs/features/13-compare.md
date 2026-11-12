# Comparing collections

The compare tab pairs the documents of two collections by `_id` and lets the user copy documents from one side to
the other. Only the writes have cards for now: copying one document, making one side like the other, and the rule of
document equality that decides which documents are copied. Choosing the other collection, reading both sides, the
list of differences and the field-by-field detail are written when the area is next changed. The user's side is in
the README's [Features](../../README.md#features), under **Comparing collections**.

The compare tab is `ComparePanel` in `src/compare.ts`, with `src/webview/compare.ts` and `media/compare.css`; its
messages are `CompareHostMessage` and `CompareViewMessage` in `src/shared/messages.ts`. Both writes below are the
same method, `ComparePanel.apply(to, keys)`: `keys` is the row's `_id` for one document, `null` for every difference.

### `compare.copy-document` — Copy one document to the other side

On a row of the list, copies that document to the other side (insert or replace), or deletes it from the side where
the other side lacks it, so that the two sides agree on that `_id`.

- **Kind**: Operation
- **Function**: `src/compare.ts › ComparePanel.apply` (with `keys` set to the row's key).
- **Implemented in**: `src/webview/compare.ts › rowActions` (the buttons), `src/shared/messages.ts` (`{ type: 'apply',
  to, keys }`, answered by `{ type: 'applied', ok, message }`), `src/history.ts` (`UndoHistory.start`, `note`).
- **Entry points**: the buttons on each row of the compare tab: **→ Right** and **← Left** on a different document;
  **→ Right** and **Delete** on a document only on the left; **Delete** and **← Left** on a document only on the
  right.
- **Offered when**: a comparison has a result. The buttons are disabled while a comparison runs and on a side that is
  read-only, with the reason as their tooltip.
- **Asks**: one modal confirmation, `Make <to> like <from>: <insert 1 | replace 1 | delete 1> document in
  <connection> › <database>.<collection>?`, with the detail `Documents are written as they are now on the other
  side.` and the undo note; button **Apply**.
- **Reads**: the document on the source side by `_id`, with `promoteValues: false`; the target document before the
  write, for the undo history.
- **Writes**: on the target collection, `bulkWrite([{ replaceOne: { filter: { _id }, replacement: <source document>,
  upsert: true } }], { ordered: false })` for an insert or a replace; `deleteMany({ _id: { $in: [<_id>] } })` for a
  delete.
- **Danger**: Confirm: the text above. A replace overwrites the target document, a delete removes it.
- **Read-only**: Refused when the target side is a read-only connection or a view, with `The connection <name> is
  read-only. Its documents can't be changed.` or `<collection> is a view. Its documents can't be changed.` in the
  tab's message line.
- **Undo**: Recorded in the undo history (`undo.record`) under the label
  `Make like <connection> › <database>.<collection>` of the source side, when the undo history records the
  connection.
- **redis-oplog**: Not published.
- **After**: the tab shows `Wrote 1 document in …` or `deleted 1 in …` (or `Nothing changed in …`), runs
  `mongoster.refresh` for the tree, and compares again with the same options.
- **Refuses**: `Wait for the comparison to finish.` while a comparison runs; `Nothing to change: compare again.` when
  the key is no longer among the differences (after `⇄`).
- **Settings**: `mongoster.history.*` (whether and up to how many documents the write is recorded).
- **Uses**: `compare.equality`, `undo.record`, `undo.limits`.
- **Tested by**: *none*.
- **Differs**: the write is not published to redis-oplog (`src/compare.ts:399-431` has no `RedisOplog.sink`; the
  README lists the comparison among the writes not published), and the result is said only in the tab: no
  `UndoHistory.notify` with **Undo**, and open collection tabs of the target are not refreshed
  (`src/compare.ts:430-432`).

Acceptance:

- [ ] On a document only on the left, **→ Right** asks `Make right like left: insert 1 document in Local ›
  shop.orders?` and, after **Apply**, the right collection has the document with the same `_id`.
- [ ] A copied document keeps every BSON type: an `Int32` field stays `Int32`, a `Decimal128` stays `Decimal128`,
  and its fields keep their order.
- [ ] On a different document, **← Left** replaces the left document with the right one, ignored fields included.
- [ ] On a document only on the right, **Delete** asks `Make right like left: delete 1 document in …?` and removes it
  from the right collection.
- [ ] Closing the confirmation writes nothing.
- [ ] With a read-only connection or a view on the target side, the button is disabled, and a message sent anyway is
  answered with `… Its documents can't be changed.` and writes nothing.
- [ ] The write is in the undo history, and undoing it puts the target document back as it was.
- [ ] (differs) On a connection that publishes to redis-oplog, the inserted, replaced or deleted document is
  published (`oplog.publish`).
- [ ] After the write, the tab compares again and the row is gone.

### `compare.make-like` — Make one side like the other

Copies every document missing or different on one side from the other side and, if chosen, deletes the documents
found only on that side, for all the differences of the comparison, not only those shown.

- **Kind**: Operation
- **Function**: `src/compare.ts › ComparePanel.apply` (with `keys` null).
- **Implemented in**: `src/webview/compare.ts › renderBulk` (the buttons and `Showing the first N of M; the buttons
  above apply to all of them.`), `src/shared/messages.ts`, `src/history.ts`.
- **Entry points**: **Make right like left…** and **Make left like right…** above the list in the compare tab.
- **Offered when**: the comparison found at least one difference. Disabled while a comparison runs and for a side
  that is read-only, with the reason as tooltip.
- **Asks**: a modal confirmation `Make <to> like <from> in <connection> › <database>.<collection>?`, whose detail says
  `insert N, replace M documents from the <from> side.`, `K documents only on the <to> side can also be deleted.` and
  the undo note. Its buttons: **Apply** (copies only) when there is something to copy; **Apply and Delete K** when
  there are also documents to delete; **Delete** alone when there is nothing to copy.
- **Reads**: the source documents by `_id`, 500 at a time, with `promoteValues: false`; the target documents before
  the write, for the undo history.
- **Writes**: on the target collection, per batch of 500, `bulkWrite` of `replaceOne({ _id }, <source document>, {
  upsert: true })` (unordered); then, when deletes were chosen, `deleteMany({ _id: { $in: [...] } })` per batch of
  500.
- **Danger**: Confirm: the text above. Different documents are overwritten; with **Apply and Delete K** or **Delete**,
  the documents only on the target side are deleted.
- **Read-only**: Refused when the target side is a read-only connection or a view, with `… Its documents can't be
  changed.`
- **Undo**: Recorded in the undo history (`undo.record`) as one operation labeled
  `Make like <connection> › <database>.<collection>`, when the documents written and deleted are within
  `mongoster.history.maxDocumentsPerOperation`; beyond it the confirmation says `This can't be undone: …`.
- **redis-oplog**: Not published.
- **After**: the tab shows `Wrote N documents, deleted K in <connection> › <database>.<collection>.`, runs
  `mongoster.refresh` and compares again with the same options.
- **Refuses**: `Wait for the comparison to finish.` while a comparison runs; `Nothing to change: compare again.` after
  `⇄` swapped the sides.
- **Settings**: `mongoster.history.*`.
- **Uses**: `compare.equality`, `compare.copy-document`, `undo.record`, `undo.limits`.
- **Tested by**: *none*.
- **Differs**: as `compare.copy-document`: nothing is published to redis-oplog (`src/compare.ts:399-431`), and the
  result has no **Undo** notification and does not refresh open collection tabs (`src/compare.ts:430-432`).

Acceptance:

- [ ] With 3 documents only on the left, 2 different and 4 only on the right, **Make right like left…** asks with
  `insert 3, replace 2 documents from the left side.` and `4 documents only on the right side can also be deleted.`
  and the buttons **Apply** and **Apply and Delete 4**.
- [ ] **Apply** inserts the 3 and replaces the 2, and leaves the 4 on the right untouched.
- [ ] **Apply and Delete 4** also deletes the 4 documents only on the right.
- [ ] With only documents on the target side to delete, the one button is **Delete**, and nothing is copied.
- [ ] With a filter, only documents matching the filter on both sides are written or deleted.
- [ ] Documents that are equal by `compare.equality` (for example, different only in an ignored field) are not
  written.
- [ ] Differences beyond the first 300 of each kind shown in the list are written too.
- [ ] The copied documents keep their BSON types and field order.
- [ ] With the undo history on and 10,000 documents or fewer, the write is one operation of the undo history, and
  undoing it restores the target side, deleted documents included.
- [ ] With more documents than `mongoster.history.maxDocumentsPerOperation`, the confirmation says `This can't be
  undone: the undo history keeps operations of up to N documents.`
- [ ] With the target side read-only (connection or view), both buttons for that side are disabled and nothing is
  written.
- [ ] (differs) On a connection that publishes to redis-oplog, every inserted, replaced and deleted document is
  published (`oplog.publish`).

### `compare.equality` — When two documents are equal

Decides whether two documents with the same `_id` are identical or different, and so which documents the copy
buttons write. The user sets it with **Ignore**, **Ignore field order** and **Compare numbers by value**.

- **Kind**: Derivation
- **Function**: `src/shared/compare.ts › comparable` (with `normalize`); `src/compare.ts › ComparePanel.compare`
  hashes its result with SHA-1, one hash per `_id`.
- **Implemented in**: `src/shared/compare.ts › parseIgnore` (the **Ignore** text), `src/webview/compare.ts` (the
  options, both on by default).
- **Tested by**: `test/unit/compare.test.ts › 'comparable'` › `'tells field order apart unless it is ignored'`,
  `'never ignores the order of array elements'`, `'tells int, long and double apart unless numbers compare by value'`,
  `'compares large longs exactly by value'`, `'keeps special doubles distinct from each other'`, `'leaves out ignored
  fields, also inside sub-documents and array elements'`, `'ignores only the exact path'`; `'fieldsSummary /
  parseIgnore'` › `'splits on commas and spaces, without duplicates or blanks'`.

Inputs: the two documents as canonical Extended JSON (every BSON type told apart), and the options `ignore` (paths),
`ignoreOrder`, `numbersByValue`. Output: a text that is the same exactly when the documents compare equal.

Rules:

1. A field whose path is in **Ignore** is left out, at any depth. The path of a field of array elements is the
   array's path and the field's name, without an index: `items.price`. Only the exact path is left out: `b` does not
   leave out `a.b`.
2. With **Ignore field order**, the fields of every document and sub-document are compared sorted by name; without
   it, the order counts. The order of array elements always counts.
3. With **Compare numbers by value**, an `Int32`, an `Int64` and a `Double` with the same value are equal. Longs are
   compared exactly, beyond the 53 bits of a double. `-0` equals `0`; `NaN` equals `NaN`; `Infinity` and `-Infinity`
   differ. `Decimal128` is never equal to the other number types. Without the option, the BSON type counts.
4. Every other value is compared with its BSON type: a string `"1"` never equals the number `1`, a date never equals
   its number of milliseconds.
5. **Ignore** splits on commas, spaces and new lines, without blanks or duplicates: ` a, b.c  a\n,d ,` is `a`, `b.c`,
   `d`.

Worked examples (left → right: result):

| Left | Right | Options | Result |
| --- | --- | --- | --- |
| `{ a: 1, b: 2 }` | `{ b: 2, a: 1 }` | field order counts | different |
| `{ a: 1, b: 2 }` | `{ b: 2, a: 1 }` | **Ignore field order** | identical |
| `{ x: [{ a: 1, b: 2 }] }` | `{ x: [{ b: 2, a: 1 }] }` | **Ignore field order** | identical |
| `{ a: [1, 2] }` | `{ a: [2, 1] }` | both options on | different |
| `{ n: 1 }` (int) | `{ n: 1.0 }` (double) | numbers by type | different |
| `{ n: 1 }` (int) | `{ n: NumberLong(1) }` | **Compare numbers by value** | identical |
| `{ n: 1.5 }` | `{ n: 1 }` (int) | **Compare numbers by value** | different |
| `{ n: NumberLong("9007199254740993") }` | `{ n: 9007199254740992.0 }` | by value | different |
| `{ n: NumberLong("9007199254740992") }` | `{ n: 9007199254740992.0 }` | by value | identical |
| `{ updatedAt: 1, meta: { rev: 1, v: 1 }, items: [{ a: 1, tmp: 1 }] }` | the same with `updatedAt: 2`, `rev: 2`, `tmp: 2` | **Ignore** `updatedAt, meta.rev, items.tmp` | identical |
| `{ a: { b: 1 } }` | `{ a: { b: 2 } }` | **Ignore** `b` | different |

Acceptance:

- [ ] The examples above give the results shown.
- [ ] A document identical under the options is counted as identical and is never written by `compare.copy-document`
  or `compare.make-like`.
- [ ] A different document is written whole, as it is on the source side: ignored fields and field order included.
