# The connections view

The tree of the connections view: folders, connections, databases, collections, views and GridFS buckets, with the
filter. Only the colors of single collections have cards for now ([D16](../08-decisions.md#d16--a-collections-color-is-kept-on-its-connection),
[proposal 0001](../proposals/0001-collection-colors.md)); the nodes, refreshing, disconnecting and the filter are
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
