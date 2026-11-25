# 0004 — Collation and hint in Find

**Status**: accepted (D22)

## Summary

`Find` gets two more options beside Sort and Project: a **collation**, the rules strings are compared and sorted
with, and a **hint**, the index the query must use. They are typed in mongosh syntax in a row that `Options` opens,
go with the query wherever the query goes (its count, `Explain`, `Code`, `Export`), and are kept with it in the
history and in the saved queries. The saved query files get two optional keys, which is why this is a proposal.

## Why

Looking for `mario` without caring for `Mario` and `MARIO`, or sorting names as their language does, takes a
collation; today the only way is a regular expression, which uses no index, or a playground. Trying a query against
one index and then another, before or after `Explain`, takes a hint. Both are options of `find` in every driver, and
the tab had no place for them.

## What changes for the user

Card added, in `docs/features/03-collection-tab.md`: `query.find-options` (Derivation) — what a collation and a
hint are, where they go, what refuses them. No card is changed; `mcp.data-model-tools` says what an AI gets of them. Glossary
rows: *collation*, *hint*.

## Design

- **The texts.** `FindExtras { collation?: string; hint?: string }` in `src/shared/messages.ts`, which the find of
  `QueryRequest`, `QuerySource` and `QueryText` extend. A text is left out when empty: nothing that was stored or
  sent before changes shape.
- **To the driver.** `src/queries.ts › toCollation` (a document with a `locale`), `toHint` (the keys of an index, or
  its name quoted or not), `findOptions` (sort, projection, collation and hint together). Used by
  `src/queryRunner.ts › findPage` and its count, by `explain` and by `src/transfer.ts › exportSource`.
- **In the tab.** A row `#moreOptions` under Sort and Project with the boxes Collation and Hint, closed until
  `Options` (beside `Code`) opens it, and open while one of them has a value. The names of the collection's indexes
  are offered in Hint. `Reset` empties both.
- **Code.** `CodeQuery` gets `collation` and `hint`; each of the six languages writes them as its driver takes them.
  Java, C# and Go have a named option for each key of a collation: a key they have no name for is left out, and a
  value is written only when it is of the option's type, as text of a saved query file may be someone else's.
- **Kept.** `src/queryHistory.ts` stores them trimmed, only when not empty, and compares them in `sameQuery`. A
  saved query file gets `"collation"` and `"hint"` after `"projection"`:

  ```json
  {
    "name": "By name",
    "database": "shop",
    "collection": "people",
    "filter": "{ name: \"mario\" }",
    "collation": "{ locale: \"it\", strength: 1 }",
    "hint": "name_1"
  }
  ```

  A file with a `pipeline` and one of them is refused, like one with a pipeline and a filter.
- **The MCP server.** `list_saved_queries` prints them; with `mongoster.mcp.readDocuments` off, a collation and the
  keys of a hint as shapes and the name of an index as `?`, since the text is the user's.
- **The desktop app** needs nothing of its own.

## Alternatives

- **One box for every option of `find`** (`{ collation: …, hint: …, maxTimeMS: … }`). One box less, but a second
  syntax to learn, and options that clash with what the tab already sets (limit, skip, the time limit).
- **The collation in the filter's row, always visible.** It is rarely used; two more boxes always there make the
  query bar harder to read, mostly in the query pane.
- **Collation for the pipeline too.** `aggregate` takes one, but the pipeline editor has no options row; left for
  when it is asked.

## Costs

- A Mongoster before this change reads a saved query file with the new keys and runs the query **without** them: the
  documents found can differ. It does not lose the keys unless the query is saved again from it.
- `Schema`, `Chart`, `Update many` and `Delete many` use the filter without the collation. With a collation that
  ignores case, `Delete many` matches fewer documents than the table shows, never more than a filter the user can
  read; it shows its own count before it writes.
- The generated code for Java, C# and Go names driver classes that no test compiles.

## Open questions

- Whether `Update many` and `Delete many` should take the collation of the query, with the undo history recording
  the documents the collation matches.
