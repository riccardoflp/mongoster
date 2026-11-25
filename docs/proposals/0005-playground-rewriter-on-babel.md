# 0005 — The playground's rewriter on Babel, and functions that wait by themselves

**Status**: accepted (D23)

## Summary

A playground script is rewritten so that its calls to the database are awaited without the user writing `await`.
Today `src/playground/rewrite.ts` parses the script with `acorn` and only **inserts text** into it. This proposal
moves the rewriter to **Babel** (parse, change the tree, write the code again), and uses what that allows to close
the case still open: a function the user declares (`function ids(name) { return db[name].find().toArray().map(…) }`)
waits for the database by itself, without `async`. Babel is a new dependency of what is bundled, which is why this
is a proposal.

## Why

What a script may leave out is today a list the user has to know: `await` isn't needed in the script, in its blocks,
in `async` functions, in a callback written in place for `forEach`, `map`, `filter`…; it *is* needed, as `async` on
the function, in any other function. The last case gives a clear error since the callbacks were fixed, but it is
still an error for code that runs as it is in mongosh, and a script pasted from there has to be edited.

The functions can't simply all become `async`: the comparator of a `sort`, the callback of a `replace`, a function
used in a template would give a promise where a value is needed. What works is a function that **runs as it is until
it meets a promise**, and only then becomes one. That rewrites the whole body of every function (its `return`s, its
`this` and `arguments`, the calls it makes), which inserting text can do only with growing care: the last change
already had to order openings and closings at the same offset by hand.

## What changes for the user

The playground has no cards yet (`19-playground.md` is planned in [04-feature-contract.md](../04-feature-contract.md));
they will be written on what this proposal leaves.

- A function that isn't `async` and calls the database works: called from the script, from another function, or as
  the callback of `forEach`, `map`, `filter`… whether written in place or by name (`names.map(count)`).
- The error *"… gives its result later, and the function it is in is not async"* stays only where waiting is
  impossible: a getter, a setter, a constructor, a generator, and a function whose caller needs the value at once
  (a `sort` comparator that calls the database).
- Nothing else is meant to change: results, the order of the calls, the line of an error.

## Design

- **Dependencies.** `@babel/parser`, `@babel/traverse`, `@babel/generator`, `@babel/types` in `dependencies`,
  where `acorn` is (they are bundled into `dist/extension.js`); `acorn` is removed, nothing else imports it.
- **The module.** `src/playground/rewrite.ts` keeps its exports (`rewritePlayground`, `ScriptSyntaxError`, the names
  of the runtime functions, `iterate`, `checkSync`) and its "no vscode dependency". `ScriptSyntaxError` takes the
  line and column of Babel's `err.loc`.
- **Lines.** The code is written with `generate(ast, { retainLines: true })`: every statement stays on its line, so
  an error thrown while running names the script's line as today, with no source map. Tried on a multi-line chain:
  the lines are kept.
- **Awaiting.** As today, in the visitor's words: every call in code that can wait becomes
  `await RESOLVE_FN(call)`, the last expression is assigned to the result, cursors stay lazy, optional chains keep
  stopping early, `withTransaction` callbacks become async.
- **Functions that wait by themselves.** A function that isn't `async` (declaration, expression, arrow, method)
  becomes a function with the same parameters whose body runs inside an async function called at once. In that
  body a call is awaited **only when it gave a promise**, so a body that meets none finishes before the outer
  function goes on: the outer function then returns the value (or throws the error) as the original would. When the
  body did stop on a promise, the outer function returns the promise of its result, which the caller awaits in the
  same way. `this` and `arguments` are passed in; a generator, a getter, a setter and a constructor are left as
  they are, with the guard of `SYNC_FN`.
- **Iteration.** `ITERATE_FN` is applied to every `forEach`, `map`, `filter`… of the script, not only to a callback
  written in place, and works the same way: it calls the callback as the array would until a call gives a promise,
  and from there waits for each one. A script that touches no database gets arrays and values, never promises.
- **Tests.** The unit tests that compare the rewritten text (`body(…)` in `test/unit/rewrite.test.ts`) are rewritten
  on what running gives; the others and `test/integration/shell.test.ts`, `transactions.test.ts` must pass unchanged.
  New ones: a declared function used by the script, by another function, by `map` by name and by `sort`; the line
  of an error in each.
- **The desktop app** needs nothing of its own: it runs the same bundle.

## Alternatives

- **Stay on `acorn` and inserted text, and stop here.** No new dependency. The declared function keeps needing
  `async`, with the error that says so. This is the state today, and it is a defensible place to stop.
- **Functions that wait by themselves, with inserted text.** Possible: a prefix after the function's `{`, a suffix
  before its `}`, a wrap around each `return`. No dependency, but arrow functions with an expression body, `this`,
  `arguments`, default parameters and nested functions each need their own case of text surgery; this is where a
  tree written back as code pays.
- **`acorn` with a small code generator (`astring`)** instead of Babel. About a tenth of the weight, but no
  `retainLines` (a source map would be needed for the lines) and no helpers to build and replace nodes.
- **All functions `async`.** One line of code; breaks `sort`, `replace` and every caller that needs a value.

## Costs

- **Weight.** Bundled and minified, the four Babel packages are about 710 KB against 120 KB for `acorn`: about
  590 KB more in `dist/extension.js`, in the `.vsix` and in the desktop app.
- **What is bundled.** 18 packages instead of 1 come under the `npm audit` that stops the build on a known flaw
  ([06-testing.md](../06-testing.md)): more updates to follow, more chances of a stopped build.
- **Speed.** Every function call of a script goes through a wrapper and an async function: slower loops of pure
  JavaScript in a playground. To be measured (see the questions).
- **What the user can see of the rewrite.** A function printed with `toString()` and the frames of a stack show the
  rewritten code, more changed than today.
- **Risk of the rewrite itself.** Every script that runs today goes through new code; the existing tests are the
  net, the ones comparing text are lost with the move.
- No file Mongoster writes for itself changes.

## As built

- `@babel/traverse` was not needed: the rewriter walks the tree itself, with `VISITOR_KEYS` of `@babel/types`. Three
  packages are added, not four, and the bundle grows by about 490 KB, not 590 (the rewriter with Babel is 612 KB
  minified, with `acorn` it was about 125).
- A function that makes no call is left as it was written: it has nothing to wait for, and costs what it did.
- In a function that waits by itself only the calls are looked at, not every statement and initializer as in the
  script: `i++` and `const d = docs[i]` cost what they did.
- The function given to `sort`, `toSorted`, `replace` and `replaceAll` can't wait, and has the guard; so has the
  value of a class field and a static block. The guard also looks at a call used in arithmetic (`count(a) - count(b)`).
- The error of the guard names the place: *"db.c.findOne() gives its result later, and a getter cannot wait for it:
  move the call to a function or a method, which can."*
- Babel 8 asks for Node.js 22.18 to be installed: [06-testing.md](../06-testing.md) says so. What is bundled runs on
  the Node.js of VS Code 1.90, as before.

## Open questions

- Is 590 KB acceptable for this? *Accepted with the proposal; it came to 490.*
- How much slower is a loop of a million calls of a small function in a playground? *Measured: a million calls of
  `(x) => Math.abs(x) + 1` from the script take about 0.6 s against 0.5 s for a function that makes no call (the
  half second is the script awaiting each call, as it did before); `map` over a million elements with that callback
  0.26 s against 0.15 s as plain JavaScript.*
- Class methods: *in. A method waits by itself as any function; a constructor, a getter and a setter have the guard.*
