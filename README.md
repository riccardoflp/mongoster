# Mongoster

A VS Code extension for working with MongoDB: open collections in a table, write queries and aggregations, edit documents, analyze schemas, indexes and relations, and keep an eye on the server. Filters can also be built by dragging cells and columns.

It works with MongoDB 4.2 or later (standalone, replica set, sharded cluster, Atlas): older servers are refused by the MongoDB driver it uses.

Mongoster also runs without VS Code, as a [desktop app](#desktop-app) with the same features.

## Features

- **Connections** in the sidebar (leaf icon): connection → database → collections. Connection strings are stored in VS Code's SecretStorage.
  - `Edit Connection…` changes the connection string and the name (a new connection string is tested before it is saved); `Copy Connection String` copies it to the clipboard.
  - **Folders**: `Move to Folder…` groups connections (in an existing or a new folder); on a folder, `+` adds a connection inside it, `Rename Folder…` renames it and `Remove Folder` removes it, keeping its connections.
  - **Color**: `Set Color…` (red, orange, yellow, green, blue, purple) colors the icon in the tree and adds a colored stripe at the top of the tabs of its collections, for example red for production.
  - **Read-only**: `Make Read-Only` stops Mongoster from writing anything through that connection (edits, insert, delete, update/delete many, import, indexes, `$out`/`$merge`, creating/renaming/dropping databases and collections); queries, aggregations, schema, explain and export stay available. `Allow Changes` turns writing back on after a confirmation. This is a safeguard of the extension: the real permissions are still those of the MongoDB user.
  - Name, color and read-only apply right away to tabs that are already open.
  - **TLS and SSH tunnel**: `Connection Settings (TLS / SSH)…` on a connection, or `Add Connection with TLS / SSH…` in the view's `…` menu (and on folders), opens a form with the name, the connection string and:
    - **TLS / SSL**: CA certificate (for a private authority), client certificate with key (PEM, also password-encrypted) and, only if really needed, `Allow invalid certificates` / `Allow invalid host names`;
    - **SSH tunnel**: SSH server (bastion), port, user and authentication with a password, a private key (also with a passphrase) or the SSH agent. The tunnel leads to the first host of the connection string with a direct connection to that server (`mongodb+srv://` connection strings can't be used); with TLS, the certificate is checked against the real server name.
    - `Test Connection` tries the connection and shows the server version; `Save` saves it. Passwords and passphrases are kept in SecretStorage and never sent back to the form: leaving the field empty keeps the saved one.
    - The first time you connect to an SSH server, its key fingerprint (`SHA256:…`) is shown for you to confirm; if it changes later, Mongoster warns you and asks again.
    - In the tree, SSH connections are labeled `SSH`; the tooltip shows the tunnel and TLS.
- **Managing databases and collections** from the tree's context menu:
  - `Create Database…` on a connection asks for the name of the database and of its first collection (MongoDB only creates a database together with a collection) and opens it.
  - `Create Collection…` (also `+` on a database) accepts optional options, for example `{ capped: true, size: 1048576 }` or `{ timeseries: { timeField: "ts" } }`.
  - `Rename Collection…` renames within the same database; the open tab, the query history and the expanded columns follow the new name. Views can't be renamed.
  - `Drop…` on collections and views, `Drop Database…` on a database: for collections and databases you type the name to confirm, and the message says how many documents, indexes or collections will be deleted. The tabs of dropped collections are closed.
- **Table** for each collection: one column per field, values colored by type, paging, total count. Values take the syntax colors of the active color theme, as in a JSON file in the editor (strings, numbers, booleans, keys; ObjectId, dates and regexes take the colors of keywords, types and regexes), including `editor.tokenColorCustomizations`, and change with the theme. The same colors are used by the playground results, the server monitor, the global search and the index advisor.
- **Filter / Sort / Project** in mongosh syntax: `{ _id: ObjectId("…"), name: /mario/i, createdAt: { $gte: ISODate("2024-01-01") } }`. `Ctrl+Enter` runs the query.
- **Visual query builder**: `Builder` next to the filter opens a list of conditions below it, each with a field, an operator and a value, for those who don't want to write mongosh syntax:
  - operators `=`, `≠`, `>`, `≥`, `<`, `≤`, `in` / `not in` (comma-separated values or an array), `matches` (regular expression, `/^mario/i` or just the text), `exists`, `missing`, `type` (BSON type from a list) and `size` (arrays with that number of elements);
  - the field is picked from the collection's fields (nested ones too), the value from the field's most frequent values; values are written as in mongosh (`42`, `true`, `"text"`, `ISODate("2024-01-01")`, `ObjectId("…")`), and a word without quotes is a string;
  - `Match all` combines all the conditions (those on the same field become a single range, e.g. `{ age: { $gte: 20, $lte: 30 } }`), `Match any` combines them with `$or`;
  - the text filter updates as you fill in the rows (incomplete rows, shown dashed, don't count) and, the other way round, a filter written by hand, dragged or taken from the history fills the rows. If it uses operators the rows can't show (`$elemMatch`, `$expr`, nested `$or`…), the builder says so and leaves the filter as it is. `Enter` in a row runs the query; the builder stays open or closed per tab.
- **Autocomplete** while you type in Filter, Sort, Project, in pipeline stages (also as text), in `Update many` and in the keys and the partial filter of an index:
  - field names, nested ones too (`address.city`, quoted when needed), taken from a sample of 500 documents, with the type and the percentage of documents that have them; from the second stage on, if the table shows the output of the previous stage, the fields are those of that output;
  - operators that fit where you are: `$and`/`$or`/`$expr` at the top of the filter, `$gte`/`$in`/`$elemMatch`/`$exists`… inside a field, pipeline stages, accumulators in `$group`, expressions and `"$field"` references in `$project`/`$addFields`, update operators (`$set`, `$inc`, `$push`…);
  - the field's most frequent values (`status: ` → `"active"`, `"pending"`…), also inside `$in: [...]`, plus `1`/`-1` for sorting and the types for `$type`;
  - `Tab` or `Enter` insert the suggestion (operators come with a skeleton of the value, e.g. `$in: [|]`), `↑/↓` move through the list, `Esc` closes it, `Ctrl+Space` opens the suggestions where you are.
- **Drag & drop into the filter**:
  - drag a **cell** → `= equals`, `≠ not equal`, and for numbers/dates/strings `≥ from` / `≤ to` (they combine into a range on the same field); for arrays `∈ in`;
  - drag a **column header** → `exists`, `missing`, `is null`.
- **Query history**: `History` in the toolbar shows the queries saved with a name and the last 50 that ran successfully on that collection (without duplicates, remembered after closing VS Code too). Click or `Enter` to run one again; search, `☆` to save it with a name, `✕` to remove it, `Clear` to empty the recent ones.
- **Global search**: right-click a connection, a database, a collection or a view → `Search Documents…` opens a tab that searches for a text in **any field** of the documents, nested or inside arrays too, across all collections:
  - `Contains` finds the text inside strings (case-insensitive, unless `Match case`), but also an `_id` or a reference: pasting an ObjectId (or part of it, or `ObjectId("…")`) finds the document and the ones that refer to it; the same goes for UUIDs and dates (`2024-03-15`). Numbers and booleans are compared as whole values: `42` finds `42`, `NumberLong(42)` and `NumberDecimal("42.0")`, not `420`. `Regex` searches with a regular expression (`^mario` or `/^ma/i`);
  - `Field names` also searches field names; `Views` includes views (usually left out, because they show documents of collections that are already searched); `Read` limits the documents read per collection (all, or the first 1,000 / 10,000 / 100,000). The `admin`, `local` and `config` databases, `system.*` collections and the contents of GridFS files (`*.chunks`) are skipped;
  - MongoDB has no "any field" query: Mongoster reads and checks the documents itself, three collections at a time, with the progress of each collection (read / estimated). `Stop` (or `Esc`) interrupts the search;
  - results are grouped by collection: for each document, its `_id` and the matching fields with the text highlighted. Click a document to open it in the editor; `Open in Collection` opens the collection filtered on the documents found (`{ _id: { $in: [...] } }`, up to 1,000). The first 50 documents of each collection are listed and the others are counted; collections that can't be read (permissions) are reported.
- **Sorting**: click a header (▲ → ▼ → none).
- **Custom columns**, remembered for each collection (also after a rename):
  - **hide**: right-click a header → `Hide`, or the checkboxes of the `Columns` panel in the bar above the table (with search, `Show all` and `Reset`);
  - **reorder**: drag a header onto another one (the column goes before or after it, among those of the same level), or drag the rows in the `Columns` panel;
  - **resize**: drag the right edge of a header; double-click the edge to go back to the automatic width;
  - **pin to the left**: right-click → `Pin`, or `📌` in the panel: the column stays visible while scrolling horizontally.
  - CSV export uses the visible columns in the chosen order.
- **Aggregate**: the `Find / Aggregate` switch at the top opens the pipeline editor.
  - Each stage is a card: operator (with suggestions and a template for common stages), body in mongosh syntax, a checkbox to disable it, `‹ ›` to move it, `✕` to remove it. `Ctrl+Enter` in a stage runs the pipeline.
  - Clicking a **stage number** shows the output up to that stage (with paging and count); the following stages are dimmed. `Run` runs the whole pipeline.
  - Drag & drop works here too: the condition goes into the `$match` shown, or into a new `$match` right after the stage shown. Clicking a header adds or changes a `$sort` at the same point.
  - `Edit as text` to paste or edit the whole pipeline (`[ { $match: … }, … ]`), `Copy` to copy it.
  - Stages that write (`$out`, `$merge`) ask for confirmation before running; previewing an earlier stage writes nothing.
  - Errors point to the stage that caused them. Pipelines go into the same history as queries.
  - Aggregation results can't be edited: to edit a document, go back to `Find`.
  - `Save as view…` creates a view on the collection with the pipeline up to the stage shown (without `$out`/`$merge`) and offers to open it.
- **Nested columns**: columns with sub-documents have a `▸` button that expands them into dotted columns (`address` → `address.city`, `address.zip`, …), one level at a time; `Alt+click` expands all levels. Click the prefix (`address.`) to collapse the group again. Filters, ranges and sorting work on nested fields too (`{ "address.city": "Milano" }`). If the field isn't an object in a document, the value spans the whole group. Expansions are remembered for each collection.
- **Arrays of objects**: columns with arrays of sub-documents have `▸[]` too: they expand into the fields of the elements (`items[].sku`, `items[].qty`, …) and **each element becomes a sub-row** of the document, so the fields of the same element stay aligned (up to 20 elements per document, then `… N more`).
  - Dragging the value of an element builds a filter with `$elemMatch`: `{ items: { $elemMatch: { sku: "A1", qty: { $gte: 4 } } } }`. Several conditions on the same array go into the same `$elemMatch`, so they apply to the **same element**.
  - Dragging the header and sorting use the dotted path (`items.sku`).
  - Sub-documents inside the elements can be expanded (`items[].options.color`); arrays inside arrays stay as a value.
- **Update many / Delete many**: the buttons next to `Explain` act on all the documents matching the filter.
  - The dialog shows the filter and how many documents match before writing; the table behind it shows those documents.
  - For updates you write operators (`{ $set: { status: "archived" }, $inc: { version: 1 } }`) or a pipeline (`[ { $set: { total: { $add: ["$a", "$b"] } } } ]`); a document without operators is refused, because it would replace whole documents. `Ctrl+Enter` applies it.
  - With an empty filter, an extra confirmation is asked, because the whole collection would be changed or deleted.
  - At the end, the number of documents changed or deleted is shown. Not available for views.
- **Inline editing**: double-click a cell (or `F2` on the selected cell) to edit its value in mongosh syntax; `Enter` saves it with `$set`, `Shift+Enter` adds a new line, `Esc` (or a click elsewhere) cancels.
  - It also works on nested fields, on the elements of expanded arrays (`items.2.qty`) and on empty cells (it adds the field).
  - Numeric types stay the original ones; `NumberLong(...)` and similar force a type.
  - If the value has changed in the database in the meantime, you are asked whether to overwrite it. Not available for `_id`, for views and in Aggregate mode.
- **JSON document**: clicking the row number (or `Enter` on the selected cell) opens a dialog with an expandable JSON tree; `↑/↓` to move through the documents, `Copy`.
- **Editing**: `Edit` opens the document in an editor tab; `Ctrl+S` saves it to MongoDB.
  - Numeric types stay the original ones (Double, Int32, Long), even when the value changes; `NumberLong(...)` and similar force an explicit type.
  - The editor also accepts mongosh syntax (`ObjectId(...)`, `ISODate(...)`).
  - If the document was changed or deleted in the database after it was opened, you are asked whether to overwrite / insert it again.
  - `_id` can't be changed: use `Duplicate`.
- **Insert / Duplicate / Delete**: `Insert` in the toolbar (or `+` on the collection in the tree) opens a new document to save with `Ctrl+S`; `Duplicate` opens a copy without `_id`; `Delete` (or the `Delete` key on a cell) deletes it after a confirmation.
- **Export**: the `Export` button exports what the table shows (the query, or the pipeline up to the stage shown): all the results or just the current page. Also from the tree: right-click a collection or view → `Export Collection…`.
  - **JSON**: a readable array (relaxed Extended JSON).
  - **JSON Lines**: one document per line in canonical Extended JSON, which keeps all the types; it's the right format to import again.
  - **CSV**: the visible columns (expanded ones too); expanded arrays give one row per element with the other values repeated. With a UTF-8 BOM, so Excel reads accented characters.
  - Pipelines ending with `$out`/`$merge` can't be exported: select an earlier stage.
- **Import**: right-click a collection → `Import Documents…` accepts JSON (an array or a single document), JSON Lines, CSV and also mongosh syntax (`ObjectId(...)`, `ISODate(...)`). It asks for confirmation, inserts in batches of 1000 and reports the documents that were skipped (e.g. an existing `_id`) without stopping.
  - In CSV, headers with a dot create sub-documents (`address.city`), empty cells are left out, and numbers, booleans, `null`, ISO dates (`…Z`), JSON and hexadecimal `_id`s are recognized.
- **Copying collections**: right-click a collection or view → `Copy Collection To…` copies it to another database, also on another connection (e.g. from production to local). You choose the connection, the database (also a new one) and the collection name, then:
  - if the target collection exists: `Append` (documents with an `_id` that is already there are skipped), `Replace matching` (replaced by `_id`) or `Drop and recreate`;
  - an optional filter in mongosh syntax, to copy only part of the documents;
  - whether to also copy the indexes and the collection options (validation rules, capped, collation, time series…).
  - After a confirmation with the number of documents, the copy proceeds in batches of 1000 with the progress in the notification; `Cancel` stops it after the current batch (documents already copied stay). BSON types stay identical (Int32, Double, Long, Decimal128, regex…). At the end, `Open` opens the copied collection.
  - Read-only connections can be the source but not the target; a view is copied as a collection with its documents.
- **Backup and restore**, in the `mongodump` folder format (compatible both ways with `mongodump` / `mongorestore`):
  - `Back Up…` (right-click a connection, a database, a collection or a view) saves the chosen databases, the chosen collections of a database or a single collection. You choose the format (`Compressed (gzip)` or `Uncompressed`) and the folder: inside it, a folder with a name and date is created (`shop_2026-10-08_16-45-12`) and, for each database, a subfolder with `<collection>.bson` (the documents, byte for byte as they are in the database) and `<collection>.metadata.json` (options such as validation rules, and indexes; views only have this one), or `.bson.gz` / `.metadata.json.gz`;
  - the backup shows its progress in the notification and can be cancelled (the incomplete folder is deleted). At the end, `Copy mongorestore Command` copies the command to restore it with the MongoDB tools (`mongorestore --gzip --dir "…"`), and `Reveal Folder` opens the folder. Time series collections aren't supported and are left out (they need `mongodump`);
  - `Restore from Backup…` on a connection or a database (not read-only) asks for the backup folder: one created by Mongoster or by `mongodump --out` (with a subfolder per database), or the folder of a single database. On a connection you choose the databases (a single one can be restored under another name), on a database which database of the backup to restore into it; then the collections. On a collection you choose a single `.bson` / `.bson.gz` file (with its `.metadata.json` next to it, if there is one);
  - `Add documents` adds the documents and keeps the existing ones (those with an `_id` that is already there are skipped, as `mongorestore` does); `Drop and restore` drops the collections first (like `mongorestore --drop`). New collections are created with their options, then the indexes are rebuilt; documents are inserted unchanged, without applying the validation rules. With `Add documents`, the added documents can be undone from the history (one operation per collection, up to 10,000 documents).
- **Comparing collections**: right-click a collection or view → `Compare With…` compares it with another one, also on another connection (e.g. staging and production): you choose the connection, the database and the collection (the same name is suggested). Documents are paired by `_id` and split into identical, different, left only and right only.
  - `Filter` (mongosh syntax) limits the comparison to the matching documents, on both sides; `Ignore` leaves fields out (`updatedAt, __v`, also nested ones like `address.zip` or fields of array elements like `items.price`).
  - `Ignore field order` (on) treats documents with the same fields in a different order as equal; `Compare numbers by value` (on) treats `1` (int), `1.0` (double) and `NumberLong(1)` as equal. Turning them off shows these differences too, with the BSON type next to the value.
  - The counts at the top filter the list by kind of difference. For different documents, the list shows the changed fields; click a row for a field-by-field comparison (left / right, `—` if the field is missing); for documents on one side only, the whole document. `Open Left` / `Open Right` open the document in the editor.
  - `→ Right` / `← Left` on a row copy the document from one side to the other (insert or replace, with identical BSON types) or, if it's missing on the other side, `Delete` deletes it. `Make right like left…` / `Make left like right…` do the same for all the differences: after a confirmation they copy the missing or different documents and, if chosen, delete those found only on the target side. Then the comparison runs again.
  - `⇄` swaps the sides. Read-only connections and views can be compared but not changed. The comparison reads one side at a time, keeping only a fingerprint per document in memory (up to 1,000,000 documents per side); the list shows the first 300 differences of each kind.
- **Undo changes**: before every change Mongoster makes to documents, it saves how they were, so the change can be undone even after restarting VS Code:
  - inline edits, `Edit` / `Insert` / `Delete` of documents, `Update many` / `Delete many`, import, copying collections (`Append` and `Replace matching`; not `Drop and recreate`) and the comparison's `Make … like …` are recorded. The playground, `$out` / `$merge`, indexes, users, GridFS files and dropping collections and databases can't be undone;
  - `Show Undo History` (clock icon in the view's title bar) opens the tab with the operations, newest first: when, connection and collection, what was done, how many documents were inserted, changed or deleted and how much space they take. Click a row to see what undoing would do to each document (the current value and the value after the undo, field by field);
  - `Undo` puts the documents back as they were: it deletes the inserted ones, restores the changed ones and inserts the deleted ones again, with identical BSON types. If some of the documents changed in the meantime, it says so and you choose whether to overwrite those changes too (`Undo All`) or undo only the others (`Undo Unchanged Only`). The undo is recorded too, so it can itself be undone (redo). `Undo` is also in the notification of `Update many`, `Delete many`, import, copy and document deletion, and `Undo Last Change` (the view's `…` menu or the command palette) undoes the last operation;
  - **Disk space**: operations are compressed (gzip) files in the extension's folder (`globalStorage`, on Windows `%APPDATA%\Code\User\globalStorage\riccardofilippozzi.mongoster\history`), holding only the documents involved (only the `_id` for inserts). By default at most 100 MB, 7 days and 200 operations are kept, deleting the oldest first; operations on more than 10,000 documents or more than 20 MB aren't recorded, and the confirmation says so (`can't be undone`). The limits are in the `mongoster.history.*` settings, where the history can also be turned off (`mongoster.history.enabled`); `Clear History…` (or `Clear Undo History` from the palette) empties it, `✕` removes a single operation;
  - for a single connection: right-click → `Stop Keeping Undo History` (and `Keep Undo History` to turn it back on). Removing a connection also deletes its saved operations. With a read-only connection nothing is recorded or undone.
- **Schema**: the `Schema` tab analyzes the documents matching the filter (all of them, or a random sample of 100 / 1,000 / 10,000) and shows, for each field:
  - how often it's there and with which BSON types (`int`, `double`, `long`, `decimal`, `date`, `objectId`, …), with percentages;
  - the most frequent values, or a histogram for numbers and dates with minimum and maximum; for arrays, the length and the values of the elements.
  - Sub-documents and the fields of objects in arrays (`items[].sku`) expand with `▸`; `⊞` / `⊟` expand or collapse everything.
  - Click a value, a histogram bar or a type to add it to the filter (`{ status: "active" }`, `{ age: { $gte: 25, $lt: 30 } }`, `{ name: { $type: "string" } }`): the analysis runs again on the filtered documents.
- **Charts**: the `Chart` tab draws the documents matching the filter, or the output of the `Aggregate` tab's pipeline (up to the stage shown): the `Data` selector chooses `Filter` or `Pipeline`, and when opened it follows the tab you came from. The computations run on the server with an aggregation pipeline, so they also work on large collections.
  - **Bar** and **Pie**: for each value of the `Category` field, the number of documents, or the sum / average / minimum / maximum of a numeric field; the largest categories (`Top`, 20 for bars and 10 for pies). Arrays count each element (`tags`); with grouped dates, the bars are in time order.
  - **Line**: like bars, but ordered along the category, usually a date; dates can be grouped by hour, day, week, month or year.
  - **Scatter**: two numeric or date fields of a random sample of documents (`Sample`, 1,000).
  - **Histogram**: the distribution of a numeric or date field in `Bins` equal intervals (also `long` and `decimal`).
  - `Series` splits bars, lines and points by the values of another field (up to 12 series, the largest ones).
  - Clicking a bar, a slice or a point of the line opens `Find` with the matching filter (`{ status: "active", "address.city": "Milano" }`, a date or value range) to see those documents.
  - `Code` shows the chart's pipeline as code (mongosh, Node.js, Python, Java, C#, Go); `Export PNG` saves the image. Colors follow the VS Code theme.
- **Views**: right-click a view → `Edit View Definition…` opens `viewOn` and `pipeline` as JSON in a tab; `Ctrl+S` applies the changes (`collMod`) and refreshes the view's tab.
- **Validation rules**: right-click a collection → `Edit Validation Rules…` (or `Validation rules…` in the `Schema` tab) opens `validator`, `validationLevel` and `validationAction` as JSON; `Ctrl+S` applies them.
  - If the collection has no rules, a `$jsonSchema` generated from a sample of 1,000 documents is proposed: the BSON types of each field (nested and in arrays too) and, as `required`, the fields that are always present. Review it before saving; `validationAction: "warn"` logs invalid documents without rejecting them.
  - `validator: {}` removes the rules. With a read-only connection the rules can only be read.
- **Relationship diagram**: right-click a database, a collection or a view → `Relationship Diagram` opens a tab with the database's collections as boxes (fields, types, number of documents) and arrows for the references between them:
  - MongoDB doesn't declare relations: Mongoster reads a sample of documents from each collection (100 / 500 / 2,000, random with `$sample` in large collections) and looks for fields that look like references. An ObjectId or a UUID can point to the `_id` of any collection with the same `_id` type; strings and numbers only to collections with a similar name (`categoryId` → `categories`, `customerEmail` → `customers.email`), on `_id` or on a field with a unique index. Up to 20 values of each field are actually looked up in the target collection (one `$in` per collection): the relation exists if at least 20% (ObjectId/UUID) or 60% (strings and numbers) of them are found. DBRefs are recognized directly; views are linked to their source collection;
  - `N` on an arrow marks an array of references (`items[].productId`); `PK`, `UK` and `FK` mark `_id`, unique fields and fields that point elsewhere. Up to 14 fields are shown per box, in document order; `Keys only` keeps only keys and references;
  - collections are laid out in columns following the references, those without relations in a grid below. Boxes can be dragged (their position is kept while the tab is open), the background can be panned and the wheel zooms; `Fit` fits the diagram to the tab, `Reset Layout` goes back to the automatic layout;
  - clicking a box or a relation in the `Relations` list (at the bottom, with how many sampled values were found) highlights its links; double-click or `Enter` on a box opens the collection;
  - `Copy Mermaid` copies the diagram as a Mermaid `erDiagram` (to paste into a README or a wiki); `Save SVG…` saves an SVG image with the current layout.
- **Indexes**: the `Indexes` tab (next to `Find / Aggregate`; also right-click a collection → `Indexes`) lists the collection's indexes with keys, properties (`unique`, `sparse`, TTL, `partial`, `text`, `wildcard`, collation, `hidden`, …), size on disk compared with the largest one, and number of uses and uses per day since the server started. Above the list: how many they are, their total size, how many were never used. `Name`, `Size` and `Usage` sort the list.
  - Clicking an index opens its details: the full definition as the server reports it, the mongosh command that creates it (`Copy`) and, on a sharded cluster, the uses on each member.
  - `Create index…` opens a dialog with the fields (suggested from the documents; direction `1` / `-1` or type `text`, `2dsphere`, `2d`, `hashed`; `$**` for a wildcard index; the arrows change their order), the name and the options: `Unique`, `Sparse`, `Hidden`, `TTL` (in seconds, minutes, hours or days), `Partial` (a filter, with autocomplete), `Collation`, the weights and the language of a text index, and any other option of `createIndex` in `More options`. `Text` switches to the keys and options as `createIndex` takes them, and back. The command is shown while editing, with `Copy command`; an option MongoDB doesn't know is refused instead of being ignored. A wildcard written wrong (`address.*`, `**`: MongoDB would quietly index a field with that very name) or given something a wildcard index can't have (`unique`, `sparse`, TTL, a type, a `wildcardProjection` missing or out of place) is pointed out while editing, and an existing index on such a field is marked `not a wildcard` in the list.
  - `Edit…` opens the same dialog on an existing index, and says what the change takes before saving. Hiding it and changing its TTL are applied in place. MongoDB can't change anything else of an index (keys, name, `unique`, partial filter, …): after a confirmation it is dropped and built again. When the new definition can exist next to the old one (other keys under another name), it is built first and the old index is dropped afterwards, so queries are never left without one. If the new definition is refused (e.g. duplicate values for `unique`), the index stays, or is created again, as it was.
  - `Duplicate…` opens the dialog on a copy of the index, to create a variant of it.
  - While an index is being built, the list shows it as `building` with the progress of the build, and the dialog can be closed: the build goes on and the tab says when it ends.
  - `Hide` hides an index from the query planner without deleting it (useful to find out whether it's still needed), `Unhide` brings it back; `Drop` deletes it after a confirmation. `_id_` can't be touched.
  - Views have no indexes of their own: they use those of the source collection.
- **Index advisor**: right-click a connection, a database or a collection → `Index Advisor` opens a tab that reads the indexes (with how many times they were used, from `$indexStats`) and the slow operations, and suggests what to do:
  - **Indexes to create**: for slow queries that read the whole collection, sort in memory or examine many more documents than they return, the index that would serve them (equality fields, then sort, then range). Queries the same index can serve are merged into a single suggestion (`{ kind: 1 }` and `{ kind: 1, user: 1 }` → only the second); those already served by an existing index aren't suggested. For each suggestion: number of operations and total time, the queries with their average, documents examined / returned, `Open` / `Explain` to open them in the collection's tab, `Create Index…` (with a confirmation) and `Copy` for the mongosh command;
  - **Redundant indexes**: indexes whose fields are the start of another index (also with all directions reversed, e.g. `{ a: -1 }` and `{ a: 1, b: 1 }`), which therefore only cost writes and memory. `unique` and TTL indexes aren't considered redundant, nor are those with different options (`partialFilterExpression`, `sparse`, collation);
  - **Unused indexes**: indexes never used since statistics started (server start or index creation), only if the statistics cover at least one day; newer ones are only counted. `_id`, `unique` and TTL indexes are left out (they do their job without being read by queries). Hidden indexes are listed too, with `Unhide`. Statistics only come from the server Mongoster is connected to: on a replica set, check the other members too;
  - `Hide` hides the index from the query planner without dropping it (you can go back right away if something slows down), `Drop…` drops it after a confirmation; on read-only connections the actions are disabled;
  - slow operations come from the profiler (`system.profile`, the last 5,000 per database) where it has data, otherwise from the "Slow query" lines of the server log (the last 1,024 lines). If a database's profiler is off, `Turn On…` turns it on for operations slower than the threshold (`slowms`, usually 100 ms).
- **Explain**: the `Explain` button (in `Find` and in the pipeline editor) shows how MongoDB runs the query: index used or `COLLSCAN`, in-memory sort, documents and keys examined compared to those returned, time, execution plan as a tree; `Raw` shows the full output.
  - If the query reads the whole collection or sorts in memory, it suggests an index (equality fields first, then sort, then ranges); `Create…` opens the `Indexes` tab with the index dialog already filled in.
  - For pipelines it explains up to the stage shown; those with `$out`/`$merge` can't be explained.
- **Code**: the `Code` button (in `Find` and in the pipeline editor) shows the query (filter, projection, sort) or the pipeline as code for **mongosh**, **Node.js**, **Python** (PyMongo), **Java**, **C#** and **Go** (driver v2):
  - BSON types become the driver's (`ObjectId`, dates, `Long`/`Int64`, `Decimal128`, regex, UUID, binary, timestamp, `MinKey`/`MaxKey`…), so the query finds exactly the same documents;
  - `Full program` adds imports, the connection (from the `MONGODB_URI` environment variable) and printing of the results: a program that runs as it is;
  - `Copy` copies the code, `Open in Editor` opens it in a new tab with the right language. The chosen language is remembered for the collection.
- **Playground**: `.mongodb.js` files with mongosh syntax. `New Playground` (icon in the view's title bar, or right-click a connection, a database or a collection) opens one already set to that connection and database.
  - `Ctrl+Enter` (or `▶ Run` at the top of the file, or the tab's ▶ button) runs the whole file, or only the selected lines; the result opens beside it: documents as a table or as mongosh text (`Table` / `JSON`), `Copy` and `Open in Editor`.
  - As in mongosh, `await` isn't needed: `const u = db.users.findOne({ … }); u.name` works. The value of the last expression is shown (for a cursor, the first 200 documents); `print()`, `printjson()` and `console.log()` write to the result's output and to the `Mongoster Playground` channel.
  - Available: `db.<collection>` (or `db.getCollection("…")`) with `find`/`aggregate` (cursors with `sort`, `limit`, `skip`, `project`, `toArray`, `forEach`, `map`, `count`, `explain`…), `findOne`, `countDocuments`, `distinct`, `insert*`, `update*`, `replaceOne`, `delete*`, `findOneAnd*`, `bulkWrite`, indexes, `drop`; `use("db")`, `db.getSiblingDB()`, `db.runCommand()`, `db.adminCommand()`, `db.getCollectionNames()`, `db.stats()`; `ObjectId()`, `ISODate()`, `NumberLong()`, `NumberDecimal()`, `UUID()`, `Timestamp()` and the other BSON types.
  - The default connection and database are shown (and can be changed) in the CodeLens at the top of the file and in the status bar; `use("…")` in the script takes precedence. With a read-only connection, methods that write, `$out`/`$merge` and commands that change things are refused.
  - Errors show the line (click to go there); `Cancel` in the notification stops waiting for the result (operations already sent may still complete on the server).
  - Autocomplete in the file: after `db.` the database's collections and methods, after `db.users.` the collection's methods, after `find(...).` the cursor's; inside `find`, `aggregate`, `updateMany`, `sort`… the same field, operator and value suggestions as the table.
- **Server monitor**: right-click a connection → `Open Server Monitor` opens a tab with four sections, refreshed with `Refresh` or automatically (every 2, 5 or 15 seconds, only while the tab is visible):
  - `Operations`: the operations in progress (`currentOp`) with type, namespace, duration (yellow over 5 s, red over 30 s), client and application, plan (`COLLSCAN` highlighted), lock waits and command; filter by text and by minimum duration, idle connections and the server's internal operations on request. Click a row for the full details; `Kill` stops the operation (`killOp`) after a confirmation.
  - `Slow queries`: slow operations, from two sources:
    - `Profiler`: those recorded in the chosen database's `system.profile` (the last 1,000). The profiler level (off, operations over N ms, all) can be changed from there; `Clear` empties the recorded operations and keeps the settings.
    - `Server log`: the "Slow query" lines of the server's recent log (the last 1,024), for all databases or just one, without turning on the profiler; the threshold (`slowms`, 100 ms by default) can be changed from there.
    - `Since` limits them to the last 15 minutes, the last hour or the last 24 hours. Operations of the profiler itself, of the monitor and the server's internal ones are left out.
    - `By query` groups operations by **query shape**: the same query with different values (`{ status: ?, age: { $gt: ? } }`, a pipeline with its stages) becomes a single row with the number of runs, total, average and maximum time, documents examined compared to those returned, plans and last run, sortable by column. Requests for a cursor's later batches (`getMore`) count with their query. `All` shows every operation.
    - When the query scans the whole collection (`COLLSCAN`), sorts in memory or examines many more documents than it returns, the details (⚑) suggest an index following the ESR rule (equality, sort, range) and `Create Index…` creates it after a confirmation; if it already exists, it says so.
    - `Open in Collection` opens the filter (with sort and projection) or the pipeline in the collection's tab, `Explain` opens it and shows the current plan right away; `Copy Query`, `Show Operations` (the single runs) and the full profiler or log document.
  - `Stats`: version, uptime, connections, operations per second by type, network and memory of the server; a table of databases (collections, views, documents, data, storage, indexes) and, clicking one, of its collections, sortable by column.
  - `Replication`: the state of the replica set:
    - tiles with the replica set name and term, current primary (and the server you are connected to), healthy members, maximum replication lag (yellow over 10 s, red over 60 s; intentionally delayed members are left out), oplog window (how much time it covers: how far a member can fall behind and still catch up), size and number of entries, election settings;
    - the members table: state (`PRIMARY`, `SECONDARY`, `ARBITER`, unreachable…), lag behind the primary, last applied operation, last heartbeat, ping, sync source, priority and votes, notes (hidden, delayed by N s, never primary, tags, error messages), uptime. Click a member for the full `replSetGetStatus` and `replSetGetConfig` data;
    - `Step Down…` makes the primary step down after a confirmation (`replSetStepDown`) so that another one is elected, for example to test a failover;
    - the **oplog**: the last 50, 200 or 1,000 replicated operations, newest first, filterable by database or collection (inside transactions too) and by type. For each entry: time, type, namespace, `_id` and what changes (`set status, address.city · unset tempToken` for updates, the inserted document, the command, the operations of a transaction); click for the full entry. Periodic no-ops are left out unless requested.
    - On a standalone server or a mongos, the section says so. Without the `clusterMonitor` role, members are read from `hello` with fewer details.
  - With a read-only connection, operations can't be killed, the profiler and the threshold can't be changed, suggested indexes can't be created and the primary can't be stepped down.
- **GridFS**: GridFS buckets (the `<bucket>.files` / `<bucket>.chunks` pairs) appear in the tree under the database with a files icon; click to open their tab:
  - the list of files with name, size, upload date, content type, metadata and `_id`, sortable by name, size or date, in pages of 100, with the total number of files and bytes. The filter searches the name, or accepts a mongosh filter on the `files` collection (`{ "metadata.contentType": "image/png" }`);
  - click a file for a preview: images (up to 4 MB), text (the first 256 KB) or the first 512 bytes in hexadecimal for binary files; `Edit Metadata` opens the file's document in the editor (`Ctrl+S` saves it), `Copy _id`, `Copy Name`;
  - `Open` downloads the file to a temporary folder and opens it in VS Code (text, images, PDF…); `Download…` saves it where you choose;
  - `Upload…` (also from the tree: right-click a bucket, or a database → `Upload Files to GridFS…` to create a new one, `fs` by default) uploads one or more files, with the content type taken from the extension. If files with the same name already exist, you choose whether to add a new revision (GridFS keeps them all), replace them or skip them. Uploads and downloads are streamed with the progress in the notification and can be cancelled;
  - `Rename…` and `Delete` (after a confirmation, together with the chunks); right-click the bucket → `Delete GridFS Bucket…` deletes the whole bucket. With a read-only connection, files can only be browsed and downloaded.
- **Users and roles**: right-click a connection (or a database) → `Manage Users and Roles` opens a tab with the users and roles of one database or of all of them (`Database`), filterable by name, role or privilege. At the top you can see which user and roles the connection is authenticated with (or that it isn't).
  - `Users`: user, database where it's defined, roles, authentication mechanisms. `Create User…` asks for the name, the database, the password (`Generate` creates a random 24-character one, `Copy` copies it), the roles (with role names suggested; those that only exist in `admin`, such as `clusterMonitor` or `readAnyDatabase`, go there on their own) and optional custom data. `Password…` sets a new password; after setting it, `Copy Password` copies it, because MongoDB never shows it again. Click a user for their roles: `✕` revokes a role after a confirmation, `Grant` adds one. `Delete` deletes the user after a confirmation.
  - `Roles`: custom roles, with privileges (`shop.orders: find, insert`, `shop.*` for all the database's collections, `cluster`), inherited roles and the number of users who have them; `Built-in roles` adds MongoDB's own. Click a role for its full privileges and users. `Create Role…` / `Edit…` ask for the privileges in mongosh syntax (`[{ resource: { db: "shop", collection: "orders" }, actions: ["find", "insert"] }]`) and the inherited roles; `Delete` deletes the role after a confirmation.
  - If you change the password or remove roles of the user you are connected with, you are reminded to update the connection string. With a read-only connection, users and roles can only be browsed.
- **Watch (change streams)**: right-click a collection, a database or a connection → `Watch Changes` (or `Watch` in the collection's toolbar) opens a tab that shows inserts, updates, replacements and deletes (and `drop`, `rename`, …) live, newest first:
  - click an event for its details: for updates, the table of changed fields (before → after), for inserts the document, then the current document, the full event with `Copy event` and `Open document` to open it in the editor;
  - values **before** the change (and the deleted document) are shown if the collection records pre-images: `Enable…` turns them on (`changeStreamPreAndPostImages`, after a confirmation; not with read-only connections);
  - filters by operation type and by text; `$match` applies a server-side filter to the events (e.g. `{ "fullDocument.status": "active" }`); `Current document on update` also reads the current version of the updated document;
  - `Pause` holds new events without closing the stream, `Stop` / `Start` close and reopen it, `Clear` empties the list (the last 1000 events are kept).
  - Change streams need a replica set or a sharded cluster (a single-node replica set is enough); on a standalone server, the tab explains this. If the collection is dropped or renamed, the stream closes.
- **AI assistants (MCP)**: an MCP server lets an AI assistant (GitHub Copilot in VS Code, Claude Code, Cursor and other clients of the Model Context Protocol) work with the connections saved in Mongoster. Run `Mongoster: Set Up MCP Server for AI Assistants…` from the Command Palette: it turns the server on and copies the configuration for your client.
  - The tools: `list_connections`, `list_databases`, `list_collections`, `describe_collection` (estimated count, indexes, and the fields of a sample of documents with their types and how often they are present), `find_documents` and `aggregate` (up to 100 documents in mongosh syntax, with how many match), and `open_query`, `open_aggregation` and `open_search`, which open the collection's tab with the filter or the pipeline's stages, or the global search, and run them so you see the results in Mongoster. Ask for example *"find the orders of the users in Rome and show them to me"*.
  - **GitHub Copilot** in VS Code finds the server on its own once it is on. For **Claude Code**, the setup command copies `claude mcp add --transport http mongoster http://127.0.0.1:37017/mcp --header "Authorization: Bearer …"`; for clients configured with JSON (`.mcp.json`, Cursor, Windsurf…) it copies the `mcpServers` entry.
  - The server never writes: there are no tools that change data, and pipelines with `$out` or `$merge` are refused. It listens on `127.0.0.1` only and needs an access token, kept in VS Code's SecretStorage (`Generate a new access token` replaces it); connection strings are never given to the AI. With `mongoster.mcp.readDocuments` off, the AI only sees the structure and opens tabs, without reading documents. Each call is written to the `Mongoster MCP` output channel.
  - **Several VS Code windows**: the tabs open in the window you used last. Only one window can listen on the port, so a window that gets the focus takes it from the one that had it (calls in progress there finish); when that window is closed, another one takes the port within a few seconds.
  - **Port**: `37017` on `127.0.0.1`. `Mongoster: Change MCP Server Port…` (also `Change the port…` in the setup command) asks for another one; clients other than Copilot then need the new address, so copy the configuration again. If another program is using the port, a warning says so and `Change Port` suggests a free one.
  - Settings: `mongoster.mcp.enabled` (off by default), `mongoster.mcp.port` and `mongoster.mcp.readDocuments`.
- **Views** are read-only, like the collections of read-only connections (`view` / `read-only` badge next to the name).
- `Ctrl+C` on a selected cell copies its value.

## Desktop app

The same code also runs as a desktop app (Electron) for Windows, macOS and Linux, for those who don't use VS Code. Everything described above works the same way; what VS Code provides is replaced by the app:

- **Window**: the connections in the side bar (`Ctrl+B` hides it), tabs on two sides (a tab's menu has `Move to the Other Side`; documents, playground results and what the extension opens "beside" go to the second one), `Ctrl+PageUp` / `Ctrl+PageDown` to switch tab, `Ctrl+W` to close it.
- **Commands**: the same context menus on the tree and buttons in its title, the menu bar, and the Command Palette (`Ctrl+Shift+P`).
- **Editor**: documents as JSON, playgrounds, view definitions, validation rules and generated code open in the editor of VS Code (Monaco), with `Ctrl+S` to save, the playground's CodeLens, `Ctrl+Enter` and autocomplete. A new playground is saved as a `.mongodb.js` file wherever you like; `File › Open File…` (`Ctrl+O`) opens it again, with the connection it had.
- **Settings** (`Ctrl+,`): the `mongoster.*` settings in a tab, plus the color theme (`View › Theme`: dark, light or the system's).
- **Storage**: connections, history and settings are kept in the app's own folder (`%APPDATA%\Mongoster`, `~/Library/Application Support/Mongoster`, `~/.config/Mongoster`), and connection strings, passwords and the MCP token are encrypted with the system's keychain. The app and the extension don't share their connections.
- **AI assistants (MCP)**: the MCP server works in the app too, with the same setup command (`Tools` menu). Only the automatic discovery by GitHub Copilot needs the extension. The app and VS Code have their own access tokens and the same default port: the first one started gets it, and `Change MCP Server Port…` gives the other one its own.

To run it from the sources or build the installers, see [Development](#development).

## Development

```bash
npm install
npm run build      # or: npm run watch
```

Press **F5** in VS Code ("Run Mongoster") to open an Extension Development Host window.

To build an installable package:

```bash
npm run package    # creates mongoster-<version>.vsix
code --install-extension mongoster-0.2.0.vsix
```

The desktop app:

```bash
npm run app            # builds and starts the app (npm run watch:app rebuilds on changes)
npm run package:app    # creates the installer for this system in release/
```

An installer is built on the system it is for (a macOS disk image can only be made on macOS), so the `Desktop app` workflow (`.github/workflows/app.yml`) builds the three of them on GitHub Actions: on every pull request and on demand they are kept as artifacts of the run, and on a `v*` tag they are attached to the release of that tag. The macOS and Windows builds are not signed with a certificate yet: the systems warn about it the first time the app is opened.

`npm run typecheck` checks the code twice: against VS Code's API and against the app's implementation of it.

## Structure

- `src/extension.ts` – activation and commands
- `src/standalone/` – the desktop app. The extension's code runs unchanged in Electron's main process: `vscode/` implements the part of VS Code's API that Mongoster uses (the app's build resolves `import 'vscode'` to it) and reads menus, commands, keybindings and settings from the `contributes` of `package.json`; `main.ts` is the entry point (window, menu bar, the `mongoster-app://` protocol that serves the window and the webviews); `shell/` is the window (tree, tabs, Monaco editors, quick picks, notifications, settings); `protocol.ts` has the messages between the two; `theme.ts` the dark and light colors. `electron-builder.yml` and `build/` are for the installers
- `src/themeColors.ts`, `src/shared/tokenColors.ts`, `src/webview/tokenColors.ts` – syntax colors of the active theme (its file, its includes and `editor.tokenColorCustomizations`) sent to the webviews
- `src/connections.ts` – saved connections and the `MongoClient` cache
- `src/mcpServer.ts`, `src/mcpTools.ts`, `src/shared/mcp.ts` – MCP server for AI assistants: HTTP on `127.0.0.1` with a bearer token, JSON-RPC, the read-only tools, the VS Code provider for Copilot
- `src/transport.ts` – TLS options and SSH tunnel (`ssh2`) with host key verification
- `src/connectionEditor.ts`, `src/webview/connectionEditor.ts`, `media/connectionEditor.css` – connection form (TLS, SSH, test)
- `src/tree.ts` – connections/databases/collections tree
- `src/collectionPanel.ts` – webview for a collection, running queries
- `src/queryHistory.ts` – history and saved queries per collection
- `src/documentFs.ts` – `mongoster://` virtual file system to open, edit and save documents
- `src/definitionFs.ts` – `mongoster-def://` virtual file system for view definitions and validation rules
- `src/monitor.ts`, `src/webview/monitor.ts`, `media/monitor.css` – server monitor: operations in progress, profiler, stats, replica set and oplog
- `src/advisor.ts`, `src/shared/advisor.ts`, `src/webview/advisor.ts`, `media/advisor.css` – index advisor: indexes to create, redundant, unused
- `src/watch.ts`, `src/webview/watch.ts`, `media/watch.css` – change streams of a collection, a database or a connection
- `src/search.ts`, `src/webview/search.ts`, `media/search.css` – global search in any field of the documents
- `src/relations.ts`, `src/shared/relations.ts`, `src/webview/diagram.ts`, `media/diagram.css` – relationship diagram: sampling, verified references, layout, Mermaid and SVG export
- `src/playground/` – playground: script rewriting (`rewrite.ts`, with `acorn`), mongosh-style runtime (`shell.ts`), cursor context for autocomplete (`context.ts`), commands, CodeLens and completion (`playground.ts`), result tab (`resultPanel.ts`, `src/webview/playground.ts`, `media/playground.css`)
- `src/queries.ts` – filter and pipeline text → driver arguments
- `src/transfer.ts` – export (JSON, JSON Lines, CSV) and import
- `src/manage.ts` – creating, renaming and dropping databases and collections
- `src/copy.ts` – copying a collection to another database or another connection
- `src/backup.ts` – backup and restore in the mongodump format (`.bson` + `.metadata.json`, also gzip)
- `src/history.ts`, `src/webview/undoHistory.ts`, `media/undoHistory.css` – undo history: documents saved on disk within the limits, undo and the `Undo History` tab
- `src/compare.ts`, `src/webview/compare.ts`, `media/compare.css` – comparing two collections by `_id` and aligning one side with the other
- `src/shared/query.ts` – parsing/formatting mongosh syntax ⇄ EJSON
- `src/shared/builder.ts`, `src/webview/builder.ts` – visual query builder: field/operator/value rows ⇄ filter
- `src/shared/columns.ts` – model of the columns (nested and arrays) and of the user's layout, used by the table and by CSV
- `src/shared/csv.ts` – CSV generation and parsing
- `src/shared/pipeline.ts` – aggregation stage model, templates and text ⇄ stages conversion
- `src/shared/explain.ts` – summary of the explain output and index suggestion
- `src/indexes.ts`, `src/shared/indexes.ts` – indexes of a collection: definition, size, usage and builds in progress; creating them, and changing them in place or by dropping and recreating
- `src/shared/schema.ts` – schema analysis of a sample of documents and generated `$jsonSchema`
- `src/shared/complete.ts` – autocomplete: cursor context in mongosh text, suggested fields, operators and values
- `src/shared/compare.ts` – when two documents are equal (field order, numeric types, ignored fields) and field-by-field differences
- `src/gridfs.ts`, `src/webview/gridfs.ts`, `media/gridfs.css`, `src/shared/gridfs.ts` – GridFS buckets: listing, preview, upload, download, renaming and deleting files
- `src/users.ts`, `src/webview/users.ts`, `media/users.css` – users and roles: listing, creation, passwords, granted and revoked roles, custom roles
- `src/replication.ts` – replica set members with their lag and oplog entries (fields changed by an update, operations of a transaction)
- `src/shared/profile.ts` – slow operations from the profiler or the server log: query shape, grouping and suggested index
- `src/shared/codegen.ts`, `src/webview/codeDialog.ts` – queries and pipelines as code for mongosh and the drivers (Node.js, Python, Java, C#, Go)
- `src/shared/chart.ts`, `src/webview/chartView.ts`, `src/webview/chartjs.ts` – chart pipelines and their results as series; drawing with Chart.js, loaded only when the `Chart` tab is opened
- `src/webview/main.ts`, `src/webview/history.ts`, `src/webview/pipeline.ts`, `src/webview/indexes.ts`, `src/webview/indexDialog.ts`, `src/webview/explainView.ts`, `src/webview/bulk.ts`, `src/webview/schemaView.ts`, `src/webview/columnsUi.ts`, `src/webview/autocomplete.ts`, `media/webview.css` – UI of the table, history, pipeline editor, indexes, explain, update/delete many, schema, columns and suggestions
