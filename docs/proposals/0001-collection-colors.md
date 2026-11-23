# 0001 — The color of a collection

**Status**: accepted (D16)

## Summary

`Set Color…` on a collection, a view or a GridFS bucket in the tree gives it one of the six colors of
`connection.set-color`, `None` to show it without a color in a colored connection, or `Connection's Color` to go
back to the connection's. The collection's color takes the place of the connection's wherever something of that
collection alone is shown: its icon in the tree, the icon and stripe of its tab (and the desktop app's line above it),
the names of its documents' and definitions' editor tabs, its document history tabs. The colors are kept on the connection, in `mongoster.connections`, as a map from `database.collection` to
a color or `none`, so that export and import in Mongoster's format carry them and removing the connection removes them.

## Why

A connection's color tells production from staging. Inside one connection the user wants to tell some collections
apart too: the ones that must not be touched by hand (`payments`, `audit`), the ones being migrated, the ones a team
works on. Today every collection of a connection looks the same, and so do all the tabs open on it.

## What changes for the user

- New area card file `docs/features/02-tree.md` (`tree.`), the first cards of that area:
  - `tree.set-collection-color` — Set the color of a collection, a view or a bucket (Operation).
  - `tree.collection-color-follows` — The color follows a rename and goes with a drop (Operation, the cleanup done
    by the rename and drop handlers).
  - `tree.color-of-collection` — Which color something of a collection takes (Derivation: the pure rule of
    `src/shared/collectionColors.ts`).
- `connection.set-color`: its acceptance says that a collection's own color wins over the connection's for that
  collection's icon, tabs and editor tabs; the decorations change also when a collection's color does.
- `connection.export`, `connection.write-file`, `connection.read-file`, `connection.import`: Mongoster's format writes and
  reads `collectionColors`; Compass's format and the list leave them out, with the note *colors of collections were
  left out*.
- README `Features` (Connections › Color), a bullet in `## Unreleased`.

## Design

**Data.** `ConnectionInfo` gets an optional `collectionColors?: Record<string, CollectionColor>`, keyed by the
namespace `database.collection`, where `CollectionColor` is a `ConnectionColor` or `'none'` (no color, even in a
colored connection). A database name cannot contain a `.`, so the first dot separates the two even when
the collection's name has dots (`fs.files`). A GridFS bucket `fs` takes the color of its `fs.files` collection:
`Set Color…` on the bucket sets that one, and the GridFS tab looks it up. An empty map is removed, like the other
optional fields in `ConnectionManager.update`.

**Pure part**, `src/shared/collectionColors.ts` (no vscode): `namespaceOf(database, collection)`,
`bucketCollection(bucket)` (`<bucket>.files`), `colorOf(connection, database, collection)` (the collection's color,
none for `'none'`, else the connection's), `collectionColorChoices(connectionColor, current)` (the quick pick's
items), `setCollectionColor(map, ns, color | undefined)`, `renameCollectionColor(map, from, to)`,
`dropCollectionColors(map, database, collection?, bucket?)` (one collection, a bucket's two collections, or all of a
database), and `readCollectionColors(value)` that keeps only entries with a valid namespace and one of the six colors
or `none` (used by the import). Each returns a new map, the same one when nothing changes, or `undefined` when
empty.

**Host part.**

- A new command `mongoster.setCollectionColor` (**Set Color…**), on `viewItem =~ /^(collection|view|bucket)/`, hidden
  from the Command Palette (`when: false`) like `mongoster.setColor`; with no argument it does nothing. Quick pick
  **Color of <collection>**, the six colors after their circles, **None**, then **Connection's Color** described
  with the connection's color (`red`, or `none`); the current choice is described **current**. It writes through
  `updateConnection`, so every open tab of the connection hears it as today.
- `src/tree.ts`: `CollectionNode` and `BucketNode` take their icon's color from `colorOf`. Names keep the usual color,
  as for the connection's color.
- `src/connectionColors.ts`: `ConnectionDecorations.provideFileDecoration` reads the database and collection from the
  documents' and definitions' URIs (`/<database>/<collection>/…`, already there) and colors with `colorOf`; its
  signature includes `collectionColors`, so a change of one refreshes the decorations. Playgrounds keep the
  connection's color.
- The collection tab (`CollectionPanel`), the GridFS tab (`GridFSPanel`) and the document history tab
  (`DocumentHistoryPanel`) paint with `colorOf`; the collection and GridFS webviews already draw their stripe from the
  `color` of their `init`, which becomes the collection's color. The collection tab computes it from its connection
  each time it paints, instead of keeping a copy in `CollectionTarget.color`, which goes. The other tabs (monitor, users, watch, search, advisor,
  diagram, compare, structure, playground result) belong to a connection or a database and keep the connection's
  color.
- **Rename** from Mongoster (`mongoster.renameCollection`): the color moves to the new name, next to
  `moveCollectionState`. **Drop** from Mongoster (`mongoster.dropCollection`, `mongoster.dropDatabase`,
  `mongoster.dropGridFSBucket`): the color is removed. A rename or drop done elsewhere (mongosh, a restore that drops)
  leaves the entry; it comes back if a collection of the same name is created again. That is the same behaviour as
  RS4's keys, but bounded by the collections the user colored by hand.
- **Desktop app**: nothing of its own. `tabColor` is set by `paintTab`, which now gets the collection's color; the
  quick pick and the menus come from `package.json`.
- **Export and import**: `PortableConnection` gets `collectionColors`; `serializeConnections` writes it in Mongoster's
  format; `fromMongoster` reads it through `readCollectionColors`; `connectionsTransfer.ts` passes it through both ways
  (an import with **Replace** takes the file's colors, and keeps the existing ones when the file has none, as
  Compass's format and the list never do). This touches `src/shared/connectionsFile.ts` in a few small places only.

**Old form (11-data.md).** The field is optional: a `mongoster.connections` written by an older version has no
`collectionColors` and reads as *no collection has a color*. An older version reading a newer list keeps the field,
because `ConnectionManager.update` spreads the stored entry; it just does not show the colors. A Mongoster export
without the field imports as today; an older Mongoster reading a newer export ignores the unknown field. No migration.

## Alternatives

- **A `globalState` key per collection** (`mongoster.color.<connection>/<database>/<collection>`), like the layout.
  It would follow the other four keys in `moveCollectionState`, but export and import would not carry the colors,
  removing a connection would leave them behind (RS4 grows), and nothing would tell the decorations and the open tabs
  that a color changed: `ConnectionManager.onDidChange` and `updateConnection` already do. Not chosen.
- **A key of its own in `globalState` with all the collection colors** (`mongoster.collectionColors`). Same problems
  of export and removal, with one more key to keep in step with the connections. Not chosen.
- **The color on the bucket's own key** (`database.fs` instead of `database.fs.files`). It could clash with a
  collection named `fs`, and the `fs.files` collection listed below the bucket would have another color than the
  bucket. Not chosen.
- **Without `None`** (six colors and `Connection's Color` only, as the roadmap said). The user asked for `None` when
  accepting: a collection of a red connection can be shown plain.
- **Coloring the collection's name in the tree too.** The connection's color colors only the icons below it, to keep
  the tree readable; the same rule here.

## Costs

- `ConnectionInfo` and `PortableConnection` grow by one field; `mongoster.connections` grows by one entry per colored
  collection.
- A few places of `src/shared/connectionsFile.ts`, which item 1 of M2 also changes: the merge is by hand, but small.
- `CollectionTarget` loses its `color`: the places that built one with `color: info.color` drop that line.
- 11-data.md: the row of `mongoster.connections` says the field; Mongoster's connection file gains an optional field.
- RS4 is not fixed: the other four keys of a dropped collection still stay. The colors do not add to it, because they
  go with a drop from Mongoster and with the connection.

## Open questions

- Should a watch tab on a single collection take the collection's color? Proposed: no for now, it belongs to the
  watch area.
