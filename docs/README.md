# Mongoster's documentation for contributors

Mongoster is a MongoDB client that runs as a VS Code extension and, with the same code, as a desktop app. These pages
are for whoever changes its code, person or agent: how it is built, the rules it follows, what each feature promises,
and why. What Mongoster does for its users is in the [README](../README.md), which is the user manual; the two are
kept apart.

The state of the work: version 0.12.0 is released, with `Cut`, `Copy` and `Paste` in the connections view, dragging
its nodes, `Rename Database…` and the copies published to redis-oplog (after 0.11.1, which was 0.11.0 on Electron 45 and
updated build tools); the catalog has cards for the riskiest areas (writes, undo,
connections and secrets, the MCP server, backups, scheduled tasks), and the other areas get theirs when they are next
changed. Next ([07-roadmap.md](07-roadmap.md)): the known risks (M3 to M5).

## The pages

| Page | Says |
| --- | --- |
| [01-product.md](01-product.md) | The product as the user meets it, its parts, and the promises every change keeps. |
| [02-architecture.md](02-architecture.md) | The context and containers (C4), where code runs, the layers, the tab pattern, the write pipeline, the desktop app, the MCP server, a map of every file. |
| [03-code-rules.md](03-code-rules.md) | The numbered rules (R1.1…), where each comes from, and what checks it. |
| [04-feature-contract.md](04-feature-contract.md) | How a feature is shaped in the code, the template of a card, the list of areas. |
| [05-platform.md](05-platform.md) | What Mongoster asks of VS Code, of Electron and of the operating systems. |
| [06-testing.md](06-testing.md) | Setup, running, the tests, from a card to a test, what no test reaches, packaging, CI, releasing. |
| [07-roadmap.md](07-roadmap.md) | The features scheduled next, the gaps to close in order, and the areas still without cards. |
| [08-decisions.md](08-decisions.md) | The decisions (D1…), most reconstructed from the history, and the open questions (Q1…). |
| [09-glossary.md](09-glossary.md) | The words of Mongoster, one meaning each, and the words to avoid. |
| [10-security.md](10-security.md) | The threat model: what is protected, the trust boundaries, the threats (T1…) and their mitigations. |
| [11-data.md](11-data.md) | Every file and key Mongoster keeps between runs, their formats and how they change. |
| [12-quality.md](12-quality.md) | The qualities that matter most and their scenarios (QA1…). |
| [13-risks.md](13-risks.md) | Risks and technical debt (RS1…), with what is done about them. |
| [features/](features/README.md) | The catalog: one card per feature, with its function, its tests and its acceptance lines. |
| [proposals/](proposals/README.md) | Large changes discussed before they are built. |
| [../AGENTS.md](../AGENTS.md) | Commands, the checklists for a new command, tab, MCP tool or setting, the writing style. |
| [../SECURITY.md](../SECURITY.md) | How to report a vulnerability. |

Not here: a clean room page (Mongoster is not a rewrite). The desktop rewrite in Rust has its own specification on the
`main-desktop` branch.

## What to read first

To change a feature: [AGENTS.md](../AGENTS.md), then the feature's card (search the identifier, or the command id,
in `features/`), then [02-architecture.md](02-architecture.md) for the part of the code it lives in. Before a write:
the write pipeline in [02-architecture.md](02-architecture.md#writing-to-a-database) and R4 of
[03-code-rules.md](03-code-rules.md).

## Checking the documents

```bash
python docs/catalog.py docs              # duplicates, identifiers that name no card, missing lines, avoided words
python docs/catalog.py docs --index      # also rewrites features/README.md, keeping each card's status
```

It needs Python 3.9 or later and nothing else. It must say *no problems* before a commit that changes a card, the
glossary or a page that names cards.
