# Mongoster

A MongoDB client that runs as a VS Code extension and, with the same code, as an Electron desktop app. TypeScript, bundled with esbuild, no UI framework (plain DOM in the webviews), tested with Vitest.

- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md) – where code runs, layering, the tab pattern, the write pipeline, the desktop app, the MCP server, a map of every file
- [docs/DEVELOPMENT.md](docs/DEVELOPMENT.md) – running, tests, packaging, CI, releasing
- [README.md](README.md) – the user documentation (also the Marketplace page)
- [CHANGELOG.md](CHANGELOG.md) – what changed, by version

## Commands

```bash
npm run build               # all bundles of the extension (npm run watch to rebuild on changes)
npm run build:app           # the extension's bundles and the desktop app's
npm run typecheck           # against VS Code's API and against the desktop app's implementation of it
npm test                    # unit tests (test/unit)
npm run test:integration    # against a real mongod started by the tests (test/integration)
npx vitest run --project unit test/unit/query.test.ts   # one file
```

Before calling a change done: `npm run typecheck`, `npm test`, and `npm run test:integration` when the change touches database code.

## Rules of the code

- **`src/shared/`** imports neither `vscode` nor `mongodb` nor Node: it runs in the webviews too.
- **`src/webview/`** imports only `src/shared/`. Values reach it as relaxed EJSON plain objects, never BSON classes.
- **The `vscode` API**: only what `src/standalone/vscode/` implements. Using something new (a new `vscode.window.*`, a new event…) means implementing it there too; `npm run typecheck` reports what is missing.
- **Logic worth testing** goes in a module without a `vscode` import (like `src/relationsAnalysis.ts`, `src/mcp/*.ts`, `src/taskRunner.ts`), with pure parts in `src/shared/`.
- **Writes** through the UI follow the steps in [ARCHITECTURE.md › Writing to a database](docs/ARCHITECTURE.md#writing-to-a-database): refuse on read-only connections, confirm, record in `UndoHistory`, publish with `RedisOplog.sink(…)`, refresh.
- **The MCP server never writes**, kills an operation or changes server settings. Tools returning documents or values are gated on `mongoster.mcp.readDocuments`.
- **What the user types and reads is mongosh syntax** (`src/shared/query.ts`): `ObjectId("…")`, `ISODate("…")`, `/re/i`.

## Checklists

**A new command**
- `package.json`: `contributes.commands` (title, `category: "Mongoster"`, icon), `contributes.menus` (tree context with `when` on `viewItem`, `commandPalette` with a `when` for the ones that only make sense in a context).
- Register it in `src/extension.ts`. It must work with no argument (Command Palette) as well as from a tree node.
- The desktop app picks it up from `package.json` by itself; add it to the `Tools` menu in `src/standalone/main.ts` only if it belongs there.

**A new tab** (copy `src/docHistory.ts` + `src/webview/docHistory.ts` + `media/docHistory.css`)
- Host class with `static show`, a `panels` map, `paintTab`, CSP with nonce, `media/controls.css` loaded last.
- `XHostMessage` / `XViewMessage` in `src/shared/messages.ts`; the webview starts with `ready`, the host answers with `init`.
- `static connectionChanged` and `static close`, called from `src/extension.ts` with the other tabs.
- A bundle entry in `esbuild.mjs` **and** a `!dist/<name>.js` line in `.vscodeignore` (otherwise the tab is blank in the installed `.vsix`).

**A new MCP tool**: in the group of `src/mcp/` it belongs to (or `src/mcpTools.ts`), read-only, output bounded by `MAX_OUTPUT` and `MAX_TIME_MS`, gated on `readDocuments` if it returns data; a test in `test/unit/` for arguments and output and in `test/integration/` against mongod; listed in the README's MCP section.

**A new setting**: `contributes.configuration` in `package.json` with a `markdownDescription`; the desktop app's Settings tab is built from it.

**Every user-visible change**
- An entry in `## Unreleased` of `CHANGELOG.md`.
- The README's `Features` updated (it is the user manual), and the `Desktop app` section if the app behaves differently.
- [docs/ARCHITECTURE.md](docs/ARCHITECTURE.md)'s code map updated when files are added, renamed or change role.

## Writing style

- Everything in the repository is in English: code, comments, docs, commit messages.
- Each module starts with a comment saying what it does (and "No vscode dependency" when that matters); comments explain why, in full sentences.
- **CHANGELOG**: one bullet per change, user's point of view. A feature starts with its name in bold and says where to find it, with the UI labels in backticks: `- **Scheduled tasks**: periodic backups and exports. \`Show Scheduled Tasks\` (Command Palette, …) lists them …`. A fix is a plain sentence on what now happens: `- The relationship diagram now calls an array of ids a many-to-many relation; it was shown as many-to-one.`
- **README**: the same voice, describing what the user sees and does, not the implementation.
- **Commit messages**: one imperative sentence on what changes for the user, no prefix (`Show each connection's color on its tabs and in the tree`, `Fix search indexes found on a real mongot: …`). Releases: `Release 0.7.0 with search indexes and transactions`.
- UI text: sentence case for messages, title case for command titles and buttons (`Compare Structure With…`), `…` on actions that ask something more.

## Environment notes

- Line endings are LF (`.gitattributes`): on Windows, scripts that write files must not produce CRLF.
- The integration tests start their own mongod (ports 27110–27139); no local MongoDB or Redis needs to be running.
