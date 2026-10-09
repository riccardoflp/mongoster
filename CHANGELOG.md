# Changelog

## Unreleased

- Values in the table, the playground results, the server monitor, the global search and the index advisor take the syntax colors of the active color theme, and change with it.
- In a narrow tab, the filter keeps a usable width: its buttons, the top bar, Sort / Project, the pipeline buttons and the status bar wrap instead of squeezing it.
- Popups use the theme's shadow.
- Empty arrays and objects in the JSON view of a document or of explain are no longer centered on their own line.
- In the Indexes tab, the empty actions cell of the `_id_` index takes the height of its row.

## 0.1.1

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
