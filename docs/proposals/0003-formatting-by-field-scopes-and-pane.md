# 0003 — Formatting by a field's values, rules beyond one collection, the Formatting pane

**Status**: accepted (D21), built in three stages: see [Stages](#stages)

## Summary

Conditional formatting gains four things. A second kind of formatting rule, the **field rule**, colors the table by
the values of one field without a condition: green and red for booleans, a color scale for numbers and dates, one
color per distinct value for the rest. Rules get a **scope**: this collection (as today), this database, this
connection, or everywhere. The `Formatting` popup and the rule dialog become one **Formatting pane** docked at the
right of the table, which stays open while the user works, lists the rules of the four scopes with a legend of the
colors in use, moves a rule from a scope to another, and shows or hides all formatting with one button. Rules can
have a **name**, and can be **exported to a file and imported** from one, to share them.

## Why

A condition rule answers "which documents are the failed ones". The user also wants "show me this field": every
status in its own color, the amounts as a heatmap, the flags in green and red, without writing one rule per value.
Rules written for a collection are written again for the same field in the next collection (`deleted`, `status`,
`tenantId` are in most of them), in the next database and on the next connection (staging and production have the same
collections). The popup closes at the first click on the table, so a rule can't be tuned while looking at what it
colors, and nothing says what a color means. Rules can't be handed to a colleague.

## What changes for the user

Cards, in `docs/features/03-collection-tab.md`:

| Card | | What |
| --- | --- | --- |
| `query.format-rules` | changed | The Formatting pane in place of the popup and the dialog; names; scopes and moving a rule between them; the button that shows and hides formatting. |
| `query.format-table` | changed | The order across scopes; row colors fainter than cell colors; field rules. |
| `query.format-field` | added, Derivation | Which color a value gets from a field rule: the kind chosen from the values, the scale, the color of a distinct value. |
| `query.format-transfer` | added, Operation | `Export Formatting…` and `Import Formatting…`. |
| `query.match` | unchanged | |

Glossary rows: *field rule*, *condition rule*, *formatting scope*, *Formatting pane*; *formatting rule* reworded (it
is no longer "kept per collection").

## Design

### The two kinds of rule

```ts
/** src/shared/formatting.ts */
interface RuleBase {
  id: string;
  /** What the pane shows for the rule; absent: its condition or its field, on one line. */
  name?: string;
  /** Absent means on. */
  enabled?: false;
}

/** As today. An entry without `kind` is a condition rule: what 0.9.0 wrote. */
export interface ConditionRule extends RuleBase {
  kind?: 'condition';
  condition: string;
  field?: string;
  color: FormatColor;
}

export interface FieldRule extends RuleBase {
  kind: 'field';
  /** The dotted path whose values choose the color. */
  field: string;
  /** What is colored: the whole row, or that field's cell. */
  target: 'row' | 'cell';
  /** `auto`: chosen from the values of the page, see below. */
  mode: 'auto' | 'boolean' | 'scale' | 'values';
  /** Scale: the two ends, as numbers (a date is its milliseconds). Fixed when the rule is made. */
  min?: number;
  max?: number;
  /** Scale: one color growing stronger, or from one color to another through yellow. */
  scale?: { from?: FormatColor; to: FormatColor };
  /** Values: the colors the user fixed, by the value's canonical text; the others get theirs by themselves. */
  pinned?: { value: string; color: FormatColor }[];
  /** Values: where the other values' colors come from. Absent: `all`. A color: the shades of that color. */
  palette?: 'all' | FormatColor;
}

export type FormatRule = ConditionRule | FieldRule;
```

- **`auto`** looks at the values of the field on the page, leaving out missing and `null`: all booleans → `boolean`;
  all numbers, or all dates → `scale`; anything else, or a mix → `values`. The pane shows which one was chosen and
  lets the user fix it.
- **`boolean`**: `true` green, `false` red; a button swaps them (stored as `scale: { from: 'green', to: 'red' }`, so
  no field of its own).
- **`scale`**: a value between `min` and `max` gets the color at its place between them, a value outside gets the
  end's. With `to` alone, the color goes from 6 % to 45 % of `to` over the table's background; with `from` too, from
  `from` through yellow to `to` (`Red to green`, `Green to red`), at 30 %. `min` and `max` are **stored**, filled from
  the page when the rule is made and by `From This Page` afterwards, so that a value keeps its color from a page to
  the next; they are two inputs in the pane. Int64 and decimals are read as JavaScript numbers, as `query.match` does.
  No rainbow: its colors have no order a reader can see.
- **`values`**: a distinct value gets one of ten colors (the presets of `src/shared/colors.ts` less gray) by a hash of
  its canonical text (the mongosh text of the value), so that `"failed"` has one color on every page, in every
  collection and for every user of the same rules. Two values may share a color beyond ten, and before: the legend
  says which; when the page has more distinct values than the palette has colors the pane warns `<field> has <n>
  values on this page: the colors repeat.` An array is one value (its text), not its elements; inside an expanded
  array, each element's cell has its own value, as for condition rules.
  - **Pinned values**: `pinned` fixes the color of the values that must mean something (`"home"` green, `"failed"`
    red), from the legend (click the value's swatch) or with `+ Pin a Value…` for a value the page doesn't show. A
    pinned color is the preset at full strength whatever the palette, and it is **taken**: the other values get their
    color among the palette's colors that no pinned value uses, so nothing else is green once `"home"` is. A pin is
    removed with `Unpin`, and the value goes back to a color of the palette.
  - **Palette**: `All Colors` (the ten), or the shades of one color: `Shades of Gray`, `Shades of Blue` and so on for
    each preset, five strengths of it from 10 % to 45 %. The shades are for a field where the pinned values are what
    matters and the rest should only be told apart from its neighbors; with five steps they repeat sooner, which the
    warning says. A pinned value whose color is the palette's own is drawn at full strength with a border, so it
    still stands out from the shades.
- **Missing and `null`** get no color, in every mode. A value of another type than the mode's (a string under a scale)
  gets none either.
- `FormatColor` becomes the eleven presets (D17) for every rule; custom `#rrggbb` stays out (D18's reason holds).

### What colors what

Unchanged in its principle: the first enabled rule that gives a color wins, a cell color over a row color. A field
rule gives a color when its field has a value it can color, so a field rule with `target: 'row'` listed first decides
the row of every document that has the field, and the rules after it color the rows of the others.

- **Several field rules**: the user chooses each one's target, as for condition rules. `Color by This Field` (below)
  makes the first field rule of the list a row rule and the next ones cell rules, which the pane's `Row` / `Cell`
  switch changes.
- **Rows are a faint full background**: row colors are mixed at 12 %, cell colors at 28 % (both 25 % today), so a
  colored cell reads on a colored row and a row scale doesn't drown the values' syntax colors. A row scale runs from
  4 % to 22 %.
- **Across scopes**, the list is the collection's rules, then the database's, the connection's, the global ones:
  the nearest scope wins, as for the colors of collections, databases and connections.

### Scopes and where the rules are kept

| Scope | `globalState` key | Applies to |
| --- | --- | --- |
| Collection | `mongoster.formatting.<connection>/<database>/<collection>` (as today) | that collection's tabs |
| Database | `mongoster.formattingDatabase.<connection>/<database>` | every collection of the database |
| Connection | `mongoster.formattingConnection.<connection>` | every collection of the connection |
| Everywhere | `mongoster.formattingGlobal` | every collection tab |

Each is an array of `FormatRule`, 100 at most, read by `readFormatRules`, which now also keeps the entries of
`kind: 'field'` that have a field, a known target and mode, and drops what it can't use from the rest (a `pinned`
entry without a known color, a `min` that is not a number). The database's and connection's keys are removed with
`Remove Connection`; a database dropped or renamed elsewhere leaves its key (RS4, as for the collection's).

A rule of a wider scope names fields a collection may not have: it then colors nothing there, and the pane shows it
dimmed with `No <field> in this table.` That is the common case, not an error.

### The Formatting pane

The `Formatting` button stays in the status bar (`Formatting (3)`: the enabled rules of all scopes that color
something here) and opens and closes a pane **docked at the right of the table**, resizable, at the left of the query
pane when `mongoster.queryBar.position` is `right`. Open or closed and its width are kept for every tab in
`mongoster.formattingPane`, as `mongoster.queryPane` is. The popup and the dialog `Add formatting rule` go away:
a rule is edited in place in the pane, and the table repaints as it changes.

- **Head**: the eye button `Show Formatting` / `Hide Formatting`, which turns every color of the table off and on
  without changing a rule (kept in `mongoster.formattingPane`, so it holds for every tab until turned back; the status
  bar's button reads `Formatting (off)`); `+ Add Rule…` (a menu: `Condition…`, `By Field…`); `⋯` with
  `Export Formatting…`, `Import Formatting…`.
- **Four sections**, `This collection`, `Database <name>`, `Connection <name>`, `Everywhere`, each with its count, a
  checkbox that turns the whole section off for this tab's collection, and its rules. An empty section is one dimmed
  line.
- **A rule's line**: drag handle, on/off checkbox, color swatch (or the scale's bar, or the values' first swatches),
  `Row` or the field, then the **name**, or without one the condition (`{ status: "failed" }`) or `by <field>` on one
  line, cut with `…` and whole in the tooltip. Clicking the line opens it in place: the `Name` box (`F2` on the line
  goes straight to it), the condition's text area or the field input, the target, the colors, and for a field rule
  the mode, `min`, `max`, `From This Page` and the **legend**.
- **The legend** of a field rule lists what the page has: each distinct value with its swatch and how many rows have
  it, the pinned ones first with a pin mark (click a swatch to pin another color; `+ Pin a Value…`; the `Palette`
  choice above the list), or the scale's bar with its two ends. For a condition rule the line itself
  is the legend.
- **Moving a rule**: dragging it into another section, or `Move To ▸` / `Copy To ▸` `This Collection`, `This
  Database`, `This Connection`, `Everywhere` in the line's menu. A move removes it from where it was; a rule moved to
  a wider scope keeps its id.
- **`Color by This Field`** in a column header's menu, beside `Format Cells…`: adds a field rule in `auto` for that
  field to the collection's rules, opens the pane on it, asks nothing.

### Export and import

- **`Export Formatting…`** asks which scopes (checkboxes, all four ticked: `This collection`, `Database <name>`,
  `Connection <name>`, `Everywhere`) and writes `<name>.mongoster-formatting.json`:

  ```json
  {
    "mongosterFormatting": 1,
    "groups": [
      { "scope": "global", "rules": [ … ] },
      { "scope": "connection", "rules": [ … ] },
      { "scope": "database", "database": "shop", "rules": [ … ] },
      { "scope": "collection", "database": "shop", "collection": "orders", "rules": [ … ] }
    ]
  }
  ```

  Nothing of the connection is written: no id, no name, no host. The database's and collection's names are, so the
  import can offer the same place. A command `Export All Formatting…` (Command Palette) writes every rule Mongoster
  keeps, with one `connection` group per connection, still unnamed (`"label": 1`, `2` … tell them apart).
- **`Import Formatting…`** reads a file, shows its groups with their rule counts and, for each, where it goes: by
  default the same scope in the tab's own connection, database and collection, changeable to any of the four. The
  imported rules are **added after** the ones already there, with new ids; a rule equal to one already in that scope
  is skipped; nothing is replaced. The message says `Imported 7 formatting rules, 2 were already there.`
- The file is read as JSON, at most 1 MB, through `readFormatRules`: an entry it can't use is dropped and counted
  (`3 rules could not be read.`). A condition is text that `parseQuery` parses when the table is painted; nothing in
  the file is run. A line in [10-security.md](../10-security.md): a new kind of file read from outside.

### Messages and modules

- `init` gains `formatting: { collection, database, connection, global: FormatRule[]; pane: FormattingPane }` in
  place of `formatRules`.
- `{ type: 'saveFormatRules'; scope; rules }` (webview → host). For the three wider scopes the host then posts
  `{ type: 'formatRules'; scope; rules }` to the other collection tabs that scope reaches, as `saveQueryPane` does for
  the width.
- `{ type: 'exportFormatting'; scopes }`, `{ type: 'importFormatting' }` (webview → host): the host shows the save
  and open dialogs (`showSaveDialog`, `showOpenDialog`, which the desktop app implements), reads and writes the file;
  the choice of places for an import is made in the pane, from `{ type: 'importPreview'; groups }`.
- `src/shared/formatting.ts` — the rule types, `readFormatRules`, `TableFormat` over the four lists.
- `src/shared/formatField.ts` (new) — `fieldMode(values)`, `scaleColor(rule, value)`, `valueColor(rule, value)`,
  `legend(rule, docs)`: pure, unit-tested (`query.format-field`).
- `src/shared/formattingFile.ts` (new) — the file's form, reading it, merging an import (`query.format-transfer`).
- `src/formattingStore.ts` (new, no vscode types beyond `Memento`) — the four keys, reading and writing a scope,
  removing a connection's.
- `src/webview/formatting.ts` — rewritten as the pane; `src/webview/main.ts` keeps `renderGrid` setting the colors,
  now with a strength and a mixed color set on the cell for scales and shades (`--fmt-level`, `--fmt-solid`) beside
  the `data-fmt` names.

### The desktop app

Nothing of its own: `globalState`, the two file dialogs and the eleven theme colors are there already.

## Alternatives

- **Scale ends recomputed on each page.** Needs no input, but the same value changes color from a page to the next,
  and a heatmap that can't be compared across pages misleads.
- **A rainbow scale.** Asked for first; left out because hue has no order: is yellow more than green? One color
  growing stronger, or two ends through yellow, are read without a legend.
- **The first selected field colors the row, implicitly.** The order of selection is not visible afterwards. The
  target is on each rule, with that default when rules are made from a column.
- **The pane under the query, or at the bottom.** It takes height from the table, which is what the user watches
  while tuning; documents are wider than tall less often than tables are long.
- **Keeping the popup for the rules and a pane for the legend only.** Two places for one thing.
- **The wider scopes kept on the connection's entry**, as the colors of collections are (D16). Mongoster's export of
  connections would carry them, but that file is about reaching servers and may hold secrets; formatting has its own
  file that is safe to post in a chat.
- **Rules in the project's `.mongoster/`**, shared through git (0002's open question 1). Still possible later, with
  this proposal's file form; export and import cover sharing without a repository, which is what was asked.
- **Server-side distinct values or `$min`/`$max` for the legend and the scale.** Exact over the whole collection, but
  a query per rule, slow on large collections, and nothing for a pipeline's output. The page, and `From This Page`.

## Costs

- **0.9.0 reading newer rules**: its `readFormatRules` drops the entries without a `condition` and the colors beyond
  six, and writes back what it kept: going back to 0.9.0 and editing a collection's rules there loses that
  collection's field rules. The other way is whole: everything 0.9.0 wrote is read as condition rules.
  [11-data.md](../11-data.md) gets the four keys, `mongoster.formattingPane` and the exported file.
- **Existing row colors get fainter** (25 % → 12 %) for everyone at the update.
- **D18 changes**: rules are no longer per collection only, colors are eleven, a rule may have no condition. It is
  replaced by a new decision, not edited.
- **A rule that applies everywhere is easy to forget**: a color appears in a collection the user never formatted. The
  status bar's count, the sections of the pane and the eye button are the answer.
- **Painting**: a field rule in `values` mode hashes each value of its field on each paint (500 rows at most, cached
  by text for the page).
- `src/webview/formatting.ts` is rewritten, its tests with it; three new shared modules.

## Open questions

1. `Hide Formatting` for every tab, kept (proposed), or for the one tab, forgotten when it closes?
2. Should a section's checkbox (turn off the database's rules *for this collection*) be kept, which is one more key
   per collection, or is the eye button enough?
3. Ten colors by hash can give two frequent values the same color, and pinning a value changes the colors of some of
   the others (its color leaves the palette). Assign instead by first appearance and store the assignment in the rule
   (stable, never clashing before the palette runs out, but the rule changes as the user pages)?
4. A palette of the user's own colors (pick three or four presets) besides `All Colors` and the shades?
5. Should `Export All Formatting…` exist from the start, or only the export of what the tab sees?
6. The order of building: field rules and the pane first, then scopes, then export and import — three releases, or one?

## Stages

Accepted to be built in three stages, each usable by itself.

1. **Field rules and the pane** (built): the two kinds of rule, pinned values and palettes, the eleven colors, rows
   fainter than cells, names, the Formatting pane with its legends and `Hide Formatting`, `Color by This Field`. The
   pane lists the collection's rules only; `init` keeps `formatRules` and gains `formattingPane`, saved with
   `saveFormattingPane`. Open question 1 is settled as proposed: `Hide Formatting` holds for every tab and is kept.
2. **Scopes**: the database's, the connection's and the global rules, the four sections, moving and copying a rule
   between them, `src/formattingStore.ts`. Open question 2.
3. **Export and import**: the file, the two commands, the line in 10-security.md. Open question 5.
