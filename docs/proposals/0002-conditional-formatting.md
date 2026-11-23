# 0002 — Conditional formatting in the collection tab

**Status**: accepted (D16)

## Summary

Formatting rules per collection color the background of rows or cells of the table, as conditional formatting does in
a spreadsheet. A rule has a condition written as a filter in mongosh syntax (`{ status: "failed" }`), a color among the
six colors of connections, and what it colors: the whole row, or the cell of one field. The rules are matched in the
webview by a new pure matcher of query operators over relaxed Extended JSON, `src/shared/match.ts`. They are kept for
the user in `globalState`, per collection, like the columns' layout. They are listed, added, edited, reordered, turned
off and removed from a `Formatting` button beside `Columns`, and added for one field with `Format Cells…` in a column
header's menu.

## Why

Reading a page of documents, the user looks for the few that matter: the failed payments, the amounts over a
threshold, the documents marked deleted. Today the only way is a filter, which hides every other document. A color
keeps the context: all documents are shown, and the ones that match a condition stand out. The user asked for it as
it is in a spreadsheet.

## What changes for the user

Cards added, in `docs/features/03-collection-tab.md`, the first cards of the `query.` area (the other features of the
collection tab keep having none, as [07-roadmap.md](../07-roadmap.md) says):

- `query.format-rules` (Operation) — the `Formatting` panel and the rule dialog: list, add, edit, reorder, turn off,
  remove; `Format Cells…` from a column header.
- `query.format-table` (View) — how the rules color the table: first match wins, a cell rule over a row rule, the
  elements of an expanded array, the colors in dark and light themes.
- `query.match` (Derivation) — whether a document matches a filter, as MongoDB decides it, for the operators listed
  below; what is refused and with which message.

No card is changed. Glossary rows: *formatting rule*, *conditional formatting*.

## Design

### The rule

```ts
/** src/shared/formatting.ts */
export type FormatColor = 'red' | 'orange' | 'yellow' | 'green' | 'blue' | 'purple';

export interface FormatRule {
  /** Random, stable: what edit, reorder and remove refer to. */
  id: string;
  /** The filter in mongosh syntax, as the user typed it (kept as text, like the saved queries). */
  condition: string;
  /** The dotted path of the field whose cell is colored; absent: the whole row. */
  field?: string;
  color: FormatColor;
  /** Absent means on. */
  enabled?: false;
}
```

- **Order**: the rules form a list. For each document, the **first** enabled row rule that matches colors the row;
  for each cell, the **first** enabled cell rule of its field that matches colors the cell. A cell rule wins over a
  row rule on that cell; the other cells keep the row's color.
- **The condition is about the document**, also for a cell rule: `{ amount: { $gt: 1000 } }` on the field `amount`
  colors the `amount` cell of the documents whose amount is over 1000; `{ status: "failed" }` on the field `amount`
  colors the `amount` cell of the failed ones. This is what a spreadsheet's "custom formula" does, and it needs one
  syntax only, the filter's.
- **Elements of an expanded array** (`items[].qty`, one sub-row per element): a cell rule whose field is inside the
  array is matched, for each element, against the document with the array replaced by that element alone. So
  `{ "items.qty": { $gt: 5 } }` on `items.qty` colors the `qty` cells of the elements over 5, not every `qty` of a
  document where one element is. A row rule colors all the sub-rows of its document.
- **Colors**: the six colors of `connection.set-color`, from the theme's chart colors (`--vscode-charts-red` …, which
  the desktop app also defines), mixed at about 25 % into the table's background with `color-mix`, so that the text
  keeps the theme's foreground and reads in dark, light and high-contrast themes. The selection and the selected cell
  are drawn over the formatting, so they stay visible. A colored cell keeps the color of its value's type.
- **An invalid rule** (its condition does not parse, or uses an operator the matcher refuses) colors nothing; the
  panel shows it marked, with the reason as its tooltip. The dialog does not save a rule whose condition is invalid.

### The matcher: `src/shared/match.ts`

No vscode, no Node, no `mongodb`: it runs in the webview, over the values as the table has them (relaxed Extended
JSON plain objects: `{ $oid }`, `{ $date }`, `{ $numberLong }`, `{ $numberDecimal }`, `{ $regularExpression }` …).

```ts
/** Compiles a parsed filter into a predicate; throws a MatchError saying what is not supported. */
export function compileFilter(filter: unknown): (doc: unknown) => boolean;
```

Compiled once per rule when the rules or the page change, then run on each document of the page (500 at most).
It follows MongoDB's semantics, which its unit tests state case by case:

- **Paths**: dotted paths, implicit traversal of arrays (`items.qty` matches if any element's `qty` matches), a
  numeric segment as an array index (`items.0.qty`), a missing field equal to `null`.
- **Equality**: `{ f: v }` and `$eq` match when the value is equal, or, for an array, when the array is equal or one
  of its elements is. Numbers are equal across their types (`1`, `{ $numberLong: "1" }`, `{ $numberDecimal: "1.0" }`);
  sub-documents are equal with their fields in the same order, as in MongoDB. A regex as the value (`/re/i`) matches
  strings, as `$regex` does.
- **Comparison**: `$gt`, `$gte`, `$lt`, `$lte` compare values of the same type bracket only (numbers, strings, dates,
  ObjectIds, booleans, timestamps), as MongoDB does: `{ amount: { $gt: 5 } }` does not match `amount: "10"`. Strings
  compare by code point (the collation of the collection is ignored). `$ne`, `$nin` are the negations of `$eq`, `$in`.
- **Sets**: `$in` (values and regexes), `$nin`, `$all`, `$size`, `$elemMatch` (with operators or a sub-filter).
- **Others**: `$exists`, `$type` (names, numbers, `"number"`), `$regex` with `$options`, `$mod`, `$not` (an operator
  object or a regex).
- **Logic**: `$and`, `$or`, `$nor` at any level, and implicit and of the fields of an object.
- **Refused**, with `<operator> is not supported in a formatting rule.`: `$expr`, `$where`, `$text`, `$jsonSchema`,
  the geospatial operators, `$bitsAllSet` and the other bitwise ones; `$comment` is ignored; any other unknown `$`
  key: `Unknown operator <operator>.` Int64 beyond 2⁵³ and decimals are compared as JavaScript numbers,
  rounding beyond 15 digits (said in the card).

### Where the rules are kept

In `globalState`, under `mongoster.formatting.<connection>/<database>/<collection>`, as an array of `FormatRule`;
the key is removed when the last rule is. It is added to `moveCollectionState`, so the rules follow a renamed
collection, and, like the layout, they stay when the collection is dropped (RS4, unchanged). Reading tolerates what an
older or newer version may have written: `readFormatRules(value)` in `src/shared/formatting.ts` keeps each entry that
has a string condition and a known color, drops the others and unknown fields, and reads anything that is not an array
as no rules; a unit test reads a recorded value. A new row in [11-data.md](../11-data.md): *may be lost? No* — the
user wrote them.

### Messages and modules

- `init` (host → webview) gains `formatRules: FormatRule[]`.
- `{ type: 'saveFormatRules'; rules: FormatRule[] }` (webview → host): the host passes them through
  `readFormatRules`, writes them, and sends nothing back (the webview already shows them).
- `src/shared/match.ts` — the matcher (`query.match`).
- `src/shared/formatting.ts` — `FormatRule`, `readFormatRules`, and `formatTable(docs, rules)`, which returns for each
  document its row color and the colors of its cells by path (and by element for expanded arrays): the whole decision,
  unit-tested, so that `renderGrid` only sets classes.
- `src/webview/formatting.ts` — the `Formatting` panel and the rule dialog (as `columnsUi.ts` is for the columns);
  `src/webview/main.ts` calls it from `renderGrid` and from the column menu.
- `media/webview.css` — the `fmt-<color>` classes.

### The UI

- **`Formatting`** button in the status bar, beside `Columns` (both are about how the table looks), showing the
  number of enabled rules (`Formatting (2)`). It opens a panel like the `Columns` panel: one line per rule with a
  drag handle to reorder, a checkbox to turn it on and off, the color, `Row` or the field, the condition on one line
  (with the full text as tooltip), and buttons to edit and remove it; `+ Add rule…` at the bottom. An empty panel says
  `No formatting rules. Add one, or use Format Cells… in a column header's menu.`
- **The rule dialog** (`Add formatting rule` / `Edit formatting rule`): *Color* the row or *the cell of* a field (an
  input with the fields' autocompletion), *When the document matches* a filter (the filter's text area, with its
  highlighting and autocompletion), the six colors as swatches, `Save` and `Cancel`. The error of an invalid condition
  is shown under it, as in the query bar.
- **`Format Cells…`** in a column header's menu (all columns, all modes, also on views and read-only connections:
  nothing is written to the database) opens the dialog for that field's cell, with the condition `{ <field>: <the
  value of the selected cell> }` when a cell of that column is selected, else `{ <field>: { $exists: true } }`.
- The rules apply to every table of the tab: Find and the output of Aggregate. A rule about fields the output does
  not have colors nothing.
- **Remove** asks nothing (turning a rule off is the way to keep it aside); nothing about the rules is in the undo
  history, which is for writes to databases.

### The desktop app

Nothing of its own: the feature is the webview plus `globalState`, which the desktop app already implements; the
theme's chart colors are defined by `src/standalone/theme.ts`.

## Alternatives

- **Rules in the project's `.mongoster/`, like saved queries, to share them with the team.** Useful, but it is a new
  file format shared through git (a proposal of its own under 11-data.md's rules: naming files by collection,
  connection names, merging two places' rules). Rules *for me* first; *in the project* can come later with the same
  `FormatRule` and the place chosen as for saved queries. Open question 1.
- **Matching on the server** (`$match` per rule, or `$cond` fields added to the query). Exact MongoDB semantics,
  collations included, but one more query per page and per rule, nothing for the output of a pipeline without
  rewriting it, and the documents shown would no longer be the ones returned. The page is already in the webview.
- **A condition per cell on its own value** (`> 1000`, `contains "x"`), as a spreadsheet's simple rules. Friendlier for
  the simple case but a second little language, and it cannot say "color the amount when the status is failed". The
  dialog's prefill covers the simple case with the filter syntax.
- **Any CSS color** (a color picker). Unreadable in one of the themes sooner or later; the six theme colors are what
  connections use already.
- **All matching rules mixed**, or the last one winning. Spreadsheets stop at the first; it is predictable and
  reordering is how the user chooses.
- **An existing matcher library** (`sift`, `mingo`). A new dependency (11 KB–100 KB), written for plain JavaScript
  values, not relaxed Extended JSON wrappers; it would need a conversion layer, and its edge cases are not MongoDB's
  everywhere. The subset needed here is about 300 lines with its tests.

## Costs

- A matcher that must stay MongoDB's semantics in the cases it accepts: where it differs (collation, decimals beyond
  15 digits), the card says so. It is the first place Mongoster decides itself whether a document matches a filter;
  nothing that writes uses it, and nothing must: the card says `query.match` is for display only.
- One more `globalState` key per collection with rules, left behind when the collection is dropped (RS4).
- `src/webview/main.ts` grows by the calls only; the panel and dialog are their own module.

## Open questions

1. Rules *in the project* as files, shared through git — later, in its own proposal, if wanted.
2. A `Format Cells Like This…` entry in a cell's right-click menu, prefilled with that cell's value — small, not in
   this proposal.
