# Quality

The qualities that matter most to Mongoster, in order, and the scenarios that make them checkable. *Source: ISO/IEC
25010:2023 for the qualities; arc42 §10 for the scenarios.* A scenario with no test says so: it is a promise only a
person checks today, listed in [13-risks.md](13-risks.md).

## The goals

1. **Safety of the data** (25010: *reliability* and *security*, integrity). Mongoster is pointed at production
   databases: a write must never reach a read-only connection, must be what the confirmation said, and must be
   undoable when the confirmation said so. Traded for: speed (a second read before each write to record it) and disk
   space (the undo history).
2. **Fidelity of values** (25010: *functional suitability*, correctness). A value keeps its BSON type through every
   path. Traded for: plain JSON's simplicity, everywhere.
3. **Staying responsive on large deployments** (25010: *performance efficiency*). Large collections, many databases,
   slow servers: every read has a bound, long work has progress and `Cancel`. Traded for: completeness (samples,
   limits, the first N results).
4. **Same behavior in both products** (25010: *flexibility*, portability). Traded for: the VS Code APIs the desktop app
   would have to reimplement.
5. **Changeability** (25010: *maintainability*). Agents and people change the code often; the cards, rules and tests
   say what must not move.

## Scenarios

| | When | What must happen | Measure | Checked by |
| --- | --- | --- | --- | --- |
| QA1 | A write is attempted on a read-only connection, from any entry point (tab, tree, editor, playground, comparison, structure, restore). | Nothing is sent to MongoDB; the user reads why. | 0 writes | the `(differs)`-free acceptance lines of each write card; integration tests partly |
| QA2 | A document with `Int32`, `Double`, `Long`, `Decimal128`, a regex and a date is edited inline, copied to another connection, backed up and restored. | Every value comes back with its type. | 6 of 6 types kept | unit tests of `src/shared/compare.ts` and `src/archive.ts`; integration tests of backup; not the inline edit |
| QA3 | `Update many` on 50,000 documents. | The confirmation says it cannot be undone (over 10,000 documents), and the update runs. | the confirmation's text | none |
| QA4 | Two collections of 1,000,000 documents each are compared. | The comparison finishes with one fingerprint per document in memory and lists the first 300 differences of each kind. | memory proportional to the number of documents, not their size | none |
| QA5 | An MCP tool is called on a slow server. | It stops after 30 seconds and returns at most 60,000 characters. | `MAX_TIME_MS` = 30,000; `MAX_OUTPUT` = 60,000 | `test/unit/mcpTools.test.ts`, partly |
| QA6 | The collection tab opens a collection of 10 million documents with no filter. | The first page shows without counting every document (an estimated count). | `estimatedDocumentCount` | none |
| QA7 | A query in the collection tab runs on a slow server. | It stops after the time limit of its kind and says so. | 20 s for samples, 60 s for counts, 120 s for aggregations and charts | none |
| QA8 | Global search across 200 collections. | Three collections at a time, each with its progress, and `Stop` interrupts within one batch. | 3 in parallel | none |
| QA9 | The same action in the extension and in the desktop app. | The same result and the same texts, except what the README's `Desktop app` section lists. | — | `npm run typecheck` for the API; by hand before a release ([06-testing.md](06-testing.md#what-no-test-reaches)) |
| QA10 | A change to a feature with a card. | Its card, its tests and the README change in the same commit, and `catalog.py` says *no problems*. | — | review; `catalog.py` |
