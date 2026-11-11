# Architecture

How Mongoster's code is organized, what talks to what, and where each feature lives. For building, testing and releasing see [DEVELOPMENT.md](DEVELOPMENT.md); for the rules to follow when changing the code see [CLAUDE.md](../CLAUDE.md).

## The four places code runs

Mongoster is one code base built by `esbuild.mjs` into several bundles, which run in different places and can't import each other freely:

| Where | Entry point | Bundle | Can use |
| --- | --- | --- | --- |
| **Extension host** (Node) | `src/extension.ts` | `dist/extension.js` | `vscode`, `mongodb`, Node, `src/shared` |
| **Webviews** (a browser sandbox per tab) | `src/webview/<tab>.ts` | `dist/<tab>.js` | the DOM, `src/shared` only |
| **Desktop app, main process** (Electron) | `src/standalone/main.ts` | `dist/app/main.js` | the extension host's code, with `vscode` resolved to `src/standalone/vscode` |
| **Desktop app, window** (Electron renderer) | `src/standalone/shell/main.ts` | `dist/app/shell.js` | the DOM, Monaco |

```
             VS Code                                    Desktop app (Electron)
┌──────────────────────────────┐        ┌─────────────────────────────────────────────┐
│ extension host               │        │ main process                                │
│  src/extension.ts + features │        │  src/standalone/main.ts                     │
│  import 'vscode' ──► VS Code │        │  the same src/extension.ts + features       │
└──────────┬───────────────────┘        │  import 'vscode' ──► src/standalone/vscode  │
           │ postMessage                └──────────┬──────────────────────────────────┘
┌──────────▼───────────────────┐                   │ IPC (src/standalone/protocol.ts)
│ webview (one per tab)        │        ┌──────────▼──────────────────────────────────┐
│  src/webview/<tab>.ts        │        │ window: src/standalone/shell                │
│  media/<tab>.css             │        │  tree, tabs, Monaco, quick picks, settings  │
└──────────────────────────────┘        │  └─ webview frames: the same src/webview    │
                                        └─────────────────────────────────────────────┘
```

`src/shared/` is the code both sides use: parsing and formatting mongosh syntax, the message types, the schema analysis, the pipeline model, CSV, code generation… It imports neither `vscode` nor `mongodb`, so it runs in the webviews and is unit-tested without anything around it.

## Layering rules

These are kept everywhere today; breaking one breaks a bundle or the desktop app.

- **`src/shared/`** imports only other `src/shared` modules and small pure libraries (`json5`). No `vscode`, no `mongodb`, no Node APIs.
- **`src/webview/`** imports only `src/shared` (and `chart.js` in `chartjs.ts`). Values from the database reach it as relaxed EJSON plain objects (`{ $oid: … }`, `{ $date: … }`), never as BSON classes.
- **The extension host** may import `vscode`, but only the part of the API that `src/standalone/vscode` implements: `npm run typecheck` checks the code against both. Using a new VS Code API means implementing it there too (or the desktop app breaks at run time).
- **Logic that needs no VS Code** goes in modules without a `vscode` import (e.g. `src/relationsAnalysis.ts`, `src/mcp/*.ts`, `src/oplogHistory.ts`, `src/taskRunner.ts`), so it can be tested against a real mongod. Modules that import `vscode` only for types or classes get `test/stubs/vscode.ts` in the tests.

## Values and text

- **mongosh syntax** is what the user types and reads: filters, sorts, projections, pipelines, documents in dialogs (`ObjectId("…")`, `ISODate("…")`, `/re/i`). `src/shared/query.ts` parses it (with JSON5) and formats it (`toShell`, `prettyShell`).
- **Relaxed EJSON** plain values are what crosses `postMessage`: `relaxEjson` in `src/shared/query.ts` makes them from canonical EJSON. In the host, `src/queries.ts` turns query texts into driver arguments.
- Documents are read with `promoteValues: false` where types must survive a round trip (e.g. `Int32` vs `Double`), and compared with `src/shared/compare.ts`, which knows about field order and numeric types.

## A tab: host class + webview + CSS

Every tab other than the editors is a `vscode.WebviewPanel`, built the same way. `src/docHistory.ts` + `src/webview/docHistory.ts` + `media/docHistory.css` is a small, complete example.

**Host side** (`src/<feature>.ts`):

- A class with a `private static readonly panels = new Map<string, Panel>()` keyed by what the tab shows (connection, database, collection…), and a `static show(…)` that reveals the existing tab or creates one.
- `vscode.window.createWebviewPanel(…, { enableScripts: true, retainContextWhenHidden: true, localResourceRoots: [dist, media] })`.
- `paintTab(panel, extensionUri, color)` from `src/connectionColors.ts` gives the tab the connection's color.
- `html()` writes the page: a Content-Security-Policy with a nonce, the CSS files from `media/` (`media/controls.css` last), and `<script nonce src="dist/<tab>.js">`.
- `receive(m: XViewMessage)` handles what the webview sends; `post(m: XHostMessage)` answers. The webview starts with `{ type: 'ready' }`, and the host answers with `{ type: 'init', … }`.
- `static connectionChanged(info)` (name, color, read-only changed) and `static close(connectionId)` (connection removed): `src/extension.ts` calls them for every tab type in `updateConnection` and when a connection is removed.

**Message types** live in `src/shared/messages.ts`: one `XHostMessage` and one `XViewMessage` union per tab, discriminated by `type`. Requests that expect an answer carry a `requestId`.

**Webview side** (`src/webview/<tab>.ts`): `acquireVsCodeApi()`, a `post()` helper, plain DOM code (no framework), `window.addEventListener('message', …)` switching on `type`. Shared widgets: `popupMenu.ts`, `cellEditor.ts`, `highlight.ts` (colored query inputs), `autocomplete.ts`, `codeDialog.ts`.

**Build and package**: a webview bundle needs an entry in `esbuild.mjs` and a `!dist/<tab>.js` line in `.vscodeignore` (an allowlist: anything not listed is left out of the `.vsix`).

The collection tab (`src/collectionPanel.ts` + `src/webview/main.ts` and the modules it imports) is the big one: table, query bar, builder, pipeline editor, schema, indexes, explain, chart, history and saved queries.

## Writing to a database

Every write made through Mongoster's UI goes through the same steps, so that it can be undone and so that Meteor apps using redis-oplog see it. `DocumentHistoryPanel.restore` in `src/docHistory.ts` is a short example:

1. **Read-only**: refuse if `connections.get(id)?.readOnly` (views are read-only too).
2. **Confirm** destructive or bulk writes with a modal `showWarningMessage`, adding `UndoHistory.note(connectionId, n)` to the detail (it says whether the write can be undone).
3. **Undo history**: `const rec = UndoHistory.start(target, label)`, then `rec?.snapshot(coll, filter)` / `rec?.snapshotIds(coll, ids)` before writing, and `rec?.commit(coll)` after (`src/history.ts`).
4. **redis-oplog**: `RedisOplog.sink(target)?.inserted(ids) / updated(ids, fields) / removed(ids) / changes(before, after)` (`src/redisOplog.ts`); both return `undefined` when the feature is off for the connection.
5. **Refresh**: `UndoHistory.notify(message, entry)`, `CollectionPanel.refresh(ref)`, `mongoster.refresh` for the tree when counts or collections changed.

The MCP server never writes. The playground's writes are published to redis-oplog by `src/playground/oplogWrites.ts`, but aren't in the undo history.

## Connections and state

- `ConnectionManager` (`src/connections.ts`) keeps the list of connections in `globalState`, the connection strings, TLS/SSH options and Redis URLs in `SecretStorage`, and one `MongoClient` per connected connection (`getClient(id)`), with the SSH tunnel of `src/transport.ts`.
- Per-collection UI state (columns layout, expanded fields, query history) is in `globalState`, under the keys of `src/collectionPanel.ts` (`panelKey`, `layoutStateKey`, `expandedStateKey`).
- Larger data is in files under `context.globalStorageUri`: the undo history (`history/`) and the scheduled tasks (`scheduledTasks/`, shared by all VS Code windows through the lock of `src/fileLock.ts`).
- Saved queries are either the user's (`src/queryHistory.ts`, `globalState`) or the project's (`src/projectQueries.ts`, JSON files in `.mongoster/queries` of the workspace folder).
- Settings are the `mongoster.*` of `package.json`'s `contributes.configuration`, read with `vscode.workspace.getConfiguration`.

## The desktop app

`src/standalone/` runs the extension unchanged in Electron's main process:

- `vscode/` implements the part of VS Code's API that Mongoster uses. It reads commands, menus with their `when` clauses, key bindings and settings from `package.json`'s `contributes` (`contributions.ts`), so a command added there shows up in the app's tree, menus and Command Palette without app-specific code. Storage is files in the app's data folder, secrets are encrypted with Electron's `safeStorage` (`storage.ts`).
- `main.ts` creates the window, the menu bar (the `Tools` menu lists some commands by hand), the tray, and the `mongoster-app://` protocol that serves the window and the webviews.
- `shell/` is the window: tree, tabs in two groups, Monaco editors, quick picks, notifications, the Settings tab. It only draws what the host sends, through `protocol.ts` and `preload.ts`.
- `theme.ts` has the dark and light colors given to the webviews as `--vscode-*` CSS variables, as VS Code does.

`npm run typecheck` checks the code a second time with `tsconfig.standalone.json`, which maps `vscode` to `src/standalone/vscode/index.ts`: a VS Code API the app lacks is a type error there.

## MCP server

`src/mcpServer.ts` serves the Model Context Protocol on `127.0.0.1` (Streamable HTTP, plain JSON, bearer token in the secret storage) for AI assistants. `src/shared/mcp.ts` is the protocol and the `McpTool` type; `src/mcpTools.ts` has the basic tools and gathers the groups of `src/mcp/`:

- `context.ts`: what the tools share (finding the connection, database and collection, parsing arguments, `MAX_OUTPUT`, `MAX_TIME_MS`).
- `data.ts`, `performance.ts`, `topology.ts`, `changes.ts`: read-only tools without a `vscode` import, tested against a real mongod.
- `workspace.ts`: tools on Mongoster's own state and tabs, through the `WorkspaceHost` interface that `src/extension.ts` implements.

Tools that return documents or field values are offered only with `mongoster.mcp.readDocuments` on. No tool writes, kills an operation or changes the profiler.

## Code map

### Extension core
- `src/extension.ts` – activation: creates the services, registers every command, wires tabs to connection changes
- `src/connections.ts` – saved connections, their secrets and the `MongoClient` cache
- `src/transport.ts` – TLS options and SSH tunnel (`ssh2`) with host key verification
- `src/tree.ts` – connections / folders / databases / collections / GridFS buckets tree, the tree filter; `errorMessage`
- `src/connectionColors.ts` – a connection's color on its tabs, its documents' and playgrounds' tab names and its tree nodes
- `src/themeColors.ts`, `src/shared/tokenColors.ts`, `src/webview/tokenColors.ts` – syntax colors of the active theme (its file, its includes and `editor.tokenColorCustomizations`) sent to the webviews
- `src/manage.ts` – creating, renaming and dropping databases and collections
- `src/documentFs.ts` – `mongoster://` file system to open, edit and save documents in editor tabs
- `src/definitionFs.ts` – `mongoster-def://` file system for view definitions and validation rules

### Connections UI
- `src/connectionEditor.ts`, `src/webview/connectionEditor.ts`, `media/connectionEditor.css` – connection form (TLS, SSH, redis-oplog, test)
- `src/connectionsTransfer.ts`, `src/shared/connectionsFile.ts` – importing and exporting connections: Compass's export, Mongoster's JSON, lists of connection strings, passwords encrypted as Compass does

### Collection tab
- `src/collectionPanel.ts` – the collection tab's host: queries, aggregations, edits, bulk updates and deletes, column actions, references
- `src/queries.ts` – query and pipeline texts → driver arguments (shared with the exporter)
- `src/fieldActions.ts` – column actions (rename, remove, convert a field): the documents they touch and the update
- `src/queryHistory.ts` – recent and saved queries of a collection, for the user
- `src/projectQueries.ts`, `src/savedQueryActions.ts`, `src/shared/savedQueries.ts` – saved queries in the project's repository: file format, watching the folder, saving, renaming and moving them
- `src/webview/main.ts` – the table and the tab's wiring; with `history.ts`, `pipeline.ts`, `builder.ts`, `indexes.ts`, `indexDialog.ts`, `searchIndexes.ts`, `searchIndexDialog.ts`, `explainView.ts`, `bulk.ts`, `schemaView.ts`, `chartView.ts`, `columnsUi.ts`, `autocomplete.ts`, `insertDialog.ts`, `cellEditor.ts`, `popupMenu.ts`, `highlight.ts`, `codeDialog.ts` of `src/webview/`, and `media/webview.css`
- `src/webview/chartjs.ts` – Chart.js, a bundle of its own loaded only when the `Chart` tab is opened

### Shared logic (`src/shared/`, no `vscode` or `mongodb`)
- `messages.ts` – message types between the host and every webview
- `query.ts` – mongosh syntax ⇄ EJSON, relaxed EJSON helpers
- `syntax.ts` – tokens of mongosh text, to color the query inputs
- `complete.ts` – autocomplete: cursor context in mongosh text, suggested fields, operators and values
- `builder.ts` – visual query builder rows ⇄ filter
- `pipeline.ts` – aggregation stages, templates, text ⇄ stages
- `columns.ts` – columns model (nested fields, arrays) and the user's layout, for the table and CSV
- `csv.ts` – CSV writing and parsing
- `formats.ts` – documents as text to copy (mongosh, EJSON, JSON Lines, JSON, YAML, insert commands) and the insert dialog's text back to documents
- `schema.ts` – schema analysis of a sample and generated `$jsonSchema`
- `explain.ts` – explain summary (also per shard) and suggested index
- `indexes.ts`, `searchIndexes.ts` – index definitions, summaries and templates
- `compare.ts` – document equality (field order, numeric types, ignored fields) and field differences
- `profile.ts` – slow operations from the profiler or the log: query shape, grouping, suggested index
- `codegen.ts` – queries and pipelines as code for mongosh, Node.js, Python, Java, C#, Go
- `chart.ts` – chart pipelines and their results as series
- `generate.ts` – fake documents from a schema analysis (seedable, no I/O)
- `relations.ts`, `references.ts` – relationship diagram model and layout; following references from the table
- `structure.ts` – comparing two databases' structures and the script that aligns them
- `docHistory.ts` – rebuilding a document's versions from its oplog entries
- `oplog.ts` – redis-oplog channels and messages, the fields an update changes
- `schedule.ts` – scheduled tasks: next runs in local time, missed runs, file name patterns
- `gridfs.ts`, `advisor.ts`, `mcp.ts`, `connectionsFile.ts`, `savedQueries.ts`, `tokenColors.ts` – see their features

### Other tabs (host, webview, CSS)
- Server monitor – `src/monitor.ts`, `src/webview/monitor.ts`, `media/monitor.css`; with `src/replication.ts` (members, lag, oplog entries) and `src/sharding.ts` (shards, chunks, balancer, changelog)
- Index advisor – `src/advisor.ts`, `src/shared/advisor.ts`, `src/webview/advisor.ts`, `media/advisor.css`
- Watch (change streams) – `src/watch.ts`, `src/webview/watch.ts`, `media/watch.css`
- Global search – `src/search.ts`, `src/webview/search.ts`, `media/search.css`
- Relationship diagram – `src/relations.ts`, `src/relationsAnalysis.ts` (sampling, verified references, cache per database; no `vscode`), `src/webview/diagram.ts`, `media/diagram.css`
- Compare collections – `src/compare.ts`, `src/webview/compare.ts`, `media/compare.css`
- Compare structure – `src/structurePanel.ts`, `src/structure.ts`, `src/webview/structure.ts`, `media/structure.css`
- Document history – `src/docHistory.ts`, `src/oplogHistory.ts` (reading a document's oplog entries a page at a time), `src/webview/docHistory.ts`, `media/docHistory.css`
- Undo history – `src/history.ts`, `src/webview/undoHistory.ts`, `media/undoHistory.css`
- Users and roles – `src/users.ts`, `src/webview/users.ts`, `media/users.css`
- GridFS – `src/gridfs.ts`, `src/shared/gridfs.ts`, `src/webview/gridfs.ts`, `media/gridfs.css`
- Scheduled tasks – `src/scheduledTasks.ts` (tab), `src/scheduler.ts` (timers, lock, log), `src/taskRunner.ts` (running a task without prompts, retention), `src/fileLock.ts`, `src/shared/schedule.ts`, `src/webview/scheduledTasks.ts`, `media/scheduledTasks.css`

### Data operations without a tab
- `src/transfer.ts` – export (JSON, JSON Lines, CSV) and import
- `src/copy.ts` – copying a collection to another database or connection
- `src/backup.ts`, `src/archive.ts` – backup and restore in mongodump's formats (folders, gzip, `--archive` / `.agz`)
- `src/generate.ts` – the test documents dialog, target and batches
- `src/redisOplog.ts` – the RESP client and the sink that publishes writes for redis-oplog

### Playground (`src/playground/`)
- `rewrite.ts` – rewrites the script with `acorn` so every call is awaited where it is
- `shell.ts` – mongosh-style runtime (`db`, cursors, sessions, transactions)
- `context.ts` – cursor context for autocomplete
- `playground.ts` – commands, CodeLens, completion
- `resultPanel.ts`, `src/webview/playground.ts`, `media/playground.css` – the result tab
- `oplogWrites.ts` – finds the documents a playground write changes, for redis-oplog

### MCP server
- `src/mcpServer.ts`, `src/mcpTools.ts`, `src/mcp/*.ts`, `src/shared/mcp.ts` – see [MCP server](#mcp-server)

### Desktop app (`src/standalone/`)
- `main.ts` – entry point: window, menu bar, tray, `mongoster-app://` protocol
- `preload.ts`, `protocol.ts` – the messages between the main process and the window
- `theme.ts` – dark and light colors
- `vscode/` – the `vscode` module: `index.ts` (exports), `base.ts` (value types), `commands.ts`, `contributions.ts` (reads `package.json`), `documents.ts` (text documents, file systems, providers), `tree.ts`, `ui.ts` (messages, quick picks, dialogs, progress), `webview.ts`, `storage.ts`, `decorations.ts`, `watcher.ts` (`fs.watch`), `appearance.ts`, `bridge.ts`, `runtime.ts`
- `shell/` – the window: `main.ts`, `workbench.ts` (tabs), `tree.ts`, `editor.ts` (Monaco), `panels.ts` (webview frames), `quickInput.ts`, `notifications.ts`, `settings.ts`, `dom.ts`, `shell.html`, `shell.css`, `webview-default.css`
- `electron-builder.yml`, `build/` – the installers

### Other files
- `media/controls.css` – checkboxes, radios and selects in the theme's colors; every tab loads it last
- `media/connection/*.svg` – the leaf icon in each connection color, dark and light
- `media/mongoster.svg` (activity bar and uncolored tabs), `media/collection.svg` (uncolored collection tabs), `media/icon.png` / `media/icon.svg` (Marketplace icon), `build/icon.png` (the app's icon)
- `test/unit/`, `test/integration/`, `test/stubs/vscode.ts` – see [DEVELOPMENT.md](DEVELOPMENT.md#tests)
