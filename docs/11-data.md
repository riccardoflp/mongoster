# Stored data

Everything Mongoster keeps between runs. What a version writes, the next version must read: these keys and files are
already on users' machines, so a change to any of them keeps reading the old form (R15). Paths per product are in
[05-platform.md](05-platform.md#where-data-lives).

## What is stored

### Secrets

In the secret storage (VS Code's `SecretStorage`; in the desktop app `secrets.json`, see
[05-platform.md](05-platform.md#where-data-lives)). Never in `globalState`, settings or files Mongoster writes without
being asked for passwords.

| Key | Holds | Written by | Deleted |
| --- | --- | --- | --- |
| `mongoster.uri.<id>` | The connection string, with its credentials | `connection.secrets` | when the connection is removed |
| `mongoster.options.<id>` | TLS and SSH options as JSON: certificate files' content, keys, passwords, passphrases | `connection.secrets` | when TLS and SSH are both cleared, or the connection is removed |
| `mongoster.redis.<id>` | The Redis URL for redis-oplog, with its password | `connection.secrets` | when redis-oplog is turned off, or the connection is removed |
| `mongoster.mcp.token` | The MCP server's access token | `mcp.access-token` | replaced by `Generate a new access token` |

### Small state, in `globalState`

| Key | Holds | May be lost? |
| --- | --- | --- |
| `mongoster.connections` | The list of connections: id, name, folder, color (a preset name, or `#rrggbb` added in 0.9.0, D17), the colors of databases (`databaseColors`: the database's name → a color or `none`, optional, added in 0.10.0, D16), the colors of collections (`collectionColors`: `database.collection` → a color or `none`, optional, added in 0.9.0, D16), what is excluded from searches (`excluded`: the connection, `true` or absent; `exclusions`: a sorted list of databases and `database.collection` keys; both optional, added in 0.9.0, D19), read-only, no undo history, SSH label, TLS flag, redis-oplog settings without the URL (`ConnectionInfo`) | **No**: the user's connections |
| `mongoster.knownHosts` | The SSH host keys the user confirmed | No: losing it asks again, which is safe but surprising |
| `mongoster.history.<connection>/<database>/<collection>` | The last 50 queries run on a collection | Yes |
| `mongoster.saved.<connection>/<database>/<collection>` | The queries saved *for me* | **No** |
| `mongoster.layout.<connection>/<database>/<collection>` | The columns' layout: hidden, order, widths, pinned | Yes |
| `mongoster.expanded.<connection>/<database>/<collection>` | The expanded nested columns | Yes |
| `mongoster.formatting.<connection>/<database>/<collection>` | The formatting rules, in their order (`FormatRule`): condition rules `{ id, condition, field?, color, name?, enabled? }` (0.9.0 wrote them without `kind` and `name`, and with six colors), and since 0.10.0 `{ id, kind: 'field', field, target, mode, min?, max?, scale?, pinned?, palette?, name?, enabled? }`. Read by `readFormatRules`, which drops the entries and the kinds it can't use. 0.9.0 drops the field rules and the five newer colors, and loses them if it then saves the collection's rules | **No**: the user wrote them |
| `mongoster.formattingDatabase.<connection>/<database>`, `mongoster.formattingConnection.<connection>`, `mongoster.formattingGlobal` | The formatting rules of a database, of a connection and the ones for everywhere (added in 0.10.0): each an array of `FormatRule` like a collection's, read by `readFormatRules` (`src/formattingStore.ts`). `Remove Connection` removes the first two for that connection | **No**: the user wrote them |
| `mongoster.formattingOff.<connection>/<database>/<collection>` | The formatting scopes whose rules the collection leaves out (added in 0.10.0): an array among `collection`, `database`, `connection`, `global`, read by `readScopesOff`, which drops anything else; follows a renamed collection | Yes |
| `mongoster.formattingPane` | The Formatting pane of every collection's tab: `{ open, width, hidden }` (added in 0.10.0), read by `readFormattingPane`, which gives closed, 320 px and colors shown for anything else | Yes |
| `mongoster.queryPane` | The width of the query pane of every collection's tab: `{ width }` (added in 0.9.0), read by `readQueryPane`, which gives the default (380 px) for anything else; where the query goes is the setting `mongoster.queryBar.position`, and a `side` stored by a build before that setting is ignored | Yes |
| `mongoster.playgroundTargets` | The connection and database of each playground file | Yes |
| `mongoster.backupFolder` | The last folder used for a backup | Yes |
| `mongoster.savedQueries.lastPlace` | *For me* or *In the project*, offered first | Yes |
| `mongoster.savedQueries.projectFolder` | The desktop app's project folder for saved queries | No |

The five keys of a collection follow its rename (`moveCollectionState` in `src/collectionPanel.ts`). They are not
deleted when the collection or its database is dropped, nor when the connection is removed: they stay in
`globalState`, and come back if a collection of the same name is created again (RS4).

A collection's color, in its connection's entry of `mongoster.connections`, follows a rename from Mongoster and is
removed when Mongoster drops the collection, its bucket or its database, and with the connection. A rename or drop
done elsewhere leaves it (`tree.collection-color-follows`). An entry written by 0.8.0 or earlier has no `collectionColors`
and reads as no collection having a color of its own; an older version keeps the field when it rewrites the entry,
because `ConnectionManager.update` spreads the stored one.

A database's color (`databaseColors`, in the same entry) is removed when Mongoster drops the database, and with the
connection; a drop done elsewhere leaves it. An entry written by 0.9.0 or earlier has no `databaseColors` and reads as
no database having a color of its own; 0.9.0 shows such a connection without the databases' colors and keeps the
field when it rewrites the entry.

The exclusions from searches (`excluded`, `exclusions`) live in the same entry and follow the same rules: a rename from
Mongoster moves a collection's entry, a drop removes the entries of the collection, of the bucket's two collections or
of the database and all its collections (`tree.exclusion-follows`). An entry without them reads as nothing excluded,
and an older version keeps them when it rewrites the entry.

A color is a preset name or a custom `#rrggbb` (D17). The six names of 0.8.0 keep their meaning, so nothing is
migrated. An older version shows a connection or collection with a new preset or a custom color without its color
(and without a leaf on its tabs), and keeps the value when it rewrites the entry. An older Mongoster importing a newer
connection file takes a hex color to its nearest old color and drops a new preset name.

### Files of Mongoster's own

| Path | Format | Written | May be lost? |
| --- | --- | --- | --- |
| `<global storage>/history/index.json` | JSON array of `HistoryEntry`: id, time, connection, target, label, counts, size | atomically (a `.tmp` beside, then rename) after each operation and each pruning | **No**: see below |
| `<global storage>/history/<id>.json.gz` | gzip of canonical Extended JSON `{ docs: [...] }`: the documents as they were (only `_id` for inserts) | once, when the operation is recorded | Yes, one by one: that operation can no longer be undone |
| `<global storage>/scheduledTasks/tasks.json` | JSON array of `ScheduledTask` | atomically, under the lock of `src/fileLock.ts` | **No**: the user's tasks |
| `<global storage>/scheduledTasks/<id>.json` | JSON `TaskState`: the last scheduled time handled, the run log (last 20 runs), the outputs written | atomically | Yes, losing the log and the outputs that retention deletes |
| `<global storage>/scheduledTasks/<id>.lock`, `<id>.cancel` | the lock of a run, the request to cancel it | by the window running the task | Yes |

The files and folders above are written for the user only on macOS and Linux: files with mode `0600`, the `history/`
and `scheduledTasks/` folders with `0700` (on Windows the profile folder's permissions do it). Folders made by a
version before this are changed when Mongoster starts.

### Files in the user's places

| Path | Format | Promise |
| --- | --- | --- |
| `.mongoster/queries/<database>/<collection>/<name>.json` (or `mongoster.savedQueries.folder`; a value of that setting from the workspace's own settings is taken only inside the workspace) | JSON: `name`, `description`, `database`, `collection`, optional `connection`, `filter` / `sort` / `projection` or `pipeline` in mongosh syntax, text on several lines as an array of lines | Shared through git by teams: other versions of Mongoster read and write the same files; invalid ones are skipped with a warning and `Open File` (D15) |
| Backups: `.agz`, `.archive`, folders of `.bson` and `.metadata.json` (gzipped or not) | mongodump's formats. In a folder, the names of the files and of the database folders are the collections' and databases' percent-encoded (`a/b` → `a%2Fb.bson`, `con` → `%63on.bson`; `backup.folder-layout`); backups written by versions up to 0.8.0 hold the names as they are, and are still read: a file name with a `%` is told apart by the `collectionName` of its metadata | Readable by `mongorestore` and from `mongodump` ([D10](08-decisions.md#d10--backups-in-mongodumps-formats-written-by-mongoster)) |
| Exports: JSON, JSON Lines (canonical Extended JSON), CSV with a UTF-8 BOM | as `mongoexport` writes them, for JSON Lines | Importable again by Mongoster and `mongoimport` |
| Formatting files: `<name>.mongoster-formatting.json` | JSON: `mongosterFormatting` (the version, 1) and `groups`, each `{ scope, database?, collection?, rules }` with the rules as in `globalState`; nothing of a connection (added in 0.10.0). `src/shared/formattingFile.ts` | A file of version 1 stays importable. Reading keeps the rules it can use and counts the others; a file of a later version is refused with a message |
| Connection files: Mongoster's JSON, Compass's JSON, lists of connection strings | `src/shared/connectionsFile.ts` | Compass reads Mongoster's Compass export, passwords included when encrypted with a passphrase. Mongoster's JSON may have `collectionColors`, `excluded` and `exclusions` per connection (added in 0.9.0) and `databaseColors` (added in 0.10.0); a file without them reads as before, and an older Mongoster ignores them |

### The desktop app

Besides the equivalents above, in its folder: `secrets.json`, the settings as `settings.json`, `globalState` as a JSON
file, `window.json` (the window's bounds), written atomically by `JsonFile` in `src/standalone/vscode/storage.ts`, with mode `0600` (not `window.json`); files written by an older version are changed when the app starts.
`settings.json` also has the app's own `app.theme` and `app.layout`. `app.theme` was `system`, `dark` or `light`
before the other themes came; those values still name the same themes (Mongoster Dark and Light). An unknown value,
from a later version, reads as the default.

## Versions

None of Mongoster's own formats carries a version number today. Reading relies on the shape: `index.json` must be an
array, `tasks.json` must be an array, a saved query file must have its fields. Adding a version field is open question
[Q3](08-decisions.md#open-questions).

What happens to a file that cannot be read:

| File | When it cannot be read | Consequence |
| --- | --- | --- |
| `history/index.json` | `load` in `src/history.ts` treats it as empty, then prunes with `orphans`: every `*.json.gz` without an entry is deleted | **The whole undo history is deleted, without a warning** (RS1 in [13-risks.md](13-risks.md)) |
| `scheduledTasks/tasks.json` | `readTasks` in `src/scheduler.ts` returns no tasks; the next change to a task writes the list with only that change | **Every other task is lost at the next change, without a warning** (RS2) |
| `scheduledTasks/<id>.json` | read as an empty state | The run log and the list of outputs are forgotten; retention no longer knows the older outputs, which then stay |
| A saved query file | skipped, with a warning and `Open File` | Safe |
| `secrets.json` (desktop app), a value that cannot be decrypted | read as missing | The connection asks for nothing and fails to connect (T2) |

## Migrations

None has been needed so far. The rule for the first one (R15.1): the code that reads the new form also reads the old
one and rewrites it in the new form on the next write; a test reads a file recorded from the old version; the change
is a proposal ([proposals/](proposals/README.md)) when it touches files users share (saved queries, backups).

## How files are written

- Atomically: write a temporary file beside, then rename (`writeAtomic` in `src/scheduler.ts`, `writeIndex` in
  `src/history.ts`, `JsonFile` in the desktop app). On Windows a rename retries for a moment while another window
  reads the file.
- Shared between VS Code windows: the scheduled tasks, under the lock of `src/fileLock.ts`. The undo history is one
  folder for all windows, but each window keeps its own list of operations in memory and rewrites `index.json` from
  it, without a lock: two windows writing in turn can drop each other's entries, and the next start's pruning then
  deletes the files of the dropped ones (RS3).

## What never changes

The names of the `mongoster.*` settings, of the `globalState` and secret keys above, of the saved query files and their
fields, and the formats of backups and exports. Renaming any of them is a decision, with the code that reads the old
name.
