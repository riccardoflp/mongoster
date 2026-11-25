// Playground scripts are written like mongosh: `const n = db.stock.findOne({}).n`,
// `db.c.find().toArray().length` or `print(db.c.countDocuments())` work without `await`. The script is
// parsed with Babel, its tree is changed and written back as code, keeping every statement on its line:
// errors thrown while running report the script's own line numbers.
//
// The script becomes the body of an async function where every call is awaited where it is
// (`x.findOne().n` runs as `(await x.findOne()).n`), as are expression statements and variable
// initializers, and the value of a final expression statement is returned. Awaiting goes through
// RESOLVE_FN, which leaves the shell's cursors alone: `db.c.find().sort(…).limit(5)` stays a lazy cursor
// until a terminal method.
//
// A function of the script that isn't async waits by itself: its body runs in an async function called
// at once, where a call is awaited only when it gave a promise. A body that meets none has finished
// when that call returns, and the function gives its value as it always did (FINISH_FN); otherwise it
// gives the promise of it, which its caller awaits in the same way. So `function ids(name) { return
// db[name].find().toArray().map(…) }` works, and the comparator of a `sort` still gives a number.
// `forEach`, `map`, `filter`… go through ITERATE_FN, which calls the callback as the array would until
// a call gives a promise, and from there waits for each one. Where nothing can wait (a getter, a
// constructor, a generator…) a call whose result is used at once goes through SYNC_FN, which says so
// when that result is a promise. No vscode dependency.
import { generate } from '@babel/generator';
import { parse } from '@babel/parser';
import * as t from '@babel/types';

export const RESULT_VAR = '__mongosterResult';
export const RESOLVE_FN = '__mongosterResolve';
export const ITERATE_FN = '__mongosterIterate';
export const SYNC_FN = '__mongosterSync';
export const FINISH_FN = '__mongosterFinish';
/** In a function that waits by itself: what its body did (`v` returned, `e` thrown, `d` done), and `x`, the call being looked at. */
const STATE_VAR = '__mongosterState';
const ERROR_VAR = '__mongosterError';

/** A syntax error with the 1-based line and column of the script. */
export class ScriptSyntaxError extends Error {
  constructor(
    message: string,
    readonly line: number,
    readonly column: number,
  ) {
    super(message);
  }
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- Babel's nodes, read and changed loosely
type AnyNode = Record<string, any> & { type: string };

/** Source of an async arrow function, called, that runs the script. */
export function rewritePlayground(source: string): string {
  let program: t.Program;
  try {
    program = parse(source, { sourceType: 'script', allowAwaitOutsideFunction: true, allowReturnOutsideFunction: true }).program;
  } catch (err) {
    const loc = (err as { loc?: { line: number; column: number } }).loc;
    const message = (err as Error).message.replace(/\s*\(\d+:\d+\)$/, '');
    throw new ScriptSyntaxError(message, loc?.line ?? 1, (loc?.column ?? 0) + 1);
  }
  const body = [
    t.variableDeclaration('let', [t.variableDeclarator(t.identifier(RESULT_VAR))]),
    ...new Rewriter(source).script(program),
    t.returnStatement(t.identifier(RESULT_VAR)),
  ];
  const run = t.callExpression(t.arrowFunctionExpression([], t.blockStatement(body), true), []);
  // No comments: a line comment would swallow what is written after it on its line.
  return generate(t.expressionStatement(run), { retainLines: true, comments: false }).code;
}

/**
 * How the calls of a piece of code are waited for: `always` in the script and in async functions,
 * `ifPromise` in a function that waits by itself, `guard` where nothing can wait (`where` says what
 * that place is, for the error; empty where there is no call to guard).
 */
interface Scope {
  mode: 'always' | 'ifPromise' | 'guard';
  where: string;
}
const ALWAYS: Scope = { mode: 'always', where: '' };
const IF_PROMISE: Scope = { mode: 'ifPromise', where: '' };
const guarded = (where: string): Scope => ({ mode: 'guard', where });

const FUNCTIONS = new Set(['FunctionDeclaration', 'FunctionExpression', 'ArrowFunctionExpression', 'ObjectMethod', 'ClassMethod', 'ClassPrivateMethod']);
const isFunction = (n: AnyNode) => FUNCTIONS.has(n.type);
const isOptional = (n: AnyNode) => n.type === 'OptionalCallExpression' || n.type === 'OptionalMemberExpression';
const isCall = (n: AnyNode) => n.type === 'CallExpression' || n.type === 'TaggedTemplateExpression' || n.type === 'OptionalCallExpression';
/** Expressions whose value is never a promise (the calls inside them are awaited on their own). */
const NEVER_PROMISES = new Set([
  'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'RegExpLiteral', 'BigIntLiteral', 'TemplateLiteral',
  'ObjectExpression', 'ArrayExpression', 'UnaryExpression', 'BinaryExpression', 'UpdateExpression',
  'FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression',
]);
/** The methods that call a function for the elements of an array, one after the other. */
const ITERATION = new Set([
  'forEach', 'map', 'filter', 'find', 'findIndex', 'findLast', 'findLastIndex', 'some', 'every', 'flatMap', 'reduce', 'reduceRight',
]);
/** The methods that use the value of their callback at once: it can't wait. */
const NEEDS_VALUE = new Set(['sort', 'toSorted', 'replace', 'replaceAll']);
/** Reading these of a call's result is how a script handles a promise by itself. */
const PROMISE_METHODS = new Set(['then', 'catch', 'finally']);
/** A promise as an operand of these is never meant. */
const ARITHMETIC = new Set(['+', '-', '*', '/', '%', '**', '<', '>', '<=', '>=', '&', '|', '^', '<<', '>>', '>>>', '~']);
/** What can't be the function of an iteration method: the first argument of `db.c.find({ … })`. */
const NEVER_FUNCTIONS = new Set([
  'ObjectExpression', 'ArrayExpression', 'StringLiteral', 'NumericLiteral', 'BooleanLiteral', 'NullLiteral', 'RegExpLiteral', 'TemplateLiteral',
]);
/** The longest text of a call quoted in an error. */
const QUOTED = 60;

const id = (name: string) => t.identifier(name);
const state = (key: string) => t.memberExpression(id(STATE_VAR), id(key));
const set = (key: string, value: AnyNode) => t.assignmentExpression('=', state(key), value as t.Expression);

/** Changes the tree of a script in place. */
class Rewriter {
  constructor(private readonly source: string) {}

  script(program: t.Program): t.Statement[] {
    // A directive stays what it was among the statements, a string that does nothing: the script isn't
    // made strict by being wrapped.
    const directives = program.directives.map((d) => this.at(d, t.expressionStatement(t.stringLiteral(d.value.value))));
    const last = program.body.length - 1;
    const body = program.body.map((s, i) => {
      if (i !== last || s.type !== 'ExpressionStatement') return this.visit(s, ALWAYS) as t.Statement;
      // The value of the final expression is the result.
      const value = this.awaited(this.visit(s.expression, ALWAYS, true), ALWAYS);
      return this.at(s, t.expressionStatement(t.assignmentExpression('=', id(RESULT_VAR), value as t.Expression)));
    });
    return [...directives, ...body];
  }

  /** A new node on the lines of the one it stands for. */
  private at<T extends t.Node>(from: { loc?: t.Node['loc'] }, node: T): T {
    node.loc = from.loc;
    return node;
  }

  /** The node as it is to run: itself, changed inside, or what stands for it. `whole`: it is awaited by who asked. */
  private visit(node: AnyNode, scope: Scope, whole = false): AnyNode {
    if (isFunction(node)) {
      this.function(node, scope);
      return node;
    }
    switch (node.type) {
      case 'ClassProperty':
      case 'ClassPrivateProperty':
      case 'ClassAccessorProperty':
        // The key is worked out where the class is, the value when an object is made: nothing waits there.
        if (node.computed) node.key = this.visit(node.key, scope);
        if (node.value) node.value = this.visit(node.value, guarded('the value of a class field'));
        return node;
      case 'StaticBlock':
        this.children(node, guarded('a static block'));
        return node;
      case 'ExpressionStatement':
        // In the script the value of the whole statement is awaited; a function that waits by itself only
        // looks at its calls, so that `i++` costs what it did.
        node.expression = scope.mode === 'always' ? this.awaited(this.visit(node.expression, scope, true), scope) : this.visit(node.expression, scope);
        return node;
      case 'VariableDeclarator':
        node.id = this.visit(node.id, scope);
        if (node.init) node.init = this.value(node.init, scope);
        return node;
      case 'ReturnStatement':
        if (node.argument) node.argument = this.value(node.argument, scope);
        // What a function that waits by itself returns is kept for who called it.
        if (scope.mode === 'ifPromise' && node.argument) node.argument = set('v', node.argument);
        return node;
      case 'CallExpression': {
        const callee = node.callee;
        node.callee = this.visit(callee, scope);
        if (callee.type === 'CallExpression') node.callee = this.guard(node.callee, callee, scope);
        this.arguments(node, scope);
        return whole ? node : this.awaited(node, scope);
      }
      case 'TaggedTemplateExpression':
        this.children(node, scope);
        return whole ? node : this.awaited(node, scope);
      case 'OptionalCallExpression':
      case 'OptionalMemberExpression':
        this.chain(node, scope);
        return node.type === 'OptionalMemberExpression' || whole ? node : this.awaited(node, scope);
      case 'MemberExpression': {
        const object = node.object;
        node.object = this.visit(object, scope);
        if (node.computed) node.property = this.visit(node.property, scope);
        if (object.type === 'CallExpression' && (node.computed || !PROMISE_METHODS.has(node.property.name))) node.object = this.guard(node.object, object, scope);
        return node;
      }
      case 'BinaryExpression':
      case 'UnaryExpression':
        for (const key of node.type === 'BinaryExpression' ? ['left', 'right'] : ['argument']) {
          const operand = node[key];
          node[key] = this.visit(operand, scope);
          if (operand.type === 'CallExpression' && ARITHMETIC.has(node.operator)) node[key] = this.guard(node[key], operand, scope);
        }
        return node;
    }
    this.children(node, scope);
    return node;
  }

  private children(node: AnyNode, scope: Scope): void {
    for (const key of t.VISITOR_KEYS[node.type] ?? []) {
      const child = node[key];
      if (Array.isArray(child)) node[key] = child.map((c) => (c && typeof c.type === 'string' ? this.visit(c, scope) : c));
      else if (child && typeof child.type === 'string') node[key] = this.visit(child, scope);
    }
  }

  /**
   * A value awaited as a whole in the script (an initializer, a returned value), unless it can't be a
   * promise; a call is awaited as any call. Functions and classes keep the name they get from the variable.
   */
  private value(node: AnyNode, scope: Scope): AnyNode {
    if (scope.mode !== 'always' || isCall(node) || NEVER_PROMISES.has(node.type)) return this.visit(node, scope);
    return this.awaited(this.visit(node, scope, true), scope);
  }

  /** The value of `node`, waited for as the scope can. */
  private awaited(node: AnyNode, scope: Scope): AnyNode {
    if (scope.mode === 'always') return t.awaitExpression(t.callExpression(id(RESOLVE_FN), [node as t.Expression]));
    if (scope.mode === 'guard') return node;
    // `(state.x = call) != null && typeof state.x.then === "function" ? await state.x : state.x`: no
    // `await`, which always lets other code run first, unless there is a promise to wait for.
    const isPromise = t.logicalExpression(
      '&&',
      t.binaryExpression('!=', set('x', node), t.nullLiteral()),
      t.binaryExpression('===', t.unaryExpression('typeof', t.memberExpression(state('x'), id('then'))), t.stringLiteral('function')),
    );
    return t.conditionalExpression(isPromise, t.awaitExpression(state('x')), state('x'));
  }

  /** `SYNC_FN(call, "its text", "where")` where nothing can wait, for a call whose result is used at once. */
  private guard(visited: AnyNode, call: AnyNode, scope: Scope): AnyNode {
    if (scope.mode !== 'guard' || !scope.where) return visited;
    const text = this.source.slice(call.start ?? 0, call.end ?? 0).replace(/\s+/g, ' ');
    const quoted = text.length > QUOTED ? `${text.slice(0, QUOTED - 1)}…` : text;
    return t.callExpression(id(SYNC_FN), [visited as t.Expression, t.stringLiteral(quoted), t.stringLiteral(scope.where)]);
  }

  /** The name of the method a call calls, when it is written as `object.name(…)`. */
  private method(callee: AnyNode): string | undefined {
    const member = callee.type === 'MemberExpression' || callee.type === 'OptionalMemberExpression';
    return member && !callee.computed && callee.property.type === 'Identifier' ? callee.property.name : undefined;
  }

  /**
   * The arguments of a call. A function written in place is async for `….withTransaction(fn)`, so that
   * `session.withTransaction(() => { coll.insertOne(…); })` waits for every write before committing, and
   * can't wait for `sort` or `replace`, which use its value at once. The object of an iteration method
   * goes through ITERATE_FN, unless its function is written async: `Promise.all(list.map(async …))`
   * keeps running for all the elements at once.
   */
  private arguments(call: AnyNode, scope: Scope): void {
    const callee = call.callee;
    const name = this.method(callee);
    const first = call.arguments[0];
    const iterates = name && ITERATION.has(name) && first && !NEVER_FUNCTIONS.has(first.type) && !(isFunction(first) && first.async);
    call.arguments = call.arguments.map((a: AnyNode, i: number) => {
      const inPlace = (a.type === 'FunctionExpression' || a.type === 'ArrowFunctionExpression') && !a.generator;
      if (inPlace && i === 0 && name === 'withTransaction') a.async = true;
      else if (inPlace && !a.async && name && NEEDS_VALUE.has(name)) {
        this.body(a, guarded(`the function given to ${name}()`));
        return a;
      }
      return this.visit(a, scope);
    });
    // Not `super`, and not inside an optional chain, which must keep stopping early.
    if (iterates && callee.object.type !== 'Super' && !isOptional(callee.object)) {
      callee.object = t.callExpression(id(ITERATE_FN), [callee.object, t.stringLiteral(name)]);
    }
  }

  /**
   * An optional chain (`a?.b().c`). A call after the `?.` can't be awaited alone without losing the
   * chain's short-circuit: the chain is awaited as a whole by who asked, when it ends with a call.
   */
  private chain(node: AnyNode, scope: Scope): void {
    const key = node.type === 'OptionalCallExpression' ? 'callee' : 'object';
    const link = node[key];
    if (isOptional(link)) this.chain(link, scope);
    else node[key] = this.visit(link, scope);
    if (node.type === 'OptionalCallExpression') this.arguments(node, scope);
    else if (node.computed) node.property = this.visit(node.property, scope);
  }

  /** A function of the script. */
  private function(fn: AnyNode, outer: Scope): void {
    if (fn.computed) fn.key = this.visit(fn.key, outer);
    const kind = fn.kind === 'get' ? 'a getter' : fn.kind === 'set' ? 'a setter' : fn.kind === 'constructor' ? 'a constructor' : '';
    if (fn.async) this.body(fn, ALWAYS);
    else if (fn.generator) this.body(fn, guarded('a generator'));
    else if (kind) this.body(fn, guarded(kind));
    // Nothing to wait for: the function is left as it is (the functions inside it are looked at).
    else if (!hasCalls(fn.body)) this.body(fn, guarded(''));
    else this.waiting(fn);
  }

  /** The body of a function, its parameters left alone: `await` isn't allowed in them. */
  private body(fn: AnyNode, scope: Scope): void {
    if (fn.body.type === 'BlockStatement') this.children(fn.body, scope);
    else fn.body = this.value(fn.body, scope);
  }

  /**
   * A function that waits by itself:
   *
   *     function f(a) { const state = {}; return FINISH_FN(state, (async () => {
   *       try { …the body… } catch (error) { state.e = error; state.t = true; } finally { state.d = true; }
   *     })()); }
   *
   * The arrow function keeps `this` and `arguments`. An async function runs until its first `await`
   * before its call returns: with no promise met, `state.d` is set by then.
   */
  private waiting(fn: AnyNode): void {
    if (fn.body.type !== 'BlockStatement') {
      fn.body = t.blockStatement([this.at(fn.body, t.returnStatement(fn.body))]);
      fn.expression = false;
    }
    const block: t.BlockStatement = fn.body;
    this.children(block, IF_PROMISE);
    const failed = t.blockStatement([t.expressionStatement(set('e', id(ERROR_VAR))), t.expressionStatement(set('t', t.booleanLiteral(true)))]);
    const done = t.blockStatement([t.expressionStatement(set('d', t.booleanLiteral(true)))]);
    const attempt = t.tryStatement(t.blockStatement(block.body), t.catchClause(id(ERROR_VAR), failed), done);
    const run = t.callExpression(t.arrowFunctionExpression([], t.blockStatement([attempt]), true), []);
    // The directives ("use strict") stay where they are, at the start of the function.
    block.body = [
      t.variableDeclaration('const', [t.variableDeclarator(id(STATE_VAR), t.objectExpression([]))]),
      t.returnStatement(t.callExpression(id(FINISH_FN), [id(STATE_VAR), run])),
    ];
  }
}

/** The code of a function makes a call (the functions and classes inside it don't count). */
function hasCalls(node: AnyNode): boolean {
  if (isCall(node)) return true;
  for (const key of t.VISITOR_KEYS[node.type] ?? []) {
    for (const child of Array.isArray(node[key]) ? node[key] : [node[key]]) {
      if (!child || typeof child.type !== 'string' || isFunction(child) || child.type === 'ClassBody') continue;
      if (hasCalls(child)) return true;
    }
  }
  return false;
}

/** A function of the script, as the runtime calls it. */
type Callback = (...args: unknown[]) => unknown;

const isPromise = (v: unknown): v is PromiseLike<unknown> => v != null && typeof (v as { then?: unknown }).then === 'function';
const never = () => false;

/** What a function that waits by itself keeps of its body: see `Rewriter.waiting`. */
interface FunctionState {
  /** The body is done. */
  d?: boolean;
  /** It threw `e`. */
  t?: boolean;
  e?: unknown;
  /** It returned `v`. */
  v?: unknown;
}

/**
 * What FINISH_FN is in the script's context: what a function that waits by itself gives. Its value, or
 * its error, when the body is done; the promise of it when the body stopped to wait.
 */
export function finish(state: FunctionState, body: Promise<void>): unknown {
  const settle = () => {
    if (state.t) throw state.e;
    return state.v;
  };
  return state.d ? settle() : body.then(settle);
}

/**
 * What ITERATE_FN is in the script's context. For an array (a typed one too), and for the `forEach` of
 * a Map or a Set, an object whose `method` works as the language's while the callback gives values; from
 * the first promise it gives, the callback is called for one element after the other, each waited for,
 * and the method gives a promise of its result. Anything else is returned as it is: a cursor of the
 * shell waits for its callbacks by itself.
 */
export function iterate(target: unknown, method: string): unknown {
  if (target === null || typeof target !== 'object') return target;
  const native = (target as Record<string, unknown>)[method];
  if (typeof native !== 'function') return target;
  // By tag: the script's objects come from another realm, `instanceof` doesn't know them.
  const tag = Object.prototype.toString.call(target);
  const typed = ArrayBuffer.isView(target) && tag !== '[object DataView]';
  const list = Array.isArray(target) || typed;
  if (!list && !(method === 'forEach' && (tag === '[object Map]' || tag === '[object Set]'))) return target;
  return {
    [method]: (...args: unknown[]) => {
      // The language's own error for what isn't a function.
      if (typeof args[0] !== 'function') return native.apply(target, args);
      return list ? iterateList(target as unknown as unknown[], method, args, typed) : eachEntry(target as Map<unknown, unknown>, args);
    },
  };
}

/** `forEach` of a Map or a Set. */
function eachEntry(target: Map<unknown, unknown>, [fn, thisArg]: unknown[]): unknown {
  const entries = target.entries();
  const rest = (): unknown => {
    for (let next = entries.next(); !next.done; next = entries.next()) {
      const given = (fn as Callback).call(thisArg, next.value[1], next.value[0], target);
      if (isPromise(given)) return given.then(rest);
    }
    return undefined;
  };
  return rest();
}

/**
 * Calls `visit` for the indexes from `from` by `step`, giving each value to `take`, which says when to
 * stop; then `result()`. From the first promise that `visit` gives, the rest runs waiting for each.
 */
function loop(
  from: number,
  length: number,
  step: number,
  skip: (i: number) => boolean,
  visit: (i: number) => unknown,
  take: (value: unknown, i: number) => boolean,
  result: () => unknown,
): unknown {
  let i = from;
  const inside = () => i >= 0 && i < length;
  for (; inside(); i += step) {
    if (skip(i)) continue;
    const value = visit(i);
    if (isPromise(value)) {
      return (async () => {
        if (take(await value, i)) return result();
        for (i += step; inside(); i += step) if (!skip(i) && take(await visit(i), i)) break;
        return result();
      })();
    }
    if (take(value, i)) break;
  }
  return result();
}

/** An iteration method of an array, as the language defines it. */
function iterateList(list: unknown[], method: string, [fn, ...rest]: unknown[], typed: boolean): unknown {
  const call = (i: number) => (fn as Callback).call(rest[0], list[i], i, list);
  const length = list.length;
  const hole = (i: number) => !(i in list);
  // The result is an array of the script's realm, as the method's own; a typed array is built at the end.
  const out: unknown[] = typed ? [] : list.slice(0, 0);
  const made = () => (typed ? new (list.constructor as new (values: unknown[]) => unknown)(out) : out);
  switch (method) {
    case 'forEach':
      return loop(0, length, 1, hole, call, never, () => undefined);
    case 'map':
      // The holes of the array stay holes.
      out.length = length;
      return loop(0, length, 1, hole, call, (v, i) => ((out[i] = v), false), made);
    case 'filter':
      return loop(0, length, 1, hole, call, (v, i) => (v && out.push(list[i]), false), made);
    case 'flatMap':
      return loop(0, length, 1, hole, call, (v) => (Array.isArray(v) ? out.push(...v) : out.push(v), false), () => out);
    case 'some':
    case 'every': {
      // `some` stops at the first true value, `every` at the first false one.
      let stopped = false;
      const some = method === 'some';
      return loop(0, length, 1, hole, call, (v) => (stopped = !!v === some), () => stopped === some);
    }
    case 'find':
    case 'findIndex':
    case 'findLast':
    case 'findLastIndex': {
      let found = -1;
      const last = method.startsWith('findLast');
      const index = method.endsWith('Index');
      const take = (v: unknown, i: number) => (v ? ((found = i), true) : false);
      return loop(last ? length - 1 : 0, length, last ? -1 : 1, never, call, take, () => (index ? found : found < 0 ? undefined : list[found]));
    }
    default: {
      // reduce and reduceRight: without a start value, the first element there is.
      const step = method === 'reduce' ? 1 : -1;
      let from = method === 'reduce' ? 0 : length - 1;
      let acc = rest[0];
      if (!rest.length) {
        while (from >= 0 && from < length && hole(from)) from += step;
        if (from < 0 || from >= length) throw new TypeError('Reduce of empty array with no initial value');
        acc = list[from];
        from += step;
      }
      return loop(from, length, step, hole, (i) => (fn as Callback)(acc, list[i], i, list), (v) => ((acc = v), false), () => acc);
    }
  }
}

/**
 * What SYNC_FN is in the script's context: the value of a call made where nothing can wait. Reading
 * anything of a promise there gives an error that doesn't say why ("….forEach is not a function"): this
 * one names the call and the place.
 */
export function checkSync<T>(value: T, call: string, where: string): T {
  if (!isPromise(value)) return value;
  throw new Error(`${call} gives its result later, and ${where} cannot wait for it: move the call to a function or a method, which can.`);
}

/** What the rewritten script needs in its context, beside RESOLVE_FN, which the shell gives. */
export const RUNTIME: Record<string, unknown> = { [ITERATE_FN]: iterate, [SYNC_FN]: checkSync, [FINISH_FN]: finish };
