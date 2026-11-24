# Security

What Mongoster protects, from whom, and how. *Source: the Threat Modeling Manifesto (2020) for the four questions
below; STRIDE (Microsoft; Adam Shostack, "Threat Modeling", 2014) to find the threats; OWASP ASVS as the checklist of
mitigations for the MCP server.* Each mitigation is a code rule (R14 of [03-code-rules.md](03-code-rules.md)), an
acceptance line of a card, or a decision. How to report a vulnerability is in [SECURITY.md](../SECURITY.md).

## What we are working on

The picture is the context diagram of [02-architecture.md](02-architecture.md#context): Mongoster on the user's
machine, holding the credentials of MongoDB deployments that are often production ones, talking to them directly or
through SSH, publishing to Redis, and serving AI assistants on `127.0.0.1`.

Worth protecting, in order:

1. **The data in the deployments**: against writes the user did not mean (a read-only connection, a wrong
   confirmation) and against reading by someone who should not.
2. **The credentials**: connection strings with passwords, TLS keys, SSH keys and passwords, Redis URLs, the MCP
   access token. Each opens a deployment or a service.
3. **The user's machine and files**: Mongoster writes backups and exports, deletes old ones (retention), and runs
   playground scripts.

The trust boundaries: between Mongoster and everything in **Not trusted** on the diagram (the deployments, SSH
servers, Redis), between the host and its webviews (a webview shows data from the database), between Mongoster and
other programs on the same machine (the MCP port), and between Mongoster and the files it reads that someone else may
have written (imports, connection files, backups, saved query files from git, playgrounds).

## What can go wrong

| | STRIDE | The threat | Where | Mitigation | Status |
| --- | --- | --- | --- | --- | --- |
| T1 | I | A credential is read from where Mongoster keeps it, or from a place it was copied to (settings, logs, the output channels, an export). | `connection.secrets`, `connection.export` | Secrets only in the secret storage (R14.1); exports leave passwords out unless the user chooses otherwise, after a warning for clear text | **Open, partly**: `Without passwords` and the passphrase still leave `proxyPassword` and `AWS_SESSION_TOKEN` in the connection string in clear text, and in two formats `tlsCertificateKeyFilePassword` (Differs of `connection.export`, RS6) |
| T2 | I | In the desktop app without a keychain (some Linux sessions), secrets are written to `secrets.json` in clear text (`plain:`), and the user is not told; the README says they are encrypted. | `connection.secrets`; `src/standalone/vscode/storage.ts` › `SecretStorage.store` | The file can be read only by the user (mode 0600, [11-data.md](11-data.md)) | **Open** (RS5): still clear text, and the user is not told |
| T3 | I | A password reaches a webview and so its page, where any script of the page could read it. | `connection.form` | The key password, the SSH password and the passphrase are not sent back to the form (R14.2) | **Open, partly**: the form receives the connection string and the Redis URL with their passwords (Differs of `connection.form`, RS7) |
| T4 | S | A machine in the middle poses as the SSH server and receives the tunnel's credentials and traffic. | the SSH tunnel | The host key is confirmed the first time and checked every time after (R14.6) | Mitigated |
| T5 | T | A file from someone else (a connection file, a backup, an import, a saved query from git) makes Mongoster run code or write where it should not. | `connection.import`, `backup.restore`, `transfer.import`, saved queries | Parsed, never evaluated (R14.3); a folder backup's file names are encoded, so no name leaves the folder (`backup.folder-layout`); a restore offers no system database under its own name, creates no TTL index on a collection that was already there and names the collections a view would replace (`backup.restore`); the import list says what each connection weakens or sends elsewhere (`connection.import`); saved query files skipped when invalid | Mitigated for code and for where files are written. An archive's checksum is a CRC against accidental damage only, checked at each collection's end, after its documents were inserted; **sizes are not bounded** (a huge or crafted file is read whole) |
| T6 | E | A playground from someone else's repository runs with the user's connections when the user runs it. | playgrounds | Runs only on the user's command; writes refused on read-only connections | **Open**: no check of VS Code's workspace trust ([Q8](08-decisions.md#open-questions)) |
| T7 | T, E | A value in the database contains HTML or script that a webview renders, and the script posts messages that make the host write. | every tab | Values shown as text (R14.4); Content Security Policy with a nonce (R10.3) | Mitigated, by review |
| T8 | S, I | Another program or a web page on the same machine calls the MCP server and reads data. | `mcp.server`, `mcp.access-token` | Listens only on `127.0.0.1`; refuses another `Host` (403), an `Origin` other than `127.0.0.1` or `localhost` (403, against DNS rebinding from a web page), a missing or wrong token (401), a body over 1 MB (413) and a batch of more than 20 requests (400) (R14.5). A window asks another for the port with a proof of having the token (an HMAC over a nonce, the time and the port, accepted once within 30 seconds), never the token: a program that took the port learns nothing. The `mongoster.mcp.*` settings are application settings, so a workspace cannot turn the server on | Mitigated (`mcp.server`, `mcp.access-token`), tested by `test/unit/mcpHttp.test.ts`. An MCP client still sends the token to whatever listens on the port it was configured with |
| T9 | I | An AI assistant, steered by text inside the data (prompt injection), reads more than the user meant and sends it to its provider. | `mcp.read-documents` | No tool writes; documents and values only with `mongoster.mcp.readDocuments`: with it off the document tools and `explain_query` are not offered, `count_documents` takes no filter, commands, validators, view pipelines, partial filters, saved queries and undo labels are reduced to shapes or left out, and the server's error texts are replaced by their code (`mcp.read-documents`); `system.*` collections and stages that are not a plain read are refused whatever the setting; every call logged to `Mongoster MCP` | Accepted: reading is what the server is for; the setting is the user's choice. An excluded connection, database or collection still answers when asked for by name: the exclusion is not an access control |
| T10 | T | A write goes through a read-only connection or a view because an entry point skips the check. | every write card | The write pipeline (R4.1); `connection.read-only` | **Open, partly**: a document, a view definition or validation rules opened in an editor tab before **Make Read-Only** can still be saved (`document.edit-in-editor`, `manage.edit-view`, `manage.edit-validation`, RS8) |
| T11 | T | A write the user confirmed changes more than the confirmation said (another filter, a stale count). | `document.update-many`, `document.delete-many`, `compare.make-like`, `structure.apply` | The confirmation shows the filter and the count of the same filter the write uses | Mitigated, see the cards |
| T12 | D, T | Retention of a scheduled task deletes files that are not its own outputs. | `task.retention` | Only the outputs recorded in the task's state are deleted, by exact path; names and patterns are never looked at | Mitigated; a file the user later puts at exactly a recorded path would be deleted (accepted) |
| T13 | I | A Redis URL or a connection string is given to an AI. | `mcp.server` | Tools never return them (`redis_oplog_status` gives the channels, not the URL) | Mitigated |
| T14 | S | TLS with `Allow invalid certificates` or `Allow invalid host names` lets a machine in the middle pose as the server. | the connection form | Off by default, said "only if really needed" | Accepted: the user's explicit choice |
| T15 | T, S | A version the maintainer did not mean is published on the Marketplace: a tag pushed by someone else, a workflow changed on a branch, a token that leaked. | `.github/workflows/release.yml` | [D20](08-decisions.md#d20--a-tag-publishes-the-release-once-the-maintainer-approves): no token is stored; trusted publishing gives a credential of 15 minutes only to the workflow and the environment its policy names; the environment `marketplace` asks the maintainer's approval and takes only `v*` tags; the workflow publishes only a tag on `main` whose version and changelog agree, after the whole of `build.yml` | Mitigated while the environment keeps its required reviewer |
| T16 | E | A file kept in GridFS by someone else (an upload of an application's user) is run when the user opens it from the bucket's tab in the desktop app. | GridFS `Open` | The desktop app hands to the system only the types that programs open as data (`src/shared/openable.ts`) and shows any other file in its folder; the copy goes in a private temporary folder (0700), removed when Mongoster closes | Mitigated |
| T17 | T, E | A repository's `.vscode/settings.json` changes what Mongoster does on the user's machine. | settings | The MCP settings are application settings; `mongoster.savedQueries.folder` from a workspace must stay inside it (`src/projectQueries.ts`) | Mitigated; playgrounds remain (T6) |
| T18 | S | A name or an error text from the database shows as a link in a VS Code notification, and the user clicks it. | notifications | `noLinks` (`src/shared/plainText.ts`) on error texts and on the messages that carry names | Mitigated for errors; some messages with names are not covered yet |
| T19 | E | Another program starts the installed desktop app as a plain Node.js, or with injected code, to act with the app's identity (the keychain entry of the secrets). | the desktop app | Electron fuses in `electron-builder.yml`: no `ELECTRON_RUN_AS_NODE`, `NODE_OPTIONS` or `--inspect`, code only from `app.asar` | Mitigated, partly: the asar's integrity is not validated and the installers are not signed |

## What we do about it

The mitigations above are the rules R14.1 to R14.6, the read-only and confirmation rules R4.1 and R4.2, and the
acceptance lines of the cards named in the table. An **Open** threat is in [13-risks.md](13-risks.md) with what is
planned.

## Secrets

| Secret | Kept in | Who reads it | Never in |
| --- | --- | --- | --- |
| Connection string | `mongoster.uri.<id>` | `ConnectionManager` to connect; `Copy Connection String`; exports with passwords | `globalState`, logs, the form (shown only as typed), the MCP server's answers |
| TLS and SSH options, passwords and passphrases | `mongoster.options.<id>` | `src/transport.ts` | the form (an empty field keeps the saved one), logs |
| Redis URL | `mongoster.redis.<id>` | `src/redisOplog.ts` | `ConnectionInfo`, the MCP server's answers |
| MCP access token | `mongoster.mcp.token` | `src/mcpServer.ts`; the setup command copies it into the client's configuration | logs, a request to another window (which gets a proof of it) |
| Passwords of new MongoDB users | not kept | shown once with `Copy Password` | anywhere after the tab is closed |
| Marketplace credential of a release | nobody: the Marketplace makes it from GitHub's OIDC token, for 15 minutes | `vsce publish --oidc` in the job `marketplace` of `release.yml` (D20) | the repository, GitHub's secrets, the log |

## Input that is not trusted

| Source | What Mongoster does with it |
| --- | --- |
| Documents and values from the database | Shown as text; parsed as BSON by the driver; never evaluated |
| Server replies (`currentOp`, the log, profiler entries) | Shown as text; grouped by `src/shared/profile.ts` |
| Connection files (Compass, Mongoster, lists) | Parsed by `src/shared/connectionsFile.ts`; passwords decrypted only with the user's passphrase |
| Backups (archives, folders) | Parsed by `src/archive.ts`; names decoded by `src/backupNames.ts`; a checksum that does not match stops the restore (what was inserted before stays) |
| Imports (JSON, JSON Lines, CSV, mongosh text) | Parsed by `src/shared/csv.ts` and `src/shared/query.ts`; inserted as documents |
| Saved query files from the project | Parsed as JSON; invalid ones skipped with a warning |
| Playground files | Run only when the user runs them, in a `vm` context that is not a sandbox |
| Requests to the MCP server | Checked by `src/mcp/http.ts` (host, origin, token, size, batch); arguments parsed by `src/mcp/context.ts`; output bounded (`MAX_OUTPUT`, `MAX_TIME_MS`) |
| Files in GridFS | Shown as text, an image or bytes in the tab; opened by the system only when their type is data (`src/shared/openable.ts`) |
| Workspace settings | The MCP settings are not read from them; a saved queries folder outside the workspace is ignored |

## What is not defended

- A user, or a program, with the rights of the user's account on the machine: it can read VS Code's secret storage
  through the system's keychain, `globalState`, and the undo history, which holds documents as they were.
- The undo history and backups are not encrypted: they hold copies of the data, in the user's folders.
- The MongoDB user's own permissions: a read-only connection is a safeguard of Mongoster, not a limit of MongoDB (D6).
- The AI provider: what the MCP server returns goes wherever the assistant sends it (T9).

## Did we do a good enough job

Read this page again when a change adds a secret, a listening port, a kind of file read from outside, a new entry
point that writes, or a dependency; and before each release, with the **Open** rows.
