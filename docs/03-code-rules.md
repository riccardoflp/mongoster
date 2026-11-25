# Code rules

The rules Mongoster's code follows, numbered so that a review can cite them. Each says where it comes from and how it
is checked:

- *Enforced*: a command the CI runs fails when the rule is broken.
- *Followed*: true of the code today, but only a review notices a break.
- *Target*: not yet true everywhere; new code and changed code follow it, and [07-roadmap.md](07-roadmap.md) says how
  it becomes true.

A change that needs to break a rule changes this page first, in its own commit, with the reason. The commands are in
[06-testing.md](06-testing.md); the checklists for a new command, tab, MCP tool or setting are in
[AGENTS.md](../AGENTS.md).

## R1 — Dependencies and layers

- **R1.1** Runtime dependencies are only those of `package.json` (`@babel/generator`, `@babel/parser`, `@babel/types`, `chart.js`, `json5`, `mongodb`, `ssh2`).
  Adding one is a decision in [08-decisions.md](08-decisions.md), and the desktop app's build must still bundle it.
  *Source: project choice.* *Followed.*
- **R1.2** `src/shared/` imports only other `src/shared/` modules and small pure libraries (`json5`): no `vscode`, no
  `mongodb`, no Node APIs. It runs in the webviews. *Source: project choice
  ([02-architecture.md](02-architecture.md#layering-rules)).* *Enforced, partly: `npm run build` fails for a module a
  webview imports, because the webview bundles are built for the browser; a shared module only the host imports is
  checked by review.*
- **R1.3** `src/webview/` imports only `src/shared/` (and `chart.js` in `chartjs.ts`). Values reach it as relaxed
  Extended JSON plain objects, never BSON classes. *Source: project choice.* *Enforced, partly: the build, as R1.2;
  BSON classes by review.*
- **R1.4** The host uses only the part of the `vscode` API that `src/standalone/vscode/` implements; a new API is
  implemented there in the same change. *Source: project choice (one code base for two products).* *Enforced:
  `npm run typecheck` checks against `tsconfig.standalone.json` too.*
- **R1.5** The MCP server's tools never write, kill an operation or change a server setting, and those returning
  documents or values are offered only with `mongoster.mcp.readDocuments`. *Source: product promise
  ([01-product.md](01-product.md#what-stays-the-same)).* *Followed; `mcp.read-documents` lists the tests.*

## R2 — Features

- **R2.1** Every command works with no argument (Command Palette) as well as from a tree node, or is hidden from the
  palette with a `when` clause. *Source: project choice.* *Followed, with exceptions listed as **Differs** in the
  cards.*
- **R2.2** Every feature the user can see has a card in [features/](features/README.md) once its area has cards; a
  change to what it does changes its card in the same commit. *Source: this documentation
  ([D9](08-decisions.md)).* *Review; `catalog.py` checks the identifiers.*
- **R2.3** A write is planned by a pure function and run by the host, as [04-feature-contract.md](04-feature-contract.md#the-target-for-new-code-and-code-that-is-changed-anyway)
  says. *Source: proposed by this documentation (Q1).* *Target.*
- **R2.4** New code writes the card's identifier in the doc comment of the function that implements it
  (`/** Feature: document.delete-many */`) and at the start of its tests' names. *Source: this documentation.*
  *Target.*

## R3 — Purity and effects

- **R3.1** Logic worth testing goes in a module without a `vscode` import (`src/relationsAnalysis.ts`,
  `src/mcp/*.ts`, `src/taskRunner.ts`), with its pure parts in `src/shared/`. *Source: project choice.* *Followed.*
- **R3.2** Pure modules take the time and randomness they need as arguments (`src/shared/schedule.ts` takes `now`;
  `src/shared/generate.ts` takes a seed). *Source: project choice.* *Followed.*

## R4 — Writes to a database

- **R4.1** Every write made through the UI follows the write pipeline, in order: refuse on a read-only connection or a
  view; confirm when it is destructive or bulk, with `UndoHistory.note` in the detail; record it in the undo history;
  publish it with `RedisOplog.sink`; refresh. *Source: product promises
  ([02-architecture.md](02-architecture.md#writing-to-a-database)).* *Followed, with exceptions listed as **Differs**
  in the cards. Not every write publishes to redis-oplog: the README lists import, generated documents, copy,
  restore, the comparison, GridFS, `$out` / `$merge`, `runCommand` and drops as not published ([Q10](08-decisions.md#open-questions)).*
- **R4.2** A write that cannot be undone says so in its confirmation. *Source: product promise.* *Followed, with the
  exceptions in the **Differs** of `document.delete`, `document.update-many`, `document.delete-many`, `undo.record`,
  `index.edit`, `index.drop` and `index.drop-search`.*
- **R4.3** Values keep their BSON types through every read, edit, copy, comparison, backup and restore: documents are
  read with `promoteValues: false` where a round trip must keep `Int32` and `Double` apart, and compared with
  `src/shared/compare.ts`. *Source: product promise.* *Followed, with the exceptions in the **Differs** of
  `transfer.export` (JSON Lines turns a whole Double into an Int32), `document.duplicate` and
  `document.keep-numeric-types`.*
- **R4.4** The playground's writes are refused on a read-only connection, and those of one document are published to
  redis-oplog. *Source: product promise.* *Followed.*

## R5 — Errors

- **R5.1** An error the user can cause is shown as a message in the domain's words (`The connection Production is
  read-only.`), not as a stack trace; `errorMessage` in `src/tree.ts` turns driver errors into text. *Source: project
  choice.* *Followed.*
- **R5.2** A failure of a side effect does not undo the write it follows: a Redis error is a warning, at most every 30
  seconds. *Source: project choice.* *Followed.*

## R6 — Size and shape

- **R6.1** One module per feature or concern, named for it (`src/fieldActions.ts`, `src/backup.ts`); no `utils`.
  *Source: project choice.* *Followed.*
- **R6.2** A tab is a host class, a webview module and a stylesheet, built as `src/docHistory.ts` is
  ([02-architecture.md](02-architecture.md#a-tab-host-class--webview--css)). *Source: project choice.* *Followed.*
- **R6.3** Messages between a host and its webview are discriminated unions in `src/shared/messages.ts`, one pair per
  tab. *Source: project choice.* *Enforced: `npm run typecheck` (strict).*
- **R6.4** Functions grow no longer than about 80 lines and files no longer than about 1,000; longer ones are split
  when they are next changed. *Source: proposed by this documentation, after Holzmann's Power of Ten rule 4 (60
  lines); to confirm (Q2).* *Target:
  `src/webview/main.ts` (2,122 lines), `src/webview/monitor.ts` (1,636) and `src/collectionPanel.ts` (1,212) are over.*

## R7 — Names

- **R7.1** Names are words, not abbreviations, and use the terms of [09-glossary.md](09-glossary.md) with the name of
  its **In code** column; never a word of its **Avoid** column. *Source: Domain-Driven Design's ubiquitous language
  (Evans, 2003).* *Enforced for the documents (`catalog.py`); review for the code.*

## R8 — Comments and documentation

- **R8.1** Each module starts with a comment saying what it does, and "No vscode dependency" when that matters.
  *Source: project choice.* *Followed.*
- **R8.2** Comments explain why, in full sentences. *Source: project choice.* *Followed.*
- **R8.3** A change the user can see adds an entry under `## Unreleased` in `CHANGELOG.md`, updates the README's
  `Features` (and `Desktop app` when the app differs), and updates the code map of
  [02-architecture.md](02-architecture.md#code-map) when files are added, renamed or change role. *Source: Keep a
  Changelog; project choice.* *Followed; the release job fails without the version's section.*

## R9 — MongoDB and the other services

- **R9.1** What the user types and reads is mongosh syntax (`src/shared/query.ts`); files for other tools are
  Extended JSON or the formats of the MongoDB tools. *Source: product promise.* *Followed.*
- **R9.2** Every call that can take long has a bound: the MCP tools `MAX_OUTPUT` and `MAX_TIME_MS`, the document
  history 100 writes or 8 seconds per page, the global search's `Read` limit. *Source: project choice.* *Followed.*
- **R9.3** MongoDB 4.2 is the oldest server supported; a feature that needs a newer one says so instead of failing
  (search indexes, `$shardedDataDistribution`). *Source: the driver's support.* *Followed.*

## R10 — User interface

- **R10.1** Messages in sentence case; command titles and buttons in title case (`Compare Structure With…`); `…` on an
  action that asks something more. *Source: project choice, after VS Code's UX guidelines.* *Followed.*
- **R10.2** Colors come from VS Code's CSS variables (the desktop app provides the same ones), and every tab loads
  `media/controls.css` last. *Source: project choice.* *Followed.*
- **R10.3** Every webview page has a Content Security Policy with a nonce. *Source: VS Code's webview guidance.*
  *Followed.*

## R11 — Tests

- **R11.1** The pure modules have unit tests in `test/unit/`; code that talks to MongoDB has integration tests in
  `test/integration/` against the mongod they start. *Source: project choice.* *Followed; not every module.*
- **R11.2** A new MCP tool has a unit test for its arguments and output and an integration test against mongod.
  *Source: project choice.* *Followed.*
- **R11.3** A fixed bug gets a test that failed before the fix. *Source: common practice.* *Target.*

## R12 — Formatting

- **R12.1** TypeScript in `strict` mode. *Source: the TypeScript handbook.* *Enforced: `npm run typecheck`.*
- **R12.2** Single quotes, semicolons, trailing commas, two spaces. There is no formatter and no fixed line width (half
  of the lines are under 35 characters, 563 are over 160): match the file you are in. *Source: project choice.*
  *Followed.*
- **R12.3** Files use LF line endings (`.gitattributes`); scripts that write files on Windows must not produce CRLF.
  *Source: project choice.* *Enforced on commit by `.gitattributes`.*

## R13 — Changes and commits

- **R13.1** A commit message is one imperative sentence on what changes for the user, with no prefix; a release is
  `Release <version> with <the main features>`. *Source: project choice.* *Followed.*
- **R13.2** Before calling a change done: `npm run typecheck`, `npm test`, and `npm run test:integration` when it
  touches database code. *Source: project choice.* *Enforced on pull requests by the CI.*

## R14 — Secrets and untrusted input

Each rule answers a threat of [10-security.md](10-security.md).

- **R14.1** Connection strings, TLS and SSH options with their passwords and passphrases, Redis URLs and the MCP access
  token are kept only in the secret storage, never in `globalState`, settings, logs, output channels or files written
  without the user asking for passwords. *Answers T1, T2.* *Followed, with the exceptions of T1 and T2.*
- **R14.2** A password or passphrase is never sent back to a webview: an empty field means "keep the saved one".
  *Answers T3.* *Followed for the key password, the SSH password and the passphrase; not for the connection string
  and the Redis URL (`connection.form`).*
- **R14.3** Text from outside (imported files, connection files, backups, saved query files, the database's own
  documents) is parsed, never evaluated: mongosh syntax goes through `src/shared/query.ts` (JSON5), not `eval`. Only
  the playground runs code, the user's own, in a `vm` context (`src/playground/shell.ts`), which is not a sandbox.
  *Answers T5, T6.* *Followed: no `eval` or `new Function` in `src/`.*
- **R14.4** A webview shows values from the database as text (`textContent`), never as HTML. *Answers T7.* *Followed:
  the only `innerHTML` with text escapes it first (`markdown` in `src/standalone/shell/dom.ts`).*
- **R14.5** The MCP server listens only on `127.0.0.1` and refuses a request without the access token, from another
  host or from another origin, and a JSON-RPC batch of more than 20 messages. Mongoster never sends the access token
  over HTTP: a window asks another one for the port with a proof of having it (an HMAC of a nonce, the time and the
  port). *Answers T8.* *Followed (`mcp.server`); checked by `test/unit/mcpHttp.test.ts`.*
- **R14.6** An SSH server's key is confirmed by the user the first time and checked every time after. *Answers T4.*
  *Followed.*

## R15 — Stored data

Each rule serves [11-data.md](11-data.md).

- **R15.1** A file format Mongoster writes for itself (undo history, scheduled tasks, saved query files) keeps reading
  the files of earlier versions; a change to it adds the code that reads the old form and a test with an old file.
  *Source: product promise.* *Target: the formats carry no version number yet.*
- **R15.2** A damaged file of Mongoster's own is skipped with a warning and never crashes a tab or the activation
  (saved query files already do this). *Source: project choice.* *Followed, partly.*
- **R15.3** A file shared by several VS Code windows is written under the lock of `src/fileLock.ts`. *Source: project
  choice.* *Followed.*
- **R15.4** Keys of `globalState` and of the secret storage are never renamed without reading the old key. *Source:
  product promise.* *Followed.*

## What the CI checks

| Check | Rules |
| --- | --- |
| `npm run typecheck` (both configurations, `strict`) | R1.4, R6.3, R12.1 |
| `npm run build` (inside `npm run package`) | R1.2, R1.3, partly |
| `npm test`, `npm run test:integration` | R11, and the acceptance lines that have tests |
| The release job (`## <version>` in `CHANGELOG.md`) | R8.3, partly |
| `.gitattributes` | R12.3 |
| `catalog.py` (not in the CI yet) | R2.2, R7.1 for the documents |

Everything else is checked by review. There is no linter: the rules a linter could check (R6.4, R12.2, the imports of
R1.2 for modules no webview imports) are listed as target in [07-roadmap.md](07-roadmap.md).
