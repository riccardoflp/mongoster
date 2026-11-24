# Backup

Backing up connections, databases and collections, and restoring them, in mongodump's formats so that `mongodump` and
`mongorestore` read and write the same files: a single archive (`.agz`, `mongodump --archive --gzip`) or a folder with
a subfolder per database. The user's side is in the [README › Features](../../README.md#features), item **Backup and
restore**. Scheduled backups are in [11-scheduled-tasks.md](11-scheduled-tasks.md); exports in
[09-transfer.md](09-transfer.md).

### `backup.create` — Back up a connection, a database or a collection

Saves the chosen databases, the chosen collections of a database, or one collection or view to an archive or a folder,
which `mongorestore` and `Restore from Backup…` read back ([README › Backup and restore](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/backup.ts › Backups.backup`, which writes through `writeBackup`.
- **Implemented in**: `src/extension.ts` (`mongoster.backup`); in `src/backup.ts`: `backupDatabases`,
  `backupCollections`, `leaveOutUnsupported`, `backupTotals`, `archiveOf`, `dumpCollection`, `rawDocuments`,
  `collectionMetadata`, `mongorestoreCommand`, `uniquePath`; `src/backupNames.ts › backupFileName` (the names of the
  files and folders); `src/archive.ts` (`backup.archive-write`).
- **Entry points**: `mongoster.backup` **Back Up…** on a connection, a database, a collection or a view in the
  connections view. Hidden from the Command Palette (`when: false`); without a tree node it does nothing.
- **Offered when**: `viewItem =~ /^(connection|database)/` and `viewItem =~ /^(collection|view)/`, read-only
  connections included.
- **Asks**, each with the title `Back Up <what>: <step>` (`<what>` is the connection's name, the database, or
  `<database>.<collection>`):
  1. on a connection with more than one database: `databases`, all its databases except `admin`, `local` and `config`,
     all checked; on a database with more than one collection: `collections`, all except `system.*`, all checked, views
     marked `view`;
  2. `format`: **Archive (.agz)** (`a single gzipped file; restore with mongorestore --gzip --archive`), **Folder,
     compressed (gzip)** (`.bson.gz files; restore with mongorestore --gzip --dir`), **Folder, uncompressed** (`.bson
     files`);
  3. an archive: a save dialog `archive`, named `<what>_<YYYY-MM-DD_HH-MM-SS>.agz` (characters that can't be in a file
     name, and spaces, become `_`), filter `mongodump archive (gzip)`, button `Back Up`; a folder: an open dialog
     `folder`, button `Back Up Here`, in which a new folder `<what>_<YYYY-MM-DD_HH-MM-SS>` is created (`_2`, `_3`… if
     the name exists). Both start in the folder of the last backup (`globalState` `mongoster.backupFolder`), else the
     first workspace folder, else the home folder.
- **Reads**: `listDatabases`, `listCollections`, `listIndexes`, `buildInfo` (the server version in the archive's
  header), `estimatedDocumentCount()` of each collection for the progress, and the documents with `find({}, { raw:
  true, batchSize: 1000 })`, as stored, without decoding them.
- **Writes**: files only. An archive: the gzipped archive of `backup.archive-write`. A folder: per database a subfolder
  with `<collection>.metadata.json` and `<collection>.bson` (a view: the metadata only), or `.metadata.json.gz` and
  `.bson.gz`; the names of the database and of the collection are percent-encoded, so that every file is inside the
  backup's folder whatever they are called (`backup.folder-layout`).
- **Danger**: None. An archive replaces an existing file only after the save dialog's confirmation; a folder backup
  always writes a new folder.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone, and needs none: it writes files, not a database.
- **After**: `Backed up <what> (<n> collections, <n> documents, <size>) to <path> in <s> s.` with `Copy mongorestore
  Command` (copies `mongorestore --gzip --archive="<path>"`, `mongorestore --gzip --dir "<path>"` or `mongorestore --dir
  "<path>"`) and `Reveal File` / `Reveal Folder`. With time series collections left out it is a warning ending in `Time
  series collections aren't supported and were left out (use mongodump): <database>.<collection>, …`.
- **Refuses**: a connection that can't be reached: `Could not connect to <name>: <error>`; no databases: `<name> has
  no databases to back up.`; only time series collections: `Nothing to back up: time series collections aren't
  supported (use mongodump).`; nothing else: `Nothing to back up in <what>.`; an error before writing: `Backup failed:
  <error>`; while writing: `Backup of <what> failed: <error>`, and the incomplete archive or folder is deleted.
- **Uses**: `backup.archive-write`, `backup.folder-layout`.
- **Tested by**: `test/integration/backup.test.ts › backup to an .agz archive and restore › 'restores documents byte for
  byte, with their indexes, options and views'` (`archiveOf`); `test/integration/scheduledTasks.test.ts › scheduled
  tasks › 'backs up a database to archives, keeping the last two'`, `› 'backs up a collection to folders, deleting
  whole folders it wrote'`, `› 'deletes what it wrote so far when cancelled'` (`writeBackup` through `runTask`);
  `test/integration/backup.test.ts › backup to a folder and restore › 'keeps every file inside the backup folder,
  whatever the collections are called, and restores them by name'` (`writeBackup`); `Backups.backup`: none.

Acceptance:

- [ ] `Back Up…` on a connection with the databases `admin`, `shop` and `logs` offers `logs` and `shop`, both checked.
- [ ] An archive of `shop` restores with `mongorestore --gzip --archive="<path>"` and gives the same documents, byte
  for byte.
- [ ] A compressed folder backup of `shop.orders` writes `<what>_<date>_<time>/shop/orders.bson.gz` and
  `orders.metadata.json.gz`; an uncompressed one `orders.bson` and `orders.metadata.json`.
- [ ] A folder backup of a database with the collections `a/b`, `a\b`, `a:b`, `con` and `up/../../../escaped` writes
  two files per collection, all directly in the database's subfolder (`a%2Fb.bson`, `a%5Cb.bson`, `a%3Ab.bson`,
  `%63on.bson`, `up%2F..%2F..%2F..%2Fescaped.bson`), and nothing outside the backup's folder.
- [ ] A view gets only its `.metadata.json`, in a folder; in an archive it is listed and ended, without documents.
- [ ] A time series collection is left out, and the result is a warning naming it.
- [ ] The notification `Backing up <what>` says `<database>.<collection>: <n> documents` every 1,000 documents.
- [ ] `Cancel` stops after the current 1,000 documents, deletes the incomplete archive or folder, and says `Backup of
  <what> cancelled: the incomplete backup was deleted.`
- [ ] `Copy mongorestore Command` puts the command on the clipboard; `Reveal Folder` shows the new folder.
- [ ] The backup works on a read-only connection.

### `backup.restore` — Restore from a backup

Writes the collections of a backup, Mongoster's or mongodump's, archive or folder, back into a connection, a database
or a collection ([README › Backup and restore](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/backup.ts › Backups.restore`; each collection through `CollectionRestore` (`open`, `add`,
  `finish`).
- **Implemented in**: `src/extension.ts` (`mongoster.restore`); in `src/backup.ts`: `scanBackup`, `scanDatabase`,
  `scanArchive`, `readBson`, `readMetadata`, `refusedDatabase`, `collectionsReplacedByViews`; `src/backupNames.ts`
  (the names of a folder's collections and databases); `src/archive.ts` (`backup.archive-read`); `src/copy.ts ›
  COPIED_OPTIONS`; `src/manage.ts › databaseNameError`; `src/history.ts`.
- **Entry points**: `mongoster.restore` **Restore from Backup…** on a connection, a database or a collection in the
  connections view. Hidden from the Command Palette (`when: false`); without a tree node it does nothing.
- **Offered when**: on connections and databases of connections that are not read-only; on collections with
  `viewItem == collection` (not views, not read-only).
- **Asks**, each with the title `Restore into <where>: <step>`:
  - On a connection or a database:
    1. `backup`: **Archive** (`a single .agz or .archive file (mongodump --archive)`) or **Folder** (`a folder backup
       (mongodump --out), or the folder of one database`);
    2. the file (filters `mongodump archive`: `agz`, `archive`, `gz`, and `All files`) or the folder, button
       `Restore`, starting in the folder of the last backup;
    3. with more than one database in the backup: on a connection, `databases` (all checked), without those whose
       name the backup can't choose as a target: `admin`, `local` and `config` (`a system database`) and the names
       MongoDB refuses (`not a valid database name`), listed in the placeholder `Not offered: <database> (<why>), …`;
       with a single one left, the step is skipped; on a database, `database of the backup`, the one to restore into
       it, whatever its name;
    4. on a connection with one database chosen: `database`, the name to restore it under: its own by default, or
       empty, with `(its own name isn't proposed: <why>)` in the prompt, when that is a system database's or not valid;
    5. for each database with more than one collection: `collections of <database>`, all checked, with their size, or
       `view or metadata only`;
  - On a collection: a `.bson` or `.bson.gz` file (its `.metadata.json` or `.metadata.json.gz` next to it is used when
    there is one) or an archive (filters `BSON or archive (mongodump)` and `All files`); for an archive, the
    collection of the archive to restore into it (`collection of the archive`, the same name first), unless it has
    only one;
  - Then `existing collections`: **Add documents** (`documents whose _id already exists are kept and skipped`) or
    **Drop and restore** (`each collection is dropped first, like mongorestore --drop`);
  - Then the modal confirmation `Restore <n> collections into <connection> › <databases>?` with `From <path>.`, then
    `Existing collections with the same names are dropped first, with their documents and indexes: this can't be
    undone.` or `Documents are added; those whose _id already exists are skipped.`, and with Add documents while the
    undo history records, `It can be undone from the Undo History, for collections of up to <n> documents.`; with
    Drop and restore, when the backup has a view whose name is now a collection's, `The backup has a view in place of
    this collection, which is dropped with its documents: <database>.<collection>.` (`these collections, which are
    dropped with their documents: …` for several); when databases were left out at step 3, `Not restored: <database>
    (<why>), ….`; button `Restore`.
- **Reads**: the backup: an archive once from start to end, also when its collections alternate (`backup.archive-read`);
  a folder's `.bson` files one after the other; the metadata (options, indexes, type). With Drop and restore and views
  in what is restored, `listCollections` for each view's name, before the confirmation.
- **Writes**, per collection: with Drop and restore, `drop()` when it exists; when it doesn't exist (or was dropped),
  `createCollection(name, options)` with the options of `COPIED_OPTIONS`, or for a view `createCollection(name, {
  viewOn, pipeline[, collation] })`; then `insertMany(batch, { ordered: false, bypassDocumentValidation: true })` in
  batches of 1,000 documents or 8 MB, the documents decoded with `promoteValues: false` and `bsonRegExp: true`; then,
  unless cancelled, `createIndexes([spec])` for each index except `_id_` and a clustered one, and, on a collection
  that existed and was not dropped, except those with `expireAfterSeconds` (a TTL index would make the server delete
  documents the restore didn't bring), unless the collection already has one with the same key and delay.
- **Danger**: Confirm: the modal above. Destructive with Drop and restore: the existing collections' documents and
  indexes are lost, also those of a collection that a view of the backup replaces, which the confirmation names.
- **Read-only**: Refused on a read-only connection: `The connection <name> is read-only: nothing can be restored into
  it.`
- **Undo**: With Add documents, recorded in the undo history (`undo.record`), one operation per collection, `Restore
  <file>` (a folder) or `Restore <collection> from <archive>`, holding the `_id`s inserted; a collection of more than
  `mongoster.history.maxDocumentsPerOperation` documents is not recorded. With Drop and restore, not recorded, and the
  confirmation says `this can't be undone`. When the undo history is off for the connection, the confirmation says
  that it can't be undone (differs).
- **redis-oplog**: Not published (differs).
- **After**: `mongoster.refresh` refreshes the tree. `Restored <n> documents and <k> indexes in <c> collections into
  <connection> › <databases> in <s> s.`, followed by `<k> skipped (their _id already existed)`, `<f> failed: <first
  error>`, `Index not created — <collection>.<index>: <error>` (for a TTL index kept off an existing collection: `a
  TTL index (expireAfterSeconds) would make the server delete documents that were already in the collection; create it
  from the Indexes tab if it's wanted`), `Not restored: <database>.<collection> (<why>), <database> (<why>)` with the
  collections not restored and the databases left out (then a warning), and `Undo from the Undo History, one operation
  per collection` when more than one was recorded; `Undo` in the notification when exactly one was.
- **Refuses**: an archive that can't be read: `Can't read <file>: <error>`; one without collections: `<file> has no
  collections to restore.`; a folder without backup files: `No backup found in <folder>: expected <collection>.bson
  and <collection>.metadata.json files (mongodump), or a folder of them per database.`; on a connection, a backup of
  several databases none of which can be restored under its name: `Nothing of <file> is restored under the names it
  gives: <database> (<why>), …. To restore one of them, use Restore from Backup… on the database to restore it into.`;
  a view to restore with Drop and restore when the server can't be asked what it replaces: `Restore into <where>
  failed: <error>`; a time series collection (`a
  time series collection (use mongorestore)`) and, with Add documents, a view that exists (`a view that already
  exists`) are not restored; a damaged or truncated archive, or any error: `Restore into <where> failed: <error>[
  Restored before the error: <summary>.]`.
- **Settings**: `mongoster.history.enabled`, `mongoster.history.maxDocumentsPerOperation`.
- **Uses**: `backup.archive-read`, `backup.folder-layout`, `undo.record`, `undo.limits`, `connection.read-only`.
- **Tested by**: `test/integration/backup.test.ts › backup to an .agz archive and restore › 'restores documents byte for
  byte, with their indexes, options and views'`, `› 'skips documents whose _id already exists when restoring without
  dropping'` (`CollectionRestore`, `scanArchive`); `› backup to a folder and restore › 'keeps every file inside the
  backup folder, whatever the collections are called, and restores them by name'` (`scanBackup`, `readBson`,
  `CollectionRestore`); `› restore of a backup that is not trusted › "doesn't create a TTL index of the backup on a
  collection that was already there"`, `› 'says nothing of a TTL index the collection already has'`, `› 'creates the
  TTL indexes of a collection the restore creates, or drops first'`, `› 'tells which collections a view of the backup
  would replace'` (`collectionsReplacedByViews`); `test/unit/backupNames.test.ts › refusedDatabase › 'refuses the
  system databases and the names MongoDB refuses'`; `test/integration/scheduledTasks.test.ts` reads backups with
  `scanArchive` and `scanBackup`; `Backups.restore`: none.
- **Differs**: no `RedisOplog.sink(…)` is called in `src/backup.ts`, so Meteor apps don't see restored documents (the
  README lists restore among the writes not published). With Add documents and the undo history off for the
  connection (or `mongoster.history.enabled` off), the confirmation says nothing about undo (`src/backup.ts:886` adds a
  line only when it records), where the product promises that a confirmation says when a write can't be undone. An open
  tab of a restored collection is not refreshed: only the tree is (`src/backup.ts:980`).

Acceptance:

- [ ] An archive written by `mongodump --archive --gzip` and one written by `mongodump --archive` (not gzipped) are both
  recognized from their content, whatever their extension.
- [ ] A folder written by `mongodump --out` restores each database it holds; the folder of a single database restores
  that one.
- [ ] Every value comes back with its BSON type and bytes: `Int32`, `Double`, `-0.0`, `Int64`, `Decimal128`, dates,
  regular expressions, binary, UUIDs, timestamps, `MinKey`, `MaxKey`, code, dotted and `$` field names.
- [ ] With Add documents, a document whose `_id` exists keeps its current value and is counted as skipped.
- [ ] With Drop and restore, an existing collection is dropped and recreated with the backup's options, then its
  indexes are rebuilt after the documents.
- [ ] Documents that the collection's validation rules would reject are restored.
- [ ] An archive in which two collections alternate restores both completely, reading the file once.
- [ ] An archive whose checksum of a collection doesn't match stops with `Restore into <where> failed: <file> is
  damaged: the checksum of <database>.<collection> doesn't match its documents.`
- [ ] With Add documents, each restored collection is one operation of the undo history, and undoing it deletes the
  documents it added.
- [ ] `Cancel` stops after the current batch with `Restore into <where> cancelled after <summary>; those stay.`; no
  index is created for the collection being restored.
- [ ] On a read-only connection the command is not offered; run anyway it says `The connection <name> is read-only:
  nothing can be restored into it.`
- [ ] A folder backup whose collections are called `a/b`, `con` and `up/../../../escaped` lists them under those names
  and restores them into collections of those names; a folder written before the names were encoded, with
  `a:b.bson`, restores `a:b`.
- [ ] With Add documents, a backup whose metadata has a TTL index `at_ttl` for the existing collection `orders`
  creates its other indexes, keeps the documents that were there, and ends with the warning `Index not created —
  orders.at_ttl: a TTL index (expireAfterSeconds) would make the server delete documents that were already in the
  collection; create it from the Indexes tab if it's wanted`.
- [ ] The same backup creates `at_ttl` on a collection that didn't exist, with Drop and restore, and, without a
  warning, when `orders` already has a TTL index on the same key with the same delay.
- [ ] On a connection, a backup with the databases `admin`, `shop` and `logs` offers `logs` and `shop` with `Not
  offered: admin (a system database)`; the confirmation and the result say `Not restored: admin (a system database)`.
- [ ] On a connection, a backup of the only database `admin` asks for the `database` with an empty field: `Enter`
  alone restores nothing.
- [ ] `Restore from Backup…` on the database `scratch` restores the `admin` database of a backup into `scratch`.
- [ ] With Drop and restore, a backup with the view `orders` on a database where `orders` is a collection says in the
  confirmation `The backup has a view in place of this collection, which is dropped with its documents: shop.orders.`
- [ ] With the undo history off for the connection, the confirmation says that the restore can't be undone (differs).
- [ ] The restored documents are published to redis-oplog on a connection that publishes (differs).
- [ ] An open tab of a restored collection shows the restored documents (differs).

### `backup.archive-write` — Writing a mongodump archive

The bytes of an archive, as `mongodump --archive --gzip` writes them, so that `mongorestore` reads Mongoster's archives
([README › Backup and restore](../../README.md#features)).

- **Kind**: Derivation
- **Function**: `src/archive.ts › archivePrelude`, `› namespaceHeader`, `› Crc64`; `src/backup.ts › archiveOf`
  orders them.
- **Used by**: `backup.create`, `task.run`.
- **Tested by**: `test/unit/archive.test.ts › Crc64 › 'computes CRC-64/XZ (the ECMA polynomial of Go’s hash/crc64)'`,
  `› 'is zero for no data and the same when the data comes in pieces'`; `› archive write → read › 'reads back the
  collections of the prelude with their metadata'`, `› 'gives back every document byte for byte, then the end of each
  collection'`; `test/integration/backup.test.ts › backup to an .agz archive and restore › 'restores documents byte for
  byte, with their indexes, options and views'`.

Rules:

- The archive is, gzipped as a whole: the magic number `0x8199e26d` (4 bytes, little-endian); the header document `{
  concurrent_collections: 1, version: '0.1', server_version: <buildInfo.version or '0.0.0'>, tool_version: 'Mongoster'
  }`; one document per collection `{ db, collection, metadata: <canonical Extended JSON text>, size: 0, type }`; a
  terminator (`ff ff ff ff`).
- Then each collection in turn, never alternating: if it has documents, a namespace header `{ db, collection, EOF:
  false, CRC: 0 }`, its documents exactly as stored, a terminator; then, also for a view or an empty collection, an EOF
  header `{ db, collection, EOF: true, CRC: <checksum> }` and a terminator.
- The checksum is the CRC-64/XZ (ECMA polynomial, as Go's `hash/crc64`) of the bytes of all the collection's
  documents, as a signed int64; 0 for no documents.
- The metadata is that of `backup.folder-layout`.

Worked examples:

- The checksum of the 9 bytes `123456789` is `0x995dc9bbdf1939fa` (as a signed int64).
- The checksum of `hello, ` then `archive` equals that of `hello, archive`.

### `backup.archive-read` — Reading a mongodump archive

How an archive, Mongoster's or mongodump's, gzipped or not, is read: its list of collections, then its documents, in
one pass ([README › Backup and restore](../../README.md#features)).

- **Kind**: Derivation
- **Function**: `src/archive.ts › readArchiveCollections` (the list only), `› readArchive` (the documents and the end of
  each collection), through `parseArchive` and `bsonFrames`; `src/backup.ts › scanArchive` groups the list by
  database.
- **Used by**: `backup.restore`.
- **Tested by**: `test/unit/archive.test.ts › bsonFrames › 'splits documents across chunk boundaries'`, `› 'gives null
  for terminators only when asked to'`, `› 'rejects a truncated last document'`; `› archive write → read › 'reads back
  the collections of the prelude with their metadata'`, `› 'gives back every document byte for byte, then the end of
  each collection'`, `› 'reads a gzipped archive (.agz) the same way and counts the bytes read from the file'`, `›
  'accepts blocks of different collections that alternate, each checksummed over all its blocks'`; `› damaged archives
  › 'refuses a collection whose checksum does not match its documents'`, `› 'refuses a file that is not an archive,
  gzipped or not'`, `› 'reports where an archive is truncated'`.

Rules:

- Gzip is recognized from the first two bytes (`1f 8b`), not from the extension. The first 4 bytes after it must be
  the magic number, otherwise `<file> is not a mongodump archive (mongodump --archive, with or without --gzip).`
- After the header document, the collection documents until a terminator give the list: database, collection, metadata
  (canonical Extended JSON, so an int64 in a view's pipeline stays an int64) and type (`collection` when missing). In
  `scanArchive`, entries without a database (mongodump's `--oplog`) and `system.*` collections are left out.
- Then: a namespace header without `EOF` starts a block; the documents until the next terminator belong to it, each
  given byte for byte. Blocks of different collections may alternate. An `EOF` header ends a collection: the CRC-64 of
  all its documents, over all its blocks, must equal its `CRC`, when the header has one, otherwise `<file> is damaged:
  the checksum of <database>.<collection> doesn't match its documents.` A file that ends between two blocks, without
  the `EOF` header of a collection, is not reported: that collection's checksum is never checked.
- A document whose size is below 5 bytes or above 48 MB: `<file> is not a mongodump archive (invalid document at byte
  <n>).` The end of the file inside the list: `<file> is truncated: it ends in its list of collections.`; inside a
  block: `<file> is truncated: <database>.<collection> is incomplete.`; inside a document: `<file> is truncated: its
  last document is incomplete.`
- The documents are given as they are read: a restore has inserted those that came before a damaged collection's EOF
  header.
- The bytes read from the file (compressed) are counted, for the progress.

Worked examples:

- Blocks `a(x1, x2)`, `b(y)`, `a(z)`, EOF `b`, EOF `a` → documents `a, a, b, a`, then the ends `b`, `a`; the checksum of
  `a` is over `x1, x2, z`.
- The archive of `shop.things` (3 documents), `logs.events.2024` (1) and `shop.empty` (none) → `things` ×3, end of
  `things`, `events.2024`, its end, end of `empty`.
- A plain `.bson` file, or one gzipped, given as an archive → `… is not a mongodump archive`.

### `backup.folder-layout` — Backup folders and their files

What a backup folder holds and how a folder is recognized as one, the same as `mongodump --out` and `mongorestore
--dir` ([README › Backup and restore](../../README.md#features)).

- **Kind**: Derivation
- **Function**: `src/backup.ts › collectionMetadata` (writing), `› scanBackup` and `› scanDatabase` (reading),
  `› mongorestoreCommand`, `› uniquePath`; `src/backupNames.ts › backupFileName` (a name as a file's or folder's),
  `› backupCollectionName` and `› backupDatabaseName` (back).
- **Used by**: `backup.create`, `backup.restore`, `task.run`.
- **Tested by**: `test/integration/scheduledTasks.test.ts › scheduled tasks › 'backs up a collection to folders,
  deleting whole folders it wrote'` (`scanBackup`, `uniquePath`); `test/integration/backup.test.ts › backup to an .agz
  archive and restore › 'restores documents byte for byte, with their indexes, options and views'`
  (`collectionMetadata` through the archive); `› backup to a folder and restore › 'keeps every file inside the backup
  folder, whatever the collections are called, and restores them by name'`; `test/unit/backupNames.test.ts ›
  backupFileName › 'keeps ordinary names as they are'`, `› 'encodes what a path or a file system gives a meaning to'`,
  `› 'gives names that are a single, portable path component'`, `› 'gives different names to different collections'`,
  `› 'cuts a name that is too long, as mongodump does, never inside an escape'`; `› backupCollectionName › 'reads back
  every name that was written, with or without the metadata'`, `› 'reads the names of backups written before they were
  encoded'`, `› "reads mongodump's names, which encode fewer characters"`, `› 'keeps the name of a file whose metadata
  is of another collection'`; `› backupDatabaseName › 'decodes only what backupFileName writes'`; `› scanDatabase and
  scanBackup › 'lists the collections by their names, from encoded and from plain file names'`, `› 'leaves out system
  collections, whatever their file is called'`, `› 'decodes the database folders'`.

Rules:

- A backup is a folder with one subfolder per database. Each collection has `<name>.bson`, its documents as stored one
  after the other, and `<name>.metadata.json`; compressed, `<name>.bson.gz` and `<name>.metadata.json.gz`. A view has
  only the metadata.
- `<name>`, and the subfolder's name, is the collection's or the database's name as `backupFileName` gives it:
  letters, digits, `_`, `-` and `.` are kept, every other byte of its UTF-8 is `%XX` (`%` itself too); a dot at
  either end is `%2E`; the first letter of a name Windows reserves (`con`, `prn`, `aux`, `nul`, `com0`–`com9`,
  `lpt0`–`lpt9`, alone or before a dot) is encoded. A result longer than 238 characters is cut to its first 208 (never
  inside a `%XX`), followed by `%24` and the SHA-1 of the name in base64url (27 characters), as mongodump does: with
  `.metadata.json.gz` the file name stays within 255 bytes. So no name leaves its folder, and mongorestore decodes them.
- The metadata is canonical Extended JSON with the keys in mongodump's order: `options` (when there are any), `indexes`
  (without `ns`; none for a view), `uuid` (hexadecimal, when known), `collectionName`, `type`.
- Reading a folder: if it holds files named `<name>.bson[.gz]` or `<name>.metadata.json[.gz]` itself, it is the folder
  of one database named after it; otherwise each subfolder holding such files is a database. Collections whose name
  starts with `system.` are left out; collections and databases are sorted by name.
- The collection of a file: a `<name>` without `%` is the collection's name (also in backups written before the names
  were encoded). With a `%`, the `collectionName` of its metadata is the name when `<name>` is that name as it is
  (an earlier backup of a collection with a `%` in its name), encoded as above, percent-encoded in another way
  (mongodump), or cut with the hash of that name; otherwise, and without metadata, `<name>` is percent-decoded, or
  kept when it can't be.
- The database of a folder: its name, decoded only when it is exactly what `backupFileName` gives for the decoded
  name; any other folder (mongodump's, an earlier backup's) keeps its name.
- A new backup folder or a scheduled output never replaces something: when the name exists, `_2`, `_3`… is added before
  the extension.
- The command to restore: `mongorestore --gzip --archive="<file>"` for an archive, `mongorestore --gzip --dir
  "<folder>"` for a compressed folder, `mongorestore --dir "<folder>"` for an uncompressed one.

Worked examples:

- A folder `backup/` with `shop/orders.bson` and `shop/orders.metadata.json` → one database `shop` with the collection
  `orders`.
- A folder `shop/` with `orders.bson.gz` and `system.views.bson` → one database `shop` with `orders`.
- The collections `a/b`, `../x`, `con`, `nul.txt`, `%2e%2e` and `été` → the files `a%2Fb`, `%2E.%2Fx`, `%63on`,
  `%6Eul.txt`, `%252e%252e` and `%C3%A9t%C3%A9` (`.bson`, `.metadata.json`); `console` and `fs.files` stay as they are.
- `a%2Fb.bson` with the `collectionName` `a/b` → `a/b`; with the `collectionName` `a%2Fb` (an earlier backup) →
  `a%2Fb`; without metadata → `a/b`; `100%.bson` without metadata → `100%`.
- The folders `%6Eul` and `50%` → the databases `nul` and `50%`.
- `shop-orders-20261101` existing → the next is `shop-orders-20261101_2`.
