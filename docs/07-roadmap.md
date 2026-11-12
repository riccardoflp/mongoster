# Roadmap

Mongoster is built: this roadmap is not about features to add, which come from the user and the CHANGELOG, but about
the documentation and the gaps it found. Each step ends with something a person can check. The reasons are in
[13-risks.md](13-risks.md); this page says when.

## M1 — The riskiest areas documented (done with this documentation)

Cards for the writes, the undo history, connections and secrets, redis-oplog, transfers, backups, scheduled tasks,
the MCP server, and the writes of compare, structure and indexes; the pages 01 to 13; `catalog.py` in the repository.

**Exit**: `python docs/catalog.py docs` says *no problems*; every card has **Tested by**; every gap found is a
**Differs** line, a row of [13-risks.md](13-risks.md) or an open question.

## M2 — Close the gaps that can lose data

The rows of [13-risks.md](13-risks.md) whose *What we do* says M2, each in its own commit with a test that failed
before, in this order: the ones that lose data or write where they must not (RS3, RS8, RS1, RS2, RS9, RS10, RS11,
RS13), then secrets and privacy (RS5, RS6, RS7, RS14), then what the user sees wrong (RS12). Q10 and Q11 are answered
first, because they decide what some of those cards should say.

**Exit**: those cards and rows no longer say *Differs* or *open*; `npm test` and `npm run test:integration` pass.

## M3 — The checks in the CI

`catalog.py` in the CI (or a Node port, [Q6](08-decisions.md#open-questions)); a linter if [Q4](08-decisions.md#open-questions)
says so, with the import rules of R1.2 and R1.3 and the size limits of R6.4; tests named after their cards for the
cards of M2.

**Exit**: a pull request that renames a card's identifier without its references, or imports `vscode` in
`src/shared/`, fails.

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
