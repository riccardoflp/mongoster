# Roadmap

Mongoster is built: features come from the user, and this roadmap lists the ones scheduled next, then the gaps the
documentation found, until [13-risks.md](13-risks.md) has no row left. Each step ends with something a person can
check. The reasons for the gaps are in [13-risks.md](13-risks.md); this page says when.

## M1 — The riskiest areas documented (done with this documentation)

Cards for the writes, the undo history, connections and secrets, redis-oplog, transfers, backups, scheduled tasks,
the MCP server, and the writes of compare, structure and indexes; the pages 01 to 13; `catalog.py` in the repository.

**Exit**: `python docs/catalog.py docs` says *no problems*; every card has **Tested by**; every gap found is a
**Differs** line, a row of [13-risks.md](13-risks.md) or an open question.

## M2 — Colors for collections, conditional formatting, names from comments in a list (done in 0.9.0)

Three features asked by the user. Each follows the checklist *Every user-visible change* of `AGENTS.md`: its cards,
its tests, the README's `Features`, an entry in `## Unreleased` of `CHANGELOG.md`. The second and third add data
Mongoster keeps for itself ([11-data.md](11-data.md)), so each starts with a proposal in
[proposals/](proposals/README.md), accepted before it is built; the first changes one card.

1. **Names from comments in a list of connection strings** (`connection.read-list`). `Import Connections…` already
   reads a list of connection strings, but it ignores comment lines, so in a file written as

   ```text
   // Production
   mongodb+srv://ada@cluster0.x.mongodb.net/shop
   // Staging
   mongodb://staging-1:27017/shop
   ```

   the connections are named after their hosts. New rule: a `//` comment on the line right above a connection string
   that has no name of its own gives it its name (`Production`, `Staging`), trimmed, without the `//`. A name on the
   connection string's own line (`name = mongodb://…`) wins over the comment; a comment followed by an empty line or
   by a line that is not a connection is forgotten; the other comments are ignored as today. The card's rules and
   examples change, with a test for each; Mongoster's own list export keeps writing `name = …` lines. A `#` comment
   names nothing, as the user's files use `//` and the export's header is a `#` line.
2. **The color of a collection**. `Set Color…` on a collection, a view and a GridFS bucket in the tree, with the six
   colors of `connection.set-color` and `Connection's Color`. The collection's color takes the place of the
   connection's wherever something of that collection is shown: its icon in the tree, the icon and stripe of its tab,
   the names of its documents' editor tabs. Without one, the connection's color applies as today. The proposal decides
   where the colors are kept (on the connection in `mongoster.connections`, so that export and import carry them, or
   in `globalState`), what happens when the collection is renamed or dropped (RS4), and the `tree.` cards this brings.
   Asked later, for connections and collections alike: more preset colors, and a color picker for a color of one's
   own; the proposal says where a custom color can show exactly and where VS Code takes only theme colors.
3. **Conditional formatting** in the collection tab. Rules per collection, each with a condition, a color and what it
   colors: the whole row, or the cell of one field. The condition is a filter in mongosh syntax, as in the filter bar
   (`{ status: "failed" }`, `{ amount: { $gt: 1000 } }`, `{ deletedAt: { $exists: true } }`); the colors are the
   theme's, so that they read in dark and light themes. Rules are listed, added, edited, reordered and turned off from
   the tab's toolbar and from a column header's menu (`Format Cells…` for that field); the first matching rule wins,
   a cell rule over a row rule. The proposal decides: matching in the webview with a matcher of the query operators
   over relaxed EJSON, new in `src/shared/` (none exists), and which operators it supports; where the rules are kept
   (for me, or in the project's `.mongoster/` like the saved queries, to share them); and the `query.` cards this
   brings.

**Exit**: the three features in `## Unreleased` and in the README; their cards with **Tested by**, and
`python docs/catalog.py docs` says *no problems*; `npm run typecheck` and `npm test` pass.

## Asked by the user, next

Changes asked after M2, built when the user says so, alongside the milestones below; each follows the checklist
*Every user-visible change* of `AGENTS.md`.

1. **A field dropped on Project doesn't run the query**. Today a header or a cell dropped on `include`, `exclude` or
   `✕ remove` of Project writes the field into the projection and runs the query at once (`setOption` in
   `src/webview/main.ts`). After the first `include` the table shows that field alone, so the next one can no longer
   be dragged from it, and each drop costs a query on a slow collection. New rule: the drop only writes the
   projection, and the box flashes as today; the query runs on `Find`, or on `Enter` in the box, as after typing there. A drop
   on Sort keeps running the query. Until the query runs, the Project box is marked as not applied yet, so that the
   table isn't read as the result of the projection shown; the mark goes on the next run and on `Reset`. With it: a
   test of the drop, the README's *Drag & drop into the filter, sort and projection*, and a fix line in
   `## Unreleased`.
2. **Cancelling a query that is running**. A `Find` runs for up to 60 seconds and a pipeline for up to 10 minutes,
   and the tab has no way to stop them. `Cancel` takes the place of `Find` (and of the pipeline's run button) while
   the query runs, and stops the operation on the server, not only the wait in the tab; the table keeps what it
   showed before. The same for the counts, `Schema` and `Chart` if it comes cheap. To decide when it is built: how
   the operation is stopped (the driver's abort, or `killOp` on an operation found by its comment), and that it stays
   allowed on a read-only connection, as it writes nothing.
3. **The time limit of a query as a setting**. The limits are written in `src/collectionPanel.ts` (`maxTimeMS` of
   20, 60, 120 and 600 seconds, by kind of query). `mongoster.query.timeout`, in seconds, replaces the ones of `Find`
   and of the pipeline, with today's values as defaults; the message of a query stopped by the limit names the
   setting. The MCP server keeps its own `MAX_TIME_MS`.
4. **A condition dropped on the filter, with or without running the query**. A cell or a header dropped on the
   filter (`= equals`, `≥ from`, `exists`…) runs the query at once too (`addCondition`). That suits a single
   condition and costs a query per drop when several are put together. To decide with the user before building:
   leave it as it is, follow rule 1, or a setting for the three boxes together.
5. **`Project Visible Columns`**. In the columns' menu and panel: writes into Project the columns the layout shows,
   as inclusions, so that the query fetches only those; like rule 1, it does not run the query. A hidden column
   stays out, an expanded one gives its dotted paths, and `_id` is excluded when its column is hidden.
6. **Collation and hint in `Find`**. Two more options of the query, beside Sort and Project: a collation
   (`{ locale: "it", strength: 1 }`, to sort and match without case and accents) and a hint (an index's name or its
   keys, offered from the collection's indexes), sent with the query, the counts, `Explain`, `Code` and the export,
   and kept in the history and in the saved queries. The saved query files get two optional keys
   ([11-data.md](11-data.md)), so this starts with a proposal in [proposals/](proposals/README.md).
7. **The collection tab's two largest files split** (R6.4). `src/webview/main.ts` (2,157 lines) and
   `src/collectionPanel.ts` (1,581) are over the limit and are split when next changed, which the rules above do:
   the drag & drop into filter, sort and projection moves to its own module of `src/webview/` with rule 1, and the
   running of queries, with its limits and its cancelling, out of `src/collectionPanel.ts` with rules 2 and 3, in a
   module without a `vscode` import so that it is tested. No change for the user.

## M3 — Close the gaps that can lose data

The rows of [13-risks.md](13-risks.md) whose *What we do* says M3, each in its own commit with a test that failed
before, in this order: the ones that lose data or write where they must not (RS3, RS8, RS1, RS2, RS9, RS10, RS11,
RS13), then secrets and privacy (RS5, RS6, RS7, and RS29 once its proposal is accepted), then what the user sees
wrong (RS12). Q10 and Q11 are answered first, because they decide what some of those cards should say.

The security analysis of 0.10.0 found RS24 to RS46. Most were fixed right after it, each with its test, and are in
`## Unreleased` of `CHANGELOG.md`; the ones left are RS29 here, RS44 to RS46 in M4, and RS36, RS39 and RS40 in M5.

**Exit**: those cards and rows no longer say *Differs* or *open*; `npm test` and `npm run test:integration` pass.

## M4 — The checks in the CI

`catalog.py` in the CI (or a Node port, [Q6](08-decisions.md#open-questions)); a linter if [Q4](08-decisions.md#open-questions)
says so, with the import rules of R1.2 and R1.3 and the size limits of R6.4; tests named after their cards for the
cards of M3; the MCP tools' output limits (RS15, RS46); the updates of what is shipped that are waiting (RS44);
the private channel for reports of `SECURITY.md` (RS45, [Q7](08-decisions.md#open-questions)).

**Exit**: a pull request that renames a card's identifier without its references, or imports `vscode` in
`src/shared/`, fails; RS15, RS22, RS23 and RS44 to RS46 are removed from [13-risks.md](13-risks.md).

## M5 — The remaining risks

Every row of [13-risks.md](13-risks.md) still there after M4, each in its own commit with a test that failed before:
a dropped collection's state left in `globalState` (RS4: M2's colors of collections go with a drop, the other keys do not), tabs left open
or not repainted after a connection is removed or recolored (RS18), the comparison's writes without `Undo` in their
notification (RS19), a size limit on the files read from outside (RS16), playgrounds in untrusted workspaces once
[Q8](08-decisions.md#open-questions) is answered (RS17), the tests still missing by area (RS20), and what is left
of the security analysis, each after its question is answered: formulas in a CSV export (RS36), the SSH tunnel's
local port (RS39), and the permissions of backups and exports (RS40).

**Exit**: [13-risks.md](13-risks.md) has no row left, or only rows found after M4, each with the milestone that will
close it.

## The areas still without cards

Each gets its cards the next time it is changed, in the same commit as the change, or earlier when it becomes risky.
The order is the proposed one: the areas that write first.

| Order | Area | Why this place |
| --- | --- | --- |
| 1 | `19-playground.md` (`playground.`) | Writes without the undo history; the read-only check of every method; T6 |
| 2 | `16-users.md` (`user.`) | Creates users and changes passwords and roles; nothing can be undone |
| 3 | `18-monitor.md` (`monitor.`) | Kills operations, changes the profiler, steps down a primary, stops the balancer |
| 4 | `17-gridfs.md` (`gridfs.`) | Uploads, replaces and deletes files; nothing can be undone |
| 5 | `23-saved-queries.md` (`saved-query.`) | Files shared through git (11-data.md) |
| 6 | `03-collection-tab.md` (`query.`) | The largest area; reads, but it is where most writes start |
| 7 | `02-tree.md` (`tree.`) | |
| 8 | `21-relations.md` (`relations.`) | |
| 9 | `22-analysis.md` (`analysis.`) | |
| 10 | `20-search.md` (`search.`) | |
| 11 | `24-watch.md` (`watch.`) | |
| 12 | `25-desktop-app.md` (`app.`) | |

The reading parts of `13-compare.md`, `14-structure.md` and `15-indexes.md` come with the next change to them.

## Before a release

- `npm run typecheck`, `npm test`, `npm run test:integration`, and `python docs/catalog.py docs`.
- The manual checks of [06-testing.md](06-testing.md#what-no-test-reaches).
- The **Open** threats of [10-security.md](10-security.md) read again.
- `## Unreleased` of `CHANGELOG.md` renamed to the version; the steps of
  [06-testing.md](06-testing.md#releasing).
