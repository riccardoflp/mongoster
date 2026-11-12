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

None yet.
