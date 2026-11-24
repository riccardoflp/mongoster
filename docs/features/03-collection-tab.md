# The collection tab

The tab of a collection or a view: the table, the query bar, the pipeline editor and the other sections. The user's
side is in the README's [Features](../../README.md#features). This area is one of those written when it is next
changed ([07-roadmap.md](../07-roadmap.md)): it has the cards of conditional formatting only, from proposals
[0002](../proposals/0002-conditional-formatting.md) and
[0003](../proposals/0003-formatting-by-field-scopes-and-pane.md) (D18, D21 in [08-decisions.md](../08-decisions.md));
the table, the query, the
builder, the pipeline and the columns get theirs when they change. The place of the query, above or beside the
results, and dropping a field on Sort or Project have theirs since they changed.

Conditional formatting writes nothing to the database. Its rules are Mongoster's own state, kept for the user in
`globalState`, one key per formatting scope (`mongoster.formatting.<connection>/<database>/<collection>`,
`mongoster.formattingDatabase.…`, `mongoster.formattingConnection.…`, `mongoster.formattingGlobal`:
[11-data.md](../11-data.md), `src/formattingStore.ts`), sent to the webview with `init` (`formatting`, the four
lists) and stored back with `{ type: 'saveFormatRules', changes }`, the lists of the scopes that changed
(`src/shared/messages.ts`). The decision of which row and cell gets which color is pure, in
`src/shared/formatting.ts`, `src/shared/formatField.ts` and `src/shared/match.ts`; `renderGrid` in
`src/webview/main.ts` only sets it on the document's `tbody` and on the cells (`applyPaint`: `data-fmt`, and a
strength or a mixed color for scales and shades), and `media/webview.css` paints them.

### `query.format-rules` — Add, edit, name, reorder, move between scopes and turn off formatting rules

The user keeps lists of formatting rules that color the rows or cells of the table, for a collection, a database, a
connection and everywhere, and edits them in the Formatting pane beside the table.

- **Kind**: Operation
- **Function**: `src/webview/formatting.ts › FormattingPaneUi` (`addCondition`, `addField`); stored by
  `src/collectionPanel.ts › CollectionPanel.onMessage` (`case 'saveFormatRules'`, `case 'saveFormattingOff'`,
  `case 'saveFormattingPane'`).
- **Implemented in**: `src/shared/formatting.ts › readFormatRules`, `conditionError`, `newRuleId`, `ruleSummary`,
  `readFormattingPane`, `moveRule`, `scopeOfRule`, `readScopedChanges`, `readScopesOff`; `src/formattingStore.ts ›
  readFormatting`, `writeFormatting`, `scopeReaches`, `removeConnectionFormatting`; `src/webview/main.ts ›
  saveFormatRules`, `saveFormatOff`, `compileFormat`, `formatCells`, `fieldItems`;
  `src/collectionPanel.ts › formattingStateKey`, `FORMATTING_PANE_KEY`, `moveCollectionState`, `postInit`;
  `src/shared/messages.ts`; `media/webview.css`.
- **Entry points**: the `Formatting` button in the bar above the table (`Formatting (n)` with `n` rules on,
  `Formatting (off)` while the colors are hidden), which opens and closes the Formatting pane at the right of the
  table; in the pane, `+ Add Rule…` → `Condition…` or `By Field…`, `Hide Formatting` / `Show Formatting`, `✕`, the
  four sections `This collection`, `Database <name>`, `Connection <name>`, `Everywhere`, each with a checkbox and its
  count, and on a rule `⋯` → `Move To ▸` / `Copy To ▸` → `This Collection`, `This Database`, `This Connection`,
  `Everywhere`; in a
  column header's right-click menu, `Color by This Field` and `Format Cells…` (tooltip `Color the cells of <field>
  when the document matches a condition`).
- **Offered when**: always, in every mode, on views and on read-only connections: nothing is written to the database.
- **Asks**: nothing in a dialog. A rule is a line of the pane (drag handle, checkbox, its colors, `Row`, `Cell` or
  the field, its name or else its condition or `by <field>` on one line, cut with an ellipsis and whole in the
  tooltip, `✕`); clicking the line opens it in place:
  - both kinds: `Name` (`F2` on the line goes to it);
  - a condition rule: `Color the cell of` a field (empty: the whole row; the page's columns are offered), `When the
    document matches` a filter in mongosh syntax (with the query bar's coloring and autocompletion), a color among
    eleven. A new rule takes the first color no condition rule uses yet. `Format Cells…` adds one for that column's
    cell with the condition `{ <field>: <the selected cell's value> }` when a cell of that column is selected, else
    `{ <field>: { $exists: true } }`;
  - a field rule: `Field`, `Color` (`The cell`, `The whole row`), `As` (`Automatic (…)`, `A color per value`, `A
    scale, for numbers and dates`, `True and false`), then what `query.format-field` needs for that kind: `Swap
    Colors`; `Scale`, its color, the two ends and `From This Page`; `Palette`, the legend whose colors pin a value,
    `Unpin` and `+ Pin a Value…`. `Color by This Field` adds one in `Automatic` for that column: the first field rule
    of the list colors the row, the next ones their cell, and a scale takes its ends from the page.
- **Reads**: the rules of the four scopes from `globalState`, through `readFormatRules`, and the scopes the
  collection leaves out, when the tab opens and when its connection changes; the pane's state from `mongoster.formattingPane`, through `readFormattingPane`.
- **Writes**: no database. The whole list of each scope that changed, in its order, to that scope's key at each
  change (add, edit, name, remove, reorder, move, copy, turn on or off), as it is typed; a key is removed when its
  list is empty. A new rule is the collection's. Moving a rule to another scope takes it out of the first and keeps
  its id; a copy gets a new id; either goes beside the rule it is dropped on, or last. The scopes a section's
  checkbox leaves out, per collection, to `mongoster.formattingOff.…`. The pane's state (open, width,
  colors hidden) to `mongoster.formattingPane`, for every collection's tab: the other open tabs follow at once.
- **Danger**: None. Removing a rule asks nothing; turning it off keeps it aside.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: the undo history is for writes to databases; a removed rule is made again.
- **redis-oplog**: Not published.
- **After**: the table is colored again at once, the legends follow the page shown, and the button's count changes
  (the rules on, of the scopes the collection takes). The other open tabs a changed scope reaches (the same
  database, the same connection, all) are colored again too. A collection's rules and the scopes it leaves out follow
  a renamed collection (`moveCollectionState`) and stay when it is dropped (RS4); `Remove Connection` removes the
  rules of the connection and of its databases.
- **Refuses**: a condition that does not parse (`Invalid syntax: …`) or that `query.match` refuses (its message),
  shown under it: the rule keeps its last usable condition, and a new rule is not stored until it has one; a field
  starting with `$` or, for a field rule, empty (the box is outlined, the rule unchanged); an end of a scale that is
  not a number or a date; a 101st rule in a scope (`A collection keeps at most 100 formatting rules.`, or `<section>
  keeps at most 100 formatting rules.` for a move or a copy, at the top of the pane).
- **Uses**: `query.format-table`, `query.format-field`, `query.format-transfer`, `query.match`.
- **Tested by**: `test/unit/formatting.test.ts › 'query.format-rules: the stored rules'`, `'query.format-rules: field
  rules and the pane'`, `'query.format-rules: scopes'` (`readFormatRules`, `conditionError`, `readFormattingPane`,
  `moveRule`, the store). The pane itself: none.

Acceptance:

- [ ] Stored rules are read back as written; an entry without a string id or condition, with an unknown color, or
  with an id already seen is dropped, unknown properties are dropped, anything but an array is no rules, and at most
  100 rules are kept.
- [ ] `conditionError('{ a: { $where: 1 } }')` is `$where is not supported in a formatting rule.`; an empty
  condition is `Type a condition, such as { status: "failed" }.`
- [ ] A value recorded from the first version (`[{ id, condition, color }, { id, condition, field, color, enabled:
  false }]`) is read unchanged.
- [ ] A field rule with a scale, pinned values, a palette and a name is read back as written; one with an unknown
  target, mode, palette or scale color keeps its field with `cell` and `auto`; a pinned entry without a string value
  or a known color, or seen already, is dropped; an entry of a kind that is neither is dropped.
- [ ] `readFormattingPane(undefined)` is closed, 320 px, colors shown; a width of 5000 is kept as 700.
- [ ] Moving the collection's rule `a` to everywhere leaves the collection `b` and makes the global list `g`, `a`;
  beside `g`, `a`, `g`. A copy to the connection leaves the collection as it was and adds a rule with a new id.
- [ ] Moving or copying into a scope that has 100 rules is refused; reordering within it is not.
- [ ] The rules of `c1/shop/orders` written in the four scopes are read from `c1/shop/customers` without the
  collection's, and from another connection with the global ones only; removing `c1` removes its connection's and
  its databases' rules and keeps its collections' and the global ones.
- [ ] A changed database scope reaches the other collections of that database only; a connection's, every
  collection of the connection; the global one, every tab.

### `query.format-transfer` — Export formatting rules to a file and import them

The user writes formatting rules to a file to share them, and adds the rules of such a file to their own.

- **Kind**: Operation
- **Function**: `src/formattingTransfer.ts › exportFormatting`, `importFormatting`
- **Implemented in**: `src/shared/formattingFile.ts › formattingFile`, `readFormattingFile`, `mergeImport`,
  `groupLabel`, `importSummary`; `src/collectionPanel.ts › CollectionPanel.onMessage` (`case 'exportFormatting'`,
  `case 'importFormatting'`), `formatRulesChanged`; `src/webview/formatting.ts › FormattingPaneUi` (the `⋯` menu).
- **Entry points**: `⋯` at the top of the Formatting pane → `Export Formatting…`, `Import Formatting…`.
- **Offered when**: always, also on views and read-only connections: nothing is written to the database.
- **Asks**: export: `Choose the rules to export`, the scopes that have rules (`Collection <name>`, `Database <name>`,
  `Connection <name>`, `Everywhere`, each with its count, all ticked), then where to save
  `<collection>.mongoster-formatting.json`. Import: the file, then `Choose the rules to import`, the file's groups
  with their counts, all ticked, then `Where do the rules go?`: `The Same Scopes` (each group in its own scope of the
  tab's connection, database and collection, whatever names the file has) or `All Into` one of the four.
- **Reads**: the rules of the four scopes from `globalState`; for an import, the chosen file, 1 MB at most.
- **Writes**: no database. Export: the file, JSON, `{ mongosterFormatting: 1, groups: [{ scope, database?,
  collection?, rules }] }`, the widest scope first, with nothing of the connection (no id, no name, no host). Import:
  the lists of the scopes that got rules, to their `globalState` keys.
- **Danger**: None: an import adds rules after the ones already there, each with a new id, and replaces none.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone; an imported rule is removed in the pane.
- **redis-oplog**: Not published.
- **After**: export: `<n> rules exported to <file>. The file has nothing of the connection: no name, no address, no
  password.` Import: `Imported <n> formatting rules, <m> were already there.`, with `<k> rules could not be read.`
  and `<j> rules did not fit: a scope keeps at most 100.` when so; this tab and the other open tabs the scopes reach
  are colored again.
- **Refuses**: export with no rule in any scope (`There are no formatting rules to export.`); a file over 1 MB, that
  is not JSON (`The file is not JSON: …`), not a formatting file (`The file is not a file of formatting rules exported
  from Mongoster.`), or of a later version (`The file was exported by a newer Mongoster: update Mongoster to import
  it.`); a file without a usable rule (`The file has no formatting rules.`).
- **Uses**: `query.format-rules`.
- **Tested by**: `test/unit/formatting.test.ts › 'query.format-transfer'` (the file and the merge). The questions and
  the dialogs: none.

Acceptance:

- [ ] The file of a collection with rules in the collection, the database and everywhere has the groups `global`,
  `database` (with the database's name) and `collection` (with both names), in that order, and is read back as
  written.
- [ ] From a group with a usable rule (with an unknown property), a rule without a condition and a string, the first
  is kept without the property and two are counted as dropped; a group of an unknown scope is dropped with its rules.
- [ ] `[]`, an object without `mongosterFormatting`, a version 2 and a text over 1 MB are each refused with their
  message.
- [ ] Importing three rules where one equals a rule already there (all but its id) adds two with new ids after the
  existing ones and counts one as already there; importing the same file again adds none.
- [ ] Importing two rules into a scope that has 99 adds one and counts one as not fitting.

### `query.format-table` — Color the table by the formatting rules

The rows and cells take the color of the first rule that gives them one: a condition rule whose condition the
document matches, or a field rule whose field has a value.

- **Kind**: View
- **Function**: `src/shared/formatting.ts › TableFormat` (`rowPaint`, `cellPaint`), `rulesInOrder`
- **Implemented in**: `src/shared/formatting.ts › withElement`, `paintLevel`; `src/webview/formatting.ts ›
  applyPaint`; `src/webview/main.ts › renderGrid`, `compileFormat`, `formatCell`; `media/webview.css` (`[data-fmt]`).
- **Entry points**: the table, in `Find` and in the output of `Aggregate`, each time it is drawn.
- **Uses**: `query.match`, `query.format-field`, `query.format-rules`, `connection.set-color` (the same eleven
  colors).
- **Tested by**: `test/unit/formatting.test.ts › 'query.format-table'`, `'query.format-table: field rules'`,
  `'query.format-table: scopes'`.

Rules:

- The first enabled row rule whose condition matches the document colors its row: every cell of the document's
  sub-rows, not the row number.
- The first enabled cell rule of a field whose condition matches colors that field's cell, over the row's color. The
  condition is about the whole document: `{ status: "failed" }` on the field `amount` colors the `amount` cell of the
  failed documents.
- In an expanded array, a cell rule of a field of the elements is matched against the document with the array
  replaced by that one element: `{ "items.qty": { $gt: 5 } }` on `items.qty` colors the `qty` of the elements over 5
  only. The `… more elements` cell and the filler under the last element are not colored.
- A field rule colors the row, or its field's cell, of the documents where the field has a value
  (`query.format-field`), and gives nothing to the others, which the rules after it may color. Rules of both kinds
  are in one order: the first that gives a color wins.
- In an expanded array, a field rule of a field of the elements colors each element's cell by that element's value.
- The rules are tried scope by scope, the nearest first: the collection's, the database's, the connection's, the
  ones for everywhere, each list in its order, without the scopes the collection leaves out (`rulesInOrder`).
- A rule turned off, or whose condition can't be used, colors nothing; the pane marks the second with `⚠` and the
  reason. While `Hide Formatting` is on, no rule colors anything.
- The colors are the eleven presets, theme colors (`--vscode-charts-red` …, `--vscode-mongoster-color-pink` …), mixed
  into the background so the text keeps the theme's foreground: 12 % for a row and 28 % for a cell, so that a cell
  reads on a colored row; a scale or a shade goes from 4 % to 22 % on a row and from 6 % to 45 % on a cell; a
  pinned cell stays opaque; a missing field keeps its hatching; hovering, a selected
  row and the selected cell show over the color.

Examples:

| Rules, in order | Document | Row | Cell `amount` |
| --- | --- | --- | --- |
| row `{ status: "failed" }` red; row `{ amount: { $gt: 1000 } }` yellow | `{ status: "failed", amount: 5000 }` | red | red (the row's) |
| the same | `{ status: "ok", amount: 5000 }` | yellow | yellow |
| row `{ status: "failed" }` red; `amount` `{ amount: { $gt: 1000 } }` green | `{ status: "failed", amount: 5000 }` | red | green |
| row `{}` red, turned off; row `{}` blue | `{ a: 1 }` | blue | blue |

Acceptance:

- [ ] With the row rules `{ status: "failed" }` red and `{ amount: { $gt: 1000 } }` yellow, `{ status: "ok", amount:
  5000 }` is yellow and `{ status: "ok", amount: 5 }` is not colored.
- [ ] With the cell rules of `amount` `{ amount: { $gt: 1000 } }` green then `{ amount: { $gt: 0 } }` blue, the
  amount 5000 is green and 5 is blue.
- [ ] For `{ items: [ { qty: 1 }, { qty: 7 } ] }` and the cell rule `{ "items.qty": { $gt: 5 } }` on `items.qty`,
  the element 0 is not colored and the element 1 is.
- [ ] The rules `{ status: ` and `{ $expr: … }` color nothing and give `Invalid syntax: …` and `$expr is not supported
  in a formatting rule.`; the other rules still apply.
- [ ] With the row rules `by status` then `{ n: 2 }` purple, `{ status: "ok", n: 1 }` takes the color of `"ok"` and
  `{ n: 2 }` is purple; with the cell rules of `status` `{ status: "failed" }` red then `by status`, a failed
  document's `status` is red.
- [ ] For `{ items: [ { qty: 0 }, { qty: 10 } ] }` and the cell rule `by items.qty`, the element 0 is at the faint
  end of the scale and the element 1 at the strong end.
- [ ] A row's plain color is mixed at 12 % and a cell's at 28 %.
- [ ] With a row rule `{}` in each scope, the collection's colors the row; with the collection's scope left out, the
  database's does.

### `query.format-field` — The color a field rule gives a value

Which color a value of the field gets, and what the rule's legend shows for a page.

- **Kind**: Derivation
- **Function**: `src/shared/formatField.ts › fieldPaint`, `fieldMode`
- **Implemented in**: `src/shared/formatField.ts › resolveField`, `paletteOf`, `fieldLegend`, `valuesOf`, `valueAt`,
  `valueText`.
- **Uses**: nothing.
- **Tested by**: `test/unit/formatting.test.ts › 'query.format-field'`.

Inputs: a field rule, the documents of the page as relaxed Extended JSON, a value. Output: a color with its
strength, or nothing.

Rules:

- **`auto`** is decided from the values of the field on the page, missing and `null` left out: all booleans →
  `boolean`; all numbers (of any numeric type), or all dates → `scale`; anything else, a mix, or no value → `values`.
- A missing or `null` value gets no color in any mode; nor does a value of another type than the mode's (a string
  under a scale, a number under `boolean`).
- **`boolean`**: `true` green and `false` red; swapped when the rule's `scale` is `{ from: 'green', to: 'red' }`.
- **`scale`**: the value's place between `min` and `max` (a date is its milliseconds; Int64 and decimals are read as
  JavaScript numbers), a value outside at the nearest end. With `scale.to` alone (blue when absent), that color from
  faint to strong; with `scale.from` too, from `from` to yellow over the first half and from yellow to `to` over the
  second. An end the rule does not have is the smallest or largest value of the page; without either, no color.
- **`values`**: a value is known by its mongosh text on one line (`"home"`, `42`, `ObjectId("…")`; an array is one
  value). A pinned value gets its pinned color at full strength, outlined when that color is the palette's own. Any
  other value gets the color at `hash(text) mod n` of the palette, FNV-1a over the text, so the same value has the
  same color on every page and for every user of the same rule. The palette `all` is the ten presets other than gray
  less the colors pinned values use (all ten when every one is used); a color is five shades of it, from faint to
  strong.
- **The legend** of a page: for `values`, the pinned values first (also with none on the page), then the page's by
  how many there are, each with its color and count, and how many colors the palette has; for `boolean`, `true` and
  `false`; for `scale`, the two ends and whether they are dates. The path goes through arrays of sub-documents, one
  value per element.

Acceptance:

- [ ] `fieldMode` is `boolean` for `[true, false]`, `scale` for `[1, NumberLong(5), NumberDecimal("2.5")]` and for
  dates, `values` for a number with a date, a string with a number, and no value.
- [ ] With `min` 0, `max` 200 and `scale.to` orange, 50 is orange at strength 0.25, 900 at 1, −5 at 0, and a string
  gets nothing.
- [ ] From red to green between 0 and 100, 25 is red half-way to yellow and 100 is green.
- [ ] `by n` on a page with 10, 30, `null` and a missing field is a scale from 10 to 30; with `min` 0 and `max` 100
  in the rule, from 0 to 100.
- [ ] With `"home"` pinned to green, `"home"` is green and none of 200 other values is.
- [ ] With the palette gray, the other values are shades of gray and a pinned value keeps its color; pinned to the
  palette's own color, it is outlined.
- [ ] The legend of `by status` with `"gone"` pinned, on `ok`, `ok`, `failed` and a document without the field, is
  `"gone"` (0, pinned), `"ok"` (2), `"failed"` (1), with nine colors for the values that are not pinned.

### `query.match` — Match a document against a filter

Whether a document of the page matches a filter, decided in the webview as MongoDB decides it, for display only:
nothing that writes may rely on it.

- **Kind**: Derivation
- **Function**: `src/shared/match.ts › compileFilter`
- **Implemented in**: `src/shared/query.ts › parseQuery` (the filter's text), `isEjsonWrapper`.
- **Uses**: nothing.
- **Tested by**: `test/unit/match.test.ts › 'query.match: equality'`, `'query.match: comparison'`, `'query.match:
  sets and arrays'`, `'query.match: $exists, $type, $regex, $mod, $not'`, `'query.match: logic'`, `'query.match:
  refusals'`.

Inputs: a filter parsed from mongosh syntax, and a document as relaxed Extended JSON (`{ $oid }`, `{ $date }`,
`{ $numberLong }` …). Output: a predicate, or a `MatchError` with a message for the user.

Rules:

- **Paths**: dotted paths go through sub-documents and into the elements of arrays; a numeric segment is also an
  index (`items.1.qty`); a missing field is equal to `null`.
- **Equality** (`{ f: v }`, `$eq`): the same type and value, numbers across int, long, double and decimal, a
  sub-document with the same fields in the same order; an array matches when it is equal or one of its elements is.
  A regex as the value matches strings (`$eq` with a regex is equality with that regex).
- **Comparison** (`$gt`, `$gte`, `$lt`, `$lte`): only values of the same type bracket compare (numbers, strings,
  dates, ObjectIds, booleans, timestamps…); strings by code point, without the collection's collation. Each bound may
  be met by a different element of an array. `$ne` and `$nin` are the negations of `$eq` and `$in`.
- **Sets and arrays**: `$in` (values and regexes), `$nin`, `$all` (an empty one matches nothing), `$size`,
  `$elemMatch` with operators or a sub-filter.
- **Others**: `$exists` (a `null` exists), `$type` by name, number or `"number"` (a whole number is `int`, `long` and
  `double`: relaxed Extended JSON does not tell them apart), `$regex` with `$options` (`i`, `m`, `s`, `x`), `$mod` on
  the integer part, `$not` with an operator or a regex.
- **Logic**: `$and`, `$or`, `$nor` at the top and inside `$elemMatch`; `$comment` is ignored.
- **Refused**: `$expr`, `$where`, `$text`, `$jsonSchema`, `$sampleRate`, `$search`, `$vectorSearch`, the geospatial
  and bitwise operators (`<op> is not supported in a formatting rule.`); any other `$` key (`Unknown operator <op>.`);
  malformed operands (`$in needs an array.`, `$mod: the divisor can not be 0.`, `$type: unknown type "text".` …); a
  condition that is not a document.
- Int64 values beyond 2⁵³ and decimals are compared as JavaScript numbers, rounded beyond 15 digits.

Examples:

| Filter | Document | Matches |
| --- | --- | --- |
| `{ amount: { $gt: 5 } }` | `{ amount: "10" }` | no: a string never compares with a number |
| `{ n: 5 }` | `{ n: NumberDecimal("5.0") }` | yes |
| `{ "items.sku": "b" }` | `{ items: [ { sku: "a" }, { sku: "b" } ] }` | yes |
| `{ deletedAt: null }` | `{ a: 1 }` | yes |
| `{ deletedAt: { $exists: true } }` | `{ deletedAt: null }` | yes |
| `{ status: { $ne: "ok" } }` | `{ other: 1 }` | yes |
| `{ scores: { $elemMatch: { $gt: 80, $lt: 85 } } }` | `{ scores: [70, 95] }` | no |

Acceptance:

- [ ] `{ amount: { $gt: 1000 } }` matches `{ amount: 1500 }` and not `{ amount: 1000 }` nor `{ amount: "2000" }`.
- [ ] `{ tags: "red" }` matches `{ tags: ["blue", "red"] }`; `{ tags: { $ne: "red" } }` does not.
- [ ] `{ $expr: { $gt: ["$a", "$b"] } }` is refused with `$expr is not supported in a formatting rule.`

### `query.pane` — Put the query above or beside the results

The user chooses whether the query (Filter, Builder, Sort, Project, or the stages of the pipeline) sits above the
table or in a resizable pane at its right; the choice is a setting and holds for every collection.

- **Kind**: Operation
- **Function**: `src/webview/queryPane.ts › QueryPaneUi`; stored by `src/collectionPanel.ts ›
  CollectionPanel.onMessage` (`case 'saveQueryPane'`).
- **Implemented in**: `src/shared/queryPane.ts › readQueryPane`, `positionOf`, `queryPaneSave`, `clampPaneWidth`,
  `paneLayout`, `draggedWidth`, `keyedWidth`; `src/queryBarHtml.ts › queryBarHtml` (the markup, with
  `src/shared/icons.ts › iconSvg`); `src/collectionPanel.ts › QUERY_PANE_KEY`, `queryPane`, `postInit`, `html`, the
  configuration listener; `src/webview/main.ts`; `src/shared/messages.ts` (`saveQueryPane`, `queryPane`,
  `init.queryPane`); `media/webview.css` (`body.query-side`).
- **Entry points**: the toggle at the right end of the tab's top row, after `Insert` (tooltip `Query at the right
  of the results` or `Query above the results`); the splitter between the pane and the results (drag, `←` `→` by 20 px,
  with Shift by 60 px, double-click for the default width).
- **Offered when**: in `Find`, `Aggregate`, `Schema` and `Chart`; not in `Indexes`, which has no query.
- **Reads**: the setting `mongoster.queryBar.position` and the width from `globalState`, through `readQueryPane`,
  when the tab opens and when the setting changes.
- **Writes**: no database. The setting (user level) at each toggle; `{ width }` to `globalState` under
  `mongoster.queryPane` at the end of each drag.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: the undo history is for writes to databases; pressing the toggle again goes back.
- **redis-oplog**: Not published.
- **After**: the open tabs of the other collections take the same place and width at once; so do all of them when
  the setting is changed in the settings.
- **Settings**: `mongoster.queryBar.position` (`top`, the default, or `right`).
- **Tested by**: `test/unit/queryPane.test.ts › 'query.pane: the stored choice'`, `'query.pane: the width'`,
  `'query.pane: above or beside'`, `'query.pane: the splitter'`, `'query.pane: saving the choice'`, `'query.pane:
  the setting'`; `test/unit/queryBar.test.ts › 'query.pane: the markup'`, `'query.pane: the icons'`. The CSS of the
  two places, the DOM wiring and the configuration listener: none (checked by hand).

Rules:

- Above the results: `Find` and `Reset` beside the filter; `Builder`, `Explain` and `Code` under it, `Update many…`
  and `Delete many…` at the right of that line; Sort and Project on the line after the builder.
- At the right of the results: each label above its box, in the order Filter, `Builder` `Explain` `Code`, the builder, Sort,
  Project, `Find` `Reset`, then `Update many…` `Delete many…` under a line. The stages of the pipeline are one under
  the other, as wide as the pane.
- When the tab leaves less than 360 px to the results, the query is above them whatever the choice; the toggle stays
  pressed and its tooltip says why.
- The width is kept between 260 and 900 px; the default is 380.

Acceptance:

- [ ] No setting and nothing stored reads as above the results, 380 px; a stored `side` of an earlier build is
  ignored, only the setting places the query.
- [ ] The setting `right` with `{ width: 500 }` stored reads as at the right, 500 px; a width of 10 becomes 260, 5000
  becomes 900, `"400"` becomes 380.
- [ ] At the right, 380 px wide, in a tab 740 px wide: at the right; in one 739 px wide: above, with the tooltip
  `Query at the right of the results: the tab is too narrow, so it is above them for now`.
- [ ] Dragging the splitter 600 px left from 380 in a tab 1000 px wide gives 640; `←` adds 20, Shift+`→` takes 60.
- [ ] Changing `mongoster.queryBar.position` in the settings moves the query of the open tabs at once.
- [ ] Every button of the query bar but the mode tabs and the toggle has a codicon and its text in a `.label` span;
  `Find` and `Reset` are in the filter's row, `Update many…` and `Delete many…` in their own group.

### `query.drop-options` — Drop a header or a cell on Sort or Project

What a field dragged from the table offers on Sort and Project: a header and a cell alike put their field there.

- **Kind**: Derivation
- **Function**: `src/shared/dropZones.ts › sortZones`, `projectionZones`
- **Implemented in**: `src/webview/main.ts › showDropzones`, `showOptionZones`, `setOption`;
  `src/shared/query.ts › mergeSort`, `mergeProjection` (what a zone does to the text).
- **Uses**: nothing.
- **Tested by**: `test/unit/dropZones.test.ts › 'query.drop-options: Sort'`, `'query.drop-options: Project'`; the
  merging: `test/unit/query.test.ts`.

Rules:

- In `Find`, Sort offers `▲ ascending` (1) and `▼ descending` (-1), and Project `include` (1) and `exclude` (0), for
  the field of a dragged header or cell. A cell of an array element gives the dotted path of its field (`items.qty`).
- A field already in the box also gets `✕ remove`.
- In `Aggregate` neither box exists, and nothing is offered.

Examples:

| Dragged | Mode | Sort already | Sort offers |
| --- | --- | --- | --- |
| header `amount` | Find | `{}` | `▲ ascending`, `▼ descending` |
| cell of `amount` (275) | Find | `{ amount: -1 }` | `▲ ascending`, `▼ descending`, `✕ remove` |
| cell of `items.qty` in an element of `items` | Find | `{}` | the same, for `items.qty` |
| cell of `amount` | Aggregate | — | nothing |

Acceptance:

- [ ] A cell of `amount` offers on Sort `▲ ascending` and `▼ descending`, as the header `amount` does, and on
  Project `include` and `exclude`.
- [ ] A cell of `items.qty` in an element of `items` offers `▼ descending` with the tooltip `items.qty: -1 (after the
  fields already in the sort)`.
- [ ] In Aggregate, a cell offers nothing on Sort nor on Project.
