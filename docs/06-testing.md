# Development

Building, running, testing and releasing Mongoster. For how the code is organized see [02-architecture.md](02-architecture.md); for the rules to follow when changing it see [03-code-rules.md](03-code-rules.md) and [AGENTS.md](../AGENTS.md).

## Setup

Node.js 20 or later (the CI uses 22).

```bash
npm install
npm run build      # or: npm run watch
```

## Running

- **Extension**: press **F5** in VS Code with "Run Mongoster" (`.vscode/launch.json`): it builds and opens an Extension Development Host window. With `npm run watch` running, reload that window (`Developer: Reload Window`) to pick up changes.
- **Desktop app**: `npm run app` builds and starts it; `npm run watch:app` rebuilds on changes, and "Run Mongoster (desktop app)" in `.vscode/launch.json` starts it under the debugger. Its data is in the app's own folder (`%APPDATA%\Mongoster`, `~/Library/Application Support/Mongoster`, `~/.config/Mongoster`), or in `MONGOSTER_USER_DATA` when set, which keeps a development instance apart from an installed one.

## Checks

```bash
npm run typecheck           # tsc against VS Code's API, then against the desktop app's (tsconfig.standalone.json)
npm test                    # unit tests
npm run test:integration    # integration tests against a real mongod
```

All three run on every pull request; run them before committing.

## Tests

The tests use [Vitest](https://vitest.dev), with two projects in `vitest.config.ts`:

- **`unit`** (`test/unit/*.test.ts`, `npm test`, `npm run test:watch` to run again on changes): the modules of `src/shared`, the archive format, the playground's rewriting, the MCP tools' argument handling and formatting, everything that runs without a server.
- **`integration`** (`test/integration/*.test.ts`, `npm run test:integration`): against a real mongod. `test/integration/mongod.ts` starts a standalone mongod (`inject('mongoUri')`) and a single-node replica set (`inject('replSetUri')`, for sessions, transactions, change streams and the oplog) with `mongodb-memory-server`, on the first free ports from 27110 to 27139. It downloads MongoDB the first time; an installed one is used instead when `MONGOMS_SYSTEM_BINARY` points to its `mongod`, and on Windows when there is one in `C:\Program Files\MongoDB\Server`.

To run one file: `npx vitest run --project unit test/unit/query.test.ts` (or `--project integration`).

Modules that import `vscode` get the stub in `test/stubs/vscode.ts`, which only has the classes they extend or create when loaded. Code that needs VS Code to do something isn't unit-testable: keep the logic in a module without a `vscode` import (see [02-architecture.md](02-architecture.md#layering-rules)).

Redis isn't needed: the redis-oplog tests check the events given to an `OplogSink`.

The search index tests (`test/integration/searchIndexes.test.ts`) need a server with search (Atlas, an Atlas local deployment, or MongoDB Community 8.3+ with `mongot`) and are skipped unless `MONGOSTER_SEARCH_URI` gives its connection string:

```bash
MONGOSTER_SEARCH_URI="mongodb://…" npx vitest run --project integration test/integration/searchIndexes.test.ts
```

They create, change and drop indexes in the `mongoster_search` database, which they drop at the end.

## From a card to a test

Each card of [features/](features/README.md) ends with acceptance lines. A line becomes a test in the project that can
check it: a pure decision in `test/unit/`, anything that talks to MongoDB in `test/integration/`. The card's **Tested
by** line names the tests; a card whose lines have no test says *none*, and that is a gap listed in
[13-risks.md](13-risks.md). New tests start their name with the card's identifier
(`it('document.delete-many: refuses on a read-only connection', …)`), so that a search finds them from the card.

## What no test reaches

The webviews and the host classes that call VS Code have no automated tests: the stub of `test/stubs/vscode.ts` only
lets modules load. Before a release, check by hand, in the extension and in the desktop app, in a dark and a light
theme:

- every write of the riskiest areas once, on a read-only connection (refused) and on a writable one (written,
  recorded in the undo history, undone);
- a connection with TLS, one with an SSH tunnel (first connection: the host key is asked), one with redis-oplog;
- in a collection tab: a field dropped on Project (marked `not applied`, no query until `Find`), `Project Visible
  Columns`, `Cancel` on a slow query (the table keeps its documents), a collation and a hint from `Options`;
- the MCP server from one client (Claude Code or Copilot), with `mongoster.mcp.readDocuments` on and off;
- a scheduled task that runs, one that is missed and runs at start, and the retention deleting only its own files;
- the desktop app's installer on each system.

## Packaging

```bash
npm run package        # the extension: mongoster-<version>.vsix
npm run package:app    # the desktop app's installer for this system, in release/
```

Install a `.vsix` with `code --install-extension mongoster-<version>.vsix`.

`.vscodeignore` is an allowlist: only the files it names go in the `.vsix` (the bundles in `dist/`, `media/`, `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`). A new webview bundle must be added there. The desktop app takes everything in `dist/` and `media/` (`electron-builder.yml`); nothing from `node_modules` is shipped, esbuild bundles it all.

The packaged app has Electron fuses set (`electronFuses` in `electron-builder.yml`): `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` and `--inspect` do nothing on it, and it loads its code only from `app.asar`. Debug with `npm run app`, which runs the Electron of npm. The validation of `app.asar`'s content is off until the app is signed with a certificate.

An installer is built on the system it is for (a macOS disk image can only be made on macOS). The macOS and Windows builds are not signed with a certificate yet.

## CI

`.github/workflows/build.yml` runs on every pull request, on demand, and inside each release. It publishes nothing:

- **Extension** (Ubuntu): `npm ci`, `npm audit` of the packages bundled in the extension (a known flaw of moderate severity or more stops the build), typecheck, unit tests, integration tests, `npm run package`; the `.vsix` is kept as an artifact of the run.
- **App** (Windows, macOS, Linux): `npm run package:app`; the installers are kept as artifacts.

The workflows name their actions by commit, with the tag in a comment: a tag can be moved, a commit cannot.
`.github/dependabot.yml` proposes the updates of the actions and of the npm packages once a week; Electron and
Monaco, bundled from the development tree, are followed that way and not by `npm audit`.

`.github/workflows/release.yml` runs on a `v*` tag ([D20](08-decisions.md#d20--a-tag-publishes-the-release-once-the-maintainer-approves)):

- **The tag and the version**: the tag is `v` + the version of `package.json`, `CHANGELOG.md` has its `## <version>` section, and the tagged commit is on `main`; otherwise nothing else runs.
- **Build**: the whole of `build.yml` on that commit.
- **Publish on the Marketplace**: waits for the maintainer's approval in the GitHub environment `marketplace`, then publishes the `.vsix` that Build made with `vsce publish --oidc` (trusted publishing, no token stored). This job installs with `npm ci --ignore-scripts`: no install script of the development tree runs where the Marketplace's token can be asked for. A version already on the Marketplace is skipped.
- **The draft release on GitHub**: a draft release on the tag with the `.vsix`, the installers and the version's section of `CHANGELOG.md` as notes, for the maintainer to read and publish. A run again on the same tag replaces the files and keeps the notes.

It can be run again by hand from the Actions tab, with the tag chosen in `Use workflow from`.

### Setting up publishing (once)

- On GitHub, `Settings › Environments`: an environment `marketplace` with the maintainer as required reviewer and deployment tags limited to `v*`.
- On the Marketplace's publisher management page, for the publisher `RiccardoFilippozzi`: a trusted publishing policy for the repository `riccardoflp/mongoster`, the workflow `release.yml` and the environment `marketplace`.

## Releasing

1. In `CHANGELOG.md`, rename `## Unreleased` to `## <version>` (the release fails if the section is missing).
2. Set the version in `package.json` and `package-lock.json` (`npm version <version> --no-git-tag-version` does both).
3. Commit as `Release <version> with <the main features>`, e.g. `Release 0.7.0 with search indexes and transactions`, and merge it into `main`.
4. Tag `v<version>` on that commit of `main` and push the tag: `release.yml` builds everything.
5. Approve the job `Publish on the Marketplace` in the run (it waits in the environment `marketplace`).
6. Read the draft release on GitHub and publish it: the README sends users there for the installers.

Versions are `0.x.0` for now: a minor version per batch of features.
