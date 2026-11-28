# The catalog of features

Every feature, one card each, 171 in all. The template and the rules of the cards are in the
feature contract. This index is written by `catalog.py --index`: change a status here in the commit that
earns it, and run the script again after adding or renaming a card; the statuses are kept. A card with a
**Differs** line is *Differs*; when the line goes, it becomes *Documented*.

| File | Area | Cards |
| --- | --- | --- |
| [01-connections.md](01-connections.md) | Connections | 30 |
| [02-tree.md](02-tree.md) | The connections view | 10 |
| [03-collection-tab.md](03-collection-tab.md) | The collection tab | 11 |
| [04-documents.md](04-documents.md) | Writing documents | 15 |
| [05-field-actions.md](05-field-actions.md) | Actions on a column | 10 |
| [06-databases.md](06-databases.md) | Databases and collections | 9 |
| [07-undo.md](07-undo.md) | Undo history | 16 |
| [08-redis-oplog.md](08-redis-oplog.md) | redis-oplog | 7 |
| [09-transfer.md](09-transfer.md) | Transfer | 9 |
| [10-backup.md](10-backup.md) | Backup | 5 |
| [11-scheduled-tasks.md](11-scheduled-tasks.md) | Scheduled tasks | 13 |
| [12-mcp.md](12-mcp.md) | The MCP server | 16 |
| [13-compare.md](13-compare.md) | Comparing collections | 3 |
| [14-structure.md](14-structure.md) | Comparing database structures | 3 |
| [15-indexes.md](15-indexes.md) | Indexes | 11 |
| [26-settings.md](26-settings.md) | Settings | 3 |

## Connections

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`connection.add`](01-connections.md#connectionadd--add-a-connection-with-its-connection-string) | Add a connection with its connection string | Operation | Documented |
| [`connection.edit`](01-connections.md#connectionedit--edit-the-connection-string-and-the-name) | Edit the connection string and the name | Operation | Documented |
| [`connection.form`](01-connections.md#connectionform--the-connection-form) | The connection form | View | Differs |
| [`connection.test`](01-connections.md#connectiontest--test-the-connection) | Test the connection | Read | Documented |
| [`connection.save`](01-connections.md#connectionsave--save-the-connection-form) | Save the connection form | Operation | Documented |
| [`connection.copy-string`](01-connections.md#connectioncopy-string--copy-the-connection-string) | Copy the connection string | Read | Documented |
| [`connection.paste`](01-connections.md#connectionpaste--paste-a-connection-as-a-second-connection) | Paste a connection as a second connection | Operation | Specified |
| [`connection.connect`](01-connections.md#connectionconnect--connect-a-connection) | Connect a connection | Operation | Documented |
| [`connection.disconnect`](01-connections.md#connectiondisconnect--disconnect) | Disconnect | Operation | Documented |
| [`connection.remove`](01-connections.md#connectionremove--remove-a-connection) | Remove a connection | Operation | Differs |
| [`connection.set-color`](01-connections.md#connectionset-color--set-the-color-of-a-connection) | Set the color of a connection | Operation | Differs |
| [`connection.custom-color`](01-connections.md#connectioncustom-color--choose-a-custom-color) | Choose a custom color | View | Specified |
| [`connection.move-to-folder`](01-connections.md#connectionmove-to-folder--move-a-connection-to-a-folder) | Move a connection to a folder | Operation | Documented |
| [`connection.rename-folder`](01-connections.md#connectionrename-folder--rename-a-folder) | Rename a folder | Operation | Documented |
| [`connection.remove-folder`](01-connections.md#connectionremove-folder--remove-a-folder-keeping-its-connections) | Remove a folder, keeping its connections | Operation | Documented |
| [`connection.read-only`](01-connections.md#connectionread-only--make-a-connection-read-only) | Make a connection read-only | Operation | Differs |
| [`connection.allow-changes`](01-connections.md#connectionallow-changes--allow-changes-through-a-read-only-connection) | Allow changes through a read-only connection | Operation | Documented |
| [`connection.trust-host-key`](01-connections.md#connectiontrust-host-key--confirm-the-host-key-of-an-ssh-server) | Confirm the host key of an SSH server | Operation | Documented |
| [`connection.secrets`](01-connections.md#connectionsecrets--keep-the-secrets-of-a-connection) | Keep the secrets of a connection | Operation | Differs |
| [`connection.import`](01-connections.md#connectionimport--import-connections) | Import connections | Operation | Documented |
| [`connection.export`](01-connections.md#connectionexport--export-connections) | Export connections | Operation | Differs |
| [`connection.read-file`](01-connections.md#connectionread-file--read-a-connections-file) | Read a connections file | Derivation | Documented |
| [`connection.read-list`](01-connections.md#connectionread-list--read-a-list-of-connection-strings) | Read a list of connection strings | Derivation | Documented |
| [`connection.read-compass`](01-connections.md#connectionread-compass--read-a-mongodb-compass-export) | Read a MongoDB Compass export | Derivation | Documented |
| [`connection.write-file`](01-connections.md#connectionwrite-file--write-a-connections-file) | Write a connections file | Derivation | Documented |
| [`connection.encryption`](01-connections.md#connectionencryption--encrypt-the-passwords-of-a-file-as-compass-does) | Encrypt the passwords of a file as Compass does | Derivation | Documented |
| [`connection.tls-in-uri`](01-connections.md#connectiontls-in-uri--tls-settings-in-and-out-of-a-connection-string) | TLS settings in and out of a connection string | Derivation | Documented |
| [`connection.color-from-compass`](01-connections.md#connectioncolor-from-compass--the-closest-color-of-a-compass-connection) | The closest color of a Compass connection | Derivation | Documented |
| [`connection.nearest-preset`](01-connections.md#connectionnearest-preset--the-preset-a-custom-color-shows-as) | The preset a custom color shows as | Derivation | Specified |
| [`connection.ssh-tunnel-target`](01-connections.md#connectionssh-tunnel-target--where-the-ssh-tunnel-leads) | Where the SSH tunnel leads | Derivation | Documented |

## The connections view

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`tree.set-collection-color`](02-tree.md#treeset-collection-color--set-the-color-of-a-collection-a-view-or-a-bucket) | Set the color of a collection, a view or a bucket | Operation | Built |
| [`tree.set-database-color`](02-tree.md#treeset-database-color--set-the-color-of-a-database) | Set the color of a database | Operation | Built |
| [`tree.color-of-collection`](02-tree.md#treecolor-of-collection--which-color-something-of-a-database-or-a-collection-takes) | Which color something of a database or a collection takes | Derivation | Built |
| [`tree.collection-color-follows`](02-tree.md#treecollection-color-follows--a-collections-color-follows-a-rename-and-goes-with-a-drop) | A collection's color follows a rename and goes with a drop | Operation | Built |
| [`tree.exclude`](02-tree.md#treeexclude--exclude-from-searches-or-include-again) | Exclude from searches, or include again | Operation | Specified |
| [`tree.excluded`](02-tree.md#treeexcluded--what-searches-leave-out) | What searches leave out | Derivation | Specified |
| [`tree.exclusion-follows`](02-tree.md#treeexclusion-follows--an-exclusion-follows-a-rename-and-goes-with-a-drop) | An exclusion follows a rename and goes with a drop | Operation | Specified |
| [`tree.type-ahead`](02-tree.md#treetype-ahead--move-to-a-node-by-typing-its-first-letters) | Move to a node by typing its first letters | Derivation | Specified |
| [`tree.copy`](02-tree.md#treecopy--copy-connections-databases-or-collections) | Copy connections, databases or collections | Operation | Specified |
| [`tree.paste-plan`](02-tree.md#treepaste-plan--what-a-paste-does-with-each-collection) | What a paste does with each collection | Derivation | Specified |

## The collection tab

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`query.format-rules`](03-collection-tab.md#queryformat-rules--add-edit-name-reorder-move-between-scopes-and-turn-off-formatting-rules) | Add, edit, name, reorder, move between scopes and turn off formatting rules | Operation | Built |
| [`query.format-transfer`](03-collection-tab.md#queryformat-transfer--export-formatting-rules-to-a-file-and-import-them) | Export formatting rules to a file and import them | Operation | Specified |
| [`query.format-table`](03-collection-tab.md#queryformat-table--color-the-table-by-the-formatting-rules) | Color the table by the formatting rules | View | Built |
| [`query.format-field`](03-collection-tab.md#queryformat-field--the-color-a-field-rule-gives-a-value) | The color a field rule gives a value | Derivation | Specified |
| [`query.match`](03-collection-tab.md#querymatch--match-a-document-against-a-filter) | Match a document against a filter | Derivation | Built |
| [`query.pane`](03-collection-tab.md#querypane--put-the-query-above-or-beside-the-results) | Put the query above or beside the results | Operation | Built |
| [`query.drop-options`](03-collection-tab.md#querydrop-options--drop-a-header-or-a-cell-on-sort-or-project) | Drop a header or a cell on Sort or Project | Derivation | Built |
| [`query.project-visible`](03-collection-tab.md#queryproject-visible--put-the-visible-columns-into-project) | Put the visible columns into Project | Derivation | Built |
| [`query.timeout`](03-collection-tab.md#querytimeout--the-time-limit-of-a-query) | The time limit of a query | Derivation | Built |
| [`query.cancel`](03-collection-tab.md#querycancel--cancel-a-running-query) | Cancel a running query | Operation | Built |
| [`query.find-options`](03-collection-tab.md#queryfind-options--the-collation-and-the-hint-of-a-find) | The collation and the hint of a find | Derivation | Built |

## Writing documents

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`document.inline-edit`](04-documents.md#documentinline-edit--edit-a-value-in-its-cell) | Edit a value in its cell | Operation | Documented |
| [`document.keep-numeric-types`](04-documents.md#documentkeep-numeric-types--keep-the-numeric-type-of-an-edited-value) | Keep the numeric type of an edited value | Derivation | Differs |
| [`document.dialog`](04-documents.md#documentdialog--the-document-dialog) | The document dialog | View | Documented |
| [`document.edit-in-editor`](04-documents.md#documentedit-in-editor--edit-a-document-in-an-editor-tab) | Edit a document in an editor tab | Operation | Differs |
| [`document.insert`](04-documents.md#documentinsert--insert-documents-from-the-insert-dialog) | Insert documents from the insert dialog | Operation | Differs |
| [`document.parse-insert-text`](04-documents.md#documentparse-insert-text--read-the-documents-of-the-insert-dialog) | Read the documents of the insert dialog | Derivation | Documented |
| [`document.insert-template`](04-documents.md#documentinsert-template--template-of-the-insert-dialog) | Template of the insert dialog | Derivation | Documented |
| [`document.insert-in-editor`](04-documents.md#documentinsert-in-editor--insert-a-document-from-an-editor-tab) | Insert a document from an editor tab | Operation | Documented |
| [`document.duplicate`](04-documents.md#documentduplicate--duplicate-a-document) | Duplicate a document | View | Differs |
| [`document.delete`](04-documents.md#documentdelete--delete-a-document) | Delete a document | Operation | Differs |
| [`document.delete-selected`](04-documents.md#documentdelete-selected--delete-the-selected-rows) | Delete the selected rows | Operation | Documented |
| [`document.update-selected`](04-documents.md#documentupdate-selected--update-the-selected-rows) | Update the selected rows | View | Documented |
| [`document.update-many`](04-documents.md#documentupdate-many--update-many) | Update many | Operation | Differs |
| [`document.delete-many`](04-documents.md#documentdelete-many--delete-many) | Delete many | Operation | Differs |
| [`document.restore-version`](04-documents.md#documentrestore-version--restore-a-version-from-the-document-history) | Restore a version from the document history | Operation | Documented |

## Actions on a column

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`field.rename`](05-field-actions.md#fieldrename--rename-a-field) | Rename a field | Operation | Documented |
| [`field.remove`](05-field-actions.md#fieldremove--remove-a-field) | Remove a field | Operation | Documented |
| [`field.convert-type`](05-field-actions.md#fieldconvert-type--convert-the-type-of-a-field) | Convert the type of a field | Operation | Documented |
| [`field.path-rules`](05-field-actions.md#fieldpath-rules--which-fields-a-column-action-can-change) | Which fields a column action can change | Derivation | Documented |
| [`field.array-guard`](05-field-actions.md#fieldarray-guard--leave-out-the-documents-where-a-parent-is-an-array) | Leave out the documents where a parent is an array | Derivation | Documented |
| [`field.rename-plan`](05-field-actions.md#fieldrename-plan--which-documents-a-rename-touches) | Which documents a rename touches | Derivation | Documented |
| [`field.remove-plan`](05-field-actions.md#fieldremove-plan--which-documents-a-removal-touches) | Which documents a removal touches | Derivation | Documented |
| [`field.convert-plan`](05-field-actions.md#fieldconvert-plan--which-values-a-conversion-touches) | Which values a conversion touches | Derivation | Documented |
| [`field.type-counts`](05-field-actions.md#fieldtype-counts--the-current-types-of-a-field) | The current types of a field | Derivation | Documented |
| [`field.layout-follows`](05-field-actions.md#fieldlayout-follows--the-column-follows-a-renamed-or-removed-field) | The column follows a renamed or removed field | Derivation | Documented |

## Databases and collections

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`manage.create-database`](06-databases.md#managecreate-database--create-a-database) | Create a database | Operation | Documented |
| [`manage.create-collection`](06-databases.md#managecreate-collection--create-a-collection) | Create a collection | Operation | Documented |
| [`manage.rename-collection`](06-databases.md#managerename-collection--rename-a-collection) | Rename a collection | Operation | Documented |
| [`manage.drop-collection`](06-databases.md#managedrop-collection--drop-a-collection-or-a-view) | Drop a collection or a view | Operation | Documented |
| [`manage.drop-database`](06-databases.md#managedrop-database--drop-a-database) | Drop a database | Operation | Documented |
| [`manage.name-rules`](06-databases.md#managename-rules--valid-names-of-databases-and-collections) | Valid names of databases and collections | Derivation | Documented |
| [`manage.edit-view`](06-databases.md#manageedit-view--edit-a-views-definition) | Edit a view's definition | Operation | Differs |
| [`manage.edit-validation`](06-databases.md#manageedit-validation--edit-a-collections-validation-rules) | Edit a collection's validation rules | Operation | Differs |
| [`manage.generate-json-schema`](06-databases.md#managegenerate-json-schema--the-jsonschema-proposed-from-a-sample) | The `$jsonSchema` proposed from a sample | Derivation | Documented |

## Undo history

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`undo.record`](07-undo.md#undorecord--record-an-operation-before-a-write) | Record an operation before a write | Operation | Differs |
| [`undo.kept-documents`](07-undo.md#undokept-documents--which-documents-an-operation-keeps) | Which documents an operation keeps | Derivation | Documented |
| [`undo.show`](07-undo.md#undoshow--the-undo-history-tab) | The Undo History tab | View | Documented |
| [`undo.details`](07-undo.md#undodetails--what-undoing-an-operation-would-do) | What undoing an operation would do | Read | Documented |
| [`undo.changed-since`](07-undo.md#undochanged-since--which-documents-changed-since-the-operation) | Which documents changed since the operation | Derivation | Documented |
| [`undo.revert`](07-undo.md#undorevert--undo-an-operation) | Undo an operation | Operation | Differs |
| [`undo.revert-plan`](07-undo.md#undorevert-plan--what-undo-does-to-each-document) | What undo does to each document | Derivation | Documented |
| [`undo.notification`](07-undo.md#undonotification--undo-from-a-writes-notification) | Undo from a write's notification | View | Documented |
| [`undo.last`](07-undo.md#undolast--undo-last-change) | Undo Last Change | Operation | Documented |
| [`undo.clear`](07-undo.md#undoclear--clear-the-undo-history) | Clear the undo history | Operation | Documented |
| [`undo.remove`](07-undo.md#undoremove--remove-one-operation) | Remove one operation | Operation | Documented |
| [`undo.limits`](07-undo.md#undolimits--limits-and-pruning) | Limits and pruning | Operation | Differs |
| [`undo.prune-order`](07-undo.md#undoprune-order--which-operations-the-limits-keep) | Which operations the limits keep | Derivation | Documented |
| [`undo.writes-of`](07-undo.md#undowrites-of--mongosters-writes-to-one-document) | Mongoster's writes to one document | Derivation | Documented |
| [`undo.per-connection`](07-undo.md#undoper-connection--stop-or-keep-the-undo-history-of-a-connection) | Stop or keep the undo history of a connection | Operation | Documented |
| [`undo.forget-connection`](07-undo.md#undoforget-connection--removing-a-connection-deletes-its-operations) | Removing a connection deletes its operations | Operation | Documented |

## redis-oplog

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`oplog.publish`](08-redis-oplog.md#oplogpublish--publish-the-events-of-a-write-to-redis) | Publish the events of a write to Redis | Operation | Differs |
| [`oplog.scope`](08-redis-oplog.md#oplogscope--which-databases-and-collections-publish) | Which databases and collections publish | Derivation | Documented |
| [`oplog.message`](08-redis-oplog.md#oplogmessage--the-event-of-a-document-and-its-channels) | The event of a document and its channels | Derivation | Documented |
| [`oplog.updated-fields`](08-redis-oplog.md#oplogupdated-fields--the-fields-an-update-changes) | The fields an update changes | Derivation | Documented |
| [`oplog.changes`](08-redis-oplog.md#oplogchanges--the-events-of-a-write-from-the-documents-before-and-after) | The events of a write from the documents before and after | Derivation | Documented |
| [`oplog.playground-writes`](08-redis-oplog.md#oplogplayground-writes--publish-the-playgrounds-writes) | Publish the playground's writes | Operation | Documented |
| [`oplog.publish-error`](08-redis-oplog.md#oplogpublish-error--the-warning-when-redis-fails) | The warning when Redis fails | View | Documented |

## Transfer

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`transfer.export`](09-transfer.md#transferexport--export-documents-to-a-file) | Export documents to a file | Operation | Differs |
| [`transfer.csv-write`](09-transfer.md#transfercsv-write--documents-as-csv) | Documents as CSV | Derivation | Documented |
| [`transfer.import`](09-transfer.md#transferimport--import-documents-from-a-file) | Import documents from a file | Operation | Differs |
| [`transfer.import-files`](09-transfer.md#transferimport-files--what-an-import-file-holds) | What an import file holds | Derivation | Documented |
| [`transfer.csv-read`](09-transfer.md#transfercsv-read--csv-rows-as-documents) | CSV rows as documents | Derivation | Documented |
| [`transfer.copy-collection`](09-transfer.md#transfercopy-collection--copy-a-collection-to-another-database-or-connection) | Copy a collection to another database or connection | Operation | Differs |
| [`transfer.paste`](09-transfer.md#transferpaste--paste-a-database-collections-or-views) | Paste a database, collections or views | Operation | Differs |
| [`transfer.generate`](09-transfer.md#transfergenerate--generate-test-documents) | Generate test documents | Operation | Differs |
| [`transfer.generate-values`](09-transfer.md#transfergenerate-values--fake-documents-from-a-schema-analysis) | Fake documents from a schema analysis | Derivation | Documented |

## Backup

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`backup.create`](10-backup.md#backupcreate--back-up-a-connection-a-database-or-a-collection) | Back up a connection, a database or a collection | Operation | Documented |
| [`backup.restore`](10-backup.md#backuprestore--restore-from-a-backup) | Restore from a backup | Operation | Differs |
| [`backup.archive-write`](10-backup.md#backuparchive-write--writing-a-mongodump-archive) | Writing a mongodump archive | Derivation | Documented |
| [`backup.archive-read`](10-backup.md#backuparchive-read--reading-a-mongodump-archive) | Reading a mongodump archive | Derivation | Documented |
| [`backup.folder-layout`](10-backup.md#backupfolder-layout--backup-folders-and-their-files) | Backup folders and their files | Derivation | Documented |

## Scheduled tasks

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`task.show`](11-scheduled-tasks.md#taskshow--the-scheduled-tasks-tab) | The Scheduled Tasks tab | View | Documented |
| [`task.edit`](11-scheduled-tasks.md#taskedit--create-or-edit-a-task) | Create or edit a task | Operation | Documented |
| [`task.next-runs`](11-scheduled-tasks.md#tasknext-runs--when-a-task-runs) | When a task runs | Derivation | Documented |
| [`task.due`](11-scheduled-tasks.md#taskdue--due-and-missed-runs) | Due and missed runs | Derivation | Documented |
| [`task.file-names`](11-scheduled-tasks.md#taskfile-names--the-names-of-what-a-run-writes) | The names of what a run writes | Derivation | Documented |
| [`task.run`](11-scheduled-tasks.md#taskrun--run-a-task) | Run a task | Operation | Documented |
| [`task.retention`](11-scheduled-tasks.md#taskretention--keep-the-last-n-outputs) | Keep the last N outputs | Operation | Documented |
| [`task.missed`](11-scheduled-tasks.md#taskmissed--runs-missed-while-mongoster-was-closed) | Runs missed while Mongoster was closed | Operation | Documented |
| [`task.enable`](11-scheduled-tasks.md#taskenable--enable-or-disable-a-task) | Enable or disable a task | Operation | Documented |
| [`task.delete`](11-scheduled-tasks.md#taskdelete--delete-a-task) | Delete a task | Operation | Documented |
| [`task.one-window`](11-scheduled-tasks.md#taskone-window--a-task-runs-in-one-window-only) | A task runs in one window only | Operation | Documented |
| [`task.notify`](11-scheduled-tasks.md#tasknotify--notifications-of-runs) | Notifications of runs | View | Documented |
| [`task.tray`](11-scheduled-tasks.md#tasktray--keep-the-desktop-app-running-in-the-tray) | Keep the desktop app running in the tray | View | Documented |

## The MCP server

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`mcp.server`](12-mcp.md#mcpserver--run-the-mcp-server-on-127001) | Run the MCP server on 127.0.0.1 | Operation | Documented |
| [`mcp.access-token`](12-mcp.md#mcpaccess-token--generate-a-new-access-token) | Generate a new access token | Operation | Documented |
| [`mcp.setup`](12-mcp.md#mcpsetup--set-up-mcp-server-for-ai-assistants) | Set Up MCP Server for AI Assistants… | Operation | Documented |
| [`mcp.change-port`](12-mcp.md#mcpchange-port--change-mcp-server-port) | Change MCP Server Port… | Operation | Documented |
| [`mcp.read-documents`](12-mcp.md#mcpread-documents--the-tools-offered-without-reading-documents) | The tools offered without reading documents | Derivation | Documented |
| [`mcp.protocol`](12-mcp.md#mcpprotocol--answer-a-message-of-the-model-context-protocol) | Answer a message of the Model Context Protocol | Derivation | Documented |
| [`mcp.arguments`](12-mcp.md#mcparguments--read-the-arguments-of-a-tool) | Read the arguments of a tool | Derivation | Documented |
| [`mcp.output-limits`](12-mcp.md#mcpoutput-limits--bound-what-a-tool-returns-and-how-long-it-runs) | Bound what a tool returns and how long it runs | Derivation | Differs |
| [`mcp.refuse-write-stages`](12-mcp.md#mcprefuse-write-stages--refuse-pipelines-that-write-are-not-a-plain-read-or-read-a-system-collection) | Refuse pipelines that write, are not a plain read, or read a system collection | Derivation | Documented |
| [`mcp.log`](12-mcp.md#mcplog--the-mongoster-mcp-output-channel) | The Mongoster MCP output channel | View | Documented |
| [`mcp.data-tools`](12-mcp.md#mcpdata-tools--explore-the-connections-and-read-documents) | Explore the connections and read documents | Read | Documented |
| [`mcp.debugging-tools`](12-mcp.md#mcpdebugging-tools--follow-what-an-application-writes) | Follow what an application writes | Read | Documented |
| [`mcp.performance-tools`](12-mcp.md#mcpperformance-tools--find-what-makes-a-database-slow) | Find what makes a database slow | Read | Documented |
| [`mcp.deployment-tools`](12-mcp.md#mcpdeployment-tools--read-the-state-of-the-deployment) | Read the state of the deployment | Read | Documented |
| [`mcp.data-model-tools`](12-mcp.md#mcpdata-model-tools--answer-quick-questions-about-the-data-model) | Answer quick questions about the data model | Read | Documented |
| [`mcp.tab-tools`](12-mcp.md#mcptab-tools--open-mongosters-tabs-for-the-user) | Open Mongoster's tabs for the user | Read | Documented |

## Comparing collections

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`compare.copy-document`](13-compare.md#comparecopy-document--copy-one-document-to-the-other-side) | Copy one document to the other side | Operation | Differs |
| [`compare.make-like`](13-compare.md#comparemake-like--make-one-side-like-the-other) | Make one side like the other | Operation | Differs |
| [`compare.equality`](13-compare.md#compareequality--when-two-documents-are-equal) | When two documents are equal | Derivation | Documented |

## Comparing database structures

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`structure.apply`](14-structure.md#structureapply--apply-differences-to-the-right-database) | Apply differences to the right database | Operation | Documented |
| [`structure.steps`](14-structure.md#structuresteps--what-each-difference-takes) | What each difference takes | Derivation | Documented |
| [`structure.script`](14-structure.md#structurescript--the-script-that-makes-the-right-database-like-the-left-one) | The script that makes the right database like the left one | Derivation | Documented |

## Indexes

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`index.create`](15-indexes.md#indexcreate--create-an-index) | Create an index | Operation | Documented |
| [`index.duplicate`](15-indexes.md#indexduplicate--duplicate-an-index) | Duplicate an index | View | Documented |
| [`index.edit`](15-indexes.md#indexedit--edit-an-index) | Edit an index | Operation | Differs |
| [`index.hide`](15-indexes.md#indexhide--hide-or-unhide-an-index) | Hide or unhide an index | Operation | Documented |
| [`index.drop`](15-indexes.md#indexdrop--drop-an-index) | Drop an index | Operation | Differs |
| [`index.create-search`](15-indexes.md#indexcreate-search--create-a-search-index) | Create a search index | Operation | Documented |
| [`index.edit-search`](15-indexes.md#indexedit-search--change-a-search-indexs-definition) | Change a search index's definition | Operation | Documented |
| [`index.drop-search`](15-indexes.md#indexdrop-search--drop-a-search-index) | Drop a search index | Operation | Differs |
| [`index.change-plan`](15-indexes.md#indexchange-plan--what-changing-an-index-takes) | What changing an index takes | Derivation | Documented |
| [`index.wildcard-checks`](15-indexes.md#indexwildcard-checks--wildcards-written-wrong) | Wildcards written wrong | Derivation | Documented |
| [`index.search-checks`](15-indexes.md#indexsearch-checks--what-a-search-index-definition-is-refused-for) | What a search index definition is refused for | Derivation | Documented |

## Settings

| Feature | Title | Kind | Status |
| --- | --- | --- | --- |
| [`settings.read`](26-settings.md#settingsread--read-the-settings) | Read the settings | Read | Documented |
| [`settings.page`](26-settings.md#settingspage--the-desktop-apps-settings-tab) | The desktop app's Settings tab | View | Documented |
| [`settings.appearance`](26-settings.md#settingsappearance--the-desktop-apps-color-theme-and-layout) | The desktop app's color theme and layout | View | Specified |
