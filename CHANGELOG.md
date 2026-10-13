# Changelog

## Unreleased

- MCP server with several VS Code windows open: the tabs the AI opens appear in the window you used last, instead of the first one opened. The port follows the focus, and is taken over within a few seconds when the window that had it is closed.
- `Mongoster: Change MCP Server Port…`, also in the setup command. When another program is using the port, a warning says so and `Change Port` suggests a free one, instead of only a line in the log.
- A new access token generated in one window now applies to the others right away.
- Disconnecting a connection that is expanded in the tree no longer reconnects it at once: it collapses and stays disconnected until it is expanded again.

## 0.2.0

- **MCP server for AI assistants**: GitHub Copilot, Claude Code, Cursor and other MCP clients can list the connections, databases and collections, describe a collection's fields and indexes, run read-only queries and aggregations, and open a query, an aggregation or a global search in Mongoster's tabs. `Mongoster: Set Up MCP Server for AI Assistants…` turns it on and copies the configuration. It listens on `127.0.0.1` with an access token, never writes, and `mongoster.mcp.readDocuments` can keep documents from the AI.

## 0.1.1

- Values in the table, the playground results, the server monitor, the global search and the index advisor take the syntax colors of the active color theme, and change with it.
- In a narrow tab, the filter keeps a usable width: its buttons, the top bar, Sort / Project, the pipeline buttons and the status bar wrap instead of squeezing it.
- Popups use the theme's shadow.
- Empty arrays and objects in the JSON view of a document or of explain are no longer centered on their own line.
- In the Indexes tab, the empty actions cell of the `_id_` index takes the height of its row.
- The README and the changelog are now in English.

## 0.1.0

First release.

- **Connections**: connection string or a form with TLS and SSH tunnel, connection strings and passwords in VS Code's SecretStorage, read-only connections and colors to tell them apart.
- **Browsing**: tree of connections, databases, collections and views; creating, renaming and dropping databases and collections.
- **Table**: nested columns and arrays of objects, sorting, columns that can be hidden, reordered, resized and pinned; inline editing of cells.
- **Queries**: filter, sort and projection in mongosh syntax with autocomplete, visual query builder, drag & drop of cells into the filter, history and saved queries.
- **Aggregate**: stage-based pipeline editor with a preview of each stage and saving as a view.
- **Documents**: opening and editing as JSON, insert, duplicate, delete, update many / delete many, undoing changes.
- **Data**: export (JSON, JSON Lines, CSV), import, copying collections, backup and restore in the mongodump format, comparing two collections.
- **Analysis**: schema, charts, global search in any field, relationship diagram, explain.
- **Indexes**: create, hide/unhide and drop; suggestions for indexes to create, redundant and unused ones.
- **Tools**: mongosh playground, code generation, server monitor (operations, profiler, stats, replica set), GridFS, users and roles, change streams.
