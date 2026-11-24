# The connections view

The tree of the connections view: folders, connections, databases, collections, views and GridFS buckets, with the
filter. The colors of single collections ([D16](../08-decisions.md#d16--a-collections-color-is-kept-on-its-connection),
[proposal 0001](../proposals/0001-collection-colors.md)), what is excluded from searches
([D19](../08-decisions.md#d19--what-is-excluded-from-searches-stays-in-the-tree-and-answers-when-asked-for-by-name)) and
the desktop app's type-ahead have cards for now; the nodes, refreshing, disconnecting and the filter itself are
written when the area is next changed. The connection's own color is `connection.set-color`. The user's side is in
the README's [Features](../../README.md#features), under **Connections › Color**.

The tree is `MongoTreeProvider` in `src/tree.ts`, with one class per kind of node (`CollectionNode` for collections
and views, `BucketNode` for GridFS buckets). The colors of a connection's collections are kept in its entry of
`mongoster.connections` as `collectionColors`, keyed by `database.collection` ([11-data.md](../11-data.md)).

### `tree.set-collection-color` — Set the color of a collection, a view or a bucket

Gives one collection its own color, which takes the place of the connection's for what belongs to that collection.

- **Kind**: Operation
- **Function**: `src/extension.ts › activate` (the `mongoster.setCollectionColor` handler), then `updateConnection`
- **Implemented in**: `src/shared/collectionColors.ts` (`ownColorOf`, `setCollectionColor`, `namespaceOf`,
  `bucketCollection`); `src/shared/colors.ts › colorChoices`; `src/extension.ts` (`askColor`,
  `changeCollectionColors`); `src/connections.ts › ConnectionManager.update`
- **Entry points**: `mongoster.setCollectionColor` (**Set Color…**), the context menu of a collection, a view or a
  GridFS bucket. Hidden from the Command Palette (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem =~ /^(collection|view|bucket)/`, read-only connections included.
- **Asks**: a quick pick **Color of <collection or bucket>**, placeholder **Shown on its tree icon, its tab and its
  documents' tabs, instead of the color of <connection>**, with the eleven presets of `connection.set-color` (each
  with the leaf in its color), **None**, **Connection's Color**, described with the connection's color (or **none**),
  and **Custom Color…** (`connection.custom-color`); the current choice is described **current** (**Connection's
  Color** when the collection has no color of its own).
- **Writes**: `collectionColors` of the connection in `mongoster.connections`: the preset name, the custom `#rrggbb`
  or `none`, under
  `<database>.<collection>`, or under `<database>.<bucket>.files` for a bucket; **Connection's Color** removes the
  entry, and the last entry removes the field.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone from the undo history; choose the previous color again.
- **After**: the tree, the decorations and the open tabs of the connection change at once, as for
  `connection.set-color`.
- **Uses**: `tree.color-of-collection`.
- **Tested by**: `test/unit/collectionColors.test.ts › 'the choices of Set Color… on a collection' › "offers the
  presets, None, Connection's Color described with the connection's, and Custom Color…"`, `› 'marks the current
  choice: none, a preset, or a custom color'`; `› 'the color of a collection' › 'sets a color, and removes it to follow the
  connection again'`, `› 'keys a collection by its namespace, and a bucket by its .files collection'`. The handler
  itself: *none*.

Acceptance:

- [ ] Dismissing the quick pick changes nothing.
- [ ] A bucket and its `<bucket>.files` collection share one color: setting either sets both.
- [ ] The collection's color shows on the surfaces of `tree.color-of-collection` without reopening anything.
- [ ] Mongoster's export carries the colors and its import brings them back (`connection.write-file`,
      `connection.read-file`); **Replace** from a file without them keeps the existing connection's.

### `tree.color-of-collection` — Which color something of a collection takes

The rule every surface of a collection follows: its own color, none, or its connection's.

- **Kind**: Derivation
- **Function**: `src/shared/collectionColors.ts › colorOf`
- **Implemented in**: `src/tree.ts › connectionIcon` (`CollectionNode`, `BucketNode`); `src/connectionColors.ts ›
  ConnectionDecorations` (`provideFileDecoration`, `collectionOf`, `signature`); `src/collectionPanel.ts ›
  CollectionPanel.color`; `src/gridfs.ts › GridFSPanel.color`; `src/docHistory.ts › DocumentHistoryPanel.color`;
  `src/connectionColors.ts › paintTab` (the tab's icon and, in the desktop app, `tabColor`)
- **Tested by**: `test/unit/collectionColors.test.ts › 'the color of a collection' › "takes the collection's own color,
  none for none, otherwise the connection's"`; `› 'the tree' › "colors the icon of a collection, a view and a bucket
  with their own color, or the connection's"`; `› 'the decorations of the editor tabs' › "colors the documents and
  definitions of a collection with its color, the rest with the connection's"`, `› "tells the decorations changed
  when a collection's color changed"`.

Rules:

- Input: the connection (its `color` and `collectionColors`), the database and the collection. Output: a preset, a custom
  color, or none; where VS Code takes only theme colors a custom color shows as its nearest preset
  (`connection.nearest-preset`).
- The collection's entry wins: a color gives that color, `none` gives none even in a colored connection. Without an
  entry the connection's color applies, as before collections had colors.
- A bucket looks up its `<bucket>.files` collection.
- It applies to: the icon of the collection's, view's or bucket's node in the tree (the name keeps the usual color);
  the icon of its collection tab, GridFS tab and document history tabs and the stripe at the top of their content; in
  the desktop app the line above those tabs; the names of the editor tabs of its documents (`mongoster://`) and
  definitions (`mongoster-def://`), whose tooltip stays the connection's name.
- It does not apply to tabs of a whole connection or database (monitor, users, search, advisor, diagram, structure),
  nor to the compare, watch and playground tabs, which keep the connection's color.

Acceptance:

- [ ] The decorations are refreshed when a collection's color changes, and still not when a connection connects.

### `tree.collection-color-follows` — A collection's color follows a rename and goes with a drop

Keeps `collectionColors` in step with the collections Mongoster renames and drops.

- **Kind**: Operation
- **Function**: `src/extension.ts › activate` (the `mongoster.renameCollection`, `mongoster.dropCollection`,
  `mongoster.dropDatabase` and `mongoster.dropGridFSBucket` handlers), through `changeCollectionColors`
- **Implemented in**: `src/shared/collectionColors.ts` (`renameCollectionColor`, `dropCollectionColors`)
- **Entry points**: renaming a collection, dropping a collection or a view, dropping a database, deleting a GridFS
  bucket, from the tree.
- **Writes**: `collectionColors` of the connection: the entry moves to the new name; the entries of the dropped
  collection, of the bucket's `.files` and `.chunks` collections, or of every collection of the dropped database are
  removed. Nothing is written when the collection had no color.
- **Danger**: None of its own; it runs after the rename or drop succeeded.
- **Undo**: Cannot be undone; neither can the drop.
- **Tested by**: `test/unit/collectionColors.test.ts › 'the color of a collection' › 'moves the color of a renamed
  collection, and leaves the map alone without one'`, `› 'forgets the colors of a dropped collection, bucket or
  database'`. The handlers: *none*.

Acceptance:

- [ ] A renamed collection's reopened tab has its color.
- [ ] A collection renamed or dropped outside Mongoster (mongosh, a restore that drops) keeps its entry, which applies
      again to a collection of the same name; removing the connection removes all its entries.

### `tree.exclude` — Exclude from searches, or include again

Leaves connections, databases, collections, views or GridFS buckets out of searches, or puts them back, for what the
user doesn't use or doesn't want searched; several selected nodes at once.

- **Kind**: Operation
- **Function**: `src/extension.ts › activate` (`setExcluded`, the `mongoster.exclude` and `mongoster.include` handlers)
- **Implemented in**: `src/shared/exclusions.ts` (`exclusionKey`, `bucketExclusionKey`, `setExclusions`, `ownExclusion`);
  `src/tree.ts` (`markExcluded`, `ConnectionNode`); `src/connectionColors.ts › ConnectionDecorations.provideFileDecoration`;
  `src/connections.ts › ConnectionManager.update`; in the desktop app `src/standalone/shell/tree.ts` (`select`,
  `selectedWith`) and `src/standalone/vscode/tree.ts › nodeArguments`
- **Entry points**: `mongoster.exclude` (**Exclude From Searches**) and `mongoster.include` (**Include in Searches**), in
  the context menu of a connection, a database, a collection, a view or a GridFS bucket, group `4_organize`. Hidden
  from the Command Palette (`when: false`); with no argument they do nothing. With several nodes selected (Ctrl+click,
  Shift+click; VS Code's `canSelectMany`), they act on all the selected nodes when the one right-clicked is among them.
- **Offered when**: Exclude when `viewItem =~ /^(connection|database|collection|view|bucket)(?!.*\.excluded$)/`, Include
  when the context value ends in `.excluded`: the node has an entry of its own. The collections of an excluded database
  offer Exclude, not Include. Read-only connections included.
- **Writes**: in the connection's entry of `mongoster.connections`, `excluded: true` for a connection (removed by
  Include) and the keys of the others in `exclusions`: `database`, `database.collection`, `database.<bucket>.files` for a
  bucket; sorted, without repeats, and the field removed with its last key. One update per connection.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone from the undo history; Include in Searches puts it back.
- **After**: the tree refreshes: the node's icon and name in `disabledForeground`, `excluded` first in its description
  (`excluded with its database` on the collections of an excluded database), a line in its tooltip; the open global
  search tabs of the connection search without it from their next search.
- **Uses**: `tree.excluded`.
- **Tested by**: `test/unit/exclusions.test.ts › 'the rules of exclusion' › 'keys a database by its name, a collection
  by its namespace and a bucket by its .files collection'`, `› 'adds and removes entries, sorted and without repeats,
  and forgets an empty list'`; `› 'the tree' › 'dims an excluded collection, view or bucket and offers Include in
  Searches'`, `› 'dims the collections of an excluded database without offering to include them one by one'`, `› 'dims
  an excluded connection and says so'`, `› 'offers Exclude From Searches and Include in Searches, and keeps the other
  entries, on excluded nodes'`; `› 'the decorations' › 'dim the names of what is excluded, and leave the rest below a
  connection alone'`, `› 'tell the decorations changed when what is excluded changed'`. The handler and the selection
  of several nodes: *none*.

Acceptance:

- [ ] Excluding `shop.logs` and `archive` together from a selection of both writes `exclusions: ["archive",
      "shop.logs"]` on their connection.
- [ ] An excluded node keeps every other entry of its context menu.
- [ ] Mongoster's export carries `excluded` and `exclusions` and its import brings them back (`connection.write-file`,
      `connection.read-file`); Compass's format and a list leave them out and say so; **Replace** from a file without them
      keeps the existing connection's.

### `tree.excluded` — What searches leave out

The rule every search across connections, databases or collections follows: what is excluded is left out, unless it
is what was asked for by name.

- **Kind**: Derivation
- **Function**: `src/shared/exclusions.ts › isExcluded`, `› leaveOutExcluded`
- **Implemented in**: `src/tree.ts › MongoTreeProvider` (`matches`, `databases`, `collections`), `› ConnectionNode`;
  `src/search.ts › SearchPanel.collections`, `src/webview/search.ts › renderSummary`; `src/mcpTools.ts`
  (`list_connections`, `list_databases`, `list_collections`)
- **Tested by**: `test/unit/exclusions.test.ts › 'the rules of exclusion' › 'excludes a database with its collections,
  and a collection alone'`, `› 'leaves the excluded out of a search over a deployment or a database'`; `› "the tree's
  filter" › 'leaves out the excluded databases and collections'`, `› 'shows everything, dimmed, without a filter'`; `›
  'the lists of the MCP server' › 'leave out the excluded connections, databases and collections'`, `› 'still answer
  for what is asked for by name, and say when everything is excluded'`. The search tab: *none*.

Rules:

- Input: the connection (`excluded`, `exclusions`), a database, maybe a collection. A collection is excluded by its own
  entry or by its database's; a database by its own; the connection by `excluded`, which says nothing of what is in it.
- The tree shows everything, dimmed. Its filter never matches an excluded database or collection, and doesn't open
  (so doesn't connect) an excluded connection; opened by hand, it shows what matches.
- The global search over a deployment leaves out the excluded databases and collections; over a database, its excluded
  collections, even when the database itself is excluded; on a collection, reads it. The summary says how many were left
  out: `2 excluded`.
- `list_connections` leaves out the excluded connections (`The user excluded every connection saved in Mongoster from
  searches.` when none is left); `list_databases` and `list_collections` the databases and collections with an entry of
  their own. Every tool given a name answers as before.
- Not left out: backups, exports, scheduled tasks, the relationship diagram, the structure comparison, the monitor.

Acceptance:

- [ ] With `exclusions: ["archive", "shop.logs"]`, the filter `o` shows `shop` with `orders` and `test`, not `archive` nor
      `logs`.
- [ ] `Search Documents…` on the connection reads neither `archive` nor `shop.logs`; on `archive`, reads its collections;
      on `shop.logs`, reads it.

### `tree.exclusion-follows` — An exclusion follows a rename and goes with a drop

Keeps `exclusions` in step with the collections Mongoster renames and drops.

- **Kind**: Operation
- **Function**: `src/extension.ts › activate` (the `mongoster.renameCollection`, `mongoster.dropCollection`,
  `mongoster.dropDatabase` and `mongoster.dropGridFSBucket` handlers), through `changeCollectionColors`
- **Implemented in**: `src/shared/exclusions.ts` (`renameExclusion`, `dropExclusions`)
- **Entry points**: renaming a collection, dropping a collection or a view, dropping a database, deleting a GridFS
  bucket, from the tree.
- **Writes**: `exclusions` of the connection, in the same update as `collectionColors`: the entry moves to the new name;
  the entries of the dropped collection, of the bucket's `.files` and `.chunks` collections, or of the database and all
  its collections are removed. Nothing is written when there was no entry.
- **Danger**: None of its own; it runs after the rename or drop succeeded.
- **Undo**: Cannot be undone; neither can the drop.
- **Tested by**: `test/unit/exclusions.test.ts › 'the rules of exclusion' › 'moves the entry of a renamed collection,
  and leaves the list alone without one'`, `› 'forgets the entries of a dropped collection, bucket or database'`. The
  handlers: *none*.

Acceptance:

- [ ] A collection renamed or dropped outside Mongoster keeps its entry, which applies again to a collection of the same
      name; removing the connection removes all its entries.

### `tree.type-ahead` — Move to a node by typing its first letters

In the desktop app's tree, typing a letter moves to the next shown node whose name starts with it; VS Code's trees
have their own.

- **Kind**: Derivation
- **Function**: `src/shared/typeAhead.ts › typeAheadTarget`, `› typedText`
- **Implemented in**: `src/standalone/shell/tree.ts` (`typeAhead`, the tree's `keydown`)
- **Tested by**: `test/unit/exclusions.test.ts › "the type-ahead of the desktop app's tree" › 'moves to the next name
  starting with the letter, round to the first, ignoring case'`, `› 'goes to the next one when the same letter is typed
  again, and refines the name with other letters'`, `› 'starts a new name after a pause'`. The keys in the shell:
  *none*.

Rules:

- Input: the names of the nodes shown (open ones' children included), the focused one, the letters typed. Output: the
  node to move to and select, or none (nothing moves).
- A letter typed within `TYPE_AHEAD_RESET_MS` (1 second) of the previous one is added to them; after a pause it starts
  again.
- The same letter repeated (`o`, `oo`) moves to the next node starting with it after the focused one, round to the first.
  Different letters (`or`, `ord`) look from the focused node on, so it stays while it still matches. Case is ignored.
- Keys with Ctrl, Alt or Cmd, the space and keys longer than one character (arrows, `Enter`) are not typed.
- Examples, with `local`, `Orders`, `orders_2019`, `products`, `Shop`, `sessions`: from `local`, `o` → `Orders`; again `o`
  → `orders_2019`; again → `Orders`; from `Orders`, `orders_` → `orders_2019`; from `Shop`, `ss` → `sessions`.
