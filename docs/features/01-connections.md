# Connections

Saved connections: adding them with a connection string or with the connection form (TLS, SSH tunnel, redis-oplog),
testing, editing, copying the connection string, removing and disconnecting them; folders, colors and the read-only
safeguard; the SSH host key check; where the secrets are kept; importing and exporting connections, with the file
formats and the encryption they use. The tree filter belongs to the tree and is not here. The user manual is the
**Connections** item of the README's [Features](../../README.md#features).

## Adding and changing a connection

### `connection.add` — Add a connection with its connection string

Saves a new connection from a connection string and a name, after trying it.

- **Kind**: Operation
- **Function**: `src/extension.ts › addConnection` (with `askConnection`)
- **Implemented in**: `src/connections.ts › ConnectionManager.add`, `ConnectionManager.test`; `package.json` (command,
  menus); `src/standalone/main.ts` (the desktop app's `File` menu)
- **Entry points**: `mongoster.addConnection` (**Add Connection**): `+` in the connections view's title, `+` inline and
  in the context menu of a folder, the Command Palette, the desktop app's `File` menu.
- **Offered when**: `view == mongoster.connections` (title), `viewItem == folder` (folder).
- **Asks**: 1. the connection string, input box titled **Add MongoDB Connection (1/2)**, prompt **Connection string**,
  prefilled `mongodb://localhost:27017`; 2. the name, **Add MongoDB Connection (2/2)**, prompt **Display name**,
  prefilled with the host part of the connection string. Both keep the box open when focus moves away.
- **Reads**: the server, through `ConnectionManager.test` (`buildInfo` on `admin`, server selection 5 seconds).
- **Writes**: the connection string to the secret storage under `mongoster.uri.<id>`; `{ id, name, folder? }` appended
  to the list `mongoster.connections` in `globalState` (`connection.secrets`).
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone from the undo history; `connection.remove` removes the connection.
- **After**: the tree shows the new connection, not connected.
- **Refuses**: a connection string that does not start with `mongodb://` or `mongodb+srv://`.
- **Uses**: `connection.trust-host-key`, `connection.secrets`.
- **Tested by**: *none*.

Acceptance:

- [ ] The first box refuses a text that does not start with `mongodb://` or `mongodb+srv://` with **Must start with
      mongodb:// or mongodb+srv://**; dismissing either box saves nothing.
- [ ] An empty name saves the connection under the host part of the connection string, without the credentials:
      `mongodb://u:p@a:1,b:2/db` is named `a:1,b:2`.
- [ ] The connection is tried before it is saved, with the progress notification **Connecting to <host>…**.
- [ ] When it can't connect, a warning **Could not connect: <reason>** offers **Save Anyway**; dismissing it saves
      nothing.
- [ ] Run on a folder, the connection is saved in that folder; from the view's title, at the top level.
- [ ] The id is the time in base 36 followed by 4 random base-36 characters.

### `connection.edit` — Edit the connection string and the name

Changes the connection string and the name of a connection, trying a new connection string first.

- **Kind**: Operation
- **Function**: `src/extension.ts › askConnection`, then `updateConnection`
- **Implemented in**: `src/connections.ts › ConnectionManager.update`, `ConnectionManager.test`; the
  `connectionChanged` of every tab named in `updateConnection`
- **Entry points**: `mongoster.editConnection` (**Edit Connection…**), first entry of a connection's context menu.
  Hidden from the Command Palette (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem =~ /^connection/`.
- **Asks**: 1. the connection string, **Edit Connection <name> (1/2)**, prefilled with the saved connection string;
  2. the name, **Edit Connection <name> (2/2)**, prompt **Display name**, prefilled with the current name.
- **Reads**: the saved connection string and TLS / SSH options; the server, when the connection string changed.
- **Writes**: a changed connection string to `mongoster.uri.<id>` in the secret storage; the name in
  `mongoster.connections`.
- **Danger**: None: the old connection string is replaced without a confirmation.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: the previous connection string is not kept anywhere.
- **After**: a new connection string closes the open client (`connection.disconnect`): the next use connects with
  the new one. The new name reaches the open tabs at once.
- **Refuses**: the same texts as `connection.add`.
- **Uses**: `connection.trust-host-key`, `connection.secrets`, `connection.disconnect`.
- **Tested by**: *none*.

Acceptance:

- [ ] The connection string box shows the saved connection string as it is, with its password.
- [ ] An unchanged connection string is saved without trying it; a changed one is tried with the connection's TLS and
      SSH settings, under **Connecting to <host>…**, and a failure asks **Could not connect: <reason>** /
      **Save Anyway**.
- [ ] An empty name keeps the current name.
- [ ] After a rename, the open collection, monitor, watch, search, advisor, diagram, compare, structure, users,
      GridFS and document history tabs show the new name.

### `connection.form` — The connection form

The tab where a connection is written with its TLS certificates, SSH tunnel and redis-oplog settings, then tested
and saved.

- **Kind**: View
- **Function**: `src/connectionEditor.ts › ConnectionEditor.show` (with `postInit`, `parse`, `parseRedis`)
- **Implemented in**: `src/webview/connectionEditor.ts`, `media/connectionEditor.css`, `src/shared/messages.ts`
  (`ConnectionForm`, `SavedSecrets`, `ConnectionEditorHostMessage`, `ConnectionEditorViewMessage`),
  `src/extension.ts` (commands, `saveConnection`), `esbuild.mjs`, `.vscodeignore`
- **Entry points**: `mongoster.addConnectionWithOptions` (**Add Connection with TLS / SSH…**): the connections view's
  `…` menu, a folder's context menu, the Command Palette, the desktop app's `File` menu.
  `mongoster.connectionOptions` (**Connection Settings (TLS / SSH)…**): a connection's context menu; hidden from the
  Command Palette (`when: false`), and with no argument it does nothing.
- **Offered when**: `view == mongoster.connections`; `viewItem == folder` (add); `viewItem =~ /^connection/` (settings).
- **Reads**: for an existing connection, its connection string, its TLS / SSH options and its Redis URL from the
  secret storage, its redis-oplog settings from `mongoster.connections`.
- **After**: **Test Connection** (`connection.test`), **Save** (`connection.save`), **Cancel** or `Escape` (closes the
  tab without saving), **Browse…** beside each file (an open dialog titled **Choose the CA certificate**, **Choose
  the client certificate and key (PEM)** or **Choose the SSH private key**, button **Choose**; the certificates are
  filtered to `pem`, `crt`, `cer`, `key`).
- **Refuses**: what `ConnectionEditor.parse` refuses, shown under the form with the field marked and focused (see the
  acceptance).
- **Uses**: `connection.test`, `connection.save`, `connection.secrets`, `oplog.publish`.
- **Tested by**: *none*.
- **Differs**: the connection string and the Redis URL are sent to the form as saved, with the passwords they hold
  (`src/connectionEditor.ts:114`, `:137`), although the README says passwords are never sent back to the form; only
  the key password, the SSH password and the passphrase are kept out. And the tab is created without
  `retainContextWhenHidden` (`src/connectionEditor.ts:76`), unlike the tab pattern of the architecture: switching to
  another tab and back reloads the page, which asks for `init` again and loses what was typed and not saved.

Acceptance:

- [ ] A new connection opens the tab **New Connection** with the heading **New Connection**, the connection string
      `mongodb://localhost:27017`, the SSH port `22`, **Password** authentication and the Redis URL
      `redis://localhost:6379`; focus is on the connection string.
- [ ] An existing connection opens the tab **Connection: <name>** with the heading **Connection <name>**, its saved
      values, and focus on the name.
- [ ] One form per connection, and one for a new connection: opening it again shows the open tab.
- [ ] Sections **TLS / SSL**, **SSH tunnel** and **redis-oplog** each have a checkbox; their fields are disabled while
      it is off. The SSH fields shown follow the authentication: **Password**, **Private key** (file and
      **Passphrase**) or **SSH agent**.
- [ ] (differs) No password is sent to the form: the **Key password**, the SSH **Password** and the **Passphrase** come
      empty, with the placeholder **Saved — leave empty to keep it** when one is saved, and so do the passwords of the
      connection string and of the Redis URL.
- [ ] (differs) What was typed stays in the form while another tab is in front.
- [ ] Refusals, each marking its field: **The connection string must start with mongodb:// or mongodb+srv://**;
      **The CA certificate file does not exist: <path>**; **The client certificate file does not exist: <path>**;
      **The SSH host is missing**; **The SSH port must be a number from 1 to 65535**; **The SSH username is missing**;
      **Choose the private key file**; **The private key file does not exist: <path>**; with the SSH tunnel on, a
      `mongodb+srv://` connection string: **A mongodb+srv:// connection string can not go through an SSH tunnel: use
      the mongodb://host:port form of one of the servers.**; **The Redis URL is missing**; **Invalid Redis URL**;
      **The Redis URL must start with redis:// or rediss://**; **The Redis URL has no host**; a line of **Databases
      and collections** with an empty part (`app.`, `.users`): **Not a database or database.collection: <line>**.
- [ ] **Namespaces** and **Databases and collections** are split at commas and new lines, trimmed, empty entries
      dropped.
- [ ] While a test or a save runs, the three buttons are disabled and read **Testing…** or **Saving…**.

### `connection.test` — Test the connection

Tries what the form says, without saving it, and tells the server version, and whether Redis answers.

- **Kind**: Read
- **Function**: `src/connectionEditor.ts › ConnectionEditor.run` (with `what = 'test'`)
- **Implemented in**: `src/connections.ts › ConnectionManager.test`, `src/transport.ts › openClient`,
  `src/redisOplog.ts › testRedis`, `src/webview/connectionEditor.ts`
- **Entry points**: **Test Connection** in the connection form (`{ type: 'test', form }`).
- **Reads**: `buildInfo` on the `admin` database, with server selection limited to 5 seconds, through the SSH tunnel
  when it is on; `PING` to Redis when redis-oplog is on.
- **Refuses**: what the form refuses (`connection.form`).
- **Uses**: `connection.connect`, `connection.trust-host-key`, `connection.ssh-tunnel-target`.
- **Tested by**: *none*.

Acceptance:

- [ ] Empty password fields are tried with the saved secrets, under the same rules as `connection.save`.
- [ ] Success reads **Connected to <host>: MongoDB <version>.**, or **Connected to <host> through
      <user>@<SSH server>: MongoDB <version>.** with the tunnel, where `<host>` is the host part of the connection
      string.
- [ ] With redis-oplog on, **Redis <host>:<port> answers.** is added; when Redis fails the result is a failure that
      still names MongoDB's version: **<MongoDB part> Could not connect to Redis: <reason>**, marking the Redis URL.
- [ ] A MongoDB failure reads **Could not connect: <reason>**.
- [ ] An unknown SSH server asks for its host key, and the answer is remembered as for a real connection.
- [ ] The client and the tunnel are closed after the test; nothing is saved.

### `connection.save` — Save the connection form

Saves a new connection, or the changes to one, with its TLS, SSH and redis-oplog settings.

- **Kind**: Operation
- **Function**: `src/connectionEditor.ts › ConnectionEditor.run` (with `what = 'save'`); for an existing connection
  `src/extension.ts › saveConnection`
- **Implemented in**: `src/connectionEditor.ts › ConnectionEditor.parse`, `parseRedis`;
  `src/connections.ts › ConnectionManager.add`, `setOptions`, `setRedisOplog`, `update`; `src/extension.ts ›
  updateConnection`
- **Entry points**: **Save** in the connection form, or `Enter` in a field (the form's submit).
- **Writes**: in the secret storage, the connection string (`mongoster.uri.<id>`), the TLS / SSH options as JSON
  (`mongoster.options.<id>`, deleted when both are off) and the Redis URL (`mongoster.redis.<id>`, deleted when
  redis-oplog is off); in `mongoster.connections`, the name, the folder (new connections), the summary `ssh:
  "user@host[:port]"`, `tls: true` and the redis-oplog settings (prefix, namespaces, scope).
- **Danger**: None: the saved settings and secrets are replaced without a confirmation.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: the previous settings and secrets are not kept.
- **After**: the tab closes and the status bar says **Mongoster: connection <name> saved** for 3 seconds. Saving an
  existing connection closes its client (`connection.disconnect`): the next use connects with the new settings.
  The tree shows **SSH** and **redis-oplog** after the name of such connections, and the tunnel and TLS in the
  tooltip (**Through the SSH tunnel <user@host>**, **TLS certificates or options set**).
- **Refuses**: what the form refuses (`connection.form`); an error while saving is shown under the form.
- **Uses**: `connection.secrets`, `connection.disconnect`, `oplog.publish`.
- **Tested by**: *none*.

Acceptance:

- [ ] Save does not try the connection.
- [ ] An empty name saves the host part of the connection string as the name.
- [ ] A new connection opened from a folder is saved in that folder.
- [ ] TLS on without any file stores `tls: {}`, which connects with `tls: true` and the system's authorities.
- [ ] An empty **Key password** keeps the saved one while a client certificate is set; without a client certificate
      the key password is dropped.
- [ ] An empty SSH **Password** or **Passphrase** keeps the saved one only while the SSH server and the user stay the
      same; with another server or user it is dropped (an empty password is then saved as empty).
- [ ] Turning TLS and SSH off deletes `mongoster.options.<id>`; turning redis-oplog off deletes
      `mongoster.redis.<id>`.
- [ ] The new name, color and redis-oplog settings reach the open tabs at once (`updateConnection`).

### `connection.copy-string` — Copy the connection string

Puts the saved connection string on the clipboard, password included.

- **Kind**: Read
- **Function**: `src/extension.ts › activate` (the `mongoster.copyConnectionString` handler)
- **Implemented in**: `src/connections.ts › ConnectionManager.uri`
- **Entry points**: `mongoster.copyConnectionString` (**Copy Connection String**), a connection's context menu. Hidden
  from the Command Palette (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem =~ /^connection/`.
- **Reads**: `mongoster.uri.<id>` in the secret storage.
- **Uses**: `connection.secrets`.
- **Tested by**: *none*.

Acceptance:

- [ ] The clipboard holds the connection string exactly as saved, with its password.
- [ ] The status bar says **Mongoster: connection string copied (it may contain the password)** for 4 seconds.
- [ ] The TLS and SSH settings are not part of what is copied.
- [ ] A connection without a saved connection string copies nothing and says nothing.

### `connection.paste` — Paste a connection as a second connection

Makes a second connection with the settings of a copied one, for a deployment that differs by little: another host,
another user, the same TLS and SSH settings ([README › Copy and Paste in the tree](../../README.md#features)).

- **Kind**: Operation
- **Function**: `src/paste.ts › TreeClipboard.paste` (`pasteConnections`), `src/connections.ts ›
  ConnectionManager.duplicate`
- **Implemented in**: `src/extension.ts` (`mongoster.pasteNode`); `src/shared/paste.ts › copyName`;
  `src/formattingStore.ts › copyConnectionFormatting`
- **Entry points**: `mongoster.pasteNode` (**Paste**) in the context menu of a folder or a connection, group
  `0_clipboard`; `Ctrl+V` (`Cmd+V` on macOS) with the focus in the connections view. Hidden from the Command Palette
  (`when: false`).
- **Offered when**: `mongoster.clipboard == connection && viewItem =~ /^(folder|connection)/`; the key when
  `focusedView == mongoster.connections`.
- **Asks**: nothing.
- **Reads**: the copied connection's entry of `mongoster.connections`; `mongoster.uri.<id>`, `mongoster.options.<id>`
  and `mongoster.redis.<id>` in the secret storage.
- **Writes**: a new entry of `mongoster.connections` with a new id, the name `<name> copy` (`tree.paste-plan`) and
  every other field of the copied one (color, colors of databases and collections, exclusions, read-only, no history,
  the SSH and TLS summaries, the redis-oplog settings); its folder is the folder pasted on, the folder of the
  connection (or of the database or collection) pasted on, or the copied one's own when nothing is selected. The three
  secrets under the new id, when the copied connection has them. The formatting rules of the connection and of its
  databases (`mongoster.formattingConnection.<id>`, `mongoster.formattingDatabase.<id>/<database>`) under the new id.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database; the copy of a read-only connection is read-only.
- **Undo**: Cannot be undone from the undo history; `Remove Connection` removes the copy.
- **After**: the tree shows the copy, disconnected; the status bar says `Mongoster: pasted the connection <name>` (`<n>
  connections` for several) for 5 seconds.
- **Refuses**: every copied connection removed since: `The copied connection has been removed.`
- **Uses**: `tree.copy`, `tree.paste-plan`, `connection.secrets`.
- **Tested by**: `test/unit/paste.test.ts › 'the copy of a connection' › 'has the settings, the secrets and the
  formatting rules of the connection, under a new id'`, `› 'goes to the top level without a folder, and is nothing for
  a removed connection'`; `test/integration/treeClipboard.test.ts` › `'Paste of connections' › 'makes a second connection in the folder pasted
  on, of the connection pasted on, or of the copied one'`. The command: *none*.

Acceptance:

- [ ] `Production` in the folder `Work`, copied and pasted on the folder `Local`, gives `Production copy` in `Local`
  with the same connection string, TLS and SSH settings and Redis URL; pasted again, `Production copy 2`.
- [ ] The copy has its own id: editing or removing it leaves `Production` and its secrets as they were.
- [ ] Not copied: the collections' own formatting rules, column layouts, recent and saved queries, the undo history
  and the scheduled tasks of the copied connection.
- [ ] Pasting connects to nothing.

### `connection.connect` — Connect a connection

Opens the client of a connection the first time something needs it, with its TLS options and through its SSH
tunnel.

- **Kind**: Operation
- **Function**: `src/connections.ts › ConnectionManager.getClient` (with `connect`)
- **Implemented in**: `src/transport.ts › openClient`, `SshTunnel.open`, `tlsClientOptions`, `tunnelTarget`,
  `throughTunnel`
- **Entry points**: anything that reads the database through a connection: expanding it in the tree, opening a tab,
  a scheduled task, a tool of the MCP server.
- **Reads**: the connection string and the TLS / SSH options from the secret storage; the SSH private key file.
- **Writes**: nothing to the database; a local TCP port on `127.0.0.1` for the tunnel.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Nothing to undo: `connection.disconnect` closes it.
- **After**: the tree shows the connection as connected.
- **Refuses**: see the acceptance for the messages.
- **Uses**: `connection.ssh-tunnel-target`, `connection.trust-host-key`, `connection.secrets`.
- **Tested by**: *none*.

Acceptance:

- [ ] One client per connection, shared by every tab and tool until it is disconnected; the client has `appName`
      `mongoster` and a server selection timeout of 10 seconds.
- [ ] A connect that fails is not kept: the next use tries again.
- [ ] Without a saved connection string it fails with **Connection string not found. Remove and re-add this
      connection.**
- [ ] The TLS settings become `tls: true` plus `tlsCAFile`, `tlsCertificateKeyFile`, `tlsCertificateKeyFilePassword`,
      `tlsAllowInvalidCertificates` and `tlsAllowInvalidHostnames` when set.
- [ ] With an SSH tunnel, the SSH server is reached on its port (22 by default) within 15 seconds, with keepalives
      every 30 seconds, authenticated by password, by the private key file (and its passphrase) or by the agent
      (`SSH_AUTH_SOCK`, or `\\.\pipe\openssh-ssh-agent` on Windows).
- [ ] The client then connects to a local port forwarded to the first host of the connection string, as a direct
      connection; with a host name (not an IP address), TLS checks the certificate against that name.
- [ ] SSH failures read **SSH: authentication failed for <user>@<host>:<port>**, **SSH: the host key of
      <host>:<port> was not trusted**, **SSH: no private key file.**, **SSH: can't read the private key <file>:
      <reason>**, **SSH: no SSH agent found (SSH_AUTH_SOCK is not set).**; a forward that fails reads **SSH tunnel:
      <host>:<port> can't reach <target host>:<target port> (<reason>)**.
- [ ] When the SSH connection drops, the connection is disconnected; the next use connects again.

### `connection.disconnect` — Disconnect

Closes the client of a connection, and its SSH tunnel.

- **Kind**: Operation
- **Function**: `src/connections.ts › ConnectionManager.disconnect`
- **Implemented in**: `src/extension.ts` (command)
- **Entry points**: `mongoster.disconnect` (**Disconnect**): inline icon and context menu of a connected connection.
  Hidden from the Command Palette (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem =~ /^connection\.connected/`.
- **Writes**: nothing; closes the `MongoClient` and the SSH tunnel.
- **Danger**: None: no confirmation; an operation still running through the client fails.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Nothing to undo: the next use connects again (`connection.connect`).
- **After**: the tree shows the connection as not connected. Open tabs stay open and connect again when they next
  read.
- **Tested by**: *none*.

Acceptance:

- [ ] After **Disconnect**, the tree no longer shows the connection as connected, and its inline **Disconnect** icon
      is gone.
- [ ] A query run afterwards in an open collection tab connects again without asking.
- [ ] Editing the connection string, saving the connection form and removing the connection disconnect it too.

### `connection.remove` — Remove a connection

Removes a saved connection, with its secrets and its operations in the undo history.

- **Kind**: Operation
- **Function**: `src/extension.ts › activate` (the `mongoster.removeConnection` handler)
- **Implemented in**: `src/connections.ts › ConnectionManager.remove`; `src/history.ts › UndoHistory.clear`; the
  `close` of the tabs; `src/redisOplog.ts` (closes the Redis connection when the connection is gone)
- **Entry points**: `mongoster.removeConnection` (**Remove Connection**), a connection's context menu. Hidden from the
  Command Palette (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem =~ /^connection/`.
- **Asks**: a modal warning **Remove connection "<name>"?** with **Remove**.
- **Writes**: deletes `mongoster.uri.<id>`, `mongoster.options.<id>` and `mongoster.redis.<id>` from the secret
  storage; removes the entry from `mongoster.connections`; deletes the connection's operations from the undo history
  with their files.
- **Danger**: Destructive: the connection string, the TLS / SSH settings with their passwords, the Redis URL, and the
  undo history of every write made through the connection.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone, and the confirmation does not say what is deleted besides the connection.
- **After**: closes the connection's monitor, watch, search, advisor, diagram, compare, structure, users, GridFS,
  document history and connection form tabs.
- **Uses**: `connection.disconnect`, `connection.secrets`, `undo.record`.
- **Tested by**: *none*.
- **Differs**: the architecture says every tab type is closed when its connection is removed, but the collection tabs,
  the playground result tab and the documents and definitions open in editor tabs stay open
  (`src/extension.ts:301-316` does not call `CollectionPanel.close`); their next query fails with **Connection string
  not found. Remove and re-add this connection.**

Acceptance:

- [ ] Only **Remove** removes; dismissing the warning keeps everything.
- [ ] The client and the SSH tunnel are closed before the secrets are deleted.
- [ ] The three secret keys of the connection are gone from the secret storage.
- [ ] The undo history no longer lists any operation of the connection.
- [ ] (differs) Every tab of the connection closes, the collection tabs included.
- [ ] Kept: the known hosts, the scheduled tasks of the connection (they are skipped when they run), and the
      per-collection state in `globalState` (columns, expanded fields, recent and saved queries).

## Organizing connections

### `connection.set-color` — Set the color of a connection

Marks everything of a connection with one of eleven preset colors or a custom one, for example red for production.

- **Kind**: Operation
- **Function**: `src/extension.ts › activate` (the `mongoster.setColor` handler), then `updateConnection`
- **Implemented in**: `src/shared/colors.ts` (`PRESET_COLORS`, `colorChoices`), `src/extension.ts › askColor`,
  `src/connections.ts › ConnectionManager.update`, `src/connectionColors.ts` (`ConnectionDecorations`, `paintTab`,
  `tabIcon`, `themeColorOf`, `connectionUri`), `src/tree.ts` (`ConnectionNode`, `connectionIcon`),
  `src/webview/stripe.ts`, `media/connection/*.svg`, `package.json › contributes.colors`
- **Entry points**: `mongoster.setColor` (**Set Color…**), a connection's context menu. Hidden from the Command Palette
  (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem =~ /^connection/`.
- **Asks**: a quick pick **Color of <name>**, placeholder **Shown on the tree icon and as a stripe on its tabs, e.g.
  red for production**, with **Red**, **Orange**, **Yellow**, **Green**, **Blue**, **Purple**, **Pink**, **Teal**,
  **Indigo**, **Brown**, **Gray** (each with the leaf in its color), **None** and **Custom Color…**
  (`connection.custom-color`); the current one is described **current**.
- **Writes**: `color` of the connection in `mongoster.connections`: a preset name or `#rrggbb` (removed for **None**).
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone from the undo history; choose the previous color again.
- **After**: the tree, the decorations and the open tabs change at once.
- **Tested by**: `test/unit/connectionColors.test.ts › 'connection decorations' › 'colors the tree node, the documents
  and the definitions of a colored connection'`, `› 'leaves alone connections without a color, unknown ones and other
  files'`, `› 'colors the files another source ties to a connection, such as playgrounds'`, `› 'tells the decorations
  changed only when a name or a color changed'`; `› 'tab icons' › "takes the leaf in the connection's color, for light
  and dark themes"`, `› 'keeps the usual icon without a color'`; `test/unit/colors.test.ts › 'the choices of Set
  Color… on a connection' › 'offers the presets with their leaves, None and Custom Color…'`.
- **Differs**: the README says the color applies right away to open tabs, but the playground result tab is not among
  the tabs `updateConnection` tells (`src/extension.ts:73-88`): it takes the color at its next run
  (`src/playground/resultPanel.ts:42`).

Acceptance:

- [ ] Dismissing the quick pick changes nothing.
- [ ] The connection's icon and name in the tree take the preset's theme color (`charts.<color>` or
      `mongoster.color.<color>`, a custom color's nearest preset: `connection.nearest-preset`); the icons of its
      databases, collections and buckets take it too, their names do not.
- [ ] A database (`tree.set-database-color`), collection, view or bucket with a color of its own (`tree.set-collection-color`) keeps it: its icon, tabs and
      editor tabs follow `tree.color-of-collection`, not the connection's color.
- [ ] The tabs of the connection take the leaf icon `media/connection/<color>-light.svg` / `-dark.svg`; without a
      color they keep `media/mongoster.svg` (or `media/collection.svg` for collection tabs).
- [ ] The names of the editor tabs of its documents (`mongoster://`), definitions (`mongoster-def://`) and
      playgrounds take the color, with the connection's name as tooltip.
- [ ] In the desktop app the tabs also get a line of the color above them (`tabColor`), a custom color exactly.
- [ ] The stripe at the top of the tabs' content takes the color, a custom color exactly.
- [ ] Dismissing the Choose a Color tab of **Custom Color…** changes nothing.
- [ ] Decorations are refreshed only when a connection's name or color changes, not when it connects.
- [ ] (differs) An open playground result tab takes the new color at once.

### `connection.custom-color` — Choose a custom color

The **Choose a Color** tab, opened by **Custom Color…** of `connection.set-color`, `tree.set-database-color` and `tree.set-collection-color`:
a color of the user's own, as `#rrggbb`.

- **Kind**: View
- **Function**: `src/colorPicker.ts › pickCustomColor`
- **Implemented in**: `src/webview/colorPicker.ts`, `media/colorPicker.css`; `src/shared/messages.ts`
  (`ColorPickerHostMessage`, `ColorPickerViewMessage`); `src/extension.ts › askColor`; `src/shared/colors.ts`
  (`readColor`, `nearestPreset`, `cssColorOf`)
- **Entry points**: **Custom Color…**, the last item of both `Set Color…` quick picks, described with the custom color
  in use and **current**.
- **Asks**: a tab titled **Color of <name>**, painted with the color being chosen: the system's color picker, a field
  for `#rrggbb` (`#rgb` and a preset name are taken too), the eleven presets as swatches, a preview of the stripe and
  a line saying which preset the tree and the tab icons show (**Shown as <preset> in the tree, on tab icons and on
  the names of editor tabs, which take only the presets.**), **Apply** and **Cancel**.
- **Writes**: nothing itself; **Apply** hands the color to the command that opened it, which writes it as its card
  says.
- **Refuses**: **Apply** is disabled while the field is not a color, with **Enter a color as #rrggbb**.
- **Tested by**: `test/unit/colors.test.ts › 'presets and custom colors' › 'reads a preset name or a hex color, and
  refuses anything else'`. The tab itself: *none*.

Acceptance:

- [ ] It starts on the color in use (a custom color, or a preset), else the connection's color for a collection,
      else blue.
- [ ] The color picker and the field follow each other; a swatch chooses the preset itself (a theme color), not its
      hex value.
- [ ] **Apply** or `Enter` in the field saves and closes the tab; **Cancel**, `Escape` or closing the tab saves
      nothing. Opening another one closes the first, which saves nothing.
- [ ] It works the same in the desktop app.

### `connection.move-to-folder` — Move a connection to a folder

Groups connections in folders of the tree.

- **Kind**: Operation
- **Function**: `src/extension.ts › activate` (the `mongoster.moveToFolder` handler)
- **Implemented in**: `src/connections.ts › ConnectionManager.update`, `ConnectionManager.folders`
- **Entry points**: `mongoster.moveToFolder` (**Move to Folder…**), a connection's context menu. Hidden from the
  Command Palette (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem =~ /^connection/`.
- **Asks**: a quick pick **Move <name> to Folder** with the other existing folders (sorted by name), **New Folder…**
  and, when the connection is in a folder, **No Folder**; **New Folder…** asks for the name (title **New Folder**,
  prompt **Folder name**, refused when empty: **Enter a name**).
- **Writes**: `folder` of the connection in `mongoster.connections` (removed for **No Folder**).
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone from the undo history; move it back.
- **Tested by**: *none*.

Acceptance:

- [ ] The connection's current folder is not offered.
- [ ] A new folder with the name of an existing one puts the connection in that folder.
- [ ] A folder exists only while a connection is in it: moving the last connection out removes the folder from the
      tree.

### `connection.rename-folder` — Rename a folder

- **Kind**: Operation
- **Function**: `src/connections.ts › ConnectionManager.renameFolder`
- **Implemented in**: `src/extension.ts` (the `mongoster.renameFolder` handler)
- **Entry points**: `mongoster.renameFolder` (**Rename Folder…**), a folder's context menu. Hidden from the Command
  Palette (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem == folder`.
- **Asks**: the new name, title **Rename Folder <folder>**, prefilled with the current name.
- **Writes**: `folder` of every connection of the folder in `mongoster.connections`.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone from the undo history; rename it back.
- **Refuses**: an empty name (**Enter a name**) and the name of another existing folder (**This folder already
  exists**).
- **Tested by**: *none*.

Acceptance:

- [ ] Every connection of the folder moves to the new name; the name is trimmed.
- [ ] The same name, or dismissing the box, changes nothing.

### `connection.remove-folder` — Remove a folder, keeping its connections

- **Kind**: Operation
- **Function**: `src/connections.ts › ConnectionManager.renameFolder` (with `to` undefined)
- **Implemented in**: `src/extension.ts` (the `mongoster.removeFolder` handler)
- **Entry points**: `mongoster.removeFolder` (**Remove Folder (Keep Connections)**), a folder's context menu. Hidden
  from the Command Palette (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem == folder`.
- **Writes**: removes `folder` from every connection of the folder in `mongoster.connections`.
- **Danger**: None: no confirmation, no connection is removed.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone from the undo history; move the connections back with `connection.move-to-folder`.
- **Tested by**: *none*.

Acceptance:

- [ ] The folder disappears and its connections are shown at the top level, with their secrets and settings.

## Read-only connections

### `connection.read-only` — Make a connection read-only

Turns on the safeguard that makes Mongoster refuse every write through the connection.

- **Kind**: Operation
- **Function**: `src/extension.ts › activate` (the `mongoster.setReadOnly` handler), then `updateConnection`
- **Implemented in**: `src/connections.ts › ConnectionManager.update` (`ConnectionInfo.readOnly`), `src/tree.ts ›
  ConnectionNode`, the `connectionChanged` of the tabs (`CollectionPanel.connectionChanged` sets `locked` and
  `readOnly`), `src/collectionPanel.ts › readOnlyMessage`
- **Entry points**: `mongoster.setReadOnly` (**Make Read-Only**), a connection's context menu. Hidden from the Command
  Palette (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem =~ /^connection(\.connected)?(\.nohistory)?$/`: the connection is not read-only.
- **Writes**: `readOnly: true` on the connection in `mongoster.connections`.
- **Danger**: None: no confirmation, it only takes rights away.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone from the undo history; `connection.allow-changes` turns it off.
- **After**: the open tabs of the connection become read-only at once.
- **Uses**: `connection.allow-changes`; the writes it stops are those of the cards `document.inline-edit`, `document.insert`,
  `document.delete`, `document.update-many`, `document.delete-many`, `document.edit-in-editor`,
  `document.restore-version`, `field.rename`, `field.remove`, `field.convert-type`, `manage.drop-collection`,
  `manage.drop-database`, `index.create`, `index.edit`, `index.drop`, `transfer.import`, `transfer.generate`,
  `transfer.copy-collection`, `backup.restore`, `compare.copy-document`, `compare.make-like`, `structure.apply`,
  `undo.revert`.
- **Tested by**: *none*.
- **Differs**: documents and definitions already open in editor tabs keep the state they were opened with: their URI
  carries `ro=1` only when they were opened read-only, and saving checks that, not the connection
  (`src/documentFs.ts:84`, `src/definitionFs.ts:103`). A document opened before **Make Read-Only** can still be saved
  to the database afterwards.

Acceptance:

- [ ] The tree shows a lock icon, **read-only** after the name, and the tooltip line **Read-only: Mongoster refuses
      writes through this connection**; the context menu offers **Allow Changes** instead of **Make Read-Only**.
- [ ] Open collection, monitor, watch, search, advisor, diagram, compare, structure, users, GridFS and document history
      tabs of the connection become read-only without being reopened; a write from a collection tab is refused with
      **The connection <name> is read-only.**
- [ ] (differs) A document or definition already open in an editor tab can no longer be saved.
- [ ] Nothing is recorded in or undone from the undo history through the connection.
- [ ] Queries, aggregations, schema, explain and export stay available.
- [ ] Mongoster's own export keeps the flag; importing over a read-only connection with **Replace** keeps it
      read-only (`connection.import`).

### `connection.allow-changes` — Allow changes through a read-only connection

Turns the read-only safeguard off, after a confirmation.

- **Kind**: Operation
- **Function**: `src/extension.ts › activate` (the `mongoster.clearReadOnly` handler), then `updateConnection`
- **Implemented in**: `src/connections.ts › ConnectionManager.update`
- **Entry points**: `mongoster.clearReadOnly` (**Allow Changes**), a read-only connection's context menu. Hidden from
  the Command Palette (`when: false`); with no argument it does nothing.
- **Offered when**: `viewItem =~ /^connection.*\.readonly$/`.
- **Asks**: a modal warning **Allow changes through <name>?**, detail **Documents, indexes, collections and databases
  can then be modified from Mongoster.**, button **Allow Changes**.
- **Writes**: removes `readOnly` from the connection in `mongoster.connections`.
- **Danger**: Confirm: **Allow changes through <name>?**
- **Read-only**: Allowed: it is how the safeguard is turned off; it writes nothing to the database.
- **Undo**: Cannot be undone from the undo history; `connection.read-only` turns it on again.
- **After**: the open tabs of the connection allow writes at once.
- **Tested by**: *none*.

Acceptance:

- [ ] Only **Allow Changes** turns the safeguard off; dismissing the warning keeps the connection read-only.
- [ ] The tree shows the usual server icon again, without **read-only**; the open tabs offer their writes again.
- [ ] Documents opened read-only in editor tabs stay read-only until they are opened again.

## The SSH host key

### `connection.trust-host-key` — Confirm the host key of an SSH server

Trust on first use: the key of an SSH server is shown for confirmation the first time, and a different key later is
a warning.

- **Kind**: Operation
- **Function**: `src/connections.ts › ConnectionManager.checkHostKey`
- **Implemented in**: `src/transport.ts › SshTunnel.open` (`hostVerifier`), `fingerprint`
- **Entry points**: connecting through an SSH tunnel (`connection.connect`), **Test Connection**
  (`connection.test`), trying a new connection string in `connection.add` and `connection.edit`.
- **Asks**: an unknown server: a modal warning **Trust the SSH server <host>:<port>?**, detail **Its host key
  fingerprint is** / the fingerprint / **Compare it with the one of the server (ssh-keygen -lf
  /etc/ssh/ssh_host_ed25519_key.pub) before trusting it. It is remembered for the next connections.**, button
  **Trust**. A server whose key changed: **The SSH host key of <host>:<port> has changed!**, detail **Remembered:
  <old>** / **Now: <new>** / **The server may have been reinstalled, or someone may be intercepting the connection.
  Trust the new key only if you know why it changed.**, button **Trust New Key**.
- **Writes**: the known hosts, `{ "<host>:<port>": "<fingerprint>" }` under `mongoster.knownHosts` in `globalState`
  (not secret).
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: there is no command to forget a known host.
- **Refuses**: a key that is not confirmed: the SSH connection fails with **SSH: the host key of <host>:<port> was
  not trusted**.
- **Tested by**: *none*.

Acceptance:

- [ ] The fingerprint is OpenSSH's: `SHA256:` and the base64 of the SHA-256 of the key, without `=` padding.
- [ ] A key equal to the remembered one connects without asking.
- [ ] Hosts are told apart by `host:port` of the SSH server (port 22 by default), whichever connection uses them.
- [ ] Dismissing either warning refuses the key and remembers nothing.
- [ ] Removing a connection keeps its known hosts.

## Secrets

### `connection.secrets` — Keep the secrets of a connection

Where the connection string, the passwords and the Redis URL of a connection are kept, when they are deleted, and
where they can and cannot go.

- **Kind**: Operation
- **Function**: `src/connections.ts › ConnectionManager` (`add`, `update`, `setOptions`, `setRedisOplog`, `remove`,
  `uri`, `options`, `redisUrl`)
- **Implemented in**: `src/transport.ts` (`ConnectionOptions`); in the desktop app
  `src/standalone/vscode/storage.ts › SecretStorage`, `src/standalone/vscode/index.ts`
- **Entry points**: every card of this area that saves, reads or removes a connection.
- **Writes**: in the secret storage (VS Code's `SecretStorage`; in the desktop app the file `secrets.json` of the app's
  data folder): `mongoster.uri.<id>`, the connection string with its password; `mongoster.options.<id>`, the TLS and
  SSH settings as JSON with the key password, the SSH password and the passphrase (only when TLS or SSH is set);
  `mongoster.redis.<id>`, the Redis URL with its password (only with redis-oplog). In `globalState`
  (`globalState.json` in the desktop app), nothing secret: `mongoster.connections` (id, name, folder, color,
  `readOnly`, `noHistory`, the SSH summary `user@host[:port]`, `tls: true`, the redis-oplog prefix, namespaces and
  scope) and `mongoster.knownHosts`.
- **Danger**: None.
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Cannot be undone: a replaced or deleted secret is not kept anywhere.
- **Uses**: `connection.add`, `connection.edit`, `connection.save`, `connection.remove`, `connection.import`,
  `connection.export`; the access token of `mcp.access-token` is kept in the same storage, under
  `mongoster.mcp.token`.
- **Tested by**: *none*.
- **Differs**: the desktop app keeps a secret in clear text, as `plain:<value>` in `secrets.json`, when the system
  offers no encryption (`safeStorage.isEncryptionAvailable()` false, some Linux sessions;
  `src/standalone/vscode/storage.ts:112`), although the README says connection strings and passwords are encrypted
  with the system's keychain. And the export **Without passwords** keeps the secrets written as options of the
  connection string (see `connection.export`).

Acceptance:

- [ ] Deleted: `mongoster.options.<id>` when the form is saved with TLS and SSH off; `mongoster.redis.<id>` when it is
      saved with redis-oplog off; all three keys when the connection is removed. The connection string is replaced,
      never left behind, when it is edited.
- [ ] In the desktop app each value is `safeStorage.encryptString(value)` in base64, written to `secrets.json` 200 ms
      after the change through a temporary file; a value that can't be decrypted reads as missing, and connecting
      then says **Connection string not found. Remove and re-add this connection.**
- [ ] (differs) In the desktop app no secret is ever written in clear text.
- [ ] No log gets a secret: Mongoster writes no connection string, password, passphrase or Redis URL to its output
      channels or to the console; the errors it shows are the driver's, SSH's and Redis's, which name the host and
      the user, and the Redis check of the MCP server replaces the URL with `<Redis URL>` in its errors.
- [ ] The AI gets no secret: `list_connections` returns the name, the id, the folder, `readOnly` and `connected`.
- [ ] The connection form never gets the key password, the SSH password or the passphrase; it gets the connection
      string and the Redis URL with their passwords (see `connection.form`), and so does the box of
      `connection.edit`.
- [ ] (differs) A file exported **Without passwords** holds no secret of the connection.

## Import and export

### `connection.import` — Import connections

Adds connections from a MongoDB Compass export, a Mongoster export or a list of connection strings, from a file or
the clipboard.

- **Kind**: Operation
- **Function**: `src/connectionsTransfer.ts › importConnections`
- **Implemented in**: `src/connectionsTransfer.ts` (`readSource`, `parse`, `askFolder`, `summary`);
  `src/shared/connectionsFile.ts` (`isEncrypted`, `parseConnections`, `hostOf`, `uniqueName`, `securityNotes`);
  `src/connections.ts › ConnectionManager.add`, `update`, `setOptions`, `setRedisOplog`; `src/extension.ts ›
  updateConnection`
- **Entry points**: `mongoster.importConnections` (**Import Connections…**): the connections view's `…` menu, a
  folder's context menu, the Command Palette.
- **Offered when**: `view == mongoster.connections` (title), `viewItem == folder` (folder).
- **Asks**: 1. **Import Connections**, placeholder **Where are the connections?**: **From a File…** (an open dialog
  with the button **Import**, filtered to `json`, `txt`, `text`, `list`, `csv`, or all files) or **From the
  Clipboard**; 2. for a file with encrypted passwords, the passphrase (password box **Import Connections:
  Passphrase**, prompt **The passwords in this file are encrypted: enter the passphrase used to export it. Leave it
  empty to import without the passwords.**; after a wrong one **Wrong passphrase: try again, or leave it empty to
  import without the passwords.**), decrypted under **Decrypting the passwords…**; 3. the connections, a multiple
  quick pick **Import Connections from <file name or "the clipboard">**, placeholder **<Compass export | Mongoster
  export | list>: <n> connection(s)[ (<n> line(s)/entries were not a connection)]. Choose those to import**; 4. when
  names are taken, a modal warning **A connection named <name> already exists.** or **<n> connections with the same
  name already exist.**, with up to 10 names and **Skip** / **Replace** / **Keep Both**; 5. unless run on a folder,
  **Import Connections: Folder**, placeholder **Where to put the imported connections**: **Folders from the File**
  (only when a chosen connection has a folder), **No Folder**, the existing folders, **New Folder…**.
- **Reads**: the file or the clipboard; the saved connection strings of the connections with the same names.
- **Writes**: per connection, as `connection.secrets` says: the connection string, the TLS / SSH options and the Redis
  URL to the secret storage, the entry with folder, color, the colors of databases and collections, `readOnly` and `noHistory` to
  `mongoster.connections`.
- **Danger**: Confirm, when names are taken: **Skip: leave them out. Replace: the existing connections take the
  connection string and the settings of the imported ones. Keep Both: the imported ones are added with a number after
  the name.**
- **Read-only**: Allowed, because it writes nothing to the database. **Replace** never turns a read-only connection
  writable.
- **Undo**: Cannot be undone: **Replace** overwrites the connection string, the secrets and the settings, and the
  confirmation does not say it can't be undone.
- **After**: an information message **<n> connection(s) imported, <n> connection(s) replaced, <n> skipped.** (or
  **Nothing imported.**), followed, when some came without a password, by **Without a password: <up to 5 names>;
  set it with Edit Connection… or Connection Settings (TLS / SSH)….**
- **Refuses**: **No connections found in <source>[ (…was not a connection)].**; any failure as **Could not import the
  connections: <reason>**, with the reasons of `connection.read-file`.
- **Uses**: `connection.read-file`, `connection.read-list`, `connection.read-compass`, `connection.encryption`,
  `connection.secrets`, `connection.read-only`.
- **Tested by**: *none* for the questions and the saving; `test/unit/connectionsFile.test.ts` (`securityNotes`) for
  what the detail says about TLS, proxy, SSH, redis-oplog and the undo history; the parsing in `connection.read-file`,
  `connection.read-list`, `connection.read-compass`.

Acceptance:

- [ ] Each item shows the name, the host and, for a name already used, **✓ already exists**, or **✓ already exists
      (same connection string)** when the saved connection string is the same; the detail lists the folder, the
      color, **<n> database color(s)**, **<n> collection color(s)**, **read-only**, **TLS**, **SSH <user>@<host>[:<port>]**, **redis-oplog → <host>** and the notes (**no password**, **no SSH
      password**, **passwords not imported (encrypted)**, **In-Use Encryption settings not imported**…).
- [ ] The detail also says what the connection turns off or where else it connects, since the file may come from
      someone else: **invalid certificates allowed** and **invalid host names allowed** (from the TLS settings, or
      `tlsInsecure` / `tlsAllowInvalidCertificates` / `tlsAllowInvalidHostnames` in the connection string), **proxy
      <host>[:<port>]** (`proxyHost`), **signs in with <mechanism>** for `PLAIN`, `MONGODB-AWS`, `MONGODB-OIDC` and
      `GSSAPI` (the password as it is, or the machine's own credentials, go to the file's host), **reads <path>** for
      a TLS or SSH key file on another machine (`\\\\server\\share\\…`), **no undo history**. No password is ever part of it: a Redis URL whose host
      cannot be read shows as **redis-oplog → a host that could not be read**.
- [ ] Connections already there with the same name and the same connection string start unchecked; all others start
      checked.
- [ ] **Skip** leaves out the chosen connections whose name is taken; **Keep Both** adds them as `name (2)`,
      `name (3)`…; dismissing the warning imports nothing.
- [ ] **Replace** gives the existing connection the imported connection string, TLS / SSH options, redis-oplog
      settings, color and `noHistory`, and the chosen folder; it stays read-only if it was, and becomes read-only if
      the imported one is. A file without passwords therefore replaces the saved password with none. The colors of
      databases and those of collections are replaced by the file's, and kept when the file has none.
- [ ] Run on a folder, every imported connection goes to that folder without asking; **Folders from the File** keeps
      each connection's own folder; **New Folder…** asks for a name (**Enter a name** when empty).
- [ ] An empty passphrase imports without the encrypted passwords; dismissing the passphrase box imports nothing.
- [ ] A replaced connection's open tabs take its new name and color at once, and its client is closed.

### `connection.export` — Export connections

Writes the chosen connections to a file for Mongoster, for Compass, or as a list of connection strings, with or
without their passwords.

- **Kind**: Operation
- **Function**: `src/connectionsTransfer.ts › exportConnections`
- **Implemented in**: `src/connectionsTransfer.ts` (`portable`, `askPassphrase`); `src/shared/connectionsFile.ts ›
  serializeConnections`, `Encrypter`
- **Entry points**: `mongoster.exportConnections` (**Export Connections…**): the connections view's `…` menu, a
  folder's context menu, the Command Palette.
- **Offered when**: `view == mongoster.connections` (title), `viewItem == folder` (folder).
- **Asks**: 1. **Export Connections**, placeholder **Choose the connections to export**: every connection, sorted by
  folder then name, described by folder, **SSH**, **TLS**, **redis-oplog**, **read-only**; all checked, or on a folder
  only its own; 2. **Export Connections: Format**: **Mongoster (JSON)**, **MongoDB Compass (JSON)**, **Connection
  strings (text)**; 3. **Export Connections: Passwords**, placeholder **Include the passwords?**: **Without
  passwords** (first), **With passwords, encrypted with a passphrase** (not for the list), **With passwords in clear
  text**; 4. for encryption, the passphrase twice (**Export Connections: Passphrase (1/2)**, refused under 8
  characters with **At least 8 characters**; **(2/2)**, prompt **The same passphrase again**, refused with **The
  passphrases don't match**); for clear text, a modal warning **Export the passwords in clear text?** with **Export
  with Passwords**; 5. where to save, button **Export**, proposing `mongoster-connections.json`,
  `compass-connections.json` or `connections.txt` in the home folder.
- **Reads**: each chosen connection's connection string, TLS / SSH options and Redis URL from the secret storage.
- **Writes**: the file, as `connection.write-file` says.
- **Danger**: Confirm, for clear text: **Export the passwords in clear text?**, detail **The file will contain the
  passwords of the connection strings, SSH and Redis as they are: whoever reads it can connect. Keep it safe, or
  export with a passphrase instead.**
- **Read-only**: Allowed, because it writes nothing to the database.
- **Undo**: Nothing to undo in Mongoster; the file is written where the user chose, replacing a file of that name.
- **After**: **<n> connection(s) exported to <file name>.**, followed by **Note: <what the format left out>.** when
  something was left out.
- **Refuses**: **There are no connections to export.**; any failure as **Could not export the connections:
  <reason>**.
- **Uses**: `connection.write-file`, `connection.encryption`, `connection.secrets`.
- **Tested by**: *none* for the questions; the writing in `connection.write-file`.
- **Differs**: only the user's password of the connection string, the TLS key password of the TLS settings, the SSH
  password and passphrase and the Redis password are taken out (`src/shared/connectionsFile.ts:534-628`). Secrets
  written as options of the connection string stay in it, in clear text, also **Without passwords** and **encrypted
  with a passphrase**: `proxyPassword` and `AWS_SESSION_TOKEN` of `authMechanismProperties` in every format, and
  `tlsCertificateKeyFilePassword` in the Mongoster format and the list when the TLS settings are off. The product
  promises that secrets never reach a file exported without passwords.

Acceptance:

- [ ] Dismissing any question writes nothing.
- [ ] **Without passwords** is the first choice and is offered for every format; the list offers no encryption.
- [ ] (differs) A file exported **Without passwords** contains no password, passphrase or token of any connection,
      including those written as options of a connection string; one exported with a passphrase contains none in
      clear text.
- [ ] Connections whose connection string is missing from the secret storage are left out of the file and of the
      count.
- [ ] The Redis settings are exported only when the Redis URL is saved.
- [ ] The notes read, as they apply: **folders, read-only and redis-oplog were left out (Compass doesn't have
      them)**, **colors of databases and collections were left out (Compass doesn't have them)**, **Compass can't use the SSH agent: those tunnels have no password or key**, **<n> SSH tunnel(s)
      was/were left out (a connection string can't hold one)**, **folders, colors, read-only and redis-oplog were left
      out**.

## Formats of the files

### `connection.read-file` — Read a connections file

Tells the format of the text to import, and reads Mongoster's own export.

- **Kind**: Derivation
- **Function**: `src/shared/connectionsFile.ts › parseConnections` (with `detectFormat`, `isEncrypted`,
  `fromMongoster`)
- **Implemented in**: `src/shared/connectionsFile.ts` (`plain`, `parseJson`, `decryptSecrets`, `missingSecrets`,
  `lacksPassword`, `withPassword`, `colorFrom`)
- **Uses**: `connection.read-list`, `connection.read-compass`, `connection.encryption`, `connection.color-from-compass`.
- **Tested by**: `test/unit/connectionsFile.test.ts › 'detectFormat' › 'tells the formats apart'`, `› 'refuses other
  JSON files and invalid JSON'`; `› 'serializeConnections and back' › 'keeps everything in Mongoster’s format, with the
  secrets in clear or encrypted'`, `› 'drops every secret from Mongoster’s format on request, and says what is
  missing'`, `› 'rejects the wrong passphrase on a Mongoster file'`; `› 'connection strings' › 'knows when a user has
  no password'`; `test/unit/collectionColors.test.ts › 'the colors of collections in connection files' › 'are read
  without the invalid entries, and a file without them reads as before'`, `› 'the color of a collection' › 'reads only
  valid entries from a file'`.

Rules:

- Input: the text of a file or of the clipboard, and the passphrase when there is one. Output: the format
  (`compass`, `mongoster`, `list`), the connections (`PortableConnection`: name, connection string, folder, color,
  colors of databases and collections, `readOnly`, `noHistory`, TLS, SSH, Redis URL and settings, notes) and how many entries were skipped.
- A text that does not start with `{` (after a byte order mark and spaces) is a list (`connection.read-list`).
- JSON whose `type` is `Compass Connections` is Compass's (`connection.read-compass`), `Mongoster Connections`
  Mongoster's; another JSON is refused with **This JSON file is neither a Compass export ("Compass Connections") nor
  a Mongoster export**, invalid JSON with **Not a valid JSON file: <reason>**.
- Canonical Extended JSON numbers (`{ "$numberInt": "1" }`) are read as numbers, `$date` and `$oid` as their values.
- `version` must be 1 (**Unsupported version of the file: <version> (expected 1)**); `connections` must be an array
  (**The file has no list of connections**).
- A file is encrypted when an entry has a non-empty string `connectionSecrets` (Compass) or `secrets` (Mongoster).
- A Mongoster entry without a connection string starting with `mongodb://` or `mongodb+srv://` and a host, or that
  is not an object, is skipped and counted.
- A Mongoster entry gives: the name (trimmed; the host part of the connection string when empty), the folder
  (trimmed), the color (`connection.color-from-compass`), `databaseColors` with only the entries whose key is a database's name
  without a `.` (`readDatabaseColors`, `tree.set-database-color`), `collectionColors` with only the entries whose key has a
  `.` after a non-empty database name and whose value is one of the six colors or `none` (`readCollectionColors` in
  `src/shared/collectionColors.ts`, `tree.set-collection-color`), `readOnly` and `noHistory` only when `true`; `tls` with
  `caFile`, `certificateKeyFile`, the key password only with a certificate file, the two `allowInvalid…` only when
  `true`; `ssh` only with a host, `auth` `privateKey` or `agent` or else `password`, port 22 left out, the password
  for password authentication, the key file and passphrase for a key; `redisOplog` only with a `url`, with `prefix`,
  and `namespaces` and `scope` as trimmed non-empty strings.
- Decrypted secrets (`password`, `tlsCertificateKeyFilePassword`, `sshPassword`, `sshPassphrase`, `redisPassword`)
  win over the same values in clear; the passwords go back into the connection string and the Redis URL.
- Encrypted secrets without a passphrase: left out, with the note **passwords not imported (encrypted)** and no other
  note about missing passwords. A wrong passphrase fails the whole file (`PassphraseError`).
- Notes about what is missing: **no password** when the connection string has a user without a password and its
  `authMechanism` is not `MONGODB-X509`, `GSSAPI`, `MONGODB-AWS` or `MONGODB-OIDC`; **no SSH password** for password
  authentication without one.

Examples:

- `{ "type": "Something" }` → refused, **…neither a Compass export…**.
- A Mongoster file exported **Without passwords** with `uri: "mongodb://ada@db1:27017/app"` and an SSH tunnel by
  password → `uri` as is, `ssh.password: ""`, notes **no password**, **no SSH password**.
- The same file exported with the passphrase `right`, read without a passphrase → `uri:
  "mongodb://ada@db1:27017,db2:27017/app?replicaSet=rs0"`, Redis URL `redis://cache:6379/0`, notes **passwords not
  imported (encrypted)**.
- `mongodb://CN=me@h/?authMechanism=MONGODB-X509` → no **no password** note.

### `connection.read-list` — Read a list of connection strings

- **Kind**: Derivation
- **Function**: `src/shared/connectionsFile.ts › parseList`
- **Implemented in**: `src/shared/connectionsFile.ts` (`isConnectionString`, `hostOf`, `tlsFromUri`,
  `missingSecrets`)
- **Uses**: `connection.tls-in-uri`.
- **Tested by**: `test/unit/connectionsFile.test.ts › 'parseList' › 'reads one connection string per line, with or
  without a name'`, `› 'names a connection after the // comment right above it'`, `› 'takes the TLS files out and
  notes a missing password'`; `› 'connection strings' › 'names a connection after its hosts, without credentials'`.

Rules:

- One connection per line; lines end with `\n` or `\r\n`; a byte order mark is dropped.
- Empty lines and lines starting with `#` or `//` are ignored, not counted.
- A line without `mongodb://` or `mongodb+srv://` (any case) is skipped and counted; so is one whose connection string
  has no host right after the scheme.
- The connection string runs from the scheme to the first space, without trailing `"`, `'`, `` ` ``, `,`, `;`.
- The name is what comes before it, without trailing spaces, `=`, `:`, `,`, `;`, `|`, quotes and without leading
  quotes; without a name, the text of a `//` comment on the line right above, trimmed and without the `//`; without
  either, the host part of the connection string, credentials left out.
- A `//` comment names only the line right below it: an empty line, a `#` comment, another `//` comment or a line
  that is not a connection in between forgets it, and an empty `//` names nothing.
- TLS certificate files in the connection string move to the TLS settings (`connection.tls-in-uri`).
- Notes: **no password** as in `connection.read-file`.

Examples:

- `mongodb://localhost:27017/app` → name `localhost:27017`.
- `Production = mongodb+srv://ada:pw@cluster0.x.mongodb.net/shop?retryWrites=true` → name `Production`, the
  connection string unchanged.
- `"Quoted Name" = "mongodb://h1:27017/db",` → `Quoted Name`, `mongodb://h1:27017/db`.
- `'Single': mongodb://h2/db;` → `Single`, `mongodb://h2/db`; `Tabbed<Tab>mongodb://h3/db` → `Tabbed`.
- `// Production` then `mongodb+srv://ada@cluster0.x.mongodb.net/shop` on the next line → `Production`.
- `// Reports` then `Main = mongodb://r1/db` → `Main`; `// Old`, an empty line, then `mongodb://h1/db` → `h1`.
- `not a connection` and `mongodb:// broken` → skipped (2).
- `Secure = mongodb://ada@h/db?tls=true&tlsCAFile=%2Fca.pem` → `mongodb://ada@h/db`, TLS `{ caFile: "/ca.pem" }`,
  note **no password**.

### `connection.read-compass` — Read a MongoDB Compass export

- **Kind**: Derivation
- **Function**: `src/shared/connectionsFile.ts › fromCompass` (through `parseConnections`)
- **Implemented in**: `src/shared/connectionsFile.ts` (`decryptSecrets`, `withPassword`, `setUriParams`, `tlsFromUri`,
  `colorFrom`, `missingSecrets`)
- **Uses**: `connection.encryption`, `connection.tls-in-uri`, `connection.color-from-compass`.
- **Tested by**: `test/unit/connectionsFile.test.ts › 'parseConnections: Compass' › 'reads a plain export with its
  options'`, `› 'does not take an SSH tunnel for a mongodb+srv string'`, `› 'decrypts the secrets of an export with a
  passphrase'`, `› 'rejects a wrong passphrase, and leaves the secrets out without one'`, `› 'merges an AWS session
  token into the mechanism properties'`.

Rules:

- An entry has `id`, `favorite` (`name`, `color`), `savedConnectionType`, `connectionOptions` (`connectionString`,
  `sshTunnel`, `fleOptions`…) and, when encrypted, `connectionSecrets`. One without a valid `connectionString`, or
  that is not an object, is skipped and counted.
- Decrypted secrets go back as Compass's `mergeSecrets` puts them: `password` into the connection string,
  `tlsCertificateKeyFilePassword` and `proxyPassword` as options of it, `awsSessionToken` as `AWS_SESSION_TOKEN:<token>`
  in `authMechanismProperties`, replacing an older one.
- Then the TLS files move out of the connection string (`connection.tls-in-uri`).
- The name is `favorite.name` trimmed, or the host part; the color is the closest of the six
  (`connection.color-from-compass`).
- `sshTunnel` with a host: with a `mongodb+srv://` connection string it is left out with the note **SSH tunnel not
  imported: a mongodb+srv:// connection string can't go through one**; otherwise port (22 left out), user, and
  `privateKey` authentication when `identityKeyFile` is set (its first element when it is an array, with the
  passphrase), else `password` authentication with the password (empty when unknown). With several hosts the note
  **the SSH tunnel goes to the first host only**.
- Left out with a note: In-Use Encryption (`fleOptions.autoEncryption` not empty: **In-Use Encryption settings not
  imported**), the application proxy (**application proxy setting not imported**).
- Without the passphrase: **passwords not imported (encrypted)**; otherwise **no password** / **no SSH password** as in
  `connection.read-file`.

Examples:

- `favorite: { name: " Prod ", color: "color3" }`, `connectionString:
  "mongodb://admin:secret@db1:27017,db2:27017/?replicaSet=rs0&tls=true&tlsCAFile=%2Fca.pem"`, `sshTunnel: { host:
  "bastion", port: 2222, username: "ubuntu", identityKeyFile: ["/id_rsa"], identityKeyPassphrase: "kp" }`, In-Use
  Encryption set → name `Prod`, `mongodb://admin:secret@db1:27017,db2:27017/?replicaSet=rs0`, TLS `{ caFile: "/ca.pem"
  }`, color `blue`, SSH `{ host: "bastion", port: 2222, username: "ubuntu", auth: "privateKey", privateKeyFile:
  "/id_rsa", passphrase: "kp" }`, notes **the SSH tunnel goes to the first host only**, **In-Use Encryption settings
  not imported**.
- `connectionString: "mongodb://admin@h:27017/?authSource=admin&tlsCertificateKeyFile=%2Fk.pem"`, encrypted secrets
  `{ password: "p%40ss", sshTunnelPassword: "sshpw", tlsCertificateKeyFilePassword: "kp" }`, the right passphrase →
  `mongodb://admin:p%40ss@h:27017/?authSource=admin`, TLS `{ certificateKeyFile: "/k.pem", certificateKeyFilePassword:
  "kp" }`, SSH password `sshpw`, no notes. Without the passphrase → `mongodb://admin@h:27017/?authSource=admin`, SSH
  password empty, note **passwords not imported (encrypted)**.
- `mongodb://key@h/?authMechanism=MONGODB-AWS&authMechanismProperties=AWS_SESSION_TOKEN:old` with the secret
  `awsSessionToken: "tok"` → `…&authMechanismProperties=AWS_SESSION_TOKEN%3Atok`.

### `connection.write-file` — Write a connections file

- **Kind**: Derivation
- **Function**: `src/shared/connectionsFile.ts › serializeConnections`
- **Implemented in**: `src/shared/connectionsFile.ts` (`tlsIntoUri`, `withPassword`, `urlPassword`, `setUriParams`,
  `Encrypter`)
- **Uses**: `connection.encryption`, `connection.tls-in-uri`, `connection.color-from-compass`.
- **Tested by**: `test/unit/connectionsFile.test.ts › 'serializeConnections and back' › 'keeps everything in
  Mongoster’s format, with the secrets in clear or encrypted'`, `› 'drops every secret from Mongoster’s format on
  request, and says what is missing'`, `› 'keeps what Compass has in its format: passwords, TLS, SSH and colors'`, `›
  'round-trips every color through Compass’s codes'`, `› 'drops the secrets from Compass’s format on request'`, `›
  'writes a list of connection strings, with TLS in them and the rest left out'`, `› 'refuses to encrypt a list or
  without a passphrase'`, `› 'notes that Compass cannot use the SSH agent'`;
  `test/unit/collectionColors.test.ts › 'the colors of collections in connection files' › "travel in Mongoster's
  format"`, `› "are left out of Compass's format and of a list, which say so"`.

Rules:

- Input: the connections with their secrets, the format, the secrets mode (`remove`, `include`, `encrypt`) and the
  passphrase. Output: the text (ending with a new line) and the notes on what the format left out.
- Refused: `encrypt` without a passphrase (**A passphrase is needed to encrypt the passwords**), a list with `encrypt`
  (**A list of connection strings can't be encrypted**).
- **Mongoster**: `{ "type": "Mongoster Connections", "version": 1, "secrets": "removed" | "included" | "encrypted",
  "connections": [...] }`, two-space indented; each entry has `name`, `uri`, and when set `folder`, `color`,
  `databaseColors`, `collectionColors`, `readOnly`, `noHistory`, `tls`, `ssh`, `redisOplog` (`url` plus the settings); `color` and the values of
  `databaseColors` and `collectionColors` are a preset name or a custom `#rrggbb`. The secrets taken out are the
  password of the connection string, `tls.certificateKeyFilePassword`, `ssh.password`, `ssh.passphrase` and the
  password of the Redis URL; `include` puts them back in place, `encrypt` writes them as one `secrets` string per
  entry (`{"secrets":{ password, tlsCertificateKeyFilePassword, sshPassword, sshPassphrase, redisPassword }}`
  encrypted), `remove` drops them. Other options of the connection string are written as they are.
- **Compass**: `{ "type": "Compass Connections", "version": 1, "connections": [...] }`; each entry has a new random
  `id`, `favorite: { name, color: <code> }`, `savedConnectionType: "favorite"` and `connectionOptions: {
  connectionString, sshTunnel? }`. The TLS settings are written into the connection string; the password and
  `tlsCertificateKeyFilePassword` are taken out of it, as are the SSH password (`sshTunnelPassword`) and passphrase
  (`sshTunnelPassphrase`); `include` puts them back (the password and the key password in the connection string,
  `password` and `identityKeyPassphrase` in `sshTunnel`), `encrypt` writes `connectionSecrets`, `remove` drops them. An agent tunnel is written without authentication.
  Folders, read-only, `noHistory`, redis-oplog and the colors of databases and collections are left out, with a note.
- **List**: a first line `# Connections exported from Mongoster: name = connection string`, with ` (without
  passwords)` for `remove`, then `<name> = <connection string>` per connection, with new lines and `=` of the name
  turned into spaces; the TLS settings are in the connection string, the key password only with `include`; `remove`
  takes the password out. SSH tunnels, folders, colors (of connections, databases and collections), read-only and redis-oplog
  are left out.

Examples:

- `Full`, `mongodb://ada:p%40ss@db1:27017/app`, folder `Work`, orange, read-only, TLS `{ caFile: "/ca.pem",
  certificateKeyFile: "/k.pem", certificateKeyFilePassword: "kp" }`, SSH `jump:2200` user `me` by password `sshpw`,
  Redis `redis://:r3dis@cache:6379/0` prefix `app:`:
  - Mongoster, `remove` → `"secrets": "removed"`, `"uri": "mongodb://ada@db1:27017/app"`, `"tls": { "caFile": "/ca.pem",
    "certificateKeyFile": "/k.pem" }`, `"ssh": { "host": "jump", "port": 2200, "username": "me", "auth": "password" }`,
    `"redisOplog": { "url": "redis://cache:6379/0", "prefix": "app:" }`.
  - Compass, `remove` → `favorite: { name: "Full", color: "color8" }`, `connectionString:
    "mongodb://ada@db1:27017/app?tls=true&tlsCAFile=%2Fca.pem&tlsCertificateKeyFile=%2Fk.pem"`, `sshTunnel: { host:
    "jump", port: 2200, username: "me" }`, note **folders, read-only and redis-oplog were left out (Compass doesn't
    have them)**.
  - List, `remove` → `Full = mongodb://ada@db1:27017/app?tls=true&tlsCAFile=%2Fca.pem&tlsCertificateKeyFile=%2Fk.pem`,
    notes **1 SSH tunnel was left out (a connection string can't hold one)**, **folders, colors, read-only and
    redis-oplog were left out**.
- Every format read back with `connection.read-file` gives the same connections, less what the format leaves out.

### `connection.encryption` — Encrypt the passwords of a file as Compass does

- **Kind**: Derivation
- **Function**: `src/shared/connectionsFile.ts › Encrypter.encrypt`, `Decrypter.decrypt`
- **Implemented in**: `src/shared/connectionsFile.ts` (`deriveKey`, `PassphraseError`); Node's `crypto`
- **Tested by**: `test/unit/connectionsFile.test.ts › 'encryption' › 'decrypts what Compass encrypts, and what
  Encrypter encrypts'`, `› 'rejects a wrong passphrase, and damaged or unknown data'`.

Rules:

- The key is PBKDF2 with SHA-512, 100,000 iterations, 32 bytes, of the passphrase in UTF-8 and a random 16-byte salt.
- Each value is encrypted with AES-256-GCM, a random 16-byte IV and a 16-byte authentication tag.
- The result is the base64 of: the version `0x0001` (2 bytes, big endian) ‖ salt (16) ‖ IV (16) ‖ tag (16) ‖
  ciphertext. This is the format of Compass's `encrypt.ts`, so each side reads the other's files.
- One salt, and one key derivation, per file; a new IV per value. Decrypting derives the key once per salt.
- The plaintext is the JSON `{"secrets":{…}}` of one connection.
- Refused: data shorter than 50 bytes (**The encrypted data is too short**), another version (**Unknown encrypted
  data version: 0x<n>**), a tag that does not match, from a wrong passphrase or damaged data (`PassphraseError`,
  **Wrong passphrase, or the file is damaged**).
- The export asks for a passphrase of at least 8 characters; the import takes any.

Examples:

- A value encrypted by Compass with `phrase` → decrypted with `phrase` to the same text; with `wrong` →
  `PassphraseError`.
- Two values encrypted by one `Encrypter` → bytes 2–17 (the salt) equal, bytes 18–33 (the IV) different.
- `AAE=` → **The encrypted data is too short**; the version changed to 2 → **Unknown encrypted data version: 0x2**.

### `connection.tls-in-uri` — TLS settings in and out of a connection string

Mongoster keeps the certificate files apart from the connection string; Compass and the list keep them in it.

- **Kind**: Derivation
- **Function**: `src/shared/connectionsFile.ts › tlsFromUri`, `tlsIntoUri`
- **Implemented in**: `src/shared/connectionsFile.ts` (`uriParams`, `setUriParams`)
- **Tested by**: `test/unit/connectionsFile.test.ts › 'TLS options' › 'moves the certificate files and their options
  out of the connection string'`, `› 'leaves the string as it is without files, or with TLS off'`, `› 'writes the TLS
  settings back into a string, the key password only with the secrets'`; `› 'connection strings' › 'sets and removes
  options, keeping the others as written'`.

Rules:

- Out (`tlsFromUri`): only when `tlsCAFile` or `tlsCertificateKeyFile` is set and `tls` (or `ssl`) is not `false`.
  The TLS settings take the two files, the key password (only with a certificate file), and `allowInvalidCertificates`
  / `allowInvalidHostnames` from their options or from `tlsInsecure=true`. The options `tls`, `ssl`, `tlsCAFile`,
  `tlsCertificateKeyFile`, `tlsCertificateKeyFilePassword`, `tlsAllowInvalidCertificates`,
  `tlsAllowInvalidHostnames` and `tlsInsecure` are then removed. Option names are compared ignoring case; values are
  decoded.
- In (`tlsIntoUri`): with TLS settings, sets `tls=true`, the files, the key password only when secrets are included,
  and the two `allowInvalid…` when on, removing `ssl` and `tlsInsecure`; the options are added at the end, encoded,
  replacing those of the same name; the others keep their place and spelling.

Examples:

- `mongodb://h:27017/db?tls=true&tlsCAFile=C%3A%5Ccerts%5Cca.pem&tlsCertificateKeyFile=%2Fk.pem&tlsCertificateKeyFilePassword=kp&tlsAllowInvalidHostnames=true&appName=x`
  → `mongodb://h:27017/db?appName=x` and `{ caFile: "C:\certs\ca.pem", certificateKeyFile: "/k.pem",
  certificateKeyFilePassword: "kp", allowInvalidHostnames: true }`.
- `mongodb://h/?ssl=true&tlsCAFile=ca.pem&tlsInsecure=true` → `{ caFile: "ca.pem", allowInvalidCertificates: true,
  allowInvalidHostnames: true }`.
- `mongodb://h/?tls=true&tlsAllowInvalidCertificates=true` and `mongodb://h/?tls=false&tlsCAFile=ca.pem` → unchanged,
  no TLS settings.
- `mongodb://h/db?ssl=true` with `{ caFile: "ca.pem", certificateKeyFile: "k.pem", certificateKeyFilePassword: "kp",
  allowInvalidCertificates: true }` and secrets →
  `mongodb://h/db?tls=true&tlsCAFile=ca.pem&tlsCertificateKeyFile=k.pem&tlsCertificateKeyFilePassword=kp&tlsAllowInvalidCertificates=true`;
  without secrets, no `kp`.

### `connection.color-from-compass` — The closest color of a Compass connection

- **Kind**: Derivation
- **Function**: `src/shared/connectionsFile.ts › colorFrom` (and `compassColor` for export)
- **Uses**: `connection.nearest-preset`.
- **Tested by**: `test/unit/connectionsFile.test.ts › 'colorFrom' › "maps Compass's color codes and names"`, `›
  "keeps Mongoster's colors, maps hex colors to the closest preset, or keeps them as custom colors"`; `›
  'serializeConnections and back' › 'round-trips every color through Compass’s codes'`; `test/unit/colors.test.ts ›
  "Compass's colors" › 'writes each preset as a Compass code and reads it back; brown goes as orange, a custom color
  as its nearest'`, `› "keeps a custom color in Mongoster's format, and takes it to the nearest preset in
  Compass's"`.

Rules:

- Mongoster's eleven preset names, in any case and with spaces around, are kept.
- Compass's codes: `color1` → green, `color2` → teal, `color3` → blue, `color4` and `iris` → indigo, `color5` →
  purple, `color6` → red, `color7` → pink, `color8` → orange, `color9` → yellow, `color10` → gray.
- A hex color (`#rgb`, `#rrggbb`, with or without `#`), from older Compass: its nearest preset
  (`connection.nearest-preset`). From Mongoster's own format it is kept as a custom color, as `#rrggbb` in lower case.
- Anything else, or not a string: none.
- Export to Compass: red `color6`, orange `color8`, yellow `color9`, green `color1`, blue `color3`, purple `color5`,
  pink `color7`, teal `color2`, indigo `color4`, gray `color10`; brown, which Compass lacks, `color8`; a custom color
  as its nearest preset.

Examples:

- `color3` → blue; `color10` → gray; `' Blue '` → blue; `#ff0000` → red; `#00f` → blue; `ffa500` → orange;
  `#808080` → gray; `#xyz` → none; `3` → none; from Mongoster's format, `#12ABEF` → `#12abef`.

### `connection.nearest-preset` — The preset a custom color shows as

Where VS Code takes only theme colors, a custom color shows as the nearest of the eleven presets.

- **Kind**: Derivation
- **Function**: `src/shared/colors.ts › nearestPreset`
- **Implemented in**: `src/shared/colors.ts` (`themeColorId`, `cssColorOf`, `PRESET_DEFAULTS`);
  `src/connectionColors.ts` (`themeColorOf`, `tabIcon`, `paintTab`); `src/webview/stripe.ts › paintStripe`;
  `src/standalone/theme.ts` (the five contributed presets as CSS variables)
- **Tested by**: `test/unit/colors.test.ts › 'presets and custom colors' › 'takes a custom color to the nearest
  preset'`, `› 'writes a color as CSS: the theme variable of a preset, the custom color as it is'`; `› 'where a custom
  color shows' › "is its nearest preset's theme color and leaf where VS Code takes only those"`, `› "is exact on the
  desktop app's line above the tab"`, `› 'is exact on the stripe of the webviews'`; `› 'the files and theme colors that
  follow the presets' › "contributes the five presets VS Code lacks, with the table's defaults"`, `› 'has a leaf for
  each preset, in its dark and light color'`.

Rules:

- The presets: red, orange, yellow, green, blue, purple (the theme's `charts.<name>`), pink, teal, indigo, brown, gray
  (`mongoster.color.<name>`, contributed with defaults for dark, light and high contrast themes).
- A custom color whose largest and smallest channels differ by less than 0.12 is gray; a dark one (largest channel
  under 0.65) with a hue from 10° to 45° is brown; otherwise the preset of the nearest hue: red 0°, orange 30°, yellow
  55°, green 125°, teal 170°, blue 215°, purple 280°, pink 330°; a blue with a hue of 220° or more and a largest
  channel under 0.8 is indigo.
- The nearest preset is used for: the icons and names in the tree, the tab icons (its leaf), the names of editor tabs.
- The custom color itself is used for: the stripe at the top of the webviews (`--conn-color`), the dot of the
  scheduled tasks, and the desktop app's line above a tab (`tabColor` as a CSS color).

Examples:

- `#ff0000` → red; `#ffa500` → orange; `#20b2aa` → teal; `#1e90ff` → blue; `#5c6bc0` → indigo; `#4b0082` → purple;
  `#ff69b4` → pink; `#8b4513` → brown; `#808080` → gray.

### `connection.ssh-tunnel-target` — Where the SSH tunnel leads

The host the tunnel forwards to, and the connection string the client then uses.

- **Kind**: Derivation
- **Function**: `src/transport.ts › tunnelTarget`, `throughTunnel`
- **Implemented in**: `src/connectionEditor.ts › ConnectionEditor.parse` (checks the connection string with
  `tunnelTarget` when SSH is on)
- **Tested by**: *none*.

Rules:

- The target is the first host of the connection string, its port or 27017; an IPv6 address in brackets loses its
  brackets; the host is percent-decoded.
- Refused: a text that is not a `mongodb://` connection string (**The connection string must start with
  mongodb://**), a `mongodb+srv://` one (**A mongodb+srv:// connection string can not go through an SSH tunnel: use
  the mongodb://host:port form of one of the servers.**), no host (**Unexpected host in the connection string:
  (none)**).
- The client's connection string keeps the scheme, the credentials, the path (`/` when there is none) and the
  options, with the hosts replaced by `127.0.0.1:<local port>` and `directConnection=true` replacing any
  `directConnection` (in any case), added last.

Examples (local port 50000):

- `mongodb://u:p@db1:27018,db2/app?replicaSet=rs0` → target `db1:27018`, client
  `mongodb://u:p@127.0.0.1:50000/app?replicaSet=rs0&directConnection=true`.
- `mongodb://[::1]/?directConnection=false&tls=true` → target `::1:27017`, client
  `mongodb://127.0.0.1:50000/?tls=true&directConnection=true`.
- `mongodb://h` → target `h:27017`, client `mongodb://127.0.0.1:50000/?directConnection=true`.
- `mongodb://a%40b@my%2Dhost:1/db` → target `my-host:1`, client `mongodb://a%40b@127.0.0.1:50000/db?directConnection=true`.
