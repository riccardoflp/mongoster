# The feature contract

How a feature of Mongoster is shaped in the code, how it is described in a card, and the list of areas the catalog is
split into. The cards are in [features/](features/README.md).

## What a feature is today

A feature is something the user can do or see. In the code it is reached in one of three ways:

- a **command** of `package.json`'s `contributes.commands`, registered in `src/extension.ts`, run from the tree, a
  menu or the Command Palette (`mongoster.dropCollection`);
- a **message** from a tab's webview to its host class, handled in its `receive` (`{ type: 'deleteMany', … }` in
  `src/collectionPanel.ts`), with its types in `src/shared/messages.ts`;
- a **tool** of the MCP server (`find_documents`), in `src/mcpTools.ts` or a group of `src/mcp/`.

What it does is spread over three layers, which the cards name:

1. **The pure part**: what to ask, what to check, which documents a write touches and how, how a result is shown. It
   lives in `src/shared/` or in a module without a `vscode` import (`src/fieldActions.ts` decides the filter and the
   update of a column action; `src/shared/structure.ts` decides the steps that align two databases), and is
   unit-tested.
2. **The host part**: a method of a host class or a command handler that asks the user (`showWarningMessage`, quick
   picks, input boxes), reads the database, and runs the write through the steps of
   [the write pipeline](02-architecture.md#writing-to-a-database).
3. **The webview part**: the buttons, dialogs and keys in `src/webview/`, which only post messages.

Most features today keep their logic in the host part, mixed with VS Code calls, and are tested only where the logic
was moved out. That is the current shape, and the cards describe it as it is.

## The target, for new code and code that is changed anyway

*Proposed by this documentation; see [Q1](08-decisions.md#open-questions).* Every write is split into a **plan** and
its **execution**:

```ts
/** Feature: field.rename */
export function planRenameField(context: FieldContext, answers: FieldAnswers): WriteOutcome

type WriteOutcome =
  | { kind: 'ask'; question: Question }          // a name, a choice, a confirmation
  | { kind: 'refuse'; reason: string }           // read-only connection, a view, `_id`…
  | { kind: 'run'; plan: WritePlan };

interface WritePlan {
  title: string;                                 // as the confirmation and the undo history show it
  target: CollectionTarget;
  filter: Document;                              // the documents it touches
  update?: Document | Document[];
  danger: 'none' | 'confirm' | 'destructive';    // and the confirmation's text
  undo: 'recorded' | { cannot: string };          // why it can't be undone
  publish: 'redis-oplog' | { not: string };
}
```

The plan is a pure function, in `src/shared/` or a module without `vscode`, unit-tested on its own; the host only
counts, confirms, runs the steps of the write pipeline and refreshes. `src/fieldActions.ts` is already close to this.
The target is not a refactor of everything: a feature moves to it when it is changed for another reason.

## Kinds

| Kind | In Mongoster | Pure? |
| --- | --- | --- |
| **Operation** | Changes something: a database, the server's settings, Mongoster's own state (connections, saved queries, tasks), or files on disk. | Today rarely; the target above. |
| **Read** | Reads a database, the server, a file or Mongoster's state, and shows or returns it. Changes nothing. | The parsing of what was read usually is (`src/shared/`). |
| **View** | A tab, a dialog or a part of one: what is shown and what can be done there. | The webview code is plain DOM; what it shows is computed in `src/shared/`. |
| **Derivation** | Turns data into other data: a filter from a builder, a schema from a sample, a script, a layout. | Yes, in `src/shared/` or a module without `vscode`. |

## Identifiers

`area.action`, lower case, words joined by `-`: `document.delete-many`, `connection.import`. The identifier heads the
card. In new code it is also written in the doc comment of the function that implements it (`/** Feature:
document.delete-many */`) and in the name of its tests (`it('document.delete-many: refuses on a read-only
connection', …)`), so that a search finds the card, the code and the tests together.

## The card

Leave out a line that does not apply, except **Danger**, **Undo** and **Read-only** on an operation, which are always
said.

````markdown
### `area.action` — Title in sentence case

What it is for, in one or two sentences, from the user's side.

- **Kind**: Operation | Read | View | Derivation
- **Function**: `src/file.ts › Class.method` (or `› function`): the function that does the work today.
- **Implemented in**: the other files involved: command registration, webview, message types, pure helpers.
- **Entry points**: the command (`mongoster.x`, its title) and where it is shown (tree node, view title, `…` menu,
  Command Palette), the tab's button or key, the MCP tool.
- **Offered when**: the `when` clause or the condition that shows it.
- **Asks**: the questions, in order, with their defaults.
- **Reads**: what it reads before it decides.
- **Writes**: the commands sent to MongoDB (`updateMany(filter, update)`), or the files written.
- **Danger**: None | Confirm: the text of the confirmation | Destructive: what is lost.
- **Read-only**: Refused on a read-only connection, with the message | Allowed, because it writes nothing to the
  database.
- **Undo**: Recorded in the undo history (`undo.record`) | Cannot be undone: why, and whether the confirmation says so.
- **redis-oplog**: Published (`oplog.publish`) | Not published.
- **After**: what is refreshed, said or offered.
- **Refuses**: when, and what it says.
- **Settings**: `mongoster.*` settings that change it.
- **Uses**: other cards, by identifier.
- **Tested by**: `test/unit/x.test.ts › 'the test name'`, or *none*.
- **Differs**: only when the code does something else than the card says is wanted: what, and why it matters.

Acceptance:

- [ ] A sentence a test can check, from the user's side, with exact values.
````

A **Derivation** card replaces the operation lines with the rules of its result: inputs, outputs, invariants and worked
examples (input → output).

Acceptance lines describe what Mongoster does today. A line that the code does not satisfy is marked `(differs)` and
the card has a **Differs** line; the index marks the card *Differs*.

## Areas

Each area has a file and a prefix. The areas marked *later* have no cards yet: they are written when the area is next
changed ([07-roadmap.md](07-roadmap.md)). Cross-references use these prefixes only.

| File | Prefix | Area | Cards |
| --- | --- | --- | --- |
| `01-connections.md` | `connection.` | Saved connections: add, edit, TLS and SSH, test, remove, folders, color, read-only, import and export, secrets | now |
| `02-tree.md` | `tree.` | The connections view: nodes, refresh, disconnect, the filter | later |
| `03-collection-tab.md` | `query.` | The collection tab: table, filter, sort, projection, builder, autocomplete, drag and drop, columns, history, aggregate | later |
| `04-documents.md` | `document.` | Writing documents: inline edit, edit in the editor, insert, duplicate, delete, selected rows, update many, delete many, restore a version | now |
| `05-field-actions.md` | `field.` | Rename, remove or convert a field from its column header | now |
| `06-databases.md` | `manage.` | Create, rename and drop databases and collections; view definitions; validation rules | now |
| `07-undo.md` | `undo.` | The undo history: recording, the tab, undo, limits, per connection | now |
| `08-redis-oplog.md` | `oplog.` | Publishing writes to Redis for redis-oplog | now |
| `09-transfer.md` | `transfer.` | Export, import, copy a collection, generate test documents | now |
| `10-backup.md` | `backup.` | Back up and restore in mongodump's formats | now |
| `11-scheduled-tasks.md` | `task.` | Scheduled backups and exports | now |
| `12-mcp.md` | `mcp.` | The MCP server for AI assistants and its tools | now |
| `13-compare.md` | `compare.` | Compare collections, and copy documents from one side to the other | now: the writes |
| `14-structure.md` | `structure.` | Compare database structures, the script, Apply | now: the writes |
| `15-indexes.md` | `index.` | Indexes and search indexes: create, edit, drop, hide | now: the writes |
| `16-users.md` | `user.` | Users and roles | later |
| `17-gridfs.md` | `gridfs.` | GridFS buckets and files | later |
| `18-monitor.md` | `monitor.` | The server monitor: operations, slow queries, stats, replication, sharding | later |
| `19-playground.md` | `playground.` | Playgrounds: running scripts, sessions, transactions | later |
| `20-search.md` | `search.` | Global search across collections | later |
| `21-relations.md` | `relations.` | The relationship diagram and following references | later |
| `22-analysis.md` | `analysis.` | Schema, charts, explain, code, the index advisor | later |
| `23-saved-queries.md` | `saved-query.` | Saved queries, for the user and in the project | later |
| `24-watch.md` | `watch.` | Change streams | later |
| `25-desktop-app.md` | `app.` | The desktop app: window, tabs, settings, tray | later |
| `26-settings.md` | `settings.` | The `mongoster.*` settings | now |
