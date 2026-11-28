# Proposals

A proposal is how a change too large for one card is discussed before it is built: one that touches several areas,
replaces a decision, adds a dependency or changes a file Mongoster writes for itself. *Source: the Rust RFC process,
Python's PEPs, design documents.* A smaller change needs none: it changes its card in the same commit as its code.

An accepted proposal becomes a decision in [08-decisions.md](../08-decisions.md) and changes to cards; the proposal
stays as the record of the discussion. A rejected one stays too, with why.

## How to write one

Copy the template into `NNNN-short-name.md`, with the next free number (`0001-ui-framework-for-large-tabs.md`). Never
reuse a number.

```markdown
# NNNN — <Title>

**Status**: draft | accepted (D<n>) | rejected | withdrawn

## Summary
One paragraph.

## Why
The problem, from the user's side.

## What changes for the user
Cards added, changed or removed, by identifier.

## Design
Enough for someone to build it: modules, messages, data, steps; what the desktop app needs.

## Alternatives
Each with why not.

## Costs
What gets harder, what breaks, the files that need reading in their old form (11-data.md).

## Open questions
```

## The proposals

| Number | Title | Status |
| --- | --- | --- |
| [0001](0001-collection-colors.md) | The color of a collection, more colors and a color picker | accepted (D16, D17) |
| [0002](0002-conditional-formatting.md) | Conditional formatting in the collection tab | accepted (D18) |
| [0003](0003-formatting-by-field-scopes-and-pane.md) | Formatting by a field's values, rules beyond one collection, the Formatting pane | accepted (D21) |
| [0004](0004-collation-and-hint.md) | Collation and hint in Find | accepted (D22) |
| [0005](0005-playground-rewriter-on-babel.md) | The playground's rewriter on Babel, and functions that wait by themselves | accepted (D23) |
| [0006](0006-masking-copied-data.md) | Masking personal data in a copy | draft |
