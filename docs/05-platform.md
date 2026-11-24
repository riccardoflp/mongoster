# Platform

What Mongoster asks of the two products it runs in, VS Code and its own Electron app, and of the operating systems
under them. The interface between the features and the platform is the `vscode` module: VS Code's own in the
extension, `src/standalone/vscode/` in the desktop app ([D1](08-decisions.md#d1--one-code-base-for-the-extension-and-the-desktop-app)).

## Minimum versions

| What | Version | Where it is said |
| --- | --- | --- |
| VS Code | 1.90 | `package.json` › `engines.vscode` |
| Node.js, to build | 20 (the CI uses 22) | [06-testing.md](06-testing.md#setup) |
| MongoDB | 4.2 | the driver ([D4](08-decisions.md#d4--the-official-nodejs-driver-mongodb-42-or-later)) |
| Search indexes | Atlas, an Atlas local deployment, or MongoDB Community 8.3 with `mongot` | `index.` cards |
| Desktop app | Windows, macOS (Intel and Apple silicon), Linux (AppImage), as Electron supports them | `electron-builder.yml` |

## What the features ask of the platform

| Need | VS Code API used | In the desktop app (`src/standalone/vscode/`) |
| --- | --- | --- |
| Commands, menus with `when` clauses, key bindings | `commands`, `package.json` › `contributes` | `commands.ts`, `contributions.ts` read `package.json`; the window draws the menus |
| The connections view | `TreeDataProvider`, `TreeView`, `FileDecorationProvider` | `tree.ts`, `decorations.ts`; the window's side bar |
| Tabs | `createWebviewPanel`, `postMessage` | `webview.ts`; frames in the window, served by `mongoster-app://` |
| Documents and definitions in editor tabs | `FileSystemProvider` for `mongoster://` and `mongoster-def://` | `documents.ts`; Monaco in the window |
| Playgrounds | text documents, CodeLens, completion, status bar | `documents.ts`; Monaco, files saved where the user chooses |
| Questions to the user | `showWarningMessage` (modal), `showQuickPick`, `showInputBox`, open and save dialogs | `ui.ts`; the window's quick input and Electron's dialogs |
| Progress with `Cancel` | `withProgress` | `ui.ts`; notifications in the window |
| Secrets | `context.secrets` (`SecretStorage`) | `storage.ts`: `secrets.json` encrypted with `safeStorage` |
| Small state | `context.globalState` | `storage.ts`: a JSON file in the app's folder |
| Larger files | `context.globalStorageUri` | the app's folder |
| Settings | `workspace.getConfiguration('mongoster')` | `storage.ts`: `settings.json`; the Settings tab |
| Watching saved query files | `createFileSystemWatcher` | `watcher.ts` (`fs.watch`) |
| Theme colors | the active color theme's files, `--vscode-*` CSS variables | `theme.ts`, `themes.ts`: seventeen themes as the same variables, chosen with `app.theme` |
| Output channels | `createOutputChannel` (`Mongoster Playground`, `Mongoster MCP`) | `ui.ts` |
| Clipboard, showing a file in the system's file manager | `env.clipboard`, the `revealFileInOS` command | Electron's `clipboard` and `shell` |
| The MCP server's discovery by Copilot | `lm.registerMcpServerDefinitionProvider`, when the VS Code version has it | not available: clients are configured by hand |

`npm run typecheck` checks the code against both: a VS Code API the desktop app lacks is a type error there (R1.4).

## Where data lives

| Data | The extension | The desktop app |
| --- | --- | --- |
| Secrets | VS Code's `SecretStorage` (the system's keychain through VS Code) | `secrets.json` in the app's folder, encrypted with `safeStorage` (DPAPI on Windows, Keychain on macOS, libsecret on Linux); **in clear text when no keychain is available** (see T2 in [10-security.md](10-security.md)) |
| Connections, layouts, query history | `globalState` | a JSON file in the app's folder |
| Undo history, scheduled tasks | `globalStorage/riccardofilippozzi.mongoster/` (on Windows under `%APPDATA%\Code\User\`) | the app's folder |
| Settings | VS Code's settings | `settings.json` in the app's folder |
| The app's folder | — | `%APPDATA%\Mongoster`, `~/Library/Application Support/Mongoster`, `~/.config/Mongoster`, or `MONGOSTER_USER_DATA` |

The details of each file are in [11-data.md](11-data.md).

## Networking

- **MongoDB**: through the driver, with its TLS; the CA, client certificate and key come from the connection's TLS
  options.
- **SSH tunnels**: `ssh2` in `src/transport.ts`, a local port forwarded to the first host of the connection string,
  with the server's key checked against the known hosts.
- **Redis**: Mongoster's own RESP client in `src/redisOplog.ts`, `redis://` or `rediss://` (TLS).
- **The MCP server**: Node's `http` on `127.0.0.1`, port 37017 by default.

## What differs between the two

The README's `Desktop app` section is the list the user reads. For the code: the desktop app has a tray and keeps
running there for scheduled tasks (`mongoster.scheduledTasks.keepRunningInTray`), has no workspace (saved queries in
the project ask for a folder), cannot be discovered by Copilot, and its installers are not signed.
