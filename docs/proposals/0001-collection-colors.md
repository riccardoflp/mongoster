# 0001 — The color of a collection, more colors and a color picker

**Status**: revision 1 (the color of a collection) accepted (D16); revision 2 (more colors and a color picker) accepted
(D17)

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

## Revision 2 — More preset colors and a color picker

Asked by the user after revision 1 was accepted: more preset colors, and a color picker, for connections as well as
collections.

### Summary

Five more presets, **Pink**, **Teal**, **Indigo**, **Brown** and **Gray**, eleven in all: four are the Compass colors
Mongoster lacked, so Compass's connections now import and export with their own color. And **Custom Color…**, the
last choice of both `Set Color…` quick picks, opens a small **Choose a Color** tab with the system's color picker
(`<input type="color">`), a `#rrggbb` field, the eleven presets and a preview; **Apply** saves the color and closes
the tab. A custom color is exact wherever Mongoster draws it itself (the stripe at the top of its tabs, the desktop
app's line above them, the dot in the scheduled tasks); where VS Code only takes a theme color (the icons and names in
the tree, the tab icons, the names of editor tabs) it shows as the nearest of the eleven presets.

### Why

Six colors are few when a user has many connections (one per customer, per environment) or wants a collection to
stand apart from its connection. Compass users bring teal, iris, pink and gray connections, which today become green,
blue, purple and no color.

### What changes for the user

- `connection.set-color` and `tree.set-collection-color`: eleven presets and **Custom Color…**; the items show the
  leaf in their color instead of an emoji circle (only six colors have one).
- A new card `connection.custom-color` (the **Choose a Color** tab, View) and `connection.nearest-preset`
  (Derivation: the preset a custom color shows as where only theme colors are taken).
- `connection.color-from-compass`: `color2`/`teal` → **Teal**, `color4`/`iris` → **Indigo**, `color7`/`pink` →
  **Pink**, `color10` → **Gray** (no color before); export writes those codes back; a custom color is written as the
  nearest Compass code. A hex color in a Compass or Mongoster file is kept as a custom color in Mongoster's own
  format, and still taken to the nearest preset from Compass's.
- `connection.write-file`, `connection.read-file`: `color` and the values of `collectionColors` may be a preset name
  or `#rrggbb`.
- README (Connections › Color), a bullet in `## Unreleased`, glossary (*color*, *preset*, *custom color*).

### Design

**The colors.** A color is a preset name or a custom `#rrggbb` (lower case, six digits):
`type Color = PresetColor | HexColor`. The six old presets stay the theme's `charts.<name>`; the five new
ones are contributed in `package.json` › `contributes.colors` as `mongoster.color.<name>`, with dark, light and high
contrast defaults chosen to read on both (pink `#f075b5` / `#c2185b`, teal `#4ec9b0` / `#00897b`, indigo `#8c9eff` /
`#3949ab`, brown `#c8956b` / `#8d6e63`, gray `#a6a6a6` / `#6e6e6e`), so a theme can change them like any color.
`themeColorOf(color)` becomes: a preset's theme color, or for a custom color its nearest preset's. Pure parts go in
`src/shared/colors.ts` (no vscode): the list of presets, `isColor`, `normalizeHex` (`#abc` → `#aabbcc`),
`nearestPreset(hex)` (by hue, as `colorFrom` does today; grays below a saturation go to **Gray**), and
`cssColorOf(color)` (`var(--vscode-charts-red, #f14c4c)`, `var(--vscode-mongoster-color-pink, #f075b5)` or the hex).
`colorFrom` in `connectionsFile.ts` uses them.

**Surfaces.**

| Where | Preset | Custom color |
| --- | --- | --- |
| Tree: connection's icon and name, icons below it | its theme color | nearest preset |
| Names of editor tabs (documents, definitions, playgrounds) | its theme color | nearest preset |
| Tab icons (the leaf) | `media/connection/<name>-light|dark.svg`, five new pairs | nearest preset's leaf |
| Stripe at the top of a tab's content, the dot of scheduled tasks | the theme's variable | exact |
| Desktop app: the line above a tab (`tabColor`) | the theme's variable | exact |

The webviews stop listing the colors in CSS (`body[data-color='red'] { --conn-color: … }` in `webview.css`,
`monitor.css`, `compare.css`, `playground.css`, `scheduledTasks.css`): the host still sends `color`, and one helper
of `src/webview/` sets `--conn-color` to `cssColorOf(color)` (CSSOM, allowed by the CSP) and `data-color` for the
rules that test whether there is a color. `tabColor` in the desktop app accepts a CSS color string besides a
`ThemeColor` (it is the app's own property). Exact tab icons for custom colors were left out: VS Code would need an
SVG written per color in global storage, and the desktop app serves icons only from `dist/` and `media/`.

**The quick picks.** Both `Set Color…` list the eleven presets with `iconPath` set to their leaf (light and dark),
then **None** (connection: no color; collection: plain), for a collection **Connection's Color**, then **Custom
Color…** (described with the current custom color when there is one). The desktop app's quick input learns to draw
an item's `iconPath` (`src/standalone/vscode/ui.ts`, `src/standalone/shell/quickInput.ts`).

**The Choose a Color tab** (`src/colorPicker.ts`, `src/webview/colorPicker.ts`, `media/colorPicker.css`, following
*A new tab* of AGENTS.md: messages `ColorPickerHostMessage` / `ColorPickerViewMessage`, a bundle entry and a
`.vscodeignore` line). One tab at a time, titled **Color of <name>**, painted with the color being chosen. It shows
the native color input, a `#rrggbb` field kept in step with it (an invalid value disables **Apply** and says
**Enter a color as #rrggbb**), the eleven presets as swatches, a preview of the stripe and of the leaf as it will
look where only presets are taken (**Shown as <preset> in the tree and on tab icons**), and **Apply** / **Cancel**.
`Set Color…` waits for it like a quick pick: **Apply** writes through `updateConnection` (connection) or
`changeCollectionColors` (collection), closing the tab or **Cancel** writes nothing. Its host part is a function
`pickCustomColor(context, title, current): Promise<string | undefined>`.

**Old form (11-data.md).** The old six names keep their meaning; nothing is migrated. A list written by an older
version reads as before. An older version reading a newer list with a new preset or a hex shows the connection
without a color (its icon path for an unknown name is missing: the tab falls back to an empty icon), and keeps the
value when it rewrites the entry; that is the downgrade cost. An older Mongoster importing a newer export maps a hex
to its nearest old preset (`colorFrom` already reads hex) and drops a new preset name.

### Alternatives

- **Exact custom colors everywhere** with SVGs generated per color in global storage (tab icons) and codicon SVGs
  copied from `@vscode/codicons` and colored (tree icons), plus a route of the desktop app's protocol for them.
  Names in the tree and editor tabs still cannot: `FileDecoration` takes only theme colors. Much more for icons
  16 pixels wide; can come later without changing the data.
- **Only an input box for `#rrggbb`** instead of the tab: cheaper (no new tab), but it is not the color picker the
  user asked for.
- **Custom colors contributed as theme colors**: `contributes.colors` is fixed in `package.json`; a user's colors
  cannot be added at run time.
- **More presets (cyan, lime, magenta…)**: they come too close to blue, green and purple to tell apart at 16 pixels
  in both themes; the picker covers the rest.
- **Emoji circles in the quick pick**: Unicode has circles for seven colors only (no pink, teal, indigo, gray).

### Costs

- A new tab (four files, a bundle entry) for a rarely used dialog.
- The CSS of five webviews and the message handler of each tab that draws a stripe change (one line each); the
  collection tab's webview is touched in its `init` handler only.
- The desktop app: `contributes.colors` must be read into its theme's CSS variables (`--vscode-mongoster-color-*`),
  since `cssColor` maps theme colors to variables; quick pick items draw `iconPath`; `tabColor` takes a string.
- Downgrading Mongoster loses the display of new presets and custom colors, not the values.
- `src/shared/connectionsFile.ts` (`colorFrom`, `TO_COMPASS`, the Mongoster entry's color) changes again.

### Open questions

- Should **Custom Color…** also remember the last few custom colors as swatches in the tab? Proposed: no, for now.
