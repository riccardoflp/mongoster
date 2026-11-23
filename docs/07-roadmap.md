# Roadmap

Mongoster is built: features come from the user, and this roadmap lists the ones scheduled next, then the gaps the
documentation found, until [13-risks.md](13-risks.md) has no row left. Each step ends with something a person can
check. The reasons for the gaps are in [13-risks.md](13-risks.md); this page says when.

## M1 — The riskiest areas documented (done with this documentation)

Cards for the writes, the undo history, connections and secrets, redis-oplog, transfers, backups, scheduled tasks,
the MCP server, and the writes of compare, structure and indexes; the pages 01 to 13; `catalog.py` in the repository.

**Exit**: `python docs/catalog.py docs` says *no problems*; every card has **Tested by**; every gap found is a
**Differs** line, a row of [13-risks.md](13-risks.md) or an open question.

## M2 — Colors for collections, conditional formatting, names from comments in a list

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
   examples change, with a test for each; Mongoster's own list export keeps writing `name = …` lines.
   *Open*: whether a `#` comment counts the same way.
2. **The color of a collection**. `Set Color…` on a collection, a view and a GridFS bucket in the tree, with the six
   colors of `connection.set-color` and `Connection's Color`. The collection's color takes the place of the
   connection's wherever something of that collection is shown: its icon in the tree, the icon and stripe of its tab,
   the names of its documents' editor tabs. Without one, the connection's color applies as today. The proposal decides
   where the colors are kept (on the connection in `mongoster.connections`, so that export and import carry them, or
   in `globalState`), what happens when the collection is renamed or dropped (RS4), and the `tree.` cards this brings.
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

## M3 — Close the gaps that can lose data

The rows of [13-risks.md](13-risks.md) whose *What we do* says M3, each in its own commit with a test that failed
before, in this order: the ones that lose data or write where they must not (RS3, RS8, RS1, RS2, RS9, RS10, RS11,
RS13), then secrets and privacy (RS5, RS6, RS7, RS14), then what the user sees wrong (RS12). Q10 and Q11 are answered
first, because they decide what some of those cards should say.

**Exit**: those cards and rows no longer say *Differs* or *open*; `npm test` and `npm run test:integration` pass.

## M4 — The checks in the CI

`catalog.py` in the CI (or a Node port, [Q6](08-decisions.md#open-questions)); a linter if [Q4](08-decisions.md#open-questions)
says so, with the import rules of R1.2 and R1.3 and the size limits of R6.4; tests named after their cards for the
cards of M3; the MCP tools' output limits (RS15).

**Exit**: a pull request that renames a card's identifier without its references, or imports `vscode` in
`src/shared/`, fails; RS15, RS22 and RS23 are removed from [13-risks.md](13-risks.md).

## M5 — The remaining risks

Every row of [13-risks.md](13-risks.md) still there after M4, each in its own commit with a test that failed before:
a dropped collection's state left in `globalState` (RS4, unless M2's colors already dealt with it), tabs left open
or not repainted after a connection is removed or recolored (RS18), the comparison's writes without `Undo` in their
notification (RS19), a size limit on the files read from outside (RS16), playgrounds in untrusted workspaces once
[Q8](08-decisions.md#open-questions) is answered (RS17), and the tests still missing by area (RS20).

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
