# 0006 — Masking personal data in a copy

**Status**: draft

## Summary

Copying a collection or a database from production to a local server brings along what should not leave production:
names, e-mail addresses, phone numbers, tokens. This proposal adds **masking rules** to a copy: for chosen fields, the
copied value is replaced by a fake one of the same kind, the same every time for the same original value, so that
references between documents still match. The rules are kept on the source connection and apply to `Copy Collection
To…`, to `Paste` in the connections view and to dragging there. Nothing is ever changed in the source.

## Why

`Copy Collection To…` and `Paste` make production → local a matter of two clicks, and the first thing such a copy
is used for is a development database full of real people. Today the choices are to copy everything, to write a
pipeline by hand in a playground, or to generate fake documents (`transfer.generate`), which lose the shape of the
real data: its odd documents, its volumes, its references. A masked copy keeps all of that and drops only the
values that identify someone.

## What changes for the user

Cards to add, in `docs/features/09-transfer.md` (their identifiers are not cards yet):

- *transfer.masking-rules* (Operation) — `Masking Rules…` on a connection, a database or a collection: a tab that
  lists the fields of a sample with the rule of each (none, or one of the kinds below), proposes rules for the fields
  whose name or values look personal, and saves them.
- *transfer.mask-values* (Derivation) — what each kind of rule turns a value into.
- *transfer.masked-copy* (Operation) — a copy or a paste from a connection that has rules asks `Mask <n> fields` (on
  by default) in its confirmation, and says in its result how many values were masked.

Cards changed: `transfer.copy-collection` and `transfer.paste` (the question, the detail line, the result),
`transfer.move` (a move is never masked: masking a move would destroy the original values, and the confirmation says
so), `connection.export` and `connection.write-file` (the rules go with the connection). Glossary rows: *masking
rule*, *masked copy*.

## Design

- **The rules.** `MaskRule { field: string; kind: MaskKind; keep?: number }`, keyed by `database.collection` in
  `ConnectionInfo.masking`, next to `collectionColors` and `exclusions`: the same place, the same follow-a-rename and
  go-with-a-drop helpers (`src/shared/exclusions.ts` is the model). `field` is a dotted path; a path through an array
  masks every element.
- **The kinds**, in a new `src/shared/mask.ts`, pure and tested by examples:
  - `fake` — a value of the same kind as the original, as `src/shared/generate.ts` already shapes strings after their
    field name and examples (an e-mail for an e-mail, a phone for a phone, a first name, a city);
  - `hash` — a hex digest of the value, for tokens and external ids that must stay distinct but mean nothing;
  - `partial` — the first `keep` characters, the rest replaced (`IT60 X054 …` → `IT60 ****`);
  - `null` and `remove` — the field set to null, or left out;
  - `shift` — a date moved by a number of days that depends on the document, so that intervals inside a document hold.
- **The same value gives the same mask.** Each mask is derived from an HMAC of the original value with a key made
  once per destination connection and kept in the secret storage (`mongoster.mask.<id>`): `mario@example.com` becomes
  the same fake address in every collection and every later copy to that destination, so joins on masked fields
  hold; another destination gets other values, and the masks can't be reversed without the key. `seededRandom` of
  `generate.ts` gives the fake value from the digest.
- **Where it runs.** `copyCollection` gets `transform?(doc)` in its hooks, applied to each batch before it is
  written; `pasteCollections` passes the one of each item. BSON types are kept: a rule replaces a string by a
  string, a date by a date, and leaves a value of another type than it expects as it is, counting it.
- **Indexes.** A unique index on a masked field holds, since distinct values get distinct masks (`fake` adds a part
  of the digest when its pool is smaller than the collection); the result says when a duplicate key made a document
  fail, as it does today.
- **What is proposed.** The tab proposes `fake` for fields named like `email`, `phone`, `name`, `address`, and for
  values that match the patterns `generate.ts` knows; `hash` for `token`, `secret`, `password`. Nothing is masked
  unless the user saves the rules.
- **The MCP server** is not concerned: it never copies.
- **The desktop app** needs nothing of its own: the tab is a webview like the others.

## Alternatives

- **A pipeline the user writes** (`$set` with `$function` or `$concat`). Already possible in a playground; it is the
  thing this replaces, and it can't give a consistent fake value across collections.
- **Masking in the destination after the copy** (`updateMany`). The real values would be written first, to the disk
  and the oplog of the destination, and stay in the undo history.
- **A fixed key for everyone.** The same e-mail would have the same mask on every machine: a table of masks could be
  built once and used against any masked copy.
- **Rules kept on the destination**, or asked at each copy. They describe the source's data, and are worth writing
  once.

## Costs

- `ConnectionInfo` gets `masking`, and the connections file a `masking` key: files written before read as having no
  rule ([11-data.md](../11-data.md)).
- A new secret, the masking key of each destination: a row in [10-security.md](../10-security.md), removed with the
  connection; a copy of a connection made by `Paste` must not take it.
- A masked copy is slower: each document is walked in the host. Unmasked copies pay nothing.
- A field the rules don't name is copied as it is: the tab must make plain what is *not* masked, and a new field
  added in production later is not covered until the rules are opened again.

## Open questions

- Should a copy from a connection marked as production (its color, or a new mark) refuse to run unmasked unless the
  user says so each time?
- Free text (`notes`, `comment`) holds names no rule on a field finds: is `remove` the only honest answer for it?
- Should `Backup…` and exports offer the same rules, or is masking only for copies between databases?
- `_id`s that are themselves personal (an e-mail as `_id`): mask them, and with them every reference, or refuse?
