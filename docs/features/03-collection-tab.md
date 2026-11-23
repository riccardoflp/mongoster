# The collection tab

The tab of a collection or a view: the table, the query bar, the pipeline editor and the other sections. The user's
side is in the README's [Features](../../README.md#features). This area is one of those written when it is next
changed ([07-roadmap.md](../07-roadmap.md)): it has the cards of conditional formatting only, from
[proposal 0002](../proposals/0002-conditional-formatting.md) and [D18](../08-decisions.md); the table, the query, the
builder, the pipeline and the columns get theirs when they change. The place of the query, above or beside the
results, and dropping a field on Sort or Project have theirs since they changed.

Conditional formatting writes nothing to the database. Its rules are Mongoster's own state, kept for the user in
`globalState` under `mongoster.formatting.<connection>/<database>/<collection>` ([11-data.md](../11-data.md)), sent to
the webview with `init` (`formatRules`) and stored back with `{ type: 'saveFormatRules', rules }`
(`src/shared/messages.ts`). The decision of which row and cell gets which color is pure, in
`src/shared/formatting.ts` and `src/shared/match.ts`; `renderGrid` in `src/webview/main.ts` only sets `data-fmt` on
the document's `tbody` and on the cells, and `media/webview.css` paints them.

### `query.format-rules` — Add, edit, reorder and turn off formatting rules

The user keeps, for each collection, a list of formatting rules that color the rows or cells of the table.

- **Kind**: Operation
- **Function**: `src/webview/formatting.ts › FormattingPanel`, `FormatDialog.save`; stored by
  `src/collectionPanel.ts › CollectionPanel.onMessage` (`case 'saveFormatRules'`).
- **Implemented in**: `src/shared/formatting.ts › readFormatRules`, `conditionError`, `newRuleId`;
  `src/webview/main.ts › saveFormatRules`, `formatCells`, `fieldItems`; `src/collectionPanel.ts ›
  formattingStateKey`, `moveCollectionState`, `postInit`; `src/shared/messages.ts`; `media/webview.css`.
- **Entry points**: the `Formatting` button in the bar above the table (`Formatting (n)` with `n` rules on), which
  opens the panel: a line per rule (drag handle, checkbox, color, `Row` or the field, the condition, `✎`, `✕`) and
  `+ Add rule…`; `Format Cells…` in a column header's right-click menu (tooltip `Color the cells of <field> when the
  document matches a condition`).
- **Offered when**: always, in every mode, on views and on read-only connections: nothing is written to the database.
- **Asks**: the dialog `Add formatting rule` or `Edit formatting rule`: `Color the row` or `Color the cell of` a
  field (with the page's columns offered), `When the document matches` a filter in mongosh syntax (with the query
  bar's coloring and autocompletion), a color among six; `Save` (Ctrl+Enter) or `Cancel` (Esc). A new rule takes the
  first color no rule uses yet. `Format Cells…` starts with that column's cell and the condition
  `{ <field>: <the selected cell's value> }` when a cell of that column is selected, else
  `{ <field>: { $exists: true } }`.
- **Reads**: the rules from `globalState`, through `readFormatRules`, when the tab opens and when its connection
  changes.
- **Writes**: no database. The whole list, in its order, to `globalState` at each change (add, edit, remove, reorder,
  turn on or off); the key is removed when the list is empty.
- **Danger**: None. Removing a rule asks nothing; turning it off keeps it aside.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: the undo history is for writes to databases; a removed rule is typed again.
- **redis-oplog**: Not published.
- **After**: the table is colored again at once, and the button's count changes. The rules follow a renamed
  collection (`moveCollectionState`); they stay when the collection is dropped (RS4).
- **Refuses**: `Save` with an empty field for a cell rule (`Type the field whose cell is colored.`), a field starting
  with `$`, a condition that does not parse (`Invalid syntax: …`) or that `query.match` refuses (its message), and a
  101st rule (`A collection keeps at most 100 formatting rules.`), each shown under the condition.
- **Uses**: `query.format-table`, `query.match`.
- **Tested by**: `test/unit/formatting.test.ts › 'query.format-rules: the stored rules'` (`readFormatRules`,
  `conditionError`). The panel and the dialog: none.

Acceptance:

- [ ] Stored rules are read back as written; an entry without a string id or condition, with an unknown color, or
  with an id already seen is dropped, unknown properties are dropped, anything but an array is no rules, and at most
  100 rules are kept.
- [ ] `conditionError('{ a: { $where: 1 } }')` is `$where is not supported in a formatting rule.`; an empty
  condition is `Type a condition, such as { status: "failed" }.`
- [ ] A value recorded from the first version (`[{ id, condition, color }, { id, condition, field, color, enabled:
  false }]`) is read unchanged.

### `query.format-table` — Color the table by the formatting rules

The rows and cells whose documents match a rule's condition take its color.

- **Kind**: View
- **Function**: `src/shared/formatting.ts › TableFormat` (`rowColor`, `cellColor`)
- **Implemented in**: `src/shared/formatting.ts › withElement`; `src/webview/main.ts › renderGrid`, `formatCell`;
  `media/webview.css` (`[data-fmt]`).
- **Entry points**: the table, in `Find` and in the output of `Aggregate`, each time it is drawn.
- **Uses**: `query.match`, `query.format-rules`, `connection.set-color` (the same six colors).
- **Tested by**: `test/unit/formatting.test.ts › 'query.format-table'`.

Rules:

- The first enabled row rule whose condition matches the document colors its row: every cell of the document's
  sub-rows, not the row number.
- The first enabled cell rule of a field whose condition matches colors that field's cell, over the row's color. The
  condition is about the whole document: `{ status: "failed" }` on the field `amount` colors the `amount` cell of the
  failed documents.
- In an expanded array, a cell rule of a field of the elements is matched against the document with the array
  replaced by that one element: `{ "items.qty": { $gt: 5 } }` on `items.qty` colors the `qty` of the elements over 5
  only. The `… more elements` cell and the filler under the last element are not colored.
- A rule turned off, or whose condition can't be used, colors nothing; the panel marks the second with `⚠` and the
  reason.
- The colors are the theme's chart colors (`--vscode-charts-red` …), mixed at 25 % into the background, so the text
  keeps the theme's foreground; a pinned cell stays opaque; a missing field keeps its hatching; hovering, a selected
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
table or in a resizable pane at its left; the choice holds for every collection.

- **Kind**: Operation
- **Function**: `src/webview/queryPane.ts › QueryPaneUi`; stored by `src/collectionPanel.ts ›
  CollectionPanel.onMessage` (`case 'saveQueryPane'`).
- **Implemented in**: `src/shared/queryPane.ts › readQueryPane`, `clampPaneWidth`, `paneLayout`, `draggedWidth`,
  `keyedWidth`; `src/queryBarHtml.ts › queryBarHtml` (the markup, with `src/shared/icons.ts › iconSvg`);
  `src/collectionPanel.ts › QUERY_PANE_KEY`, `postInit`, `html`; `src/webview/main.ts`; `src/shared/messages.ts`
  (`saveQueryPane`, `queryPane`, `init.queryPane`); `media/webview.css` (`body.query-side`).
- **Entry points**: the toggle at the right end of the tab's top row, after `Insert` (tooltip `Query beside the
  results` or `Query above the results`); the splitter between the pane and the results (drag, `←` `→` by 20 px,
  with Shift by 60 px, double-click for the default width).
- **Offered when**: in `Find`, `Aggregate`, `Schema` and `Chart`; not in `Indexes`, which has no query.
- **Reads**: the choice from `globalState`, through `readQueryPane`, when the tab opens.
- **Writes**: no database. `{ side, width }` to `globalState` under `mongoster.queryPane` at each toggle and at the
  end of each drag.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: the undo history is for writes to databases; pressing the toggle again goes back.
- **redis-oplog**: Not published.
- **After**: the open tabs of the other collections take the same place and width at once.
- **Tested by**: `test/unit/queryPane.test.ts › 'query.pane: the stored choice'`, `'query.pane: the width'`,
  `'query.pane: above or beside'`, `'query.pane: the splitter'`; `test/unit/queryBar.test.ts › 'query.pane: the
  markup'`, `'query.pane: the icons'`. The CSS of the two places and the DOM wiring: none (checked by hand).

Rules:

- Above the results: `Find` and `Reset` beside the filter; `Builder`, `Explain` and `Code` under it, `Update many…`
  and `Delete many…` at the right of that line; Sort and Project on the line after the builder.
- Beside the results: each label above its box, in the order Filter, `Builder` `Explain` `Code`, the builder, Sort,
  Project, `Find` `Reset`, then `Update many…` `Delete many…` under a line. The stages of the pipeline are one under
  the other, as wide as the pane.
- When the tab leaves less than 360 px to the results, the query is above them whatever the choice; the toggle stays
  pressed and its tooltip says why.
- The width is kept between 260 and 900 px; the default is 380.

Acceptance:

- [ ] Nothing stored, a value that is not an object, or `side` other than `true` reads as above the results, 380 px.
- [ ] `{ side: true, width: 500 }` reads back unchanged; a width of 10 becomes 260, 5000 becomes 900, `"400"`
  becomes 380.
- [ ] Beside, 380 px wide, in a tab 740 px wide: beside; in one 739 px wide: above, with the tooltip `Query beside
  the results: the tab is too narrow, so it is above them for now`.
- [ ] Dragging the splitter 600 px right from 380 in a tab 1000 px wide gives 640; `→` adds 20, Shift+`←` takes 60.
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
