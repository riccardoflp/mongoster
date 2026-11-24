# Risks and debt

What is known to be weak in Mongoster and not fixed yet. *Source: arc42 §11.* A **risk** may go wrong; **debt** is
already wrong and costs on every change. Most rows were found while writing the cards, in the code, and are not
reproduced by a test yet: the card or the place in the code says where. [07-roadmap.md](07-roadmap.md) says when each
is dealt with; a row is removed in the commit that fixes it, with a test that failed before.

*How likely* is a judgment: *often* (a normal use reaches it), *sometimes* (a less common setup), *rarely* (a damaged
file, a race).

## Losing data or writing where it must not

| | Kind | What | If it bites | How likely | What we do |
| --- | --- | --- | --- | --- | --- |
| RS1 | risk | When the undo history's `index.json` cannot be read, `load` treats it as empty and the pruning that follows deletes every `*.json.gz` ([11-data.md](11-data.md#versions)). | The whole undo history is gone, without a warning. | rarely (a damaged or older-format file) | M3: keep the files and the damaged index aside, warn |
| RS2 | risk | When `scheduledTasks/tasks.json` cannot be read, it counts as empty and the next change to a task writes only that task. | Every other scheduled task is lost, without a warning. | rarely | M3: refuse to write over a file that could not be read, warn |
| RS3 | risk | Each VS Code window keeps its own list of undo operations and rewrites `index.json` from it, without a lock (`undo.record`). | Operations of one window are dropped by another, and their files deleted at the next start: those writes can no longer be undone. | often, with several windows | M3: re-read the index under the lock of `src/fileLock.ts` before writing |
| RS8 | risk | A document, a view definition or validation rules opened in an editor tab keep the read-only state the connection had when they were opened (`ro=1` in the URI): after **Make Read-Only**, a save still writes (`document.edit-in-editor`, `manage.edit-view`, `manage.edit-validation`, `connection.read-only`). | A write through a connection the user made read-only, perhaps production. | sometimes | M3: check the connection at save time |
| RS9 | risk | JSON Lines export reads with `promoteValues` on, so a whole Double (42.0) is written as `$numberInt` and comes back as an Int32 (`transfer.export`); scheduled exports too. | Types change through an export and an import, against the product's promise. | often | M3 |
| RS10 | risk | `Duplicate` copies the relaxed row of the table: whole Doubles and safe Longs become Int32, and fields left out by the projection are not copied (`document.duplicate`). Inline edits keep only `Long` as an explicit type (`document.keep-numeric-types`). | A duplicated or edited document has other types, or fewer fields, than the user expects. | often | M3 |
| RS11 | risk | Some confirmations do not say that the write cannot be undone: `Delete`, `Update many` and `Delete many` with the undo history off; dropping or rebuilding an index; an operation over 20 MB known only after reading (`document.delete`, `document.update-many`, `document.delete-many`, `undo.record`, `index.edit`, `index.drop`, `index.drop-search`). | The user expects an undo that does not exist. | sometimes | M3 |
| RS13 | risk | When one operation's file is larger than `mongoster.history.maxSizeMB`, pruning deletes it and every older operation (`undo.limits`). | Older operations that fit are lost too. | rarely | M3 |
| RS4 | debt | A dropped collection's query history, saved queries for me, layout, expanded columns and formatting rules stay in `globalState`, and come back if a collection of the same name is created. A collection's color goes with a drop from Mongoster (`tree.collection-color-follows`), but stays after a drop done elsewhere, as these keys do. | Stale state; growth of `globalState`. | often | M5: M2's colors of collections did not take the other keys with them, because saved queries must not be lost |

## Secrets and privacy

| | Kind | What | If it bites | How likely | What we do |
| --- | --- | --- | --- | --- | --- |
| RS5 | risk | The desktop app without a keychain stores secrets in `secrets.json` as `plain:<value>`, without telling the user (T2, `connection.secrets`). | Connection strings with passwords in clear text in the user's profile. | sometimes (Linux without a keyring) | M3: warn, and ask before storing in clear text |
| RS6 | risk | `Without passwords` and the passphrase leave `proxyPassword`, `AWS_SESSION_TOKEN` and, in two formats, `tlsCertificateKeyFilePassword` in clear text in exported files (T1, `connection.export`). | A credential leaks through a file the user believed safe to share. | sometimes | M3 |
| RS7 | risk | The connection form receives the connection string and the Redis URL with their passwords (T3, `connection.form`). | A secret is in a webview's memory; the README says it never is. | often | M3: send them without the password, keep the saved one when the field is left empty |
| RS15 | risk | `list_connections`, `list_databases`, `list_collections` are not bounded by `MAX_OUTPUT` (`mcp.output-limits`). | A slow or huge answer to the AI. | rarely | M4 |
| RS16 | risk | Files read from outside (imports, connection files, backups) are read whole, without a size limit (T5). | A huge or crafted file makes Mongoster run out of memory. | rarely | M5 |
| RS17 | risk | Playgrounds run in any workspace, trusted or not (T6, Q8). | Code from someone else's repository runs with the user's connections when the user runs it. | rarely | M5, after Q8 |

## Things the user sees wrong

| | Kind | What | If it bites | How likely | What we do |
| --- | --- | --- | --- | --- | --- |
| RS12 | debt | After an undo, open collection tabs are not refreshed; cancelling the undo's confirmation leaves the button on `Undoing…` (`undo.revert`). After a copy, a restore or a comparison's write, open tabs of the target are not refreshed (`transfer.copy-collection`, `backup.restore`, `compare.copy-document`). | The tab shows documents that are no longer so. | often | M3 |
| RS18 | debt | Removing a connection leaves its collection tabs, playground result and editor tabs open (`connection.remove`); the playground result tab does not take a new color at once (`connection.set-color`). | Tabs that fail on their next query. | sometimes | M5 |
| RS19 | debt | The comparison's writes have no `Undo` in their notification, although they are recorded (`compare.copy-document`, `compare.make-like`). | The undo exists but is hard to find. | sometimes | M5 |

## The code and its checks

| | Kind | What | If it bites | How likely | What we do |
| --- | --- | --- | --- | --- | --- |
| RS20 | debt | No tests for `src/history.ts`, `src/manage.ts`, `src/definitionFs.ts` and the host classes in general; many cards say **Tested by**: *none*. | RS1 to RS13 went unnoticed; a change to the undo history is unchecked. | — | M3: a test with each fix; then by area in M5 |
| RS21 | debt | Mongoster's own file formats have no version field (Q3, R15.1). | The first change of format cannot tell old files from damaged ones (see RS1, RS2). | — | M3, with RS1 and RS2 |
| RS22 | debt | No linter: the import rules of R1.2 and R1.3 for modules no webview imports, and the size limits of R6.4, are checked by review only (Q4). | Layers leak; files keep growing. | — | M4 |
| RS23 | debt | `catalog.py` is not in the CI (Q6). | Cards drift from the code without anyone noticing. | — | M4 |
