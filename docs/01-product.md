# The product

Mongoster is a MongoDB client for developers and the people who look after their databases: it opens collections in a
table, runs queries and aggregations written in mongosh syntax, edits documents, analyzes schemas, indexes and
references, moves data in and out, and watches the server. It runs as a VS Code extension and, with the same code, as
a desktop app (Electron) for Windows, macOS and Linux. It works with MongoDB 4.2 or later: standalone servers, replica
sets, sharded clusters and Atlas.

The [README](../README.md) is the user manual and the Marketplace page: it describes every feature as the user sees
it. This page is the map of the product for whoever changes it; the cards in [features/](features/README.md) say what
each feature does exactly, with the functions and tests behind it.

## Who it is for

- **Developers** of applications that use MongoDB, in VS Code next to their code: they query, edit test data, write
  pipelines, generate code, and let an AI assistant read the data through the MCP server.
- **Whoever looks after a deployment**: indexes, slow queries, replication, sharding, users, backups, comparing
  environments before a release.
- **Teams with Meteor apps** using redis-oplog, who need the writes made in Mongoster to reach the apps at once.

## The parts

```
┌─ Activity bar: Mongoster ─┐ ┌─ Editor area ──────────────────────────────────────────────┐
│ Connections               │ │ [orders] [shop · Monitor] [order 65f…json] [script.mongodb.js] │
│ ▸ Production (red, RO)    │ │ ┌ collection tab ────────────────────────────────────────┐ │
│ ▾ Local                   │ │ │ Find | Aggregate   Filter { … }  Sort  Project  ▶       │ │
│   ▾ shop                  │ │ │ Table · Schema · Indexes · Explain · Chart · History    │ │
│     orders                │ │ │ ┌────┬──────────┬────────┬───────────┐                 │ │
│     users                 │ │ │ │ #  │ _id      │ status │ address ▸ │                 │ │
│     fs (GridFS)           │ │ │ └────┴──────────┴────────┴───────────┘                 │ │
└───────────────────────────┘ │ └─────────────────────────────────────────────────────────┘ │
                              └───────────────────────────────────────────────────────────────┘
```

- **The connections view**, in the side bar: connections in folders, then databases, collections, views and GridFS
  buckets. Its context menus and title buttons reach almost every command.
- **Tabs** (webviews), each opened from the tree or from another tab: the collection tab, the server monitor, users
  and roles, watch, global search, index advisor, relationship diagram, GridFS, compare collections, compare
  structure, document history, undo history, scheduled tasks, the connection form, the playground's result.
- **Editor tabs**, through Mongoster's own file systems: a document as JSON (`mongoster://`, saved with `Ctrl+S`),
  view definitions and validation rules (`mongoster-def://`), generated code, playgrounds (`.mongodb.js`).
- **Dialogs and notifications** of VS Code (or of the desktop app): confirmations, quick picks, input boxes, progress
  with `Cancel`.
- **The MCP server**, on `127.0.0.1`, for AI assistants: read-only tools, and tools that open tabs for the user.
- **Scheduled tasks**, which run backups and exports by themselves while Mongoster is open.
- **The desktop app**: the same features in its own window, with Monaco as the editor, a Settings tab, a menu bar and
  a tray icon.

## Settings

All settings are `mongoster.*`, declared in `package.json`'s `contributes.configuration`, grouped by feature
(`mongoster.history.*`, `mongoster.mcp.*`, `mongoster.savedQueries.*`, `mongoster.references.*`,
`mongoster.scheduledTasks.*`). The desktop app builds its Settings tab from the same declarations. The list, with the
cards that read each, is in [features/26-settings.md](features/26-settings.md).

## What stays the same

The promises every change keeps:

- **Read-only means no writes.** Through a read-only connection, and through a view, Mongoster sends nothing that
  changes data, indexes, users or server settings.
- **The MCP server never writes**, kills an operation or changes a server setting, and gives documents and values to
  an AI only with `mongoster.mcp.readDocuments` on.
- **Types survive.** A value that is read, edited, copied, compared, backed up or restored keeps its BSON type
  (`Int32` stays `Int32`, `Decimal128` stays `Decimal128`).
- **What the user types and reads is mongosh syntax**, and what Mongoster writes to a file for other tools is
  Extended JSON or the format of the MongoDB tools (`mongodump`, `mongoexport`).
- **Writes to documents can be undone** from the undo history, within its limits, and the confirmation says when one
  cannot.
- **Writes to documents reach redis-oplog** on the connections that publish, so that Meteor apps see them, except
  those the README lists as not published (import, generated documents, copy, restore, the comparison;
  [Q10](08-decisions.md#open-questions)).
- **Secrets stay in the secret storage**: connection strings, passwords, passphrases, Redis URLs and the access token
  never go to settings, logs, files exported without passwords, or the AI.
- **The extension and the desktop app behave the same**, except where the README's `Desktop app` section says.
