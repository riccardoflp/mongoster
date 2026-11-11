# Development

Building, running, testing and releasing Mongoster. For how the code is organized see [ARCHITECTURE.md](ARCHITECTURE.md); for the rules to follow when changing it see [CLAUDE.md](../CLAUDE.md).

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

Modules that import `vscode` get the stub in `test/stubs/vscode.ts`, which only has the classes they extend or create when loaded. Code that needs VS Code to do something isn't unit-testable: keep the logic in a module without a `vscode` import (see [ARCHITECTURE.md](ARCHITECTURE.md#layering-rules)).

Redis isn't needed: the redis-oplog tests check the events given to an `OplogSink`.

The search index tests (`test/integration/searchIndexes.test.ts`) need a server with search (Atlas, an Atlas local deployment, or MongoDB Community 8.3+ with `mongot`) and are skipped unless `MONGOSTER_SEARCH_URI` gives its connection string:

```bash
MONGOSTER_SEARCH_URI="mongodb://…" npx vitest run --project integration test/integration/searchIndexes.test.ts
```

They create, change and drop indexes in the `mongoster_search` database, which they drop at the end.

## Packaging

```bash
npm run package        # the extension: mongoster-<version>.vsix
npm run package:app    # the desktop app's installer for this system, in release/
```

Install a `.vsix` with `code --install-extension mongoster-<version>.vsix`.

`.vscodeignore` is an allowlist: only the files it names go in the `.vsix` (the bundles in `dist/`, `media/`, `package.json`, `README.md`, `LICENSE`, `CHANGELOG.md`). A new webview bundle must be added there. The desktop app takes everything in `dist/` and `media/` (`electron-builder.yml`); nothing from `node_modules` is shipped, esbuild bundles it all.

An installer is built on the system it is for (a macOS disk image can only be made on macOS). The macOS and Windows builds are not signed with a certificate yet.

## CI

`.github/workflows/build.yml` runs on every pull request, on `v*` tags and on demand:

- **Extension** (Ubuntu): `npm ci`, typecheck, unit tests, integration tests, `npm run package`; the `.vsix` is kept as an artifact of the run.
- **App** (Windows, macOS, Linux): `npm run package:app`; the installers are kept as artifacts.
- **Release** (only on a `v*` tag, after both): publishes the GitHub release of the tag with the `.vsix` and the installers, and the tag's section of `CHANGELOG.md` as its notes. A release that already exists (a draft too) gets the files and is published, keeping notes written by hand.

## Releasing

1. In `CHANGELOG.md`, rename `## Unreleased` to `## <version>` (the release job fails if the section is missing).
2. Set the version in `package.json` and `package-lock.json` (`npm version <version> --no-git-tag-version` does both).
3. Commit as `Release <version> with <the main features>`, e.g. `Release 0.7.0 with search indexes and transactions`.
4. Tag `v<version>` and push the commit and the tag: the workflow publishes the GitHub release.
5. Publish the extension to the Marketplace by hand (`npx vsce publish`, or upload the `.vsix` of the release).

Versions are `0.x.0` for now: a minor version per batch of features.
