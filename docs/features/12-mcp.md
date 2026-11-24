# The MCP server

Mongoster's Model Context Protocol server lets an AI assistant on the same computer (GitHub Copilot in VS Code, Claude
Code, Cursor and other MCP clients) work with the saved connections: how the server runs and is reached, its access
token, the setup and port commands, what `mongoster.mcp.readDocuments` hides, the limits every tool keeps, the log, and
the tools, one card per group. The user manual is the README's
[Features › AI assistants (MCP)](../../README.md#features) and the MCP note of its
[Desktop app](../../README.md#desktop-app) section; the code is described in
[Architecture › MCP server](../02-architecture.md#mcp-server).

Every card of this area keeps the promise of [the product](../01-product.md#what-stays-the-same): no tool writes, kills
an operation, changes the profiler or a server setting, or returns a connection string or a Redis URL, and documents
and field values go to the AI only with `mongoster.mcp.readDocuments` on. Each group card has an acceptance line for
it.

### `mcp.server` — Run the MCP server on 127.0.0.1

While `mongoster.mcp.enabled` is on, Mongoster answers the Model Context Protocol on `127.0.0.1`, so that an AI
assistant can call its tools. With several VS Code windows, the window in use has the port.

- **Kind**: Operation
- **Function**: `src/mcpServer.ts › McpServer.restart`, which starts or stops the server to match the settings, with
  `McpServer.start` (taking the port) and `McpServer.handle` (each HTTP request).
- **Implemented in**: `src/extension.ts` (creates the `McpServer` with its `ToolHost` and calls `restart()` at
  activation), `src/shared/mcp.ts › handleMessage` (`mcp.protocol`), `src/mcpTools.ts › mcpTools` (the tools),
  `package.json` (`mongoster.mcp.*`, `contributes.mcpServerDefinitionProviders`), `src/standalone/main.ts` (the
  desktop app's `Tools` menu).
- **Entry points**: the setting `mongoster.mcp.enabled` (turned on by `mcp.setup`); `POST http://127.0.0.1:37017/mcp`
  from an AI client.
- **Offered when**: `mongoster.mcp.enabled` is on; it is off by default.
- **Reads**: the access token in the secret storage under the key `mongoster.mcp.token` (`mcp.access-token`), the
  settings `mongoster.mcp.enabled` and `mongoster.mcp.port`, the window's focus.
- **Writes**: nothing to a database. The first start stores a new access token.
- **Danger**: None.
- **Read-only**: Allowed: the server writes nothing to a database, and its tools read through read-only connections
  too.
- **Undo**: Nothing to undo: turning `mongoster.mcp.enabled` off stops the server.
- **After**: the output channel says `Listening on http://127.0.0.1:37017/mcp` (`mcp.log`); GitHub Copilot is told
  that the server changed (`mcp.setup`).
- **Refuses**: HTTP requests that are not a tool call from a local client with the token, by status (below).
- **Settings**: `mongoster.mcp.enabled` (default off), `mongoster.mcp.port` (default 37017, 1024 to 65535). Changing
  either starts or stops the server again in every window.
- **Uses**: `mcp.access-token`, `mcp.protocol`, `mcp.read-documents`, `mcp.log`, `mcp.change-port`,
  `connection.secrets`.
- **Tested by**: *none*. The HTTP server, the port and the windows have no test; the tool tests call `handleMessage`
  directly.

Acceptance:

- [ ] With `mongoster.mcp.enabled` off nothing listens. Turned on, the server listens at once on `127.0.0.1` on port
  `mongoster.mcp.port` (37017 by default), never on another address.
- [ ] Only `POST /mcp` carrying `Authorization: Bearer <token>` reaches the tools. The answers are plain JSON (the
  Streamable HTTP transport without server-sent events or sessions), each with `Connection: close` and the header
  `x-mongoster-mcp: <version>`, by which another window recognizes Mongoster on the port without sending a token.
- [ ] The checks, in this order: a `Host` other than `127.0.0.1:<port>` or `localhost:<port>` gets 403
  `{ "error": "Forbidden host" }`; an `Origin` other than `http://` or `https://` `127.0.0.1` or `localhost` (any port)
  gets 403 `Forbidden origin`; a path other than `/mcp` and `/mcp/release` gets 404 `Not found`; a missing or wrong
  token gets 401 (`mcp.access-token`); a method other than POST gets 405 with `Allow: POST`; a body over 1 MB gets 413
  `Request too large`; a body that is not JSON gets 400 with the JSON-RPC error -32700 `Parse error`.
- [ ] A JSON array of messages is answered with the array of their answers; a request with only notifications gets 202
  with no body.
- [ ] Several VS Code windows of one installation share the token. The window that gets the focus asks the one with
  the port to release it (`POST /mcp/release` with the token); that window stops listening, lets the calls in progress
  finish and logs `Port 37017 moved to the VS Code window in use: it comes back when this window is used.` The tabs the
  AI opens then appear in the window in use.
- [ ] A window started while another window has the port logs
  `Port 37017 is with Mongoster in another VS Code window: it comes here when this window is used.` and shows nothing.
- [ ] A window without the port checks every 3 seconds whether it is free: when the window that had it closes, another
  one takes it within a few seconds.
- [ ] A port used by another program: the server does not start, the log says
  `Not started: Port 37017 is used by another program.`, and the focused window shows, once per port, the warning
  **Mongoster's MCP server is not running. Port 37017 is used by another program.** with the button **Change Port**,
  which runs `mcp.change-port` with a free port suggested.
- [ ] A port held by Mongoster with another token (the desktop app and VS Code, or two installations of VS Code): the
  first one started keeps it, and the other says
  **Mongoster's MCP server is not running. Port 37017 is used by Mongoster in another VS Code installation, which has a different access token.**
  A port still taken after 20 attempts: **Mongoster's MCP server is not running. Port 37017 is taken and was not
  released.** Any other error of `listen` is said with its own message.
- [ ] The desktop app runs the same server, with its own token in its own secret storage and the same default port.
- [ ] The promise: the server has no route and no tool that writes to a database, kills an operation or changes a
  server setting.

### `mcp.access-token` — Generate a new access token

The AI clients authenticate with a bearer token that Mongoster creates and keeps in the secret storage. A new one
replaces it when the old one may have leaked.

- **Kind**: Operation
- **Function**: `src/mcpServer.ts › McpServer.newToken`; `McpServer.ensureToken` creates the first one.
- **Implemented in**: `src/mcpServer.ts › McpServer.authorized` (the check of each request), `McpServer.readToken` (a
  token generated in another window).
- **Entry points**: **Generate a new access token** in the quick pick of `mcp.setup`; there is no command of its own.
- **Writes**: a token of 32 random bytes, in base64url, to the secret storage under the key `mongoster.mcp.token`.
- **Danger**: None: there is no confirmation. The item's detail says **The configured clients stop working until they
  get the new one**.
- **Read-only**: Allowed: it writes nothing to a database.
- **Undo**: Cannot be undone: the old token is gone. The clients other than Copilot work again once the configuration
  is copied again.
- **After**: the message **Mongoster's MCP server has a new access token: copy the configuration again.**; the log
  line `New access token: the old one no longer works`; GitHub Copilot is given the new token; the other windows of
  the installation read it through the secret storage's change event.
- **Uses**: `mcp.setup`, `connection.secrets`.
- **Tested by**: *none*.

Acceptance:

- [ ] The first start of the server stores a token when there is none. The token never goes to the settings, a file or
  the log; it leaves the secret storage only through the copies of `mcp.setup` and Copilot's server definition.
- [ ] A request without `Authorization`, with something other than `Bearer <token>`, or with another token (compared
  in constant time) gets 401 `{ "error": "Unauthorized" }` with `WWW-Authenticate: Bearer`, before any tool runs;
  nothing is logged for it.
- [ ] After **Generate a new access token**, the old token gets 401 at once in every window of the installation, and
  GitHub Copilot uses the new one without being configured again.

### `mcp.setup` — Set Up MCP Server for AI Assistants…

One command turns the server on and gives the configuration for the AI client in use.

- **Kind**: Operation
- **Function**: `src/mcpServer.ts › McpServer.setup`
- **Implemented in**: `src/extension.ts` (registers `mongoster.mcp.setup`), `src/mcpServer.ts › claudeCommand` and
  `McpServer.registerProvider` (GitHub Copilot), `package.json`, `src/standalone/main.ts` (`Tools` menu).
- **Entry points**: `mongoster.mcp.setup`, **Set Up MCP Server for AI Assistants…**, from the Command Palette; in the
  desktop app also the `Tools` menu.
- **Asks**: a quick pick titled `Mongoster MCP server · <status>`, with the placeholder **GitHub Copilot in VS Code
  finds it on its own. For other AI tools, copy the configuration.** and these items: **Copy the command for Claude
  Code**, **Copy the JSON configuration**, **Show the log** (*The tools the AI called*), **Change the port…**,
  **Generate a new access token**, **Turn the server off**.
- **Writes**: `mongoster.mcp.enabled` set to true in the user settings when it was off; the clipboard.
- **Danger**: None.
- **Read-only**: Allowed: it writes nothing to a database.
- **Undo**: **Turn the server off** sets `mongoster.mcp.enabled` back to false.
- **After**: after a copy, the message **Copied. It contains the access token of the MCP server: keep it private.**
- **Settings**: `mongoster.mcp.enabled`, `mongoster.mcp.port`.
- **Uses**: `mcp.server`, `mcp.access-token`, `mcp.change-port`, `mcp.log`.
- **Tested by**: *none*.

Acceptance:

- [ ] With the server off, the command sets `mongoster.mcp.enabled` to true (user settings) and starts it before the
  quick pick opens; with the server on, it brings the port to this window first.
- [ ] The title's status is `Running on http://127.0.0.1:37017/mcp`, `Running in another VS Code window`, or
  `Not running: <why>` (`starting` when there is no reason yet).
- [ ] **Copy the command for Claude Code** copies
  `claude mcp add --transport http mongoster http://127.0.0.1:37017/mcp --header "Authorization: Bearer <token>"`; its
  detail shows the same command with `…` in place of the token.
- [ ] **Copy the JSON configuration** copies
  `{ "mcpServers": { "mongoster": { "type": "http", "url": "http://127.0.0.1:37017/mcp", "headers": { "Authorization": "Bearer <token>" } } } }`,
  indented by two spaces; its detail is **For the mcpServers of .mcp.json, Cursor, Windsurf and other clients that
  support HTTP servers**.
- [ ] **Show the log** shows the **Mongoster MCP** output channel; **Change the port…** (detail `Now 37017. The
  configured clients need the new address`) runs `mcp.change-port`; **Generate a new access token** runs
  `mcp.access-token`; **Turn the server off** sets the setting to false and stops the server.
- [ ] GitHub Copilot: through VS Code's MCP API (`registerMcpServerDefinitionProvider('mongoster', …)`, declared in
  `contributes.mcpServerDefinitionProviders`) VS Code lists one server, **Mongoster**, with the URL and the
  `Authorization` header while `mongoster.mcp.enabled` is on, and none while it is off; it is told again on every start,
  stop, release of the port and new token. Where the API is missing (an older VS Code, the desktop app) nothing is
  registered and the log says why when registering failed.
- [ ] Escape closes the quick pick: nothing else changes beyond the server turned on.

### `mcp.change-port` — Change MCP Server Port…

Moves the server to another port, for when 37017 is taken or the desktop app and VS Code both run the server.

- **Kind**: Operation
- **Function**: `src/mcpServer.ts › McpServer.changePort`
- **Implemented in**: `src/extension.ts` (registers `mongoster.mcp.changePort`), `src/mcpServer.ts › freePort`,
  `src/standalone/main.ts` (`Tools` menu).
- **Entry points**: `mongoster.mcp.changePort`, **Change MCP Server Port…**, from the Command Palette and the desktop
  app's `Tools` menu; **Change the port…** in `mcp.setup`; **Change Port** on the warning of a taken port
  (`mcp.server`).
- **Asks**: an input box titled **Port of Mongoster's MCP server**, with the prompt
  `On 127.0.0.1, now 37017. The AI clients you configured need the new address afterwards.` (`now 37017 (taken)` when
  the port is taken). The value is the current port, or, when it is taken, the first free port from the next one, up
  to 50 ports further. An entry that is not a number from 1024 to 65535 shows **A number from 1024 to 65535**.
- **Writes**: `mongoster.mcp.port` in the user settings.
- **Danger**: None.
- **Read-only**: Allowed: it writes nothing to a database.
- **Undo**: Run it again with the old port.
- **After**: the server starts again; once it listens on the new port, the message
  `Mongoster's MCP server now listens on port 37018. Give the new address to the AI clients configured with port 37017; GitHub Copilot follows on its own.`
  with the button **Copy Configuration…**, which runs `mcp.setup`.
- **Settings**: `mongoster.mcp.port`.
- **Uses**: `mcp.server`, `mcp.setup`.
- **Tested by**: *none*.

Acceptance:

- [ ] The port is said to be taken when the server is on, does not listen in this window, is not held by another
  window of the installation, and failed to start.
- [ ] Escape, or the port that is already set, changes nothing.
- [ ] With the server off, the new port is saved and nothing starts and nothing is said.
- [ ] When the new port cannot be used either, the message is not shown: the warning of `mcp.server` is.

### `mcp.read-documents` — The tools offered without reading documents

`mongoster.mcp.readDocuments` decides whether the AI may read documents and field values. Turned off, the tools that
return them are not offered: the AI sees the structure, the statistics and the query shapes, and opens tabs where the
user sees the documents.

- **Kind**: Derivation
- **Function**: `src/mcpTools.ts › mcpTools`: its last line leaves out the tools marked `documents: true` when
  `ToolHost.readDocuments()` is false.
- **Implemented in**: `src/shared/mcp.ts` (`McpTool.documents`), `src/extension.ts` (`readDocuments` reads the
  setting, default true), the tools that set `documents: true` in `src/mcpTools.ts`, `src/mcp/changes.ts`,
  `src/mcp/data.ts` and `src/mcp/workspace.ts`.
- **Settings**: `mongoster.mcp.readDocuments` (default on).
- **Uses**: `mcp.protocol`.
- **Tested by**: `test/unit/mcpTools.test.ts › 'mcpTools' › 'leaves out the tools that return documents when readDocuments is off'`,
  `test/unit/mcpWorkspace.test.ts › 'workspace tools' › 'are all read-only, and only the write details return documents'`,
  `test/integration/mcpData.test.ts › 'distinct_values' › 'returns document values, so it is flagged'`.
- **Differs**: three tools offered with the setting off return values from documents or queries:
  `current_operations` gives the command of each running operation, up to 300 characters, with its literal values (an
  insert's documents, an update's new values) (`src/mcp/performance.ts:204`, `commandLine`); `list_saved_queries`
  gives the user's saved and recent queries with the values typed in them (`src/mcp/workspace.ts:119`, `queryLines`);
  `mongoster_writes` gives the labels of the undo history, which carry `_id` values and filters such as
  `Delete document ObjectId("…")` or `Delete many { status: "old" }` (`src/mcp/workspace.ts:104`, `entryLine`). The
  README and the setting's description promise only structure, statistics and query shapes.

Rules:

- Input: the 32 tools of the six groups, and the setting, read again at every request: no restart is needed.
- On (the default): all 32 tools are listed and can be called.
- Off: these six are neither listed by `tools/list` nor callable: `find_documents`, `aggregate`, `distinct_values`,
  `watch_changes`, `write_history`, `mongoster_write_details`. The other 26 stay.
- `tools/list` declares `listChanged: false`: a client that listed the tools before the setting changed keeps its list
  until it lists them again, and a call to a tool left out gets the JSON-RPC error -32602 `Unknown tool: <name>`.

Examples:

- Off, `tools/call` of `find_documents` → error -32602 `Unknown tool: find_documents`.
- Off, `count_documents` with `{ status: "active" }` → `shop.orders: 2 documents match { status: "active" }.` (a
  number, not a value).
- Off, `slow_queries` → shapes such as `find shop.orders: { a: ?, s: ? } · sort { b: 1 }`, never the values of the
  queries.

Acceptance:

- [ ] With the setting off, the six tools above are missing from `tools/list` and a call to any of them is refused as
  an unknown tool.
- [ ] Tools offered with the setting off: `describe_collection` (types and how often fields are present, index
  definitions), `count_documents`, `explain_query` (numbers and the plan of a query the AI wrote), `slow_queries` and
  `index_advice` (query shapes, values as `?`), the deployment tools, and the tools that open tabs (the AI gets a
  sentence, the user the documents).
- [ ] (differs) With the setting off, no tool returns a field value of a document or of a query the AI did not write.

### `mcp.protocol` — Answer a message of the Model Context Protocol

The JSON-RPC 2.0 messages the server understands, and how a tool's success or failure reaches the model.

- **Kind**: Derivation
- **Function**: `src/shared/mcp.ts › handleMessage`
- **Implemented in**: `src/mcpServer.ts › McpServer.handle` (HTTP, batches, the log callback), `INSTRUCTIONS` and
  `ServerInfo` in `src/mcpServer.ts`.
- **Uses**: `mcp.read-documents`, `mcp.log`.
- **Tested by**: *none* of its own. Every integration test of the tools goes through it with
  `test/integration/mcpHelpers.ts › callTool`.

Rules:

- A message that is not an object gets -32600 `Invalid request` with `id: null`. A message without `jsonrpc: "2.0"`
  or a string `method` gets -32600 when it has an `id`, nothing when it is a notification. A notification (no `id`)
  never gets an answer.
- `initialize`: `protocolVersion` is the one asked when it is `2025-06-18`, `2025-03-26` or `2024-11-05`, otherwise
  `2025-06-18`; `capabilities: { tools: { listChanged: false } }`; `serverInfo` `{ name: "mongoster", title:
  "Mongoster", version: <the extension's version> }`; and the instructions, which start
  `Mongoster is the MongoDB extension open in the user's VS Code. Its tools read the connections the user saved there and never write to a database.`
- `ping` gets `{}`.
- `tools/list` gives each tool's `name`, `title`, `description`, `inputSchema` and
  `annotations: { title, readOnlyHint: true, destructiveHint: false, openWorldHint: false }`.
- `tools/call`: an unknown name gets -32602 `Unknown tool: <name>`; arguments that are not an object get -32602
  `The arguments must be an object`; a required argument absent, null or `""` gives the result
  `Missing argument: connection.` (`Missing arguments: database, collection.` for several) with `isError: true`; a
  tool that throws gives its message as the result with `isError: true`; otherwise the result is
  `{ content: [{ type: "text", text }] }`.
- Any other method gets -32601 `Method not found: <method>`.
- Each `tools/call` that reaches a known tool is passed to the log with its outcome: `ok`, `error: <message>` or
  `missing <keys>`.

Examples:

- `{ "jsonrpc": "2.0", "id": 1, "method": "tools/call", "params": { "name": "list_databases", "arguments": {} } }` →
  result `{ content: [{ type: "text", text: "Missing argument: connection." }], isError: true }`.
- `{ "jsonrpc": "2.0", "method": "notifications/initialized" }` → no answer (HTTP 202).
- `{ "jsonrpc": "2.0", "id": 2, "method": "resources/list" }` → error -32601 `Method not found: resources/list`.

Acceptance:

- [ ] Every failure of a tool reaches the model as a result with `isError: true` and a sentence it can act on, not as
  a protocol error.
- [ ] Every tool is announced with `readOnlyHint: true` and `destructiveHint: false`.

### `mcp.arguments` — Read the arguments of a tool

How every tool finds the connection, the database and the collection it is given, and reads its other arguments, with
the refusals the model sees.

- **Kind**: Derivation
- **Function**: `src/mcp/context.ts › toolContext` (`connection`, `required`, `target`, `query`, `pipeline`), with
  `src/shared/mcp.ts › stringArg`, `intArg` and `boolArg`, and `src/mcp/changes.ts › parseTime` and `resumeToken`.
- **Implemented in**: `src/queries.ts › toBson` (mongosh syntax to BSON).
- **Uses**: `mcp.refuse-write-stages`.
- **Tested by**: `test/unit/mcpChanges.test.ts › 'parseTime' › 'reads ISO dates and times ago'` and
  `› 'refuses anything else'`, `test/unit/mcpChanges.test.ts › 'resumeToken' › 'accepts the _data string or { _data }'`
  and `› 'refuses anything else'`,
  `test/integration/mcpTopology.test.ts › 'server_status' › 'names the connections when the one given does not exist'`,
  `test/unit/mcpWorkspace.test.ts › 'mongoster_writes' › 'filters by connection, database, collection and limit'`,
  `test/integration/mcpData.test.ts › 'count_documents' › 'refuses a bad filter and a missing collection'`.

Rules:

- `connection` is a connection's id, or else its name in any case. Two connections with that name:
  `More than one connection is named "<name>": use the id (<id>, <id>).` None:
  `No connection "<name>". Connections: <names>.` (`none` when there is no connection).
- A tool on a connection that is not connected connects it, as opening it in the tree would.
- `database` and `collection` must exist: `<database>.<collection> doesn't exist on <connection>: use list_collections.`
  `collection` without `database` gives `collection needs database.`
- Strings are trimmed and an empty one counts as absent; anything else gives `<key> must be a string.`
- Whole numbers may come as numbers or digit strings: `<key> must be a whole number.`, and outside the range
  `<key> must be between <min> and <max>.`
- Booleans must be `true` or `false`: `<key> must be true or false.`
- `filter`, `sort` and `projection` are mongosh syntax (`ObjectId("…")`, `ISODate("…")`, `/re/i`); a parse error is
  given as the parser says it.
- Times (`since`, `until`) are an ISO date or a time ago: a number and `s`, `m`, `h`, `d` or `w` (`90s`, `15m`, `2h`,
  `1d`, `1w`); anything else gives
  `<key> must be an ISO date (e.g. 2024-05-01T10:00:00Z) or a time ago like "15m", "2h", "1d".`
- A resume token is the hex `_data` string, `{ _data: "…" }` as text, or that object; anything else gives
  `resumeAfter must be the resume token returned by watch_changes: its _data string (hex), or { _data: "…" }.`
- Lists (`operationTypes`, `operations`) are an array or a comma-separated string of known names; an unknown one gives
  `<key>: unknown <names>. Use <allowed>.`

Examples:

- `parseTime("15m", "since", now)` → `now` minus 15 minutes; `parseTime("yesterday", "since")` → the refusal above.
- `resumeToken('{ _data: "82AB" }')` → `{ _data: "82AB" }`; `resumeToken("not a token")` → the refusal above.
- `intArg({ limit: "5" }, "limit", 20, 1, 100)` → 5; `intArg({ limit: 500 }, "limit", 20, 1, 100)` →
  `limit must be between 1 and 100.`
- `{ connection: "nope" }` with one connection named `test` → `No connection "nope". Connections: test.`

Acceptance:

- [ ] A connection is found by id before name, and a name used twice is refused with the ids to choose from.
- [ ] Every refusal above reaches the model as a result with `isError: true` and the exact sentence.

### `mcp.output-limits` — Bound what a tool returns and how long it runs

A result must not flood the model's context, and a query must not run for long on the user's server.

- **Kind**: Derivation
- **Function**: `src/shared/mcp.ts › truncate`, with the constants `MAX_OUTPUT`, `MAX_TIME_MS` and `COUNT_CAP` of
  `src/mcp/context.ts`.
- **Implemented in**: every tool of `src/mcpTools.ts` and `src/mcp/*.ts`; `src/mcp/changes.ts › clipped`.
- **Uses**: `mcp.debugging-tools`.
- **Tested by**: `test/unit/mcpChanges.test.ts › 'clipped' › 'cuts long values saying how much is left out'`,
  `test/integration/mcpChanges.test.ts › 'watch_changes' › 'stops at maxEvents and gives the rest on the next call'`.
  `truncate` has no test of its own.
- **Differs**: `list_connections`, `list_databases` and `list_collections` return their JSON without `truncate`
  (`src/mcpTools.ts:62`, `:78`, `:92`), so a deployment with thousands of databases or collections returns all of
  them; and `listDatabases`, `listCollections`, `currentOp` (`src/mcp/performance.ts:509`) and `getLog`
  (`src/mcp/performance.ts:156`) run without `maxTimeMS`. AGENTS.md asks every tool's output to be bounded by
  `MAX_OUTPUT` and `MAX_TIME_MS`.

Rules:

- `MAX_OUTPUT` is 60,000 characters. A longer text is cut at the last line break before 60,000 when that is past
  30,000, otherwise at 60,000, and ends with `… (output truncated at 60,000 characters)` on a line of its own.
- `MAX_TIME_MS` is 30,000: the `maxTimeMS` of the finds, counts, aggregations, explains and statistics commands the
  tools run.
- `COUNT_CAP` is 100,000: counts stop there unless `exact` is asked (`count_documents`), and the text says
  `at least 100,000 documents`.
- The tools' own bounds: documents and results 1 to 100 (default 20); distinct values 1 to 500 (default 50), each cut
  at 300 characters; a value in a change or an oplog entry cut at 1,500 characters with
  `… (<n> more characters)`; 400 field lines in `describe_collection`; 300 characters of a running operation's
  command.
- `watch_changes` and `write_history` keep 2,000 characters for their head and foot: the events or entries that do not
  fit are left out whole, and `watch_changes`' resume token then points at the last event shown, so the next call gets
  the rest.

Examples:

- A 70,000-character text whose last line break before 60,000 is at 59,990 → its first 59,990 characters, then
  `\n… (output truncated at 60,000 characters)`.
- A 2,000-character value in a change event → its first 1,500 characters and `… (500 more characters)`.

Acceptance:

- [ ] (differs) No tool returns more than 60,000 characters, and every query or command a tool sends carries
  `maxTimeMS: 30000`.

### `mcp.refuse-write-stages` — Refuse pipelines with $out or $merge

Pipelines are the one way a read could write: a pipeline with `$out` or `$merge` is refused before anything is sent.

- **Kind**: Derivation
- **Function**: `src/mcp/context.ts › toolContext` (its `pipeline`), with `src/shared/pipeline.ts › isWriteStage`.
- **Implemented in**: `src/shared/pipeline.ts › textToPipeline`, `src/queries.ts › buildPipeline`; used by
  `aggregate`, `explain_query`, `open_aggregation` and `open_explain`.
- **Uses**: `mcp.arguments`.
- **Tested by**: `test/unit/pipeline.test.ts › 'isWriteStage' › 'is true for enabled $out and $merge stages'`,
  `test/integration/mcpPerformance.test.ts › 'explain_query' › 'refuses $out, and a pipeline together with a filter'`,
  `test/unit/mcpWorkspace.test.ts › 'open tools' › 'open_explain opens a find query or a pipeline with explain'`.

Rules:

- The `pipeline` argument is mongosh text, read into stages as the pipeline editor reads it.
- No stage: `The pipeline is empty.`
- A stage named `$out` or `$merge` (spaces around the name ignored): `<stage> writes to the database: Mongoster's MCP server only reads.`
- Text that cannot be read: `Pipeline: <the parser's message>`.
- Otherwise the stages are built into the pipeline sent to MongoDB, or put in the collection tab.
- `watch_changes`' `filter` is only ever a `$match` of the change stream, so it cannot add a stage.

Examples:

- `[ { $match: {} }, { $out: "copy" } ]` → `$out writes to the database: Mongoster's MCP server only reads.`
- `[ { $merge: { into: "x" } } ]` given to `open_aggregation` → the same refusal for `$merge`; no tab opens.
- `[]` → `The pipeline is empty.`

Acceptance:

- [ ] No tool sends, explains or opens in a tab a pipeline that contains `$out` or `$merge`.

### `mcp.log` — The Mongoster MCP output channel

What the server did and which tools the AI called, for the user to check.

- **Kind**: View
- **Function**: `src/mcpServer.ts › McpServer.log`, with `McpServer.logOnce` for the server's state.
- **Implemented in**: `src/mcpServer.ts › summary` (the arguments on one line), `src/shared/mcp.ts › handleMessage`
  (the outcome of each call).
- **Entry points**: the output channel **Mongoster MCP**; **Show the log** in `mcp.setup`.
- **Uses**: `mcp.server`, `mcp.protocol`.
- **Tested by**: *none*.

Acceptance:

- [ ] Each line starts with the local time in brackets: `[10:20:30] …`.
- [ ] Each call of a known tool is one line: its name, its arguments as JSON (cut at 300 characters with `…`) and the
  outcome: `find_documents {"connection":"Local","database":"shop","collection":"orders"} → ok`, `→ error: <message>`
  or `→ missing connection`.
- [ ] The server's state is logged when it changes, not again by the periodic check: `Listening on <url>`, `Stopped`,
  `Not started: <why>`, the port moved to or held by another window, `New access token: the old one no longer works`,
  and `VS Code's MCP support is not available: <why>`.
- [ ] Not logged: `initialize`, `tools/list`, `ping`, calls of unknown or hidden tools, and the requests refused by
  the HTTP checks. The token is never written.

### `mcp.data-tools` — Explore the connections and read documents

The basic tools: what is saved in Mongoster, what each deployment holds, the shape of a collection, and documents
found with a query or an aggregation.

- **Kind**: Read
- **Function**: `src/mcpTools.ts › mcpTools` (the `run` of `list_connections`, `list_databases`, `list_collections`,
  `describe_collection`, `find_documents` and `aggregate`).
- **Implemented in**: `src/mcp/context.ts` (`toolContext`, `shell`, `documentsText`), `src/shared/schema.ts ›
  analyzeSchema`, `src/mcpTools.ts › flattenFields`, `src/shared/searchIndexes.ts › searchIndexType`.
- **Entry points**: the MCP tools of the same names.
- **Reads**: the connections of the `ConnectionManager` (names, ids, folders, read-only, connected), `listDatabases`,
  `listCollections`, `estimatedDocumentCount`, a `$sample`, `indexes()`, `listSearchIndexes()`, `find`,
  `countDocuments` and `aggregate`.
- **Settings**: `mongoster.mcp.readDocuments` hides `find_documents` and `aggregate`.
- **Uses**: `mcp.arguments`, `mcp.output-limits`, `mcp.refuse-write-stages`, `mcp.read-documents`, `tree.excluded`.
- **Tested by**: `test/unit/mcpTools.test.ts › 'mcpTools' › 'gives every tool a unique name, a description and an object schema'`,
  `› 'offers only read-only tools'`,
  `› 'leaves out the tools that return documents when readDocuments is off'`; the three lists against a fake client:
  `test/unit/exclusions.test.ts › 'the lists of the MCP server' › 'leave out the excluded connections, databases and
  collections'`, `› 'still answer for what is asked for by name, and say when everything is excluded'`. None of the six
  tools is run against a server by a test.

The tools:

| Tool | Arguments | Returns | Without `readDocuments` |
| --- | --- | --- | --- |
| `list_connections` | none | JSON: `name`, `id`, `folder` when set, `readOnly: true` on a read-only connection, `connected`, of the connections not excluded from searches; `No connections are saved in Mongoster.`, or `The user excluded every connection saved in Mongoster from searches.` | offered |
| `list_databases` | `connection` | JSON: `name`, `sizeOnDisk`, `empty` of each database not excluded from searches | offered |
| `list_collections` | `connection`, `database` | JSON sorted by name: `name`, `type`, `viewOn` for a view, of the collections without an exclusion of their own; `<database> has no collections.`, or `The user excluded every collection of <database> from searches.` | offered |
| `describe_collection` | `connection`, `database`, `collection`, `sample` (1 to 1000, default 200) | the estimated count, the indexes with their options, the search indexes when the server has them, and each field of a random sample with its types and how often it is present | offered |
| `find_documents` | `connection`, `database`, `collection`, `filter`, `sort`, `projection`, `skip` (default 0), `limit` (1 to 100, default 20) | how many match and the documents in mongosh syntax | hidden |
| `aggregate` | `connection`, `database`, `collection`, `pipeline`, `limit` (1 to 100, default 20) | the first results in mongosh syntax | hidden |

Acceptance:

- [ ] The promise: `list_connections` never returns a connection string, a password or a Redis URL, and none of these
  tools writes: they send only `listDatabases`, `listCollections`, `$sample`, `listIndexes`, `$listSearchIndexes`,
  `find`, `count`, and `aggregate` without `$out` or `$merge`.
- [ ] `describe_collection` starts with `shop.orders: about 1,234 documents, 200 documents sampled.` (`unknown number
  of` when the estimate fails), lists `Indexes:` as `- name: { key } unique sparse TTL 3600s partial { … } hidden`
  (`- none (a view)` for a view), adds the search indexes (the `index` of `$search` and `$vectorSearch`) only where
  the server has them, and lists up to 400 fields as `- address.city: string 98%, null 2% (100%)`, the percentage in
  brackets being the share of sampled documents that have the field.
- [ ] `find_documents` starts with `shop.orders: 3 documents match, showing 1–3.`; past 100,000 it says
  `At least 100,000 documents match`, and when the count fails `An unknown number of documents match`; with no
  document, `none returned` and `[]`.
- [ ] `aggregate` starts with `shop.orders: 20 results (the first 20; there are more).` when the pipeline gives more
  than `limit`.
- [ ] Values keep their BSON type in the text: `ObjectId("…")`, `ISODate("…")`, `NumberLong(…)`, `Decimal128(…)`.
- [ ] A view can be described, found and aggregated like a collection.

### `mcp.debugging-tools` — Follow what an application writes

The tools for debugging an application: the writes as they happen, the recent writes kept in the oplog, and the writes
made from Mongoster itself with the documents as they were.

- **Kind**: Read
- **Function**: `src/mcp/changes.ts › changesTools` (`watch_changes`, `write_history`) and
  `src/mcp/workspace.ts › workspaceTools` (`mongoster_writes`, `mongoster_write_details`).
- **Implemented in**: `src/mcp/changes.ts › eventText`, `writesFilter`, `updateChanges`, `parseTime`, `resumeToken`;
  `src/replication.ts › oplogEntry`; `src/shared/docHistory.ts › isTransactionEntry`; `src/extension.ts` (the
  `WorkspaceHost`: `history.list()`, `history.recorded(id)`, `history.usage()`).
- **Entry points**: the MCP tools of the same names.
- **Reads**: a change stream (`watch` on a collection, a database or the deployment), `local.oplog.rs`, `hello` and
  `buildInfo`, and the undo history's files.
- **Refuses**: a standalone server for change streams and the oplog; a sharded cluster for the oplog; missing roles
  (below).
- **Settings**: `mongoster.mcp.readDocuments` hides `watch_changes`, `write_history` and `mongoster_write_details`;
  `mongoster.history.enabled` is reported by `mongoster_writes`.
- **Uses**: `mcp.arguments`, `mcp.output-limits`, `mcp.read-documents`, `undo.record`, `undo.limits`.
- **Tested by**:
  `test/integration/mcpChanges.test.ts › 'watch_changes' › 'returns the changes made while it waits, and resumes right after them'`,
  `› 'stops at maxEvents and gives the rest on the next call'`,
  `› 'filters by operation type and with a $match on the event, on the whole database'`,
  `› 'explains the errors: standalone server, bad arguments, invalid token'`;
  `test/integration/mcpChanges.test.ts › 'write_history' › 'shows the writes newest first, filtered by _id, operation and time'`,
  `› 'expands the operations of a transaction'`, `› 'explains the errors: standalone server, bad time'`;
  `test/unit/mcpChanges.test.ts › 'updateChanges' › 'reads a $v 2 diff with nested objects and arrays'`,
  `› 'reads the older $set / $unset form, and says undefined for a replacement'`;
  `test/unit/mcpWorkspace.test.ts › 'mongoster_writes' › 'lists the writes newest first, with counts, undo state and limits'`,
  `› 'filters by connection, database, collection and limit'`,
  `› 'says when the history is off, globally or for the connection'`;
  `test/unit/mcpWorkspace.test.ts › 'mongoster_write_details' › 'returns the documents as they were, by kind'`,
  `› 'limits the documents'`, `› 'refuses unknown and undone writes'`.

The tools:

| Tool | Arguments | Returns | Without `readDocuments` |
| --- | --- | --- | --- |
| `watch_changes` | `connection`, `database`, `collection`, `waitSeconds` (0 to 25, default 10), `maxEvents` (1 to 200, default 50), `resumeAfter`, `operationTypes`, `filter` (a `$match` on the event), `since`, `fullDocument` (default true) | the events: time, operation, namespace, `_id`, fields set and unset, truncated arrays, the document after (and before, where the collection records pre-images); then the resume token | hidden |
| `write_history` | `connection`, `database`, `collection`, `id` (mongosh syntax), `operations` (`insert`, `update`, `delete`, `command`), `since`, `until`, `limit` (1 to 500, default 50) | the oplog's writes, newest first: time, operation, namespace, `_id`, the inserted document, an update's fields set and unset with their values, commands; transactions expanded; the oplog window | hidden |
| `mongoster_writes` | `connection`, `database`, `collection`, `limit` (1 to 200, default 20) | the undo history, newest first: id, time (UTC), connection, `database.collection`, label, counts, undone or undo of | offered |
| `mongoster_write_details` | `id`, `limit` (1 to 100, default 20) | the documents of one write as they were before: updated and deleted in full, inserted by `_id` | hidden |

Acceptance:

- [ ] The promise: these tools write nothing. `watch_changes` only opens a change stream and closes it before
  answering; `write_history` only reads `local.oplog.rs`; the two others only read the undo history's files.
- [ ] `watch_changes` waits up to `waitSeconds`, returns as soon as `maxEvents` arrived, and starts with
  `Changes of shop.orders: 3 events, waited 4 s.`; the head says why it stopped (`stopped at maxEvents (50): more
  changes may be waiting, call again with resumeAfter`, `1 more event didn't fit in the output: call again with
  resumeAfter to get them`, or that the stream was invalidated). It ends with `Resume token: <hex>` and
  `(pass it as resumeAfter to get the changes after these)`; called again with it, it returns the changes right after,
  none lost and none repeated.
- [ ] `watch_changes` refusals: `Change streams need a replica set or a sharded cluster: <connection> is a standalone server.`;
  `Use resumeAfter or since, not both.`; a token older than the oplog (`The resume token is older than the oplog: …`);
  `Invalid resume token: …`; missing roles (`Not authorized to open a change stream on <connection>: …`); expanded
  events (`create`, `createIndexes`, `dropIndexes`, `modify`, `shardCollection`, `refineCollectionShardKey`,
  `reshardCollection`) before MongoDB 6.0 (`… events need MongoDB 6.0 or later.`).
- [ ] `write_history` starts with `Writes to shop.orders (_id "w1", since …), newest first: 3 operations.`, lists the
  operations of a transaction under one heading (`transaction, lsid …, txnNumber …`), and ends with
  `Oplog window: <first> → <last> (3.2 h).`
- [ ] `write_history` refusals: a mongos (`<connection> is a sharded cluster (mongos): the oplog is on each shard. …`),
  a standalone server (`The oplog exists only on replica sets: <connection> is a standalone server. …`), missing roles
  (`Not authorized to read the oplog of <connection>: …`), `since is after until.`, and a read over 30 s that found
  nothing (`Reading the oplog took more than 30 s without finding a match: …`).
- [ ] `mongoster_writes` ends with the limits of the history (`undo.limits`), by default
  `The history keeps up to 200 writes from the last 7 days, of up to 10,000 documents each: older or larger writes aren't listed.`,
  and says when the history is off (`The undo history is off (setting mongoster.history.enabled): new writes aren't recorded.`)
  or a connection's writes are not recorded (`Writes aren't recorded for: Prod (read-only).`).
- [ ] `mongoster_write_details` refuses an unknown id (`No write <id> in the undo history: use mongoster_writes …`)
  and an undone write (`The write u was undone on 2026-01-01T00:00:00Z: its documents are no longer kept.`).
- [ ] `mongoster_writes` stays offered with `mongoster.mcp.readDocuments` off and returns the labels of the undo
  history, which can carry `_id` values and filters (`mcp.read-documents`).

### `mcp.performance-tools` — Find what makes a database slow

How a query runs, the slow operations by query shape, what the server runs now, the indexes to create or drop, and the
size of a collection and of its indexes.

- **Kind**: Read
- **Function**: `src/mcp/performance.ts › performanceTools` (`explain_query`, `slow_queries`, `current_operations`,
  `index_advice`, `collection_stats`).
- **Implemented in**: `src/mcp/performance.ts › explainText`, `groupText`, `operationText`, `commandLine`,
  `adviceText`; `src/shared/explain.ts › summarizeExplain` and `suggestIndex`; `src/shared/profile.ts` (`fromProfileDoc`,
  `fromLogLine`, `groupOps`); `src/shared/advisor.ts › analyze`.
- **Entry points**: the MCP tools of the same names.
- **Reads**: `explain("executionStats")`, `profile: -1` (the level, without changing it), `system.profile`,
  `getLog: "global"`, `currentOp`, `listIndexes`, `$indexStats`, `$collStats`, `estimatedDocumentCount`.
- **Refuses**: missing roles, saying which (`Not authorized to <action>: the user needs the <role> role (…)`).
- **Settings**: none: `mongoster.mcp.readDocuments` hides none of them.
- **Uses**: `mcp.arguments`, `mcp.output-limits`, `mcp.refuse-write-stages`, `mcp.read-documents`.
- **Tested by**:
  `test/integration/mcpPerformance.test.ts › 'explain_query' › 'shows a collection scan and suggests an index, then uses the index once it exists'`,
  `› 'explains a pipeline, with the stages after the query layer'`,
  `› 'refuses $out, and a pipeline together with a filter'`;
  `test/integration/mcpPerformance.test.ts › 'slow_queries' › 'groups the operations recorded by the profiler by shape, without their values, and leaves the profiler as it is'`,
  `› 'says when the profiler is off, and reads the server log'`;
  `test/integration/mcpPerformance.test.ts › 'current_operations' › 'lists an operation running now, with its command and client'`,
  `› 'shows an open transaction among the idle sessions of a replica set'`;
  `test/integration/mcpPerformance.test.ts › 'index_advice' › 'suggests the index missing for the slow queries and finds a redundant one'`;
  `test/integration/mcpPerformance.test.ts › 'collection_stats' › 'gives sizes, compression and the size and uses of each index'`;
  `test/unit/mcpPerformance.test.ts › 'units' › 'writes sizes and durations'`,
  `› 'matches a namespace by database or by collection'`;
  `test/unit/mcpPerformance.test.ts › 'explainText' › 'gives the verdict, the numbers, the suggested index and the plan'`;
  `test/unit/mcpPerformance.test.ts › 'operationText' › 'writes the command without session noise, the client, locks and the transaction'`,
  `› "says when an operation is the server's own, and cuts long commands"`;
  `test/unit/mcpPerformance.test.ts › 'adviceText' › 'lists unused and hidden indexes, and those too recent to tell'`.

The tools (all offered with `mongoster.mcp.readDocuments` off):

| Tool | Arguments | Returns |
| --- | --- | --- |
| `explain_query` | `connection`, `database`, `collection`, and either `filter`, `sort`, `projection`, `limit` (0 for none) or `pipeline` | the plan (COLLSCAN or the index, in-memory sort, rejected plans), keys and documents examined against returned, time, the stages after the query layer, and the index to create by the ESR rule with its `createIndex` command |
| `slow_queries` | `connection`, `database`, `source` (`auto`, `profiler`, `log`), `sinceMinutes` (default 60, 0 for all), `namespace`, `limit` (1 to 200, default 20) | the slow operations grouped by query shape, slowest in total first: count, total, average and maximum time, documents and keys examined against returned, plan, in-memory sort, an index that could help, last time, apps |
| `current_operations` | `connection`, `minSeconds` (default 0), `namespace`, `waitingForLock`, `includeIdle`, `limit` (1 to 500, default 50) | the operations running now, active and longest first: opid, time, type, namespace, the command on one line, plan, client, app, user, locks, transaction |
| `index_advice` | `connection`, `database`, `collection` | the indexes to create for the slow operations with their command and the shapes they serve, the redundant indexes and the one that serves them, the unused and hidden ones, with sizes |
| `collection_stats` | `connection`, `database`, `collection` | documents, data size, storage size and compression, free space, average document, capped, and each index with its size, uses since when, unique, sparse, TTL, partial, hidden, building |

Acceptance:

- [ ] The promise: these tools never change the profiler (they send `profile: -1`, which only reads the level), never
  kill an operation, and never create or drop an index: the `createIndex` commands are only text for the user. After
  `slow_queries` on a database whose profiler is at level 2, the level is still 2.
- [ ] `explain_query` with both a pipeline and `filter`, `sort`, `projection` or `limit` is refused:
  `Give either a pipeline or filter/sort/projection/limit, not both: put a $match, $sort, $project or $limit stage in the pipeline instead.`
  A collection scan reads `Plan: COLLSCAN (every document of the collection is read: no index serves the filter).`
- [ ] `slow_queries` gives shapes with `?` in place of the values (`find shop.orders: { a: ?, s: ? } · sort { b: 1 }`)
  and never the values of the queries. `source: "auto"` reads the profiler of `database` when it is on or has entries,
  otherwise the last 1,024 lines of the server log; `source: "profiler"` without `database` is refused with
  `database is required with source "profiler": each database has its own profiler.` When the profiler is off, the text
  says how to turn it on (the server monitor's Profiler, or `db.setProfilingLevel(1, { slowms: 100 })`) without doing
  it.
- [ ] `current_operations` leaves out its own `currentOp`, the session fields (`lsid`, `$clusterTime`, `txnNumber` and
  the like) and starts with `0 operations running 3600 s or more, in shop (of 12 active).`; without the `inprog`
  privilege it shows the user's own operations and says
  `Only the user's own operations: seeing all of them needs the clusterMonitor role (inprog).`
- [ ] `index_advice` on a view answers that a view has no indexes of its own; with no advice it says
  `No advice: no missing, redundant, unused or hidden index found.`; indexes whose statistics started less than 24 hours
  ago are counted apart, not called unused.
- [ ] `current_operations` is offered with `mongoster.mcp.readDocuments` off and returns each operation's command with
  its literal values (`mcp.read-documents`).

### `mcp.deployment-tools` — Read the state of the deployment

The server's status, the sizes of the databases and collections, the replica set and the sharded cluster, for when the
problem is the deployment rather than the data.

- **Kind**: Read
- **Function**: `src/mcp/topology.ts › topologyTools` (`server_status`, `database_stats`, `replica_set_status`,
  `sharding_status`).
- **Implemented in**: `src/mcp/topology.ts › formatShardingStatus`, `formatBytes`, `formatDuration`;
  `src/replication.ts` (`replMembers`, `helloMembers`, `oplogEntry`); `src/sharding.ts` (`shardingStatus`,
  `shardingEvents`).
- **Entry points**: the MCP tools of the same names.
- **Reads**: `hello`, `buildInfo`, `serverStatus`, `listDatabases`, `dbStats`, `$collStats`, `replSetGetStatus`,
  `replSetGetConfig`, the first and last entries of `local.oplog.rs`, and on a mongos `listShards`, `balancerStatus`,
  `balancerCollectionStatus`, `getShardMap` and the `config` database.
- **Refuses**: a database that does not exist (`The database <name> doesn't exist on <connection>: use list_databases.`).
- **Settings**: none: `mongoster.mcp.readDocuments` hides none of them.
- **Uses**: `mcp.arguments`, `mcp.output-limits`.
- **Tested by**: `test/integration/mcpTopology.test.ts › 'server_status' › 'describes a standalone server'`,
  `› 'describes a replica set member and its state'`,
  `› 'names the connections when the one given does not exist'`;
  `test/integration/mcpTopology.test.ts › 'database_stats' › 'lists every database, largest first, with a total'`,
  `› 'limits the databases listed'`, `› 'lists the collections of one database, largest first'`,
  `› 'limits the collections listed'`, `› 'refuses a database that does not exist'`;
  `test/integration/mcpTopology.test.ts › 'replica_set_status' › 'lists the members of the replica set and the oplog window'`,
  `› 'says that a standalone server is not a replica set'`;
  `test/integration/mcpTopology.test.ts › 'sharding_status' › 'says that a standalone server is not a sharded cluster'`,
  `› 'says that a replica set is not a sharded cluster either'`;
  `test/unit/mcpTopology.test.ts › 'formatBytes and formatDuration' › 'writes sizes with a unit'`,
  `› 'writes durations in days, hours and minutes'`;
  `test/unit/mcpTopology.test.ts › 'formatShardingStatus' › 'lists shards, sharded collections, the balancer, events with failures first, and what could not be read'`,
  `› 'says when the balancer is disabled, and when the events could not be read'`,
  `› 'judges the balance from the data when the balancer status is unknown'`,
  `› 'says what a server that is not a mongos is'`.

The tools (all offered with `mongoster.mcp.readDocuments` off):

| Tool | Arguments | Returns |
| --- | --- | --- |
| `server_status` | `connection` | host, mongod or mongos and version, uptime, storage engine, topology, connections, operation counters (and replicated ones on a replica set), network, memory, WiredTiger cache, global lock queues, asserts, transactions |
| `database_stats` | `connection`, `database`, `limit` (1 to 1000, default 50) | every database (or the one given) largest on disk first, with collections, views, documents, data, storage and index sizes and a total; with `database`, also its collections, largest data first, and its views |
| `replica_set_status` | `connection` | the set's name, term, primary, every member (state, health, uptime, last applied, lag, heartbeat, ping, sync source, priority, votes, hidden, arbiter, delay, tags), the settings and the oplog window and size |
| `sharding_status` | `connection`, `events` (0 to 100, default 20) | on a mongos: the balancer, migrations of the last 24 hours, shards, sharded collections with their key, chunks, data per shard and balance, and the recent changelog events, failures first |

Acceptance:

- [ ] The promise: these tools write nothing and change no setting of the server: they never step down a primary and
  never start or stop the balancer. They show hosts and replica set names, never a connection string.
- [ ] `server_status` on a standalone server says `Topology: standalone server.`; on a primary,
  `Topology: member of the replica set rs0, state PRIMARY; primary host:27017, 1 electable member`.
- [ ] Without the role a command needs, the tools show what they could read and say which role is missing:
  `serverStatus could not be read: … (needs the clusterMonitor role). Only what hello and buildInfo tell is shown.`
- [ ] `replica_set_status` on a standalone server says `<host> is a standalone server, not a replica set member: there are no members, no replication and no oplog.`,
  and on a mongos points to `sharding_status`.
- [ ] `sharding_status` on a server that is not a mongos says what it is (`… is a standalone server: it is not a sharded cluster.`,
  `… is a replica set member, not a mongos: it is not a sharded cluster (use replica_set_status).`).

### `mcp.data-model-tools` — Answer quick questions about the data model

Counts, the values of a field, the references between collections, a collection's definition, the queries the user
saved, and whether a connection publishes to redis-oplog.

- **Kind**: Read
- **Function**: `src/mcp/data.ts › dataTools` (`count_documents`, `distinct_values`, `describe_relations`,
  `collection_options`) and `src/mcp/workspace.ts › workspaceTools` (`list_saved_queries`, `redis_oplog_status`).
- **Implemented in**: `src/mcp/data.ts › distinctPipeline`, `relationLine`, `optionsText`;
  `src/relationsAnalysis.ts › analyzeRelations`; `src/sharding.ts › formatShardKey`; `src/shared/oplog.ts › inScope`
  and `oplogMessage`; `src/extension.ts` (the `WorkspaceHost`: `queries`, `redisUrlSet`, `checkRedis`,
  `redisLastError`).
- **Entry points**: the MCP tools of the same names.
- **Reads**: `countDocuments`, `estimatedDocumentCount`, an aggregation for the distinct values, samples of every
  collection of a database, `listCollections`, `config.collections`; the user's saved and recent queries and the
  project's query files; whether the connection's Redis URL is stored, and with `check` a `PING` to Redis.
- **Settings**: `mongoster.mcp.readDocuments` hides `distinct_values`.
- **Uses**: `mcp.arguments`, `mcp.output-limits`, `mcp.read-documents`, `oplog.publish`.
- **Tested by**: `test/integration/mcpData.test.ts › 'count_documents' › 'counts all the documents, with the estimate'`,
  `› 'counts the documents that match a filter, without the estimate'`, `› 'counts a view'`,
  `› 'refuses a bad filter and a missing collection'`;
  `test/integration/mcpData.test.ts › 'distinct_values' › 'counts the values of a field, unwinding arrays once per document'`,
  `› 'shows the types of mixed values, and null and missing'`,
  `› 'follows a path into an array of documents, with a filter and a limit'`,
  `› 'refuses a bad field and a bad filter'`, `› 'returns document values, so it is flagged'`;
  `test/integration/mcpData.test.ts › 'describe_relations' › 'finds ObjectId references and arrays of named string ids'`,
  `› "shows only a collection's outgoing and incoming references"`, `› 'shows views on their collection'`;
  `test/integration/mcpData.test.ts › 'collection_options' › 'shows a $jsonSchema validator with its level and action'`,
  `› 'shows a query validator'`, `› 'shows a plain collection, a capped one and a collation'`,
  `› 'shows a view and a time series collection'`, `› 'refuses a missing collection'`;
  `test/unit/mcpWorkspace.test.ts › 'list_saved_queries' › 'lists saved and recent queries in mongosh text'`,
  `› "lists the project's queries first, with their file"`, `› 'checks the collection exists when nothing is stored'`;
  `test/unit/mcpWorkspace.test.ts › 'redis_oplog_status' › 'says when the connection does not publish'`,
  `› 'gives the settings and the channels of a published collection'`,
  `› 'tells whether a database is published, wholly or in part'`,
  `› 'checks Redis and reports the last error without URLs'`.

The tools:

| Tool | Arguments | Returns | Without `readDocuments` |
| --- | --- | --- | --- |
| `count_documents` | `connection`, `database`, `collection`, `filter`, `exact` (default false) | the count, stopping at 100,000 unless `exact`; with no filter also the estimate from the metadata | offered |
| `distinct_values` | `connection`, `database`, `collection`, `field` (a path), `filter`, `limit` (1 to 500, default 50) | the values most frequent first with how many documents have each, their types when mixed, the number of distinct values, and the documents with null and without the field | hidden |
| `describe_relations` | `connection`, `database`, `collection`, `sample` (1 to 2000, default 100) | the fields that reference other collections (`orders.customerId → customers._id (one per document; 20 of 20 sampled values found, 100%)`), DBRefs and views; with `collection`, only those from and to it | offered |
| `collection_options` | `connection`, `database`, `collection` | the kind (collection, capped, clustered, view, time series), validator with its level and action, a view's source and pipeline, capped size, time series options, clustered index, `expireAfterSeconds`, collation, pre- and post-images, shard key | offered |
| `list_saved_queries` | `connection`, `database`, `collection` | the saved queries, the project's first with their file, then the user's, and the recent ones, newest first, as written | offered |
| `redis_oplog_status` | `connection`, `database`, `collection`, `check` (default false) | whether the connection publishes, whether its Redis URL is set, the channel prefix, namespaces and patterns published, the channels of a collection, the last publishing error, and with `check` whether Redis answers | offered |

Acceptance:

- [ ] The promise: these tools write nothing to a database or to Redis (`check` sends only `PING`), and
  `redis_oplog_status` never returns the Redis URL: it says `Redis URL: set.` or
  `Redis URL: missing: nothing can be published until it is set again in the connection.`, and any `redis://` or
  `rediss://` text in an error becomes `<Redis URL>`.
- [ ] `count_documents` with no filter says `shop.items has 5 documents.` and
  `Estimate from the collection's metadata: 5 documents.`; with a filter, `shop.items: 2 documents match { status: "active" }.`
  (`1 document matches`); past 100,000 without `exact`, `at least 100,000 documents` and
  `(counting stopped there: pass exact: true for the exact number)`. A failing count gives `The count failed: …`.
- [ ] `distinct_values` counts an array's element once per document, and refuses a field that starts with `$` or has an
  empty part (`field must be a field path like address.city, not "$status".`); a failing aggregation gives
  `The aggregation failed: …`. Each value is cut at 300 characters.
- [ ] `collection_options` explains the validation: `validationLevel: strict (default): every insert and update is validated.`,
  `validationAction: error (default): invalid writes are refused (error 121, Document failed validation).`, or
  `No validator: any document is accepted.`
- [ ] `list_saved_queries` on a collection with nothing stored checks that the collection exists, then says
  `No saved or recent queries for shop.orders on Local.`
- [ ] `redis_oplog_status` on a connection that does not publish says
  `<connection> doesn't publish Mongoster's writes to Redis for redis-oplog (it can be turned on in the connection's options).`;
  on a read-only connection it adds that nothing is published.
- [ ] `list_saved_queries` is offered with `mongoster.mcp.readDocuments` off and returns the values typed in the
  queries (`mcp.read-documents`).

### `mcp.tab-tools` — Open Mongoster's tabs for the user

When the user wants to see, browse or edit the results, the AI opens them in Mongoster: a query, an aggregation, a
search, a change stream, the server monitor, an explain plan or the undo history.

- **Kind**: Read
- **Function**: `src/mcpTools.ts › mcpTools` (`open_query`, `open_aggregation`, `open_search`) and
  `src/mcp/workspace.ts › workspaceTools` (`open_watch`, `open_monitor`, `open_explain`, `open_history`).
- **Implemented in**: `src/extension.ts` (the `WorkspaceHost` and `ToolHost.openSearch`: `mongoster.openQuery`,
  `WatchPanel.show`, `MonitorPanel.show`, `SearchPanel.show`, `HistoryPanel.show`), `src/mcp/workspace.ts ›
  MONITOR_TABS`.
- **Entry points**: the MCP tools of the same names.
- **Reads**: that the collection exists; `hello`, for `open_watch` to tell a standalone server.
- **After**: the tab opens, in the window that has the port (the one used last), and runs what it was given; the AI
  gets one sentence.
- **Settings**: none: `mongoster.mcp.readDocuments` hides none of them.
- **Uses**: `mcp.arguments`, `mcp.refuse-write-stages`, `undo.show`.
- **Tested by**: `test/unit/mcpWorkspace.test.ts › 'open tools' › 'open_watch opens the scope, checking the collection and the deployment'`,
  `› 'open_monitor opens a section'`, `› 'open_explain opens a find query or a pipeline with explain'`,
  `› 'open_history opens the Undo History tab'`. `open_query`, `open_aggregation` and `open_search` have no test.

The tools (all offered with `mongoster.mcp.readDocuments` off):

| Tool | Arguments | Opens, and answers |
| --- | --- | --- |
| `open_query` | `connection`, `database`, `collection`, `filter`, `sort`, `projection` | the collection tab with the query filled in and run; `Opened shop.orders on Local with the filter { a: 1 }, sort { b: -1 }.` |
| `open_aggregation` | `connection`, `database`, `collection`, `pipeline` | the collection tab in Aggregate mode with the stages, run; `Opened shop.orders on Local in Aggregate mode with 2 stages: $match, $group.` |
| `open_search` | `connection`, `database`, `collection`, `text`, `regex`, `matchCase`, `fieldNames`, `views` (all default false), `limit` (0, 1000, 10000 or 100000; default 0, all) | the global search tab, searching; `Opened the search for "…" in every database on Local. The results appear in Mongoster's Search tab.` |
| `open_watch` | `connection`, `database`, `collection` | the Watch tab on the scope; `Opened the Watch tab on shop.orders of Local.` |
| `open_monitor` | `connection`, `section` (`operations`, `slow-queries`, `stats`, `replication`, `sharding`) | the server monitor on that section; `Opened the server monitor of Prod on slow-queries.` |
| `open_explain` | `connection`, `database`, `collection`, and either `filter`, `sort`, `projection` or `pipeline` | the collection tab with the query or the stages and its explain plan; `Opened shop.orders on Local with the filter { a: 1 }, sort { b: -1 } and its explain plan.` |
| `open_history` | none | the Undo History tab; `Opened the Undo History tab (1 write recorded; the history is off, new writes are not recorded).` |

Acceptance:

- [ ] The promise: opening a tab writes nothing. The tabs open with what the user can do there (edit, kill an
  operation, undo, change the profiler), but no tool clicks for the user: those stay the user's own actions, with their
  own confirmations.
- [ ] A pipeline with `$out` or `$merge` is refused and no tab opens (`mcp.refuse-write-stages`); a collection that does
  not exist is refused before anything opens.
- [ ] `open_explain` with both a pipeline and `filter`, `sort` or `projection` is refused with
  `Give either filter/sort/projection or pipeline, not both.`
- [ ] `open_search` refuses `collection` without `database` (`collection needs database.`), an invalid regular
  expression (`Invalid regular expression: …`) and a `limit` not in the list (`limit must be one of 0, 1000, 10000, 100000.`).
- [ ] `open_watch` on a standalone server still opens the tab and adds
  `The server is a standalone: change streams need a replica set or a sharded cluster, so the tab shows an error.`
- [ ] `open_monitor` refuses an unknown section: `section must be one of operations, slow-queries, stats, replication, sharding.`
