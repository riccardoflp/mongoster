# Settings

The `mongoster.*` settings: where they are declared and read, and which card each one changes. They are declared in
`package.json` › `contributes.configuration`, each with a `markdownDescription`, and read with
`vscode.workspace.getConfiguration`; the desktop app keeps them in its `settings.json` and builds its Settings tab from
the same declarations.

### `settings.read` — Read the settings

The values of the `mongoster.*` settings as the user set them, or their defaults.

- **Kind**: Read
- **Function**: `vscode.workspace.getConfiguration('mongoster.<group>')`, called where each setting is used.
- **Implemented in**: `package.json` (declarations); `src/history.ts`, `src/mcpServer.ts`, `src/projectQueries.ts`,
  `src/scheduledTasks.ts`, `src/collectionPanel.ts`, `src/extension.ts`; in the desktop app
  `src/standalone/vscode/storage.ts` and `src/standalone/shell/settings.ts`.
- **Entry points**: VS Code's Settings; in the desktop app the Settings tab (`Ctrl+,`).
- **Tested by**: none.

Acceptance:

- [ ] A change to `mongoster.history.*`, `mongoster.mcp.*`, `mongoster.savedQueries.folder` or
  `mongoster.scheduledTasks.*` takes effect without a reload: those modules listen to `onDidChangeConfiguration`.
- [ ] `mongoster.references.detect` and `mongoster.mcp.readDocuments` are read each time they are needed.
- [ ] The desktop app's Settings tab lists every setting of `contributes.configuration`, with its description.

### `settings.page` — The desktop app's Settings tab

A tab of the desktop app that shows every `mongoster.*` setting as a form, plus the color theme.

- **Kind**: View
- **Function**: `src/standalone/shell/settings.ts › openSettings`
- **Implemented in**: `src/standalone/vscode/contributions.ts` (the fields from `package.json`),
  `src/standalone/vscode/storage.ts` (`settings.json`).
- **Entry points**: `Ctrl+,`.
- **Tested by**: none.

Acceptance:

- [ ] Each setting shows its title and its `markdownDescription`, with `code` and **bold** rendered and everything else
  as text.
- [ ] A changed value is written to `settings.json` and reaches the host as a configuration change.

## The settings

| Setting | Default | What it does | Cards |
| --- | --- | --- | --- |
| `mongoster.history.enabled` | `true` | Keeps the undo history; off, no write is recorded. | `undo.record`, `undo.limits` |
| `mongoster.history.maxSizeMB` | `100` | The most disk space the undo history takes. | `undo.limits` |
| `mongoster.history.maxDays` | `7` | How long an operation is kept. | `undo.limits` |
| `mongoster.history.maxOperations` | `200` | How many operations are kept. | `undo.limits` |
| `mongoster.history.maxDocumentsPerOperation` | `10000` | A write on more documents is not recorded. | `undo.record` |
| `mongoster.history.maxOperationSizeMB` | `20` | A write whose documents take more is not recorded. | `undo.record` |
| `mongoster.mcp.enabled` | `false` | Runs the MCP server. | `mcp.server` |
| `mongoster.mcp.port` | `37017` | The MCP server's port on `127.0.0.1`. | `mcp.server`, `mcp.change-port` |
| `mongoster.mcp.readDocuments` | `true` | Offers the tools that return documents and values. | `mcp.read-documents` |
| `mongoster.savedQueries.folder` | `.mongoster/queries` | Where saved queries of the project are, relative to each workspace folder or absolute. | the saved queries area (no cards yet) |
| `mongoster.references.detect` | `true` | Finds references in the background when a collection of a database is first opened. | the relations area (no cards yet) |
| `mongoster.scheduledTasks.keepRunningInTray` | `false` | In the desktop app, closing the window keeps it in the tray while a task is enabled. | `task.tray` |
