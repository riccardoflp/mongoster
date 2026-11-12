# Comparing database structures

Compare Structure puts two databases side by side (collections and views, their options, indexes, search indexes and
shard keys) and makes the right one like the left one, the model: by running the changes (`Apply…`) or by giving a
mongosh script. Only the writes have cards for now: applying the changes, the steps each difference takes, and the
script. Picking the databases, reading the structures and the list of differences are written when the area is next
changed. The user's side is in the README's [Features](../../README.md#features), under **Comparing database
structures**.

The tab is `StructurePanel` in `src/structurePanel.ts`, with `src/webview/structure.ts` and `media/structure.css`.
`src/structure.ts` reads a database's structure and runs one step (`applyOp`); `src/shared/structure.ts` compares two
structures and writes the script, without `vscode` or `mongodb`. The messages are `StructureHostMessage` and
`StructureViewMessage` in `src/shared/messages.ts`.

### `structure.apply` — Apply differences to the right database

Makes the right database like the left one for one difference, the differences of one collection, or all of them,
after a confirmation that lists the commands.

- **Kind**: Operation
- **Function**: `src/structurePanel.ts › StructurePanel.apply`
- **Implemented in**: `src/structure.ts › applyOp` (one step), `src/shared/structure.ts › planSummary`,
  `orderForScript`, `diffTitle`; `src/webview/structure.ts › applyButton` and the group row (the buttons);
  `src/shared/messages.ts` (`{ type: 'apply', ids }`, answered by `{ type: 'applied', ok, message, comparing }`).
- **Entry points**: in the Compare Structure tab, **Apply…** on a difference's row and in its detail; **Apply…** on a
  collection's row, when it has more than one difference a command can apply; **Apply All…** above the list.
- **Offered when**: the difference has at least one step a command can run (`structure.steps`). The buttons are
  disabled while a comparison runs and when the right connection is read-only, with `The connection <name> is
  read-only.` as tooltip.
- **Asks**: one modal confirmation. For one difference: `Apply to <connection> › <database>: <collection> <object>?`
  (`Apply to Production › shop: orders index status_1?`), with the button **Apply**, **Apply and Drop** (it also has
  steps that drop something) or **Drop** (it only has such steps); its drops are always included. For several
  differences: `Make <right connection> › <database> like <left connection> › <database>?`, with **Apply** (the steps
  that drop nothing) and **Apply Including Drops**, or only **Apply Drops** when every step drops something. The
  detail lists, one line each: `N changes: createIndex ×3, collMod.`; `N steps drop something: dropIndex,
  createIndex.`; `N differences can't be applied by a command and are left out (the script says what to do).`; and
  always `Index builds can take a while on large collections. These changes can't be undone from the undo history.`
- **Reads**: nothing more: the differences of the last comparison.
- **Writes**: on the right database, the steps of the chosen differences in the order of `orderForScript`:
  `createCollection(name, options)` (a view with `viewOn` and `pipeline` in its options), `runCommand({ collMod, … })`,
  `runCommand({ convertToCapped, size })`, `drop()`, `createIndex(keys, options)`, `dropIndex(name)`,
  `createSearchIndex({ name, type, definition })`, `updateSearchIndex(name, definition)`, `dropSearchIndex(name)`,
  and `adminCommand({ shardCollection: "<database>.<collection>", key, unique? })`.
- **Danger**: Destructive, with drops: a collection only on the right is dropped with its documents and indexes;
  `convertToCapped` loses the oldest documents beyond the size and drops the indexes other than `_id`; an index
  rebuilt with other options or another name is dropped first, and queries can't use it until it is built again. The
  confirmation is a modal with a button; no name is typed, unlike `manage.drop-collection`.
- **Read-only**: Refused when the right connection is read-only, with `The connection <name> is read-only. Its
  structure can't be changed.` The left database is never written.
- **Undo**: Cannot be undone: structure changes are not recorded in the undo history, and the confirmation says so.
- **redis-oplog**: Not published: no document is written. The documents removed by `drop` or `convertToCapped` are
  not published either.
- **After**: the tab shows `Applied N changes to <connection> › <database>.` or `Nothing was changed in …`, followed
  by `K differences failed: <collection> <object>: <error> · …` (the first 3); runs `mongoster.refresh` when something
  changed; and compares again.
- **Refuses**: `Wait for the comparison to finish.` while a comparison runs; `Nothing to change: compare again.` when
  the differences are no longer there (after `⇄`); `These differences can't be applied by a command: the script says
  what to do.` when none of them has a step a command can run.
- **Uses**: `structure.steps`. Its index steps go through the driver's `createIndex` and `dropIndex`, not through
  `index.create`, so an option the driver does not know is left out rather than refused (see the comment of
  `createIndex` in `src/indexes.ts`).
- **Tested by**: `test/integration/structure.test.ts › 'compare structure' › 'applies the steps: first without the
  drops, then with them'` (the steps through `applyOp`, without the tab's confirmation);
  `test/unit/structure.test.ts › 'the script' › 'counts the steps by sort'` (`planSummary`).

Acceptance:

- [ ] **Apply…** on an index missing on the right asks `Apply to <right> › shop: orders index status_1?` with
  **Apply**, and after it the right collection has the index with the same keys, name and options.
- [ ] **Apply All…** with **Apply** creates what is missing and changes what collMod can change, and leaves every
  collection and index only on the right in place; the documents stay.
- [ ] **Apply All…** with **Apply Including Drops** also drops what is only on the right and rebuilds the indexes
  that differ, after which only the differences no command can make remain.
- [ ] A step that fails stops the remaining steps of its difference only; the others go on, and the message names
  the failed difference with the server's error.
- [ ] A difference that only a script comment can solve (a collation, uncapping, clustering, resharding) has no
  **Apply…** button and is left out of **Apply All…**, which says how many were left out.
- [ ] With a read-only right connection, the buttons are disabled, and a message sent anyway is answered with `…
  Its structure can't be changed.` and changes nothing.
- [ ] The confirmation always says `These changes can't be undone from the undo history.`
- [ ] Closing the confirmation changes nothing.
- [ ] After the changes, the tab compares again and the applied differences are gone.

### `structure.steps` — What each difference takes

For each difference between the two databases, the steps that make the right side like the left one, which of them
drop something, and what no command can do. `Apply…` runs the steps; the script writes them.

- **Kind**: Derivation
- **Function**: `src/shared/structure.ts › diffStructure`
- **Implemented in**: `src/shared/structure.ts › optionSteps`, `normalizeOptions`, `indexShape` and the functions it
  calls for collections, indexes, search indexes and shard keys; `src/shared/indexes.ts › planIndexChange` (whether
  an index changes in place, `index.change-plan`).
- **Tested by**: `test/unit/structure.test.ts` › `'collections on one side only'`, `'indexes'`, `'collection
  options'`, `'search indexes'`, `'shard keys'` (every test in them); `'normalizeOptions'` and `'indexShape'`;
  `test/integration/structure.test.ts › 'compare structure' › 'reads both databases and finds their differences'`.

Inputs: the structure of each database (`DatabaseShape`): collections with their type, the options that matter,
indexes without `_id_`, search indexes when the server has search, shard keys through a mongos. Output: the
differences, each with a kind (`same`, `different`, `onlyLeft`, `onlyRight`), a summary, both definitions, and its
steps; plus notes on what was not compared.

What is compared:

- Collection options: `validator`, `validationLevel`, `validationAction`, `capped`, `size`, `max`, `timeseries`,
  `expireAfterSeconds`, `clusteredIndex`, `collation`, `changeStreamPreAndPostImages`; defaults are left out
  (`validationLevel: "strict"`, `validationAction: "error"`, an empty validator, pre- and post-images off, the
  collation's `version`). Views: `viewOn`, `pipeline`, `collation`.
- Indexes, paired first by name and identity, then by identity, then by name. The identity is the keys with the
  collation and the partial filter: two indexes with the same keys and another collation are two indexes. `v`, `ns`,
  `background`, the generated name and options at their default don't count.
- Search indexes only when both servers have search; otherwise, when the other side has some, a note: `Search
  indexes are not compared: the right server has no search (1 search index on the left).`
- Shard keys only when both are sharded clusters; otherwise a note: `Shard keys are not compared: only the left is a
  sharded cluster.`

Rules (difference → steps on the right; *destructive* steps are applied only with drops and commented out of the
script without them):

| Difference | Steps | Destructive |
| --- | --- | --- |
| Collection or view only on the left | `createCollection` with its options; for a collection, `createIndex` for each index, then `shardCollection` (both sharded) and `createSearchIndex` for each search index (both with search) | no |
| Collection or view only on the right | `drop`, with the note `Its documents and indexes are deleted.` for a collection | yes |
| A view on one side, a collection on the other; or a time series on one side only | `drop`, then the steps that create it as on the left | all |
| Options of a collection | one `collMod` with what differs: `validator` (the left's, or `{}`), `validationLevel` (or `"strict"`), `validationAction` (or `"error"`), `changeStreamPreAndPostImages` (or `{ enabled: false }`), `expireAfterSeconds` of a time series or clustered collection (or `"off"`), `timeseries: { granularity }` when only the granularity differs, `cappedSize` and `cappedMax` when both are capped | no |
| Capped on the left only | `convertToCapped` with the left's size | yes |
| Capped on the right only; another collation; clustered on one side only; time series options other than the granularity | none: a note says what to do by hand | — |
| A view's `viewOn` or `pipeline` | `collMod` with `viewOn` and `pipeline` | no |
| A view's collation | `drop`, then `createCollection` as on the left (a view holds no data) | no |
| Index only on the left | `createIndex` with its keys and options, named as on the left | no |
| Index only on the right | `dropIndex` | yes |
| Paired index, only `hidden` or the TTL differ (both with a TTL) | `collMod: { index: { name: <right name>, hidden, expireAfterSeconds } }` | no |
| Paired index, anything else (keys, name, `unique`, partial filter, adding or removing a TTL…) | `dropIndex` of the right one, then `createIndex` of the left one, with the note `MongoDB can't change <what> of an index: it is dropped and built again. Queries can't use it in the meantime.` | yes |
| Search index only on the left | `createSearchIndex` | no |
| Search index with another definition, same type | `updateSearchIndex` | no |
| Search index of another type | `dropSearchIndex`, then `createSearchIndex` | yes |
| Search index only on the right | `dropSearchIndex` | yes |
| Sharded on the left only | `shardCollection`, with the note `The collection needs an index that starts with the shard key.` | no |
| Sharded on the right only | none: `unshardCollection` (MongoDB 8.0 or later) is said in a note | — |
| Another shard key | none: `reshardCollection` (MongoDB 5.0 or later) is said in a note | — |

Worked examples (left; right → difference and steps):

- `orders` with `{ validator: { a: { $exists: true } } }` and indexes `status_1 { status: 1 }`, `byDate { date: -1 }`
  with `expireAfterSeconds: 3600`; nothing on the right → `onlyLeft`, `Collection missing on the right, with 2
  indexes`: `createCollection("orders", { validator })`, `createIndex({ status: 1 }, { name: "status_1" })`,
  `createIndex({ date: -1 }, { expireAfterSeconds: 3600, name: "byDate" })`; nothing destructive.
- `byStatus { status: 1 }`; `status_1 { status: 1 }` → one `different` pair, `Same keys { status: 1 }, named
  status_1 on the right`: `dropIndex("status_1")`, `createIndex({ status: 1 }, { name: "byStatus" })`, both
  destructive.
- `main { a: 1, b: 1 }`; `main { b: 1, a: 1 }` → `Same name, different keys: { a: 1, b: 1 } on the left, { b: 1, a: 1
  } on the right`: `dropIndex`, `createIndex`.
- `a_1 { a: 1 }` hidden with TTL 60; `a_1 { a: 1 }` with TTL 30 → `Different hidden, expireAfterSeconds`: `collMod: {
  index: { name: "a_1", hidden: true, expireAfterSeconds: 60 } }`.
- `a_1 { a: 1 }` unique; `a_1 { a: 1 }` → `Different unique`: `dropIndex`, `createIndex`, destructive.
- `a_fr { a: 1 }` with collation `fr` and `a_1 { a: 1 }`; `a_1 { a: 1 }` and `a_part { a: 1 }` with a partial filter →
  `a_1` same, `a_fr` only on the left, `a_part` only on the right.
- Capped 8192 with max 10; capped 4096 → `collMod: { cappedSize: 8192, cappedMax: 10 }`. Capped 8192; not capped →
  `convertToCapped` 8192, destructive. Not capped; capped → a note `A capped collection can't be made uncapped: …`.
- Time series with `granularity: "hours"` and `expireAfterSeconds: 60`; the same with `"seconds"` and no expiry →
  `collMod: { expireAfterSeconds: 60, timeseries: { granularity: "hours" } }`.

Acceptance:

- [ ] The examples above give the differences and steps shown.
- [ ] A `same` difference has no steps, and a step with no command only has its note.
- [ ] Every step that drops a collection, an index or data is marked destructive, except dropping a view to change
  its collation.

### `structure.script` — The script that makes the right database like the left one

A mongosh script with the steps of every difference, in an order that runs, the steps that drop something commented
out unless asked, and what no command can do explained in comments. **Copy Script** puts it on the clipboard; **Open
in Playground** opens it in a new playground on the right connection and database; **Copy Script** in a difference's
detail copies only its steps.

- **Kind**: Derivation
- **Function**: `src/shared/structure.ts › structureScript`
- **Implemented in**: `src/shared/structure.ts › orderForScript`, `stepLines`, `opCommand`, `diffTitle`;
  `src/shared/indexes.ts › indexCommand`; `src/shared/searchIndexes.ts › searchIndexCommand`;
  `src/webview/structure.ts` (**Include drops in the script**, remembered by the tab); `src/structurePanel.ts ›
  StructurePanel.receive` (`copy` to the clipboard, `openPlayground` through `mongoster.newPlayground`).
- **Tested by**: `test/unit/structure.test.ts › 'commands'` › `'writes each operation in mongosh syntax'`, `'comments
  out the destructive steps unless asked'`; `'the script'` › `'orders the steps: collections, then changes, views
  after what they are on, drops last'`, `'makes the right like the left, with the drops commented out'`, `'includes
  the drops when asked'`, `'says when there is nothing to change'`; `test/integration/structure.test.ts › 'compare
  structure' › 'runs the generated script in the playground'`.

Inputs: the differences of the comparison (all of them, also those the list hides), the right database's name, the
`connection › database` of each side, and whether drops are included. Output: the script text, ending with a new
line. It writes nothing to a database: a playground on a read-only connection refuses its writes when run.

Rules:

1. The header: `// Makes <right> like <left>.`, `// Generated by Mongoster (Compare Structure).`, then, when a step
   drops something, `// Steps that drop something are commented out: remove the // in front of them to run them
   too.` (or, with drops, `// Steps marked DESTRUCTIVE drop indexes, collections or data: check them before running
   the script.`), an empty line and `use("<database>");`.
2. The order: collections to create; collections to recreate; options and indexes; shard keys; views, each after the
   view it is on; search indexes; last, whatever is only on the right. Within a group, by collection name.
3. Each difference: an empty line, `// <collection>: <object> – <summary>`, then for each step its note as a `//`
   line and its command with a `;`.
4. A destructive step without drops: `// DESTRUCTIVE, optional: remove the // to run it.` and every line of the
   command behind `// `. With drops: `// DESTRUCTIVE` above the command.
5. A step no command can do is only its note.
6. Nothing to change: `// Nothing to change: the structures are the same.` after `use`.
7. The commands, as `opCommand` writes them:

| Step | Command |
| --- | --- |
| create a collection | `db.createCollection("c")`, `db.createCollection("c", { capped: true, size: 4096 })` |
| create a view | `db.createView("v", "c", [{ $match: { a: 1 } }], { collation: { locale: "fr" } })` |
| collMod | `db.runCommand({ collMod: "c", validationLevel: "strict" })` |
| convertToCapped | `db.runCommand({ convertToCapped: "c", size: 10 })` |
| drop | `db.getCollection("c").drop()` |
| createIndex | `db.getCollection("c").createIndex({ a: 1 })`, `….createIndex({ a: 1 }, { name: "mine", unique: true })` (a generated name is left out) |
| dropIndex | `db.getCollection("c").dropIndex("a_1")` |
| createSearchIndex | `db.getCollection("c").createSearchIndex("default", { mappings: { dynamic: true } })`; a vector index adds `"vectorSearch"` before the definition |
| updateSearchIndex | `db.getCollection("c").updateSearchIndex("default", { mappings: { dynamic: false } })` |
| dropSearchIndex | `db.getCollection("c").dropSearchIndex("default")` |
| shardCollection | `db.adminCommand({ shardCollection: "shop.c", key: { a: "hashed" } })` |

Worked example: left `dev › shop` with `orders` (index `status_1`), `users`, and the views `recent` on `orders` and
`big` on `recent`; right `prod › shop` with `orders` (index `old_1`), `legacy`, and `users` with a validator. Without
drops:

```js
// Makes prod › shop like dev › shop.
// Generated by Mongoster (Compare Structure).
// Steps that drop something are commented out: remove the // in front of them to run them too.

use("shop");

// orders: index status_1 – Missing on the right: { status: 1 }
db.getCollection("orders").createIndex({ status: 1 });

// users: options – Different validator
db.runCommand({ collMod: "users", validator: {} });

// recent: view – View missing on the right (on orders)
db.createView("recent", "orders", [{ $sort: { date: -1 } }]);

// big: view – View missing on the right (on recent)
db.createView("big", "recent", [{ $match: { total: { $gt: 100 } } }]);

// legacy: collection – Collection only on the right
// Its documents and indexes are deleted.
// DESTRUCTIVE, optional: remove the // to run it.
// db.getCollection("legacy").drop();

// orders: index old_1 – Only on the right: { old: 1 }
// DESTRUCTIVE, optional: remove the // to run it.
// db.getCollection("orders").dropIndex("old_1");
```

With drops, the two last steps are `// DESTRUCTIVE` followed by the command, uncommented.

Acceptance:

- [ ] The example above gives exactly that script; with **Include drops in the script** on, the drops run.
- [ ] Running the script with drops in a playground on the right database leaves only the differences no command can
  make.
- [ ] The script of a read-only right connection can be copied and opened, and its playground refuses the writes.
- [ ] Two databases with the same structure give the script that says `// Nothing to change: the structures are the
  same.`
