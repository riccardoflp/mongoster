# Decisions

The choices that shape Mongoster, each with why and what it costs. A decision is never edited away: when it changes,
a new one replaces it and the old one says *Replaced by*. Most of these were taken before this page existed and are
**reconstructed** from the code and the history, with the commit that introduced them; where the history does not say
why, the reason is marked *inferred* and should be confirmed or corrected.

## D1 — One code base for the extension and the desktop app

The desktop app runs the extension's code unchanged in Electron's main process, with the `vscode` module replaced by
`src/standalone/vscode/`, which implements the part of VS Code's API Mongoster uses and reads commands, menus and
settings from `package.json`. A feature is written once. The cost: every new VS Code API must be implemented there
too (R1.4), and the desktop app can only look like what that API allows. *Reconstructed from afb8eaa.*

## D2 — Webviews in plain DOM, without a UI framework

Every tab is a webview written with the DOM API and Mongoster's own small widgets (`popupMenu.ts`, `cellEditor.ts`,
`autocomplete.ts`). The bundles stay small and there is no framework to keep up to date. The cost: the largest views
are long files (`src/webview/main.ts`, 2,047 lines). *Reconstructed from df3b612; the reason is inferred
([Q5](#open-questions)).*

## D3 — mongosh syntax is what the user reads and writes

Filters, documents, pipelines and values are written as in mongosh (`ObjectId("…")`, `ISODate("…")`, `/re/i`),
parsed with JSON5 and Mongoster's own rules in `src/shared/query.ts`, never evaluated. It is what MongoDB users
already know, and it keeps the BSON types that plain JSON loses. *Reconstructed from df3b612.*

## D4 — The official Node.js driver, MongoDB 4.2 or later

Mongoster talks to MongoDB only through the `mongodb` package; it supports what the driver supports, 4.2 or later.
Older servers are refused by the driver, not by Mongoster. *Reconstructed from d9c173d.*

## D5 — An undo history of Mongoster's own

MongoDB has no undo. Before each write to documents, Mongoster saves the documents as they were, in gzip files under
the extension's global storage, with limits on size, age and count (`mongoster.history.*`). Undoing writes the saved
documents back, and is itself recorded. The cost: disk space, a second read before every write, and writes larger than
the limits that cannot be undone (the confirmation says so). *Reconstructed from 5b6a6c3.*

## D6 — Read-only is a safeguard of Mongoster, not a permission

A connection marked read-only makes Mongoster refuse every write through it; the MongoDB user's roles are not
changed or checked. It protects against a mistake in the UI on a production connection, not against a malicious
user. *Reconstructed from 58d8637.*

## D7 — The MCP server is read-only, local and behind a token

The MCP server listens on `127.0.0.1` only, needs a bearer token kept in the secret storage, has no tool that writes,
and gives documents to the AI only with `mongoster.mcp.readDocuments`. An AI assistant can then explore and explain a
deployment without being able to change it. *Reconstructed from 235707f and 21722ec.*

## D8 — Publishing writes for redis-oplog

Meteor apps using `cultofcoders:redis-oplog` see only the writes announced on Redis, so a connection can be set to
publish Mongoster's writes the way the package does. A Redis error does not stop the write. *Reconstructed from
705bc9b.*

## D9 — Documents for contributors: numbered pages and a catalog of cards

The documentation for whoever changes the code is a set of numbered pages in `docs/` (product, architecture, code
rules, feature contract, platform, testing, roadmap, decisions, glossary, security, stored data, quality, risks) and a
catalog of features in `docs/features/`, one card per feature with its function and tests, checked by `catalog.py`.
The README stays the user manual. The catalog starts with the riskiest areas; the others get cards when they are next
changed. Rejected: one long architecture page (it cannot say what each feature promises), and the whole catalog at
once (most of it would describe code nobody is changing). *Decided 2026-11-12.*

## D10 — Backups in mongodump's formats, written by Mongoster

Backups and restores read and write the formats of `mongodump` and `mongorestore` (folders of `.bson` and
`.metadata.json`, and the `--archive` format, gzipped or not), implemented in `src/backup.ts` and `src/archive.ts`
rather than by running the MongoDB Database Tools. Backups move both ways between Mongoster and the tools. The cost:
what the tools do and Mongoster does not (time series collections) is left out and said. *Reconstructed from c927ebe
and 2993248; the reason, not needing the tools installed, is inferred.*

## D11 — Everything bundled, an allowlist for the package

esbuild bundles every dependency; nothing of `node_modules` is shipped. `.vscodeignore` is an allowlist, so a new
bundle that is not listed is left out of the `.vsix` and its tab is blank. *Reconstructed from the build files.*

## D12 — Tests with Vitest against a real mongod

Unit tests for the pure modules; integration tests against a standalone mongod and a single-node replica set started
by `mongodb-memory-server`, so that sessions, transactions, change streams and the oplog are tested for real. No
mocks of the driver. *Reconstructed from f68c0d7.*

## D13 — The desktop app keeps its own data

The desktop app stores connections, history and settings in its own folder, with secrets encrypted by Electron's
`safeStorage`, and does not share connections with the extension. *Reconstructed from afb8eaa; the reason is inferred
(Q9).*

## D14 — Scheduled tasks run inside Mongoster

Scheduled backups and exports run while VS Code or the desktop app is open, not through the operating system's
scheduler; with several windows, a file lock makes one of them run each task. Missed runs can run at the next start.
Nothing is installed on the system. The cost: no run while Mongoster is closed, except in the desktop app's tray.
*Reconstructed from 9ba6e0c.*

## D15 — Saved queries in the project are one JSON file each

A query saved in the project is a JSON file in `.mongoster/queries/<database>/<collection>/<name>.json`, text on
several lines is an array of lines, and nothing secret is written, so the team can review it in a diff and share it
through git. *Reconstructed from 9ba6e0c.*

## D16 — A collection's color is kept on its connection

A collection, a view or a GridFS bucket can have a color of its own (one of the six, or none), which takes the place
of the connection's for what belongs to that collection alone. The colors are kept in the connection's entry of
`mongoster.connections`, keyed by `database.collection`, so that Mongoster's export and import carry them, removing the
connection removes them, and the open tabs hear of a change the way they hear of the connection's color. A rename or
drop from Mongoster moves or removes the color; one done elsewhere leaves it. *Accepted in
[proposal 0001](proposals/0001-collection-colors.md).*

## D17 — Eleven preset colors and custom colors, exact where Mongoster draws them

The colors of connections and collections are eleven presets, the theme's six `charts.*` colors and five Mongoster
contributes as theme colors (pink, teal, indigo, brown, gray: four of them are Compass's), or a custom `#rrggbb`
chosen in the **Choose a Color** tab. VS Code takes only theme colors for the icons and names in the tree, the tab
icons and the names of editor tabs, so a custom color shows there as its nearest preset; it is exact on the stripe of
the tabs' content and the desktop app's line above the tabs, which Mongoster draws itself. The stored color is a preset
name or the hex, so the old six names keep their meaning. *Accepted in revision 2 of
[proposal 0001](proposals/0001-collection-colors.md).*

## D18 — Conditional formatting matched in the webview, rules kept for the user

Formatting rules color rows and cells of the collection tab's table. A rule's condition is a filter in mongosh syntax,
matched in the webview on the page shown by `src/shared/match.ts`, Mongoster's own matcher of the query operators over
relaxed Extended JSON, with MongoDB's semantics for the operators it supports and a clear refusal for the others
(`$expr`, `$where`, `$text`, geospatial, bitwise). The first matching rule wins, a cell rule over a row rule; the
colors are the six of connections, taken from the theme. The rules are kept for the user in `globalState`, per
collection, and follow a rename. Rejected: matching on the server (a query per rule and page, nothing for a
pipeline's output), a matcher library (`sift`, `mingo`: a dependency that knows plain values, not relaxed Extended
JSON), any CSS color (unreadable in one of the themes), rules in the project's `.mongoster/` (a shared file format,
left to a later proposal). The cost: a matcher that must keep MongoDB's semantics, and is for display only.
*Decided 2026-11-23, [proposal 0002](proposals/0002-conditional-formatting.md).*

## D19 — What is excluded from searches stays in the tree and answers when asked for by name

A connection, a database, a collection, a view or a GridFS bucket can be excluded from searches (`Exclude From
Searches`), for what the user doesn't use or doesn't want searched. The exclusions are kept on the connection, as the
colors of collections are (D16): `excluded` for the connection, `exclusions` for its databases (`shop`) and collections
(`shop.orders`, a bucket by its `.files`). Something excluded stays in the tree, dimmed, and what goes across
connections, databases or collections leaves it out: the tree's filter, the global search over a deployment or a
database, the MCP server's `list_connections`, `list_databases` and `list_collections`. What the user or a tool asks
for by name still works, excluded or not: opening it, a search started on it, a tool given its name. Rejected: hiding
what is excluded (a second way to lose a collection from sight, and a `Show Excluded` switch to explain), excluding
from backups and exports (an incomplete backup nobody asked for), a list kept per user apart from the connection (the
export would lose it). New code that goes across databases or collections on its own decides whether it leaves the
excluded out, with `leaveOutExcluded` in `src/shared/exclusions.ts`.

## Open questions

- **Q1** — Adopt the target of [04-feature-contract.md](04-feature-contract.md#the-target-for-new-code-and-code-that-is-changed-anyway)
  (a write planned by a pure function, run by the host) for new code and code changed anyway? Proposed by this
  documentation; R2.3 depends on it.
- **Q2** — Confirm or change the size limits of R6.4 (about 80 lines per function, 1,000 per file).
- **Q3** — Give Mongoster's own file formats a version field (undo history, scheduled tasks, saved query files), so
  that R15.1 can be kept? See [11-data.md](11-data.md).
- **Q4** — Add a linter (typescript-eslint, with an import rule for R1.2 and R1.3, and `max-lines-per-function` for
  R6.4)? Today only the build and the type checker enforce rules.
- **Q5** — Why no UI framework (D2): bundle size, speed, or taste? The answer decides whether a framework may come
  in for a new, large tab.
- **Q6** — Run `catalog.py` in the CI, or port it to a Node script so that the project needs no Python?
- **Q7** — The private channel for reporting a vulnerability in [SECURITY.md](../SECURITY.md).
- **Q8** — A playground opened from someone else's repository runs code only when the user runs it, but with the
  user's connections; should Mongoster refuse to run playgrounds in a workspace VS Code does not trust? See T6 in
  [10-security.md](10-security.md).
- **Q9** — Why the desktop app does not share connections with the extension (D13): separation on purpose, or not
  done yet?
- **Q10** — Import, generated documents, copy, restore and the comparison's writes are not published to redis-oplog.
  The README lists them as not published, but AGENTS.md's write steps and the promise of 01-product say every write
  to documents is. Is the README's list a choice (then R4.1 and AGENTS.md name the exceptions, and the **Differs**
  of `oplog.publish`, `transfer.import`, `transfer.copy-collection`, `transfer.generate`, `backup.restore`,
  `compare.copy-document` and `compare.make-like` lose their redis-oplog part) or a gap to close?
- **Q11** — `structure.apply` drops a collection with its documents after a modal with a button, while
  `manage.drop-collection` asks for the name to be typed. Should dropping through a structure comparison ask the same?
