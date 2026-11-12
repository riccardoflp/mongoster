# Scheduled tasks

Backups and exports that run by themselves at set times while Mongoster is open: the Scheduled Tasks tab, the form of a
task, when a task runs (also across daylight saving changes), runs that were missed, how many outputs are kept, how
several VS Code windows share the tasks, the notifications, and the desktop app's tray icon. The user's side is in the
[README › Features](../../README.md#features), item **Scheduled tasks**, and in
[README › Desktop app](../../README.md#desktop-app). What a run writes is the backup of
[10-backup.md](10-backup.md) or the export of [09-transfer.md](09-transfer.md).

A task and its state are files in the extension's global storage folder, `scheduledTasks/` (the desktop app has its own
folder, so the app and VS Code don't share tasks):

| File | Holds |
| --- | --- |
| `tasks.json` | the tasks (`ScheduledTask`) |
| `<id>.json` | the state of a task (`TaskState`): the last scheduled time handled, the last 20 runs, the outputs it wrote |
| `<id>.lock` | held while a run of the task, or the recording of a missed run, is in progress (`task.one-window`) |
| `<id>.cancel` | asks the window running the task to cancel it |

### `task.show` — The Scheduled Tasks tab

Lists the tasks with when they run, the next run and the last result, and, for a task, its last 20 runs with their
files ([README › Scheduled tasks](../../README.md#features)).

- **Kind**: View
- **Function**: `src/scheduledTasks.ts › ScheduledTasksPanel.show`; the list is `src/scheduler.ts › Scheduler.list`.
- **Implemented in**: `src/extension.ts` (`mongoster.showScheduledTasks`, `mongoster.scheduleTask`);
  `src/webview/scheduledTasks.ts` (`render`, `runLog`); `src/shared/messages.ts` (`ScheduleHostMessage`,
  `ScheduleViewMessage`, `ScheduledTaskView`); `media/scheduledTasks.css`; `src/standalone/main.ts` (the `Tools` menu).
- **Entry points**: `mongoster.showScheduledTasks` **Show Scheduled Tasks**: Command Palette, the connections view's
  `…` menu, and the desktop app's `Tools` menu; `Show Scheduled Tasks` in the notifications of `task.notify`.
  `mongoster.scheduleTask` **Schedule…** opens the tab with a new task (`task.edit`).
- **Offered when**: always (`view == mongoster.connections` for the view's menu).
- **Reads**: the tasks and their states from the files above, again on every change the file system reports (after
  300 ms) and every 15 seconds; whether a run is going on in another window (`task.one-window`).
- **Tested by**: *none* (the tab); what it shows comes from `Scheduler.list`, covered by
  `test/integration/scheduledTasks.test.ts › two windows › 'runs a due task once, records it for both, and refuses a
  second run at the same time'`.

Acceptance:

- [ ] Without tasks the tab says `No scheduled tasks yet. New Task… (or Schedule… on a connection, a database or a
  collection) backs up or exports periodically.`
- [ ] The title bar shows `<n> tasks, <k> enabled` and the button `New Task…`.
- [ ] Each row has the enabled checkbox, the name with `Backup, Archive (.agz)` (or `Export, CSV`…), the source
  `<connection> › <database>.<collection>` (`<database> (all collections)`, `all databases`; `removed connection` in
  the error color when the connection is gone), the schedule (`task.next-runs`), the next run (`today 02:00`, `tomorrow
  02:00`, `Fri 13 Nov 02:00`, `—` when disabled), the last run, and `Run Now` (or `Cancel` while running), `Edit`, `✕`.
- [ ] The last run shows its result (`done`, `failed`, `skipped`, `cancelled`, `missed`) and when; a successful one
  `<n> collections, <n> documents, <size>, <duration>`, a failed one its error; while running, `running` and what it is
  doing, or `running in another window`; without runs, `never`.
- [ ] Clicking a row shows `Writes: <format> in <folder>, named <pattern>`, `Query: …` for an export with a filter or a
  projection, `Keeps: the last <n> files it wrote` (`folders` for a folder backup) or `everything it writes`, `Missed
  runs: run when Mongoster starts` when set, then the runs: started, how (`scheduled`, `Run Now`, `missed, run late`),
  result, details (with `<n> old outputs deleted`), and the output, a link that reveals it, or greyed with the tooltip
  `Deleted by retention`. Without runs: `No runs yet.` The open rows stay open while the tab is hidden.
- [ ] In the desktop app, with an enabled task and `mongoster.scheduledTasks.keepRunningInTray` off, the tab says
  `Tasks run while the app is open. Keep running in the tray when the window is closed.`, and the link opens the
  setting.

### `task.edit` — Create or edit a task

The form of a task: what it saves, where, under which name, when, and how many outputs it keeps
([README › Scheduled tasks](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/scheduledTasks.ts › ScheduledTasksPanel.receive` (cases `new`, `edit`, `save`, `names`,
  `browse`), which saves with `src/scheduler.ts › Scheduler.save`.
- **Implemented in**: `ScheduledTasksPanel.newTask`; `src/webview/scheduledTasks.ts` (`renderForm`, `refreshForm`);
  `src/shared/schedule.ts › taskErrors`, `› patternError`, `› describeSchedule`, `› nextRuns`, `› outputName`;
  `src/extension.ts` (`mongoster.scheduleTask`).
- **Entry points**: `New Task…` in the tab; `Edit` on a row; `mongoster.scheduleTask` **Schedule…** on a connection, a
  database, a collection or a view in the connections view (hidden from the Command Palette; with no argument it opens
  the tab without a form).
- **Offered when**: `viewItem =~ /^(connection|database)/` and `viewItem =~ /^(collection|view)/` for `Schedule…`,
  read-only connections included.
- **Asks**, in the form (`New Scheduled Task`, or `Edit <name>`):
  - **Name**: `Back up <what>` for a new task (`<what>` as in `backup.create`), or `Backup`; switching the kind renames
    a default name to `Export <what>` and back.
  - **Kind**: `Backup` (format `Archive (.agz)` by default) or `Export` (format `JSON Lines` by default).
  - **Connection**, **Database** and **Collection**, with the names of the server suggested. Empty database: all
    databases except `admin`, `local` and `config`; empty collection: all collections of the database except
    `system.*`. An export needs both.
  - **Format**: `Archive (.agz)`, `Folder, compressed (gzip)`, `Folder, uncompressed` for a backup; `JSON`, `JSON Lines`,
    `CSV` for an export, then **Filter** and **Projection** in mongosh syntax (CSV: `CSV has the columns of the
    collection's tab, as laid out there.`).
  - **Folder**, typed or chosen with `Browse…` (`Folder of the scheduled task`, button `Choose Folder`); by default the
    folder of the last `Back Up…`, else the first workspace folder, else the home folder.
  - **File name**: `{name}_{date}_{time}` by default (`task.file-names`), with an example name under it.
  - **When**: `Every few hours` (`every 1, 2, 3, 4, 6, 8 or 12 hours` at a time), `Daily` at a time, `Weekly` on
    chosen days at a time; under it the schedule and the next three runs (`Daily at 02:00. Next: today 02:00, tomorrow
    02:00, Fri 13 Nov 02:00`). A new task: `Daily` at `02:00`.
  - **Keep**: `the last <n> files` (`folders` for a folder backup), 7 for a new task, 0 keeps everything
    (`task.retention`).
  - **Options**: `Run a missed run when Mongoster starts` (`task.missed`), `Notify after successful runs too`
    (`task.notify`), `Enabled`.
- **Reads**: the databases of the connection or the collections of the database, once each, for the suggestions.
- **Writes**: `tasks.json`, read again and written whole (`Scheduler.updateTasks`). A new task, a task enabled, or a
  task whose schedule changed counts its runs from now (`since`), so it has no missed runs from before.
- **Danger**: None. Keep above 0 lets later runs delete older outputs without asking (`task.retention`).
- **Read-only**: Allowed, because a task writes nothing to the database.
- **Undo**: Cannot be undone from the undo history, which holds writes to documents; a task is edited again.
- **After**: the form closes and the tab says `Saved "<name>" (<schedule>). Next run: <date and time>.`, or `Saved
  "<name>" (<schedule>). It is disabled.`
- **Refuses**: a field that is wrong, shown under it once it lost the focus or `Create Task` / `Save` was pressed, and
  by the host as the first error: `Enter a name`, `Choose a connection`, `Enter the database of the collection`, `Enter
  the database`, `An export is of one collection: enter it`, `Choose JSON, JSON Lines or CSV`, `Choose a backup
  format`, `Filter must be an object, e.g. { status: "active" }` (or `Filter: <parse error>`), the same for
  `Projection`, `Choose the folder`, the errors of `task.file-names`, `Enter a time as HH:MM, e.g. 02:30`, `Choose at
  least one day`, `Every 1, 2, 3, 4, 6, 8, 12 hours`, `Enter how many to keep (0: all)`. A file that can't be written:
  `Could not save the task: <error>`.
- **Uses**: `task.next-runs`, `task.file-names`, `task.retention`, `task.missed`, `task.notify`.
- **Tested by**: `test/unit/schedule.test.ts › validation › 'accepts a complete task'`, `› 'reports what is missing or
  wrong, field by field'`; `test/integration/scheduledTasks.test.ts › two windows › 'runs a due task once, records it
  for both, and refuses a second run at the same time'` (`Scheduler.save`); the tab: none.

Acceptance:

- [ ] `Schedule…` on the database `shop` opens the form with the name `Back up shop`, kind Backup, `Archive (.agz)`,
  database `shop`, no collection, `Daily` at `02:00`, keep 7, enabled.
- [ ] Choosing Export with no collection shows `An export is of one collection: enter it` and nothing is saved.
- [ ] The file name `backup` shows `Include the date or time, e.g. {date}_{time}, so the runs write different files`.
- [ ] A weekly schedule without days shows `Choose at least one day`; the next runs disappear until one is chosen.
- [ ] Saving shows the next run; a disabled task is saved with `It is disabled.`
- [ ] Changing only the name of a task keeps when its runs count from; changing its time restarts it from now.
- [ ] A task saved in one VS Code window appears in the tab of another within 15 seconds.

### `task.next-runs` — When a task runs

The times a schedule gives, in local time, also on the days daylight saving starts and ends
([README › Scheduled tasks](../../README.md#features)).

- **Kind**: Derivation
- **Function**: `src/shared/schedule.ts › nextRun`, `› previousRun`, `› nextRuns`, `› describeSchedule` (with
  `timesOfDay`, `runsOnDay`, `eachDay`).
- **Used by**: `task.show`, `task.edit`, `task.due`, `task.run`.
- **Tested by**: `test/unit/schedule.test.ts › next run › 'runs daily at the time, today if it has not passed'`, `›
  'runs every N hours at the times N hours apart from the one given'`, `› 'runs weekly on the chosen days'`, `› 'keeps
  the local time across daylight saving changes, without skipping or repeating a day'`, `› 'runs every hour once per
  hour of local time on the day daylight saving starts'`, `› 'finds the last run at or before a time'`.

Rules:

- A schedule is `{ kind: 'hours', every, time }`, `{ kind: 'daily', time }` or `{ kind: 'weekly', days, time }`;
  `time` is `HH:MM` (also `H:MM`); `days` are 0 (Sunday) to 6 (Saturday).
- Every N hours runs at the hours `h mod N`, then every N hours up to 23, at the minutes of `time`: every 6 hours at
  02:30 is 02:30, 08:30, 14:30, 20:30.
- The times are local. On the day daylight saving starts, a time that doesn't exist runs when the clock gets there in
  the new time (02:30 runs at 03:30), and a time that then falls on another run is one run. On the day it ends, a
  time that happens twice runs once, the first time.
- `nextRun(schedule, after)`: the first run strictly after `after`, looking from the day before for 10 days;
  undefined when there is none (a weekly schedule without days, a time that doesn't parse). `previousRun(schedule,
  at)`: the last run at or before `at`, looking back 10 days.
- `describeSchedule`: `Every <n> hours (<times>)`, `Every hour at :<mm>`, `Daily at <HH:MM>`, `<days> at <HH:MM>` with
  the days from Monday (`Mon, Thu`), `Weekdays` for Monday to Friday, `Every day` for all seven; `No days chosen`;
  `Invalid time`.

Worked examples (Europe/Rome; daylight saving starts on 2026-03-29 and ends on 2026-10-25):

- Daily at 02:30 after 2026-11-11 01:00 → 2026-11-11 02:30; after 02:30 that day → 2026-11-12 02:30; after
  2026-12-31 23:00 → 2027-01-01 02:30.
- Every 6 hours at 08:15 after 2026-11-11 00:00 → 02:15, 08:15, 14:15, 20:15, then 2026-11-12 02:15.
- Weekly on Mon and Thu at 23:30, after Wednesday 2026-11-11 12:00 → 11-12, 11-16, 11-19, at 23:30.
- Daily at 02:30 from 2026-03-27 → 03-28 02:30, 03-29 03:30, 03-30 02:30; from 2026-10-24 → 10-25 02:30, 10-26 02:30
  (25 hours later).
- Every hour at :30 on 2026-03-29 after 00:45 → 01:30, 03:30, 04:30.

### `task.due` — Due and missed runs

Whether a task has a run to do now, and whether that run was missed because Mongoster wasn't running
([README › Scheduled tasks](../../README.md#features)).

- **Kind**: Derivation
- **Function**: `src/shared/schedule.ts › dueRun`, `› runsCountFrom`, `› nextTaskRun`, `› addRun`.
- **Used by**: `task.run`, `task.missed`, `task.show` (the next run).
- **Tested by**: `test/unit/schedule.test.ts › due and missed runs › 'is due once the time has come, and not again after
  it was handled'`, `› 'finds a run more than the grace period late missed, and only the latest of several'`, `›
  'counts runs from when the task was created or enabled, and never when disabled'`, `› 'keeps the last runs in the log,
  newest first'`.

Rules:

- A disabled task has nothing due and no next run.
- Runs count from the later of `since` (when the task was created, enabled or rescheduled) and `lastSlot` (the last
  scheduled time handled: run, skipped or missed). The next run is `nextRun` after that.
- Nothing is due while that next run is in the future. Otherwise the slot is the latest scheduled time at or before
  now: of several runs due, only the latest counts.
- The slot is a run when it is at most 5 minutes old (`GRACE_MS`), otherwise it was missed.
- The run log keeps the 20 newest runs, newest first.

Worked examples (daily at 02:30):

- Last handled 2026-11-10 02:30: at 11-11 02:29 nothing; at 02:31 a run for 11-11 02:30. Once 11-11 02:30 is handled,
  nothing until 11-12 02:30.
- Last handled 2026-11-08 02:30, opened on 11-11 at 09:00: one missed run, 11-11 02:30; at 02:34 it would have been a
  run.
- Created on 2026-11-11 at 03:00: nothing due at 09:00 the same day.

### `task.file-names` — The names of what a run writes

The name of the file or folder each run writes, from the task's pattern, and which patterns are accepted
([README › Scheduled tasks](../../README.md#features)).

- **Kind**: Derivation
- **Function**: `src/shared/schedule.ts › outputName`, `› expandPattern`, `› patternError`, `› patternValues`,
  `› outputExtension`, `› safeFileName`.
- **Used by**: `task.edit` (the example name), `task.run`; `src/backup.ts › uniquePath` adds a number when the name
  exists (`backup.folder-layout`).
- **Tested by**: `test/unit/schedule.test.ts › file names › 'expands the placeholders, as Back Up names its files by
  default'`, `› 'adds the extension of the format, none for a folder'`, `› 'refuses names without a date, with folders
  or with unknown placeholders'`.

Rules:

- Placeholders: `{name}` (the collection, else the database, else the connection's name), `{connection}`,
  `{database}`, `{collection}` (empty when the task has none), `{date}` (`YYYY-MM-DD`), `{time}` (`HH-mm-ss`), `{YYYY}`,
  `{MM}`, `{DD}`, `{HH}`, `{mm}`, `{ss}`, `{weekday}` (`Sun` to `Sat`), in local time at the start of the run.
- After expanding, every run of `\ / : * ? " < > |` and white space becomes `_`, leading and trailing `.` and `_` are
  removed, and an empty name becomes `output`.
- The extension is added: `.agz` for an archive, none for a folder backup, `.json`, `.jsonl` or `.csv` for an export.
- Refused patterns: empty (`Enter a file name`); with `/` or `\` (`The file name cannot contain / or \: choose the
  folder instead`); with another placeholder (`Unknown placeholder {day}: use {name} {connection} {database}
  {collection} {date} {time} {YYYY} {MM} {DD} {HH} {mm} {ss} {weekday}`); without one of `{date}`, `{time}`,
  `{YYYY}`, `{MM}`, `{DD}`, `{HH}`, `{mm}`, `{ss}`, `{weekday}` (`Include the date or time, e.g. {date}_{time}, so the
  runs write different files`).

Worked examples (2026-10-08 16:45:12, a Thursday):

- `{name}_{date}_{time}`, database `shop` → `shop_2026-10-08_16-45-12.agz`; as a compressed folder →
  `shop_2026-10-08_16-45-12`; an export of `orders` to CSV → `orders_2026-10-08_16-45-12.csv`; a connection `My
  Server` without a database → `My_Server_2026-10-08_16-45-12.agz`.
- `{connection}-{database}.{collection}-{YYYY}{MM}{DD}-{HH}{mm}{ss}-{weekday}`, connection `Prod DB` →
  `Prod_DB-shop.orders-20261008-164512-Thu`.

### `task.run` — Run a task

Runs a task at its time, or now with `Run Now`, without asking anything: a backup or an export written as a new file
or folder in the task's folder ([README › Scheduled tasks](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/scheduler.ts › Scheduler.execute`, which calls `Scheduler.perform` and `src/taskRunner.ts ›
  runTask`; scheduled runs come from `Scheduler.tick`, `Run Now` from `Scheduler.runNow`, `Cancel` is
  `Scheduler.cancel`.
- **Implemented in**: `src/scheduledTasks.ts › ScheduledTasksPanel.receive` (cases `run`, `cancel`);
  `src/webview/scheduledTasks.ts`; `src/backup.ts` (`planBackup`, `writeBackup`, `uniquePath`); `src/transfer.ts`
  (`exportSource`, `writeExport`, `FileWriter`); `src/extension.ts` (the CSV columns: the collection tab's layout in
  `globalState`); `src/fileLock.ts`.
- **Entry points**: the schedule (checked 3 seconds after start, then every 15 seconds, in every window); `Run Now` on
  a row (`Run it once now (the schedule stays as it is)`); `Cancel` on a running row (`Stop the run: what it wrote so
  far is deleted`).
- **Reads**: the task and its state again, holding the task's lock; the database: for a backup what `backup.create`
  reads, of the connection (all databases except `admin`, `local`, `config`), a database (all collections except
  `system.*`) or a collection; for an export `find(filter, { projection, promoteLongs: false, batchSize: 1000 })`.
- **Writes**: a new file or folder in the task's folder, named by `task.file-names`, `_2`, `_3`… added when the name
  exists: the backup of `backup.create` or the export of `transfer.export` (CSV with the columns of the collection's
  tab). The state file: the run in progress (`running`), then the run in the log and the output in the list of
  outputs. Then `task.retention`.
- **Danger**: Destructive through `task.retention`: after a successful run, older outputs of the task are deleted
  without asking.
- **Read-only**: Allowed, because a run writes nothing to the database.
- **Undo**: Cannot be undone, and needs none for the database; the files are kept or deleted by `task.retention`.
- **After**: the tab follows the progress once a second (`<database>.<collection>: <n> documents`, `<n> documents`);
  the run is logged as `done` with its size, documents and collections; `task.notify`.
- **Refuses**, each logged and notified as a failed run: a folder that doesn't exist is not created: `The folder
  <folder> doesn't exist (is the drive connected?)`; `Nothing to back up: time series collections aren't supported
  (use mongodump).`; `Nothing to back up: there are no collections.`; `The collection <database>.<collection> doesn't
  exist.`; an export without database or collection: `An export needs a database and a collection.`; any error of the
  server. Logged as skipped: `The connection was removed`, `Connection unavailable: <error>`.
- **Settings**: `mongoster.scheduledTasks.keepRunningInTray` (the desktop app keeps running, `task.tray`).
- **Uses**: `backup.create`, `transfer.export` (its Differs on JSON Lines applies to scheduled exports too),
  `task.file-names`, `task.due`, `task.retention`, `task.one-window`, `task.notify`.
- **Tested by**: `test/integration/scheduledTasks.test.ts › scheduled tasks › 'backs up a database to archives,
  keeping the last two'`, `› 'backs up a collection to folders, deleting whole folders it wrote'`, `› 'exports a
  collection with a filter and a projection, keeping the last two'`, `› 'exports CSV with the columns given, and fails
  without leaving a file'`, `› 'deletes what it wrote so far when cancelled'`; `› two windows › 'runs a due task once,
  records it for both, and refuses a second run at the same time'`.

Acceptance:

- [ ] A daily backup of `shop` at 02:00 with the default pattern writes `shop_2026-11-01_02-00-00.agz` on 1 November;
  a second run with the same name writes `…_2.agz` and replaces nothing.
- [ ] An export with the filter `{ status: "open" }` and the projection `{ total: 1 }` writes only those documents and
  fields.
- [ ] A time series collection is left out of a backup, and the run's details say `Time series collections left out
  (use mongodump): <database>.<collection>`.
- [ ] With the folder on a drive that isn't connected, the run fails with `The folder <folder> doesn't exist (is the
  drive connected?)` and creates nothing.
- [ ] An export whose filter the server refuses fails and leaves no file.
- [ ] `Run Now` runs a task once, also a disabled one, logs it as `Run Now`, and doesn't change the next run.
- [ ] `Run Now` while the task runs says `"<name>" is already running.`, or `"<name>" is already running in another
  window.`
- [ ] `Cancel` stops the run, deletes what it wrote so far, and logs `cancelled` with `Cancelled: the incomplete output
  was deleted`; from another window it is noticed within 2 seconds.
- [ ] A run due while the previous one is still going is skipped, and the running one's details say `The run due at
  <time> was skipped: this one was still going`.
- [ ] A run interrupted because VS Code or the app was closed is logged as failed with `Interrupted: VS Code or the app
  was closed during the run` at the task's next run.
- [ ] A task of a removed connection is logged as skipped with `The connection was removed`.

### `task.retention` — Keep the last N outputs

After each successful run, deletes the older files or folders that this task wrote beyond the number kept, and never
anything else ([README › Scheduled tasks](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/taskRunner.ts › applyRetention`, choosing with `src/shared/schedule.ts › outputsToDelete`; called
  by `src/scheduler.ts › Scheduler.perform`.
- **Entry points**: none of its own: the end of every successful run (`task.run`); the number is the form's **Keep**
  (`task.edit`).
- **Reads**: the list of outputs of the task in `<id>.json`, and each output's path on disk (`stat`).
- **Writes**: deletes files, and folders with everything in them (`fs.promises.rm(path, { recursive, force: true })`),
  permanently, not to the recycle bin. Updates the list of outputs.
- **Danger**: Destructive: the deleted backups and exports are lost. There is no confirmation; the form says `Older ones
  written by this task are deleted after each successful run; nothing else in the folder is touched. 0 keeps them all.`
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: the files are deleted, not moved to the recycle bin.
- **After**: the run's details say `<n> old outputs deleted`; the run log shows their names greyed (`Deleted by
  retention`).
- **Uses**: `task.run`, `task.edit`.
- **Tested by**: `test/unit/schedule.test.ts › retention › 'deletes all but the newest ones kept, whatever their
  order'`, `› 'keeps everything with 0'`; `test/integration/scheduledTasks.test.ts › scheduled tasks › 'backs up a
  database to archives, keeping the last two'` (a file of the same pattern not written by the task stays), `› 'backs up
  a collection to folders, deleting whole folders it wrote'`, `› 'exports a collection with a filter and a projection,
  keeping the last two'`.

Rules, which files it may delete:

- Only the outputs in the task's list: each is the exact path of a file or folder that a successful run of this task
  (scheduled, missed or `Run Now`) created, recorded with the run's time, its size and whether it is a folder. The new
  output is recorded before retention runs, so it is never deleted.
- An output is recognized by its recorded path and kind only: names, patterns and the content of the folder are never
  looked at. A path that no longer exists is dropped from the list; a path that is now a folder where a file was
  recorded, or a file where a folder was, is left alone and dropped from the list. A file put at exactly the path of a
  recorded output, of the same kind, would be deleted as that output.
- With `keep` = N > 0, the outputs are ordered by the time of their run (of two at the same time, the one recorded
  later is newer) and all but the N newest are deleted. With 0 nothing is deleted. A change of **Keep** applies at the
  next successful run.
- A path that can't be deleted stays in the list and is tried again after the next run; the run's details say `Could
  not delete <path>: <error>`.
- Never deleted: anything else in the folder, also with names that match the pattern; outputs of a failed or cancelled
  run (removed at once by the run itself, and never recorded); anything after a failed, skipped, cancelled or missed
  run; outputs of a deleted task (its list is deleted with it, `task.delete`). Outputs recorded in a folder the task
  no longer uses are still the task's, and are deleted there.

Worked examples:

- Outputs of runs at 1, 2, 3, 4, 5 (any order), keep 3 → the outputs of 1 and 2 are deleted.
- Keep 4 → the oldest; keep 5 or 0 → none.
- Keep 2, three daily runs into a folder that also holds `mongoster_scheduled_2020-01-01_02-00-00.agz` written by
  someone else → the first run's archive is deleted, the 2020 file stays.
- Keep 1, a folder backup run twice with the same name → `…-20261101` is deleted with everything in it,
  `…-20261101_2` stays.

### `task.missed` — Runs missed while Mongoster was closed

A run whose time came while VS Code and the app were closed, or the computer was asleep: recorded as missed, or run
once late ([README › Scheduled tasks](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/scheduler.ts › Scheduler.tick`, which records with `Scheduler.recordMissed` or runs with
  `Scheduler.execute(task, 'missed')`.
- **Entry points**: the schedule's check, 3 seconds after start and every 15 seconds; the form's option `Run a missed
  run when Mongoster starts`.
- **Reads**: `task.due` on the task and its state, again holding the task's lock.
- **Writes**: the state file: `lastSlot` and a run with status `missed`; or a run (`task.run`) logged as `missed, run
  late`.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone, and needs none: it records a run in the log.
- **Uses**: `task.due`, `task.run`, `task.one-window`.
- **Tested by**: `test/unit/schedule.test.ts › due and missed runs › 'finds a run more than the grace period late
  missed, and only the latest of several'`; `Scheduler.recordMissed`: none.

Acceptance:

- [ ] A daily task at 02:30, with Mongoster closed from Sunday to Wednesday 09:00, logs one run `missed` for Wednesday
  02:30 with `Mongoster wasn't running (or the computer was asleep) at that time`, and shows no notification.
- [ ] With `Run a missed run when Mongoster starts`, it runs once instead, logged as `missed, run late`.
- [ ] A run found less than 5 minutes late runs as a scheduled run.
- [ ] A task created, enabled or rescheduled after the time of a run has no missed run for it.

### `task.enable` — Enable or disable a task

The checkbox of a row, or `Enabled` in the form, stops or starts a task's runs without deleting it
([README › Scheduled tasks](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/scheduler.ts › Scheduler.setEnabled` (from `ScheduledTasksPanel.receive`, case `toggle`); in the
  form, `Scheduler.save`.
- **Entry points**: the checkbox of a row (`Enabled: click to disable`, `Disabled: click to enable`); `Enabled` in the
  form.
- **Writes**: `tasks.json`. Enabling sets `since` to now: runs whose time came while it was disabled are neither run
  nor recorded as missed.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone from the undo history; the checkbox is clicked again.
- **Uses**: `task.due`, `task.tray` (whether a task is enabled).
- **Tested by**: `test/unit/schedule.test.ts › due and missed runs › 'counts runs from when the task was created or
  enabled, and never when disabled'`; `Scheduler.setEnabled`: none.

Acceptance:

- [ ] A disabled task's row is greyed, its next run is `—`, and it doesn't run at its time.
- [ ] Enabling it again on Thursday after a week disabled logs no missed runs.
- [ ] `Run Now` still runs a disabled task.

### `task.delete` — Delete a task

`✕` on a row deletes the task and its run log, and leaves the files it wrote
([README › Scheduled tasks](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/scheduler.ts › Scheduler.remove`, after the confirmation in `ScheduledTasksPanel.receive` (case
  `delete`).
- **Entry points**: `✕` on a row (`Delete the task (the files it wrote stay)`).
- **Asks**: the modal `Delete the scheduled task "<name>"?` with `Its run log is deleted too. The backups and exports
  it wrote stay where they are.`; button `Delete`.
- **Writes**: cancels its run if one is going on (`Scheduler.cancel`: in this window at once, in another by writing
  `<id>.cancel`), removes it from `tasks.json`, deletes `<id>.json` and `<id>.cancel`.
- **Danger**: Confirm: the modal above. The run log and the list of outputs are lost: retention no longer deletes the
  outputs it wrote.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone; the confirmation says the run log is deleted.
- **Uses**: `task.retention`.
- **Tested by**: *none*.

Acceptance:

- [ ] After `Delete`, the task is gone from the tab of every window, and every file and folder it wrote is still there.
- [ ] Deleting a task while it runs in this window stops the run and deletes its incomplete output. A run in another
  window is not stopped: the cancel file is deleted with the task before that window looks for it, so the run
  finishes, keeps its output, and is not logged.

### `task.one-window` — A task runs in one window only

With several VS Code windows open, each runs the scheduler, and a task runs in only one of them, once per scheduled
time, never twice at the same time ([README › Scheduled tasks](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/fileLock.ts › FileLock.acquire`, used by `src/scheduler.ts › Scheduler.execute` and
  `Scheduler.recordMissed`.
- **Implemented in**: `src/fileLock.ts` (`lockHeld`, `processAlive`, `FileLock.release`); `src/scheduler.ts`
  (`writeAtomic`, `Scheduler.load`, the file watcher, `runningWhere`).
- **Entry points**: every run and every missed run, in every window.
- **Reads**: `<id>.lock`: its owner's process id and token, and its modification time.
- **Writes**: `<id>.lock`, created only if it doesn't exist (`wx`), with `{ pid, token, time }`; its modification time
  renewed every 5 seconds while held; deleted on release if it is still this window's. The state and the tasks are
  written to a temporary file and renamed, so that another window never reads half a file (on Windows, retried up to 20
  times, 25 ms apart, while another window is reading it).
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone, and needs none.
- **Uses**: `task.run`, `task.missed`, `task.due`.
- **Tested by**: `test/unit/fileLock.test.ts › file lock › 'is held by one owner at a time and free again once
  released'`, `› 'is taken over when its owner process is gone'`, `› 'is taken over when its heartbeat stopped'`, `›
  'renews itself, and tells its owner when it was taken over'`; `test/integration/scheduledTasks.test.ts › two windows
  › 'runs a due task once, records it for both, and refuses a second run at the same time'`.

Rules:

- A window takes the task's lock, reads the task and its state again, and runs only if the run is still due
  (`task.due`); it records the scheduled time before running, so the other windows find nothing due.
- A lock is held while its file was renewed in the last 30 seconds by a process that is running; a file being written
  (not yet readable) counts as held for 2 seconds. A stale lock is removed and taken, unless it changed while it was
  being judged.
- A window that finds its lock taken over cancels its run.
- `Run Now` in a window while another runs the task is refused (`task.run`); the tab shows `running in another window`.
- Every window reads the tasks again when the file system reports a change (after 300 ms) and at every check.

Acceptance:

- [ ] Two windows checking a due task at the same moment write one output and log one run, `done` and `scheduled`, in
  both tabs.
- [ ] After the run, `<id>.lock` is gone and both windows show the next run in the future.
- [ ] A lock left by a window that crashed is taken over within 30 seconds.

### `task.notify` — Notifications of runs

Failed and skipped runs are told at once; successful ones only when the task asks for it
([README › Scheduled tasks](../../README.md#features)).

- **Kind**: View
- **Function**: `src/scheduler.ts › Scheduler.report`; in the desktop app's tray, `src/standalone/main.ts ›
  notifyFromTray`.
- **Implemented in**: `Scheduler.onDidRun`; the form's option `Notify after successful runs too` (`task.edit`).
- **Tested by**: *none*.

Acceptance:

- [ ] A failed run shows the error `Scheduled task "<name>" failed: <error>` with `Show Scheduled Tasks`, in the window
  that ran it.
- [ ] A skipped run shows the warning `Scheduled task "<name>" was skipped: <error>` with `Show Scheduled Tasks`.
- [ ] A successful run shows nothing, unless `Notify after successful runs too` is on: `Scheduled task "<name>" done
  (<n> collections, <n> documents, <size>) in <s> s: <file name>` with `Reveal` and `Show Scheduled Tasks`.
- [ ] Cancelled and missed runs show no notification.
- [ ] In the desktop app with the window in the tray, a failed or skipped run shows a system notification `Scheduled
  task "<name>" failed: <error>` (or `was skipped: <error>`); clicking it shows the window.

### `task.tray` — Keep the desktop app running in the tray

In the desktop app, closing the window can leave the app running in the system tray so that the tasks keep running
([README › Desktop app](../../README.md#desktop-app)).

- **Kind**: View
- **Function**: `src/standalone/main.ts › keepInTray`, `› hideToTray`, `› showWindow`.
- **Implemented in**: `src/scheduler.ts › Scheduler.hasEnabledTasks`; `src/scheduledTasks.ts` (`TRAY_SETTING`, the
  tab's note and `traySetting`).
- **Settings**: `mongoster.scheduledTasks.keepRunningInTray` (default off; desktop app only).
- **Tested by**: *none*.

Acceptance:

- [ ] With the setting on and at least one task enabled, closing the window hides it and shows a tray icon with the
  tooltip `Mongoster: scheduled tasks keep running`; its menu has `Open Mongoster` and `Quit`.
- [ ] Clicking the icon or `Open Mongoster` shows the window again and removes the icon.
- [ ] With the setting off, or no task enabled, closing the window quits the app.
- [ ] `Quit` (from the tray, the menu or the keyboard) quits the app even with the setting on.
- [ ] VS Code has no tray: its tasks run only while one of its windows is open.
