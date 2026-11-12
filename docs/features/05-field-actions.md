# Actions on a column

Changing one field in the documents matching the filter, from its column header in the table: **Rename field…**,
**Remove field…** and **Convert type…**. The user's side is in the README's [Features](../../README.md#features),
under **Actions on a column**.

The three actions are one method, `CollectionPanel.fieldAction` in `src/collectionPanel.ts`, which asks, counts,
confirms and then writes through `CollectionPanel.writeMany`, the path of **Update many** (`document.update-many`):
undo history, redis-oplog, the extra confirmation of an empty filter. Which documents each one touches and the update
it sends are pure functions of `src/fieldActions.ts`, which have their own cards below. The menu entries are
`fieldItems` in `src/webview/main.ts`; the message is `FieldActionRequest` (`{ type: 'fieldAction', action, field,
array, filter }`) in `src/shared/messages.ts`.

Common to the three operations:

- **Offered when**: in **Find**, on a collection that can be changed (not on a view, not on a read-only connection),
  on any column but `_id` and its sub-fields. The filter in the query bar must parse (otherwise `Invalid query syntax
  — check the highlighted field.` and nothing is sent); when it differs from the last query run, the query runs first,
  so that the table shows the documents concerned.
- **Scope**: the documents matching the filter of the query bar; with an empty filter, the whole collection. The
  texts say `of <collection>` for an empty filter and `matching the filter` otherwise.
- **Confirmation**: a modal with the number of documents and the undo note (`UndoHistory.note`); with an empty filter,
  a second modal `<action> in the whole collection <collection>?` with the detail `The filter is empty, so every
  document of the collection is affected.`, button `<button> in All`; when the documents are more than the undo
  history keeps, a third modal `Update without the possibility to undo?`, button **Update Without Undo**, as for
  **Update many**.
- **Refusals before anything is asked**: `<field>: <reason>.` when the path can't be changed (`field.path-rules`).
  Errors of MongoDB are shown with `showErrorMessage`, and the tab runs its query again.

### `field.rename` — Rename a field

Renames a field, or moves it to another path, in the documents matching the filter.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.fieldAction` (with `action: 'rename'`)
- **Implemented in**: `src/fieldActions.ts › renameField`, `renameError`, `fieldPathError`;
  `CollectionPanel.writeMany`; `src/webview/main.ts › fieldItems`, `fieldAction`, `fieldChanged`;
  `src/shared/columns.ts › renameInLayout`, `renamedKey`.
- **Entry points**: **Rename field…** in the right-click menu of a column header (tooltip `$rename in the documents
  matching the filter`).
- **Offered when**: see above.
- **Asks**: an input box titled `Rename <field>`, prompt `New name of <field> in the documents <scope> (a dotted path
  moves it into a sub-document)`, with the current name and its last part selected, validated by `renameError`. Then
  `Rename <field> to <new name> in <n> documents <scope>?`, with the details `<k> documents already have <new name>:
  its value is replaced by that of <field>.` and `<k> documents with <field> or <new name> inside an array are left
  out: $rename can't go through arrays.` when they apply, and the undo note; button **Rename**. With an empty filter,
  `Rename <field> to <new name> in the whole collection <collection>?`, button **Rename in All**.
- **Reads**: three counts with `countDocuments` (60 seconds at most each): the documents to rename, those that have
  the field (arrays or not), those that already have the new name. Then the documents, for the undo history.
- **Writes**: `updateMany(<filter>, { $rename: { <field>: <new name> } })`, with the filter of `field.rename-plan`.
- **Danger**: Confirm: the texts above. A value already at the new name is replaced.
- **Read-only**: Refused on a view and on a read-only connection, with `readOnlyMessage` (`The connection <name> is
  read-only.` or `Views are read-only.`); the menu has no entry there.
- **Undo**: Recorded in the undo history (`undo.record`) as `Rename field <field> to <new name>`, followed by
  ` where <filter>` when there is a filter, up to `mongoster.history.maxDocumentsPerOperation` documents.
- **redis-oplog**: Published (`oplog.publish`): an update of each renamed document, with the old and the new name as
  its fields.
- **After**: `Renamed <field> to <new name> in <k> documents of <collection>.` (`k` modified) with **Undo**; the
  column keeps its place, width, pin and visibility under the new name, and the expanded columns follow
  (`field.layout-follows`); the tab runs its query again.
- **Refuses**: on a field of the elements of an expanded array (`items[].sku`), a modal `items[].sku is a field of the
  elements of the array items: $rename can't change fields inside arrays.` with the detail `Use Update many with a
  pipeline that rewrites the array, e.g. [ { $set: { items: { $map: { input: "$items", in: … } } } } ].`; when no
  document has the field, `No document <scope> has <field>.` (with the documents left out, if any).
- **Settings**: `mongoster.history.*`.
- **Uses**: `field.path-rules`, `field.rename-plan`, `field.array-guard`, `field.layout-follows`,
  `document.update-many`, `undo.record`, `undo.limits`, `oplog.publish`, `connection.read-only`.
- **Tested by**: `test/unit/fieldActions.test.ts › renameField` and `› 'field paths'`;
  `test/integration/fieldActions.test.ts › 'rename field' › 'renames a top-level field in the matching documents, and tells which ones it overwrites'`, `'moves
  a nested field, leaving out documents where its parent is an array'`, `'fails without the array guard: the guard is
  what makes it run'` (the plan against mongod, not the method).

Acceptance:

- [ ] With the filter `{ kind: "x" }`, renaming `name` to `fullName` asks `Rename name to fullName in 3 documents
  matching the filter?`, says that 1 document already has `fullName`, and renames it in those 3 only.
- [ ] Renaming `addr.city` to `city` moves it out of `addr` where `addr` is a document, and leaves out (and counts) a
  document where `addr` is an array.
- [ ] Renaming `a` to `a.b` or `a.b` to `a` is refused in the input box as on the same path; the same name asks for a
  different one.
- [ ] With an empty filter, **Rename in All** is asked after **Rename**; declining writes nothing.
- [ ] After the rename the column `fullName` has the width, place and pin `name` had.
- [ ] **Rename field…** on `items[].sku` writes nothing and says to use **Update many** with `$map`.
- [ ] The rename is in the undo history, and undoing it gives back `name`.
- [ ] On a connection that publishes to redis-oplog, each renamed document publishes `{ e: 'u', d: { _id }, f:
  ['name', 'fullName'] }`.
- [ ] On a view and on a read-only connection the header's menu has no **Rename field…**.

### `field.remove` — Remove a field

Removes a field from the documents matching the filter, also from every element of an expanded array.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.fieldAction` (with `action: 'remove'`)
- **Implemented in**: `src/fieldActions.ts › removeField`, `fieldPathError`; `CollectionPanel.writeMany`;
  `src/webview/main.ts › fieldItems`, `fieldChanged`; `src/shared/columns.ts › renameInLayout`.
- **Entry points**: **Remove field…** in the right-click menu of a column header (tooltip `$unset in the documents
  matching the filter`).
- **Offered when**: see above; also on a field of the elements of an expanded array (`items[].sku`).
- **Asks**: `Remove <field> from <n> documents <scope>?`, or for a field of array elements `Remove items[].sku from the
  elements of items in <n> documents <scope>?`, with the documents left out when there are any (`<k> documents where
  <field> is inside an array are left out: remove it from the elements with Update many and $[].`, or `<k> documents
  where items isn't an array are left out.`) and the undo note; button **Remove**. With an empty filter, `Remove
  <field> from the whole collection <collection>?`, button **Remove in All**.
- **Reads**: two counts (the documents to change, those that have the field); the documents, for the undo history.
- **Writes**: `updateMany(<filter>, { $unset: { <field>: "" } })`, or `{ $unset: { "items.$[].sku": "" } }` for a
  field of array elements, with the filter of `field.remove-plan`.
- **Danger**: Destructive: the values of the field are gone. Confirm: the texts above.
- **Read-only**: Refused on a view and on a read-only connection, with `readOnlyMessage`.
- **Undo**: Recorded in the undo history (`undo.record`) as `Remove field <field>` (`items[].sku` for array elements)
  followed by ` where <filter>` when there is a filter.
- **redis-oplog**: Published (`oplog.publish`): an update of each document, with the field cut at the array
  (`items.$[].sku` → `items`).
- **After**: `Removed <field> from <k> documents of <collection>.` with **Undo**; the field's columns leave the layout
  (hidden, order, pins, widths) and the expanded columns; the tab runs its query again.
- **Refuses**: `No document <scope> has <field>.` when there is nothing to remove.
- **Settings**: `mongoster.history.*`.
- **Uses**: `field.path-rules`, `field.remove-plan`, `field.array-guard`, `field.layout-follows`,
  `document.update-many`, `undo.record`, `oplog.publish`, `connection.read-only`.
- **Tested by**: `test/unit/fieldActions.test.ts › removeField`; `test/integration/fieldActions.test.ts › 'remove
  field' › 'removes a top-level field, null values included'`, `'removes a nested field where the parent is a
  document'`, `'removes a field of the elements of an array from every element'` (the plan against mongod).

Acceptance:

- [ ] Removing `tmp` removes it from every matching document, also where it is `null`.
- [ ] Removing `meta.a` removes it where `meta` is a document and leaves out, and counts, a document where `meta` is
  an array.
- [ ] Removing `items[].sku` removes `sku` from every element of `items`, and leaves out a document where `items` is
  not an array.
- [ ] Closing the confirmation writes nothing.
- [ ] The removal is in the undo history, and undoing it puts the values back.
- [ ] On a connection that publishes to redis-oplog, each changed document publishes an update with the field.

### `field.convert-type` — Convert the type of a field

Converts the values of a field to another BSON type with `$convert`, keeping the values that can't be converted.

- **Kind**: Operation
- **Function**: `src/collectionPanel.ts › CollectionPanel.fieldAction` (with `action: 'convert'`)
- **Implemented in**: `src/fieldActions.ts › convertField`, `typeCounts`, `CONVERT_TYPES`; `CollectionPanel.writeMany`;
  `src/webview/main.ts › fieldItems`.
- **Entry points**: **Convert type…** in the right-click menu of a column header (tooltip `Convert the values
  ($convert) in the documents matching the filter`).
- **Offered when**: see above; on a field of array elements it is refused (below).
- **Asks**: a quick pick titled `Convert <field>`, placeholder `Type to convert the values to · now: <type> <n> ·
  <type> <n>` (the current types, most frequent first; without them when counting fails or takes more than 30
  seconds), listing `string`, `int`, `long`, `double`, `decimal`, `bool`, `date`, `objectId` with their descriptions.
  Then `Convert <field> to <type> in <n> documents <scope>?` with the details `Values that can't be converted keep
  their value and type; null and arrays are left as they are.`, `<k> documents where <field> is inside an array are
  left out.` when it applies, and the undo note; button **Convert**. With an empty filter, `Convert <field> to <type>
  in the whole collection <collection>?`, button **Convert in All**.
- **Reads**: the types of the field (`field.type-counts`); two counts; the documents, for the undo history; after the
  write, the count of the values still not converted.
- **Writes**: `updateMany(<filter>, [ { $set: { <field>: { $convert: { input: "$<field>", to: <type>, onError:
  "$<field>", onNull: "$<field>" } } } } ])`, with the filter of `field.convert-plan`.
- **Danger**: Confirm: the texts above. A converted value loses its old type (`7.9` to `int` is `7`).
- **Read-only**: Refused on a view and on a read-only connection, with `readOnlyMessage`.
- **Undo**: Recorded in the undo history (`undo.record`) as `Convert field <field> to <type>`, followed by
  ` where <filter>` when there is a filter.
- **redis-oplog**: Published (`oplog.publish`): an update of each document, with the field.
- **After**: `Converted <field> to <type> in <k> documents of <collection>.`, followed by ` <j> values couldn't be
  converted and kept their type.` (`1 value couldn't be converted and kept its type.`) when some are left, with
  **Undo**; the tab runs its query again.
- **Refuses**: on a field of array elements, a modal `items[].sku is a field of the elements of the array items:
  Convert type can't change fields inside arrays.` with the detail on **Update many** and `$map`; when nothing needs
  converting, `No value of <field> <scope> needs converting to <type>: null, missing values and arrays are left as they
  are.`
- **Settings**: `mongoster.history.*`.
- **Uses**: `field.path-rules`, `field.convert-plan`, `field.type-counts`, `field.array-guard`,
  `document.update-many`, `undo.record`, `oplog.publish`, `connection.read-only`.
- **Tested by**: `test/unit/fieldActions.test.ts › convertField`; `test/integration/fieldActions.test.ts › 'convert
  field' › 'converts what it can to int, keeps the rest, and counts what is left'`, `'converts to long, decimal,
  string, date and objectId'`, `'converts a nested field, leaving out documents where its parent is an array'` (the
  plan against mongod).

Acceptance:

- [ ] On `v` with the values `"42"`, `7.9`, `"not a number"`, `null`, `[1, 2]` and `Int32(5)`, the placeholder shows
  the current types; converting to `int` asks about 3 documents, makes `"42"` `Int32(42)` and `7.9` `Int32(7)`, keeps
  `"not a number"`, `null` and the array, and ends with `… 1 value couldn't be converted and kept its type.`
- [ ] Converting to `long`, `decimal`, `string`, `date` and `objectId` gives a `Long`, a `Decimal128`, a string, a
  date from ISO text and an `ObjectId` from 24 hexadecimal characters.
- [ ] Converting `nested.n` leaves out, and counts, a document where `nested` is an array.
- [ ] When every value already has the type, nothing is written and the message says no value needs converting.
- [ ] **Convert type…** on `items[].qty` writes nothing.
- [ ] The conversion is in the undo history, and undoing it gives back the old values and types.
- [ ] On a connection that publishes to redis-oplog, each converted document publishes an update with the field.

### `field.path-rules` — Which fields a column action can change

Decides whether a dotted path can be changed by a column action, and whether a new name is acceptable for a rename.

- **Kind**: Derivation
- **Function**: `src/fieldActions.ts › fieldPathError(path)`, `renameError(from, to)`
- **Implemented in**: `CollectionPanel.fieldAction` (the field) and the rename's input box (`validateInput`).
- **Tested by**: `test/unit/fieldActions.test.ts › 'field paths' › 'refuses empty parts, $ names and _id'`, `'refuses
  a rename to the same name or along the same path'`.

Rules of `fieldPathError` (undefined means acceptable):

1. Empty: `Enter a field name`.
2. A part between dots is empty: `"<path>" has an empty part: write names separated by single dots`.
3. A part starts with `$`: `Field names can't start with $`.
4. The first part is `_id`: `_id can't be changed`.

Rules of `renameError`: the rules above on the new name; the same name: `Enter a different name`; one path inside the
other: `<from> and <to> are on the same path: a field can't be moved inside itself or its parent`.

Examples:

| Input | Result |
| --- | --- |
| `fieldPathError('a..b')`, `('a.')` | empty part |
| `fieldPathError('$a')`, `('a.$b')` | `Field names can't start with $` |
| `fieldPathError('_id')`, `('_id.x')` | `_id can't be changed` |
| `fieldPathError('a._id')`, `('address.city')` | acceptable |
| `renameError('a', 'a')` | `Enter a different name` |
| `renameError('a', 'a.b')`, `('a.b', 'a')` | same path |
| `renameError('a', 'ab')`, `('a.b', 'c.d')` | acceptable |
| `renameError('a', '')` | `Enter a field name` |

Acceptance:

- [ ] Each row of the table above gives its result.

### `field.array-guard` — Leave out the documents where a parent is an array

An update by dotted path can't go through an array: `$rename` fails on the whole update, `$unset` does nothing, `$set`
would write into every element. The column actions leave such documents out, and count them to say so.

- **Kind**: Derivation
- **Function**: `src/fieldActions.ts › noArrayParents(path)`, `and(...parts)`
- **Implemented in**: `renameField`, `removeField`, `convertField`, `typeCounts` (same file).
- **Tested by**: `test/unit/fieldActions.test.ts › 'field paths' › 'keeps out documents where a parent of the path is
  an array'`, `'joins conditions, without the empty ones'`; `test/integration/fieldActions.test.ts › 'rename field' ›
  'fails without the array guard: the guard is what makes it run'`.

Rules:

1. `noArrayParents(path)` gives one condition `{ <parent>: { $not: { $type: 'array' } } }` for each parent of the
   path, from the outermost; none for a top-level field.
2. `and(...)` drops the empty conditions: none left is `{}`, one is itself, more are `{ $and: [ … ] }`.

Examples: `noArrayParents('a')` → `[]`; `noArrayParents('a.b.c')` → `[{ a: { $not: { $type: 'array' } } }, { 'a.b':
{ $not: { $type: 'array' } } }]`; `and({}, {})` → `{}`; `and({ a: 1 }, {})` → `{ a: 1 }`; `and({ a: 1 }, { b: 2 })` →
`{ $and: [{ a: 1 }, { b: 2 }] }`.

Acceptance:

- [ ] Each example above gives its result.
- [ ] `$rename` of `addr.city` with the guard succeeds on a collection where one document has `addr` as an array, and
  fails without it.

### `field.rename-plan` — Which documents a rename touches

- **Kind**: Derivation
- **Function**: `src/fieldActions.ts › renameField(filter, from, to)`
- **Tested by**: `test/unit/fieldActions.test.ts › renameField › 'renames in the documents of the filter that have the
  field'`, `'leaves out documents with an array on either path'`; `test/integration/fieldActions.test.ts › 'rename
  field'`.

Inputs: the user's filter (BSON), the field, the new name. Output: `{ filter, update, reached, overwrites }`.

Rules:

1. `reached`: the user's filter and `{ <from>: { $exists: true } }`.
2. `filter`: `reached`, and the array guard of both `from` and `to` (`field.array-guard`).
3. `update`: `{ $rename: { <from>: <to> } }`.
4. `overwrites`: `filter` and `{ <to>: { $exists: true } }`: the documents whose value at `to` is replaced.
5. The documents left out because of arrays are `count(reached) - count(filter)`.

Examples:

- `renameField({}, 'old', 'new')` → `filter` and `reached` `{ old: { $exists: true } }`, `update` `{ $rename: { old:
  'new' } }`, `overwrites` `{ $and: [{ old: { $exists: true } }, { new: { $exists: true } }] }`.
- `renameField({ status: 'a' }, 'a.b', 'c.d.e')` → `filter` `{ $and: [{ $and: [{ status: 'a' }, { 'a.b': { $exists:
  true } }] }, { a: <not array> }, { c: <not array> }, { 'c.d': <not array> }] }`.
- Against the documents `{ _id: 1, name: 'a', kind: 'x' }`, `{ _id: 5, name: 'e', fullName: 'kept?', kind: 'x' }` and
  others, `renameField({ kind: 'x' }, 'name', 'fullName')` overwrites one document, `_id` 5, whose `fullName` becomes
  `'e'`.

Acceptance:

- [ ] Each example above gives its result.

### `field.remove-plan` — Which documents a removal touches

- **Kind**: Derivation
- **Function**: `src/fieldActions.ts › removeField(filter, field, array?)`
- **Tested by**: `test/unit/fieldActions.test.ts › removeField › 'unsets the field where no parent is an array'`,
  `'removes a field of array elements from every element'`; `test/integration/fieldActions.test.ts › 'remove field'`.

Inputs: the user's filter, the field (`items.sku`), and `array`, the path of the expanded array whose elements have
the field (`items`), when the column is a field of array elements. Output: `{ filter, update, reached }`.

Rules:

1. `reached`: the user's filter and `{ <field>: { $exists: true } }`.
2. Without `array`: `filter` is `reached` and the array guard of the field; `update` is `{ $unset: { <field>: '' } }`.
3. With `array`: `filter` is `reached`, the array guard of `array`, and `{ <array>: { $type: 'array' } }` (`$[]` fails
   on a document where it isn't an array); `update` is `{ $unset: { '<array>.$[].<rest of the field>': '' } }`.

Examples:

- `removeField({ x: 1 }, 'a.b')` → `filter` `{ $and: [{ $and: [{ x: 1 }, { 'a.b': { $exists: true } }] }, { a: <not
  array> }] }`, `update` `{ $unset: { 'a.b': '' } }`.
- `removeField({}, 'items.sku', 'items')` → `filter` `{ $and: [{ 'items.sku': { $exists: true } }, { items: { $type:
  'array' } }] }`, `update` `{ $unset: { 'items.$[].sku': '' } }`.
- `removeField({}, 'order.items.meta.sku', 'order.items')` → `update` `{ $unset: { 'order.items.$[].meta.sku': '' }
  }`, and `order` must not be an array.

Acceptance:

- [ ] Each example above gives its result.

### `field.convert-plan` — Which values a conversion touches

- **Kind**: Derivation
- **Function**: `src/fieldActions.ts › convertField(filter, field, type)`, `CONVERT_TYPES`
- **Tested by**: `test/unit/fieldActions.test.ts › convertField › 'converts with $convert, keeping values that fail,
  null and arrays'`, `'offers the types $convert knows'`; `test/integration/fieldActions.test.ts › 'convert field'`.

Inputs: the user's filter, the field, the target type. Output: `{ filter, update, reached }`.

Rules:

1. The values still to convert: `{ <field>: { $exists: true, $not: { $type: [<type>, 'null', 'array'] } } }`.
2. `filter`: the user's filter, the array guard of the field, and rule 1. Counted again after the write, it gives the
   values that couldn't be converted.
3. `reached`: the user's filter and rule 1, without the array guard.
4. `update`: the pipeline `[ { $set: { <field>: { $convert: { input: '$<field>', to: <type>, onError: '$<field>',
   onNull: '$<field>' } } } } ]`: a value that fails keeps its value and type.
5. The types offered, in order: `string`, `int`, `long`, `double`, `decimal`, `bool`, `date`, `objectId`, each with
   its description (`32-bit integer: decimals are truncated, integer text is parsed`, `Numbers: 0 is false; any text,
   even "false", is true`, …).

Examples: `convertField({ k: 1 }, 'price', 'decimal')` → `filter` and `reached` `{ $and: [{ k: 1 }, { price: {
$exists: true, $not: { $type: ['decimal', 'null', 'array'] } } }] }`; `convertField({}, 'a.b', 'int').filter` →
`{ $and: [{ a: <not array> }, { 'a.b': { $exists: true, $not: { $type: ['int', 'null', 'array'] } } }] }`.

Acceptance:

- [ ] Each example above gives its result.
- [ ] Applied to `"42"`, `7.9`, `"not a number"`, `null`, `[1, 2]`, `Int32(5)` with `int`, it matches 3 documents,
  modifies 2, and 1 still matches afterwards.

### `field.type-counts` — The current types of a field

The pipeline that counts the BSON types of a field, shown in the placeholder of **Convert type…**.

- **Kind**: Derivation
- **Function**: `src/fieldActions.ts › typeCounts(filter, field)`
- **Tested by**: `test/unit/fieldActions.test.ts › convertField › 'counts the types of the field'`;
  `test/integration/fieldActions.test.ts › 'convert field' › 'converts what it can to int, keeps the rest, and counts
  what is left'`.

Rules: `[ { $match: <filter, array guard, { <field>: { $exists: true } }> }, { $group: { _id: { $type: '$<field>' },
n: { $sum: 1 } } }, { $sort: { n: -1 } } ]`: one row per type, most frequent first.

Example: `typeCounts({ x: 1 }, 'a.b')` → `$match` `{ $and: [{ x: 1 }, { a: <not array> }, { 'a.b': { $exists: true }
}] }`, `$group` on `{ $type: '$a.b' }`.

Acceptance:

- [ ] The example above gives its result.
- [ ] After converting `v` to `int` in the collection of `field.convert-plan`, the first row is `{ _id: 'int', n: 3 }`.

### `field.layout-follows` — The column follows a renamed or removed field

After a rename the column keeps its layout under the new name; after a removal its layout is dropped.

- **Kind**: Derivation
- **Function**: `src/shared/columns.ts › renameInLayout(layout, from, to?)`, `renamedKey(key, from, to?)`
- **Implemented in**: `src/webview/main.ts › fieldChanged` (on the host's `{ type: 'fieldChanged', from, to }`), which
  also renames the expanded columns and saves both (`saveLayout`, `saveExpanded`).
- **Tested by**: *none*.

Rules:

1. A key equal to `from`, or starting with `from.`, becomes `to` followed by the rest; without `to` it is dropped.
   Other keys stay.
2. `hidden` and `order` are renamed and keep one of each key; `pinned` is renamed and keeps only top-level keys;
   `widths` move to the new keys.

Examples: `renamedKey('addr.city', 'addr', 'address')` → `'address.city'`; `renamedKey('name', 'addr', 'address')` →
`'name'`; `renamedKey('tmp', 'tmp')` → dropped; renaming `name` to `info.name` drops `name` from `pinned`.

Acceptance:

- [ ] Each example above gives its result.
- [ ] After renaming `name` to `fullName`, a hidden `name` column is a hidden `fullName` column, with the same width.
