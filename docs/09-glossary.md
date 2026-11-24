# Glossary

The words of Mongoster, as the user reads them and as the code names them. One meaning per word. A word that is not
here means what MongoDB's documentation or a dictionary says. The cards, the README, the UI text and new code use
these words; `catalog.py` reports the words of the **Avoid** column anywhere in the documents.

## Connections

| Term | Means | Not to be confused with | Avoid | In code |
| --- | --- | --- | --- | --- |
| connection | A saved way to reach a MongoDB deployment: a name, a connection string and its options, kept by Mongoster. | the `MongoClient` that is open while it is connected | server profile, data source | `ConnectionInfo`, `ConnectionManager` |
| connection string | The `mongodb://` or `mongodb+srv://` URI of a connection, with its credentials. Kept in the secret storage. | the connection's name | connection URL | `uri`, `secretKey(id)` |
| connected | A connection with an open client, shown expanded in the tree. | read-only | online | `getClient(id)` |
| read-only connection | A connection through which Mongoster refuses every write. A safeguard of Mongoster, not a permission of MongoDB. | a MongoDB user with read roles; a view | readonly | `ConnectionInfo.readOnly` |
| excluded | A connection, database, collection, view or bucket left out of searches by `Exclude From Searches`: dimmed in the tree, skipped by the tree's filter, the global search over what contains it and the MCP lists; asked for by name, it still answers (D19). | a disabled feature; a hidden index; a field excluded by a projection | disabled collection, muted | `ConnectionInfo.excluded`, `ConnectionInfo.exclusions`, `isExcluded` |
| folder | A group of connections in the tree. Removing it keeps its connections. | a folder on disk | — | `ConnectionInfo.folder`, `FolderNode` |
| color | A preset or a custom color that marks a connection, its tree nodes and its tabs; a database, and a collection, view or bucket, can have its own, or none: a collection's wins over its database's, which wins over its connection's. | the syntax colors of the theme | label color | `ConnectionColor`, `CollectionColor`, `Color` |
| preset | One of the eleven named colors of `Set Color…`, a theme color that a color theme can change. | a Compass color code | — | `PresetColor`, `PRESET_COLORS` |
| custom color | A color of the user's own, `#rrggbb`, chosen in the Choose a Color tab; shown as its nearest preset where VS Code takes only theme colors. | a preset | — | `HexColor`, `nearestPreset` |
| SSH tunnel | The SSH server a connection goes through to reach the first host of its connection string. | TLS | SSH proxy | `SshTunnel`, `SshOptions` |
| known host | An SSH server key fingerprint the user has confirmed once. | — | trusted host | `KNOWN_HOSTS_KEY` |
| secret storage | Where secrets are kept: VS Code's `SecretStorage`, or the desktop app's files encrypted with the system's keychain. | `globalState` | — | `context.secrets` |
| connections view | The tree in the side bar: folders, connections, databases, collections, views, buckets. | the Explorer | — | `MongoTreeProvider`, `src/tree.ts` |
| connection form | The tab of `Add Connection with TLS / SSH…` and `Connection Settings (TLS / SSH)…`. | the input box of `Add Connection` | — | `ConnectionEditor` |
| host key fingerprint | `SHA256:…` of an SSH server's key, shown to be confirmed. | — | — | `HostKeyCheck` |
| passphrase | What encrypts the passwords of an exported connections file, as Compass does. | a password of a connection | — | `connectionsFile.ts` |

## Data

| Term | Means | Not to be confused with | Avoid | In code |
| --- | --- | --- | --- | --- |
| database | A MongoDB database. | the deployment | — | `DatabaseNode` |
| collection | A MongoDB collection, including time series and capped ones. | a view; the table | — | `CollectionRef`, `CollectionTarget` |
| view | A read-only MongoDB view defined by a pipeline on a collection. Mongoster writes nothing through it. | the tab; a read-only connection | virtual collection | `isView`, `CollectionType` |
| document | A MongoDB document. | a row of the table; a text document of the editor | — | `Document` |
| field | A key of a document, possibly nested. | a column | attribute | — |
| path | A field's dotted name: `address.city`. `items[].sku` is the field of the elements of an array. | a file path | — | `path` |
| bucket | A GridFS pair of collections, `<bucket>.files` and `<bucket>.chunks`. | — | — | `BucketNode` |

## The collection tab

| Term | Means | Not to be confused with | Avoid | In code |
| --- | --- | --- | --- | --- |
| collection tab | The tab of a collection or view: table, query bar, pipeline editor and the other sections. | a VS Code editor tab | — | `CollectionPanel` |
| table | The grid of the collection tab: one row per document (or per element of an expanded array), one column per field. | a collection | — | `src/webview/main.ts` |
| row | A document as shown in the table; a sub-row is an element of an expanded array. | a document in the database | — | — |
| column | A field as shown in the table, with its layout (hidden, order, width, pinned). | a field | — | `Column`, `ColumnLayout` |
| query | A filter, a sort and a projection, run with `find`. | a pipeline | — | `QueryText`, `ParsedQuery` |
| query bar | The inputs and buttons of the collection tab where the query or the pipeline is written and run: above the table, or in the query pane. | the toolbar: the top row with the mode tabs, `History`, `Export`, `Watch`, `Insert` | — | `.query-pane` in `src/collectionPanel.ts` |
| query pane | The query bar put at the right of the table, resizable; one choice for every collection, the setting `mongoster.queryBar.position`. | a VS Code panel or side bar | — | `QueryPane`, `QueryPaneUi` |
| filter | The condition that chooses documents, in mongosh syntax. | the tree filter | where clause | `filter` |
| pipeline | The stages of an aggregation. | a query | — | `PipelineStage` |
| stage | One step of a pipeline: `$match`, `$group`… | — | — | `PipelineStage` |
| mongosh syntax | How Mongoster writes and reads values: `ObjectId("…")`, `ISODate("…")`, `/re/i`. | JSON | shell syntax | `src/shared/query.ts` |
| Extended JSON | MongoDB's JSON with types: *canonical* keeps every type, *relaxed* is easier to read. What crosses to the webviews is relaxed Extended JSON. | JSON | — | `relaxEjson` |
| saved query | A query or pipeline kept under a name: *for me* in Mongoster, or *in the project* as a file. | the recent queries | favorite | `SavedQuery`, `ProjectQuery` |
| document dialog | The modal of the collection tab that shows one document as a tree. | the editor tab of a document | — | `openDocument` in `src/webview/main.ts` |
| insert dialog | The modal where documents are typed or pasted to insert. | — | — | `InsertDialog` |
| Update many dialog | The modal of `Update many` and `Delete many`. | — | — | `BulkDialog` |
| selection | The rows chosen with Ctrl or Shift and a click, kept by `_id`. | the text selected in an input | — | `Selection` |
| column action | `Rename field…`, `Remove field…`, `Convert type…` on a column header. | the column's layout | — | `src/fieldActions.ts` |
| conditional formatting | Coloring the rows and cells of the table by conditions on their documents or by the values of a field, with formatting rules. | the syntax colors of values; a connection's color | — | `TableFormat` |
| formatting rule | What colors rows or cells of the table: a condition rule or a field rule, optionally named. Kept per collection, in order; the first that gives a color wins. | a filter of the query bar; a validation rule | format rule | `FormatRule` |
| condition rule | A formatting rule with a condition (a filter), a color and what it colors: the row or the cell of one field. | a field rule | — | `ConditionRule` |
| field rule | A formatting rule that colors by the values of one field, with no condition: true and false, a scale for numbers and dates, or a color per value. | a condition rule on one field's cell | — | `FieldRule` |
| pinned value | A value of a field rule's field that the user gave a color of its own; no other value of the rule takes that color. | a pinned column | — | `FieldRule.pinned` |
| Formatting pane | The pane at the right of the table that lists the formatting rules, edits them in place and shows the legend of a field rule. | the query pane; the `Columns` panel | — | `FormattingPaneUi`, `FormattingPane` |
| query shape | A query with its literal values replaced by `?`, used to group slow operations. | a query | — | `src/shared/profile.ts` |

## Writes and their history

| Term | Means | Not to be confused with | Avoid | In code |
| --- | --- | --- | --- | --- |
| write | Anything Mongoster sends that changes a database: insert, update, replace, delete, and the commands that create, change or drop. | an export to a file | mutation | — |
| undo history | The operations Mongoster recorded with the documents as they were, so that they can be undone. Kept in files. | the oplog; the document history | undo log, undo stack | `UndoHistory`, `HistoryEntry` |
| operation | One entry of the undo history: one write, with its label, target and documents. | a MongoDB operation of the server monitor | — | `HistoryEntry` |
| undo | Putting the documents of an operation back as they were. The undo is itself an operation (redo). | Ctrl+Z in an editor | rollback | `UndoHistory.undo` |
| redo | Undoing an undo. | — | — | — |
| fingerprint | The SHA-1 of a document's BSON bytes, kept after a write to tell whether the document changed since. | a host key fingerprint | — | `src/history.ts` |
| oplog | MongoDB's replication log of a replica set, read by the document history and the server monitor. | redis-oplog | — | `src/oplogHistory.ts`, `OplogEntry` |
| redis-oplog | The Meteor package `cultofcoders:redis-oplog`, and Mongoster's publishing of its writes to Redis for it. | the oplog | redis oplog | `RedisOplog`, `OplogSink` |
| publish | Sending the events of a write to Redis for redis-oplog. | release a version | broadcast | `RedisOplog.sink` |
| document history | The writes to one document still in the oplog, and its versions. | the undo history | audit log | `DocumentHistoryPanel` |
| version | One state of a document in its document history: *exact* when every field is known, *partial* otherwise. | a release of Mongoster | — | `DocVersion` |
| event | One message published for redis-oplog about one document: `{ e, d: { _id }, f }`. | a change stream event | — | `OplogEvent` |
| channel | A Redis channel an event goes to: the collection's, `<namespace>::<collection>`, and the document's `<collection>::<id>`. | — | — | `src/shared/oplog.ts` |
| Meteor id | An `_id` a Meteor app can have: a string, an `ObjectId` or a number. Others are not published. | — | — | `src/shared/oplog.ts` |
| backup | A copy of databases or collections in mongodump's formats: an archive (`.agz`) or a folder. | an export; a copy of a collection | — | `src/backup.ts` |
| archive | mongodump's single-file format: `.agz` (gzipped) or `.archive`. | a backup folder | — | `src/archive.ts` |
| checksum | The CRC-64 of a collection's data in an archive, checked on restore. | the fingerprint of a document | — | `Crc` |
| restore | Writing a backup back into a deployment. | undo | — | `CollectionRestore` |
| export | Writing documents to a JSON, JSON Lines or CSV file. | a backup | — | `src/transfer.ts` |
| scheduled task | A backup or export that runs by itself at set times. A *run* is one execution of it. | a VS Code task | cron job | `ScheduledTask`, `TaskRun` |
| output | The file or folder one run of a scheduled task wrote. | the output channel | — | `TaskRun` |
| retention | Deleting a task's older outputs beyond `Keep the last N`. | the limits of the undo history | — | `src/taskRunner.ts` |
| missed run | A run due while Mongoster was closed or the computer asleep. | a failed run | — | `src/shared/schedule.ts` |
| file name pattern | The name of what a run writes, with placeholders such as `{name}` and `{date}`. | — | — | `src/shared/schedule.ts` |

## Comparing

| Term | Means | Not to be confused with | Avoid | In code |
| --- | --- | --- | --- | --- |
| comparison | A compare tab and what it found: collections (`Compare With…`) or structures (`Compare Structure With…`). | a diff of files | — | `ComparePanel`, `StructurePanel` |
| side | Left or right in a comparison; in a structure comparison the left side is the model, the right side is changed. | — | — | `CompareSide`, `StructureSide` |
| difference | One row of a comparison. | — | — | `CompareEntry`, `StructureDiff` |
| structure | A database's collections, views, options, indexes, search indexes and shard keys. | the schema of documents | — | `src/shared/structure.ts` |
| script | The mongosh script of a structure comparison that makes the right side like the left. | a playground | — | `src/shared/structure.ts` |
| step | One command of a difference in a structure comparison; a *destructive step* drops something and is commented out unless drops are included. | a stage | — | `StructureStep` |
| search index | An Atlas Search or Vector Search index, managed with `createSearchIndex`. | an index | — | `SearchIndexInfo` |
| validation rules | A collection's `validator`, `validationLevel` and `validationAction`. | the schema analysis | — | `src/definitionFs.ts` |
| view definition | A view's `viewOn` and `pipeline`. | — | — | `src/definitionFs.ts` |

## Elsewhere

| Term | Means | Not to be confused with | Avoid | In code |
| --- | --- | --- | --- | --- |
| playground | A `.mongodb.js` file of mongosh code run against a connection. | the collection tab | script editor | `Playgrounds` |
| MCP server | Mongoster's Model Context Protocol server on `127.0.0.1`, for AI assistants. Never writes. | a MongoDB server | AI server | `McpServer` |
| tool | A function the MCP server offers to an AI assistant (`find_documents`). | a command | — | `McpTool` |
| output channel | A panel of log lines: `Mongoster MCP`, `Mongoster Playground`. | the output of a scheduled task | — | `createOutputChannel` |
| access token | The bearer token an AI assistant sends to the MCP server. Kept in the secret storage. | a MongoDB password | API key | — |
| reference | A field whose values point to documents of another collection, as found by sampling. | a DBRef only | — | `Reference`, `Relation` |
| the extension | Mongoster running in VS Code. | the desktop app | plugin | `src/extension.ts` |
| the desktop app | Mongoster running in Electron, without VS Code, with the same code. | the extension | — | `src/standalone/` |
| color theme | The colors of the desktop app's window, tabs, editor and values: one of seventeen, or Mongoster Dark or Light as the system is set. In VS Code, VS Code's own theme. | the color of a connection | skin | `ThemeDefinition`, `THEMES`, `app.theme` |
| layout | How the desktop app's window is laid out: `Islands`, the side bar and the tabs as rounded panels apart, or `Compact`, joined edge to edge. | the query's place above or beside the results | view mode | `Layout`, `app.layout` |
| host | The part of Mongoster that runs in Node: the extension host, or the desktop app's main process. | a MongoDB host | backend | — |
| webview | The page of a tab, in a browser sandbox; it only posts messages to its host. | the tab | frontend | `src/webview/` |
