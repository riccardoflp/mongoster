// Playground scripts are written like mongosh: `const n = db.stock.findOne({}).n`,
// `db.c.find().toArray().length` or `print(db.c.countDocuments())` work without `await`. The script
// becomes the body of an async function where every call is awaited where it is (`x.findOne().n` runs
// as `(await x.findOne()).n`), as are expression statements and variable initializers, and the value
// of a final expression statement is returned. Awaiting goes through RESOLVE_FN, which leaves the
// shell's cursors alone: `db.c.find().sort(…).limit(5)` stays a lazy cursor until a terminal method.
import { parse } from 'acorn';
import type { Node } from 'acorn';

export const RESULT_VAR = '__mongosterResult';
export const RESOLVE_FN = '__mongosterResolve';

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

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- acorn's ESTree nodes, read loosely
type AnyNode = Node & Record<string, any>;

/** Text inserted at `at`, the opening or closing half of a wrap. */
interface Insert {
  at: number;
  text: string;
  /** Rank of the wrap: an outer node's is lower (it is visited first). */
  order: number;
  close: boolean;
}

/**
 * Source of an async arrow function expression running the script. Text is only inserted, never on
 * new lines: errors thrown while running report the script's own line numbers.
 */
export function rewritePlayground(source: string): string {
  let body: AnyNode[];
  try {
    body = (
      parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        allowHashBang: true,
      }) as unknown as { body: AnyNode[] }
    ).body;
  } catch (err) {
    const loc = (err as { loc?: { line: number; column: number } }).loc;
    const message = (err as Error).message.replace(/\s*\(\d+:\d+\)$/, '');
    throw new ScriptSyntaxError(message, loc?.line ?? 1, (loc?.column ?? 0) + 1);
  }
  // A hashbang is only valid at the very start of a file.
  const code = applyInserts(source, new Awaiter().script(body)).replace(/^#!.*/, '');
  return `(async () => { let ${RESULT_VAR}; ${code}\n; return ${RESULT_VAR}; })()`;
}

/** The insertions at each offset in reading order: closing texts (inner first), then opening ones (outer first). */
function applyInserts(source: string, inserts: Insert[]): string {
  const byOffset = new Map<number, Insert[]>();
  for (const ins of inserts) {
    const list = byOffset.get(ins.at);
    if (list) list.push(ins);
    else byOffset.set(ins.at, [ins]);
  }
  let code = '';
  let last = 0;
  for (const at of [...byOffset.keys()].sort((a, b) => a - b)) {
    const list = byOffset.get(at)!.sort((a, b) => Number(b.close) - Number(a.close) || (a.close ? b.order - a.order : a.order - b.order));
    code += source.slice(last, at) + list.map((i) => i.text).join('');
    last = at;
  }
  return code + source.slice(last);
}

const isFunction = (n: AnyNode) => n.type === 'FunctionExpression' || n.type === 'ArrowFunctionExpression';
/** Expressions whose value is never a promise (the calls inside them are awaited on their own). */
const NEVER_PROMISES = new Set([
  'Literal', 'TemplateLiteral', 'ObjectExpression', 'ArrayExpression', 'UnaryExpression', 'BinaryExpression', 'UpdateExpression',
  'FunctionExpression', 'ArrowFunctionExpression', 'ClassExpression',
]);
const isCall = (n: AnyNode) => n.type === 'CallExpression' || n.type === 'TaggedTemplateExpression';

/** A link of the chain up to `n` (`a?.b().c()`) is optional: the chain may stop before `n`. */
function hasOptional(n: AnyNode): boolean {
  for (let c: AnyNode | undefined = n; c && (c.type === 'CallExpression' || c.type === 'MemberExpression'); ) {
    if (c.optional) return true;
    c = c.type === 'CallExpression' ? c.callee : c.object;
  }
  return false;
}

/** Where a node sits in an optional chain (`a?.b.c()`): its whole expression, or a link under it. */
type Chain = 'none' | 'top' | 'link';

/**
 * Finds where `await` goes. Code runs async in the script, in its blocks (if, for, while, try, switch…)
 * and in functions already async: the inline callbacks of `….withTransaction(fn)` become async, so
 * `session.withTransaction(() => { coll.insertOne(…); })` waits for every write before committing.
 * Other functions (callbacks of `map`, `forEach`…) are left as they are: `await` isn't allowed there.
 */
class Awaiter {
  private readonly inserts: Insert[] = [];
  private order = 0;

  script(body: AnyNode[]): Insert[] {
    body.forEach((s, i) => {
      if (i === body.length - 1 && s.type === 'ExpressionStatement' && !s.directive) {
        // The value of the final expression is the result.
        this.wrap(s.expression, true, `${RESULT_VAR} = `);
        this.expression(s.expression, true);
      } else this.statement(s);
    });
    return this.inserts;
  }

  /**
   * `await RESOLVE_FN((node))`: in parentheses, except at the start of a statement where a `(` would
   * continue the previous line when it has no semicolon.
   */
  private wrap(n: AnyNode, bare: boolean, prefix = ''): void {
    const order = this.order++;
    this.inserts.push({ at: n.start, text: `${prefix}${bare ? '' : '('}await ${RESOLVE_FN}((`, order, close: false });
    this.inserts.push({ at: n.end, text: bare ? '))' : ')))', order, close: true });
  }

  /**
   * A value awaited as a whole (an initializer, a returned value), unless it can't be a promise; a call
   * is awaited as any call. Functions and classes keep the name they get from the variable.
   */
  private value(n: AnyNode | null | undefined): void {
    if (!n) return;
    const whole = !isCall(n) && !NEVER_PROMISES.has(n.type);
    if (whole) this.wrap(n, false);
    this.expression(n, whole);
  }

  private statement(s: AnyNode | null | undefined): void {
    if (!s) return;
    switch (s.type) {
      case 'ExpressionStatement':
        if (s.directive) return;
        this.wrap(s.expression, true);
        this.expression(s.expression, true);
        return;
      case 'VariableDeclaration':
        for (const d of s.declarations) {
          this.expression(d.id);
          this.value(d.init);
        }
        return;
      case 'ReturnStatement':
        this.value(s.argument);
        return;
      case 'ThrowStatement':
        this.expression(s.argument);
        return;
      case 'BlockStatement':
        s.body.forEach((c: AnyNode) => this.statement(c));
        return;
      case 'IfStatement':
        this.expression(s.test);
        this.statement(s.consequent);
        this.statement(s.alternate);
        return;
      case 'ForStatement':
        if (s.init?.type === 'VariableDeclaration') this.statement(s.init);
        else this.expression(s.init);
        this.expression(s.test);
        this.expression(s.update);
        this.statement(s.body);
        return;
      case 'ForInStatement':
      case 'ForOfStatement':
        if (s.left.type === 'VariableDeclaration') this.statement(s.left);
        else this.expression(s.left);
        this.expression(s.right);
        this.statement(s.body);
        return;
      case 'WhileStatement':
      case 'DoWhileStatement':
        this.expression(s.test);
        this.statement(s.body);
        return;
      case 'LabeledStatement':
        this.statement(s.body);
        return;
      case 'WithStatement':
        this.expression(s.object);
        this.statement(s.body);
        return;
      case 'TryStatement':
        this.statement(s.block);
        if (s.handler) {
          this.expression(s.handler.param);
          this.statement(s.handler.body);
        }
        this.statement(s.finalizer);
        return;
      case 'SwitchStatement':
        this.expression(s.discriminant);
        for (const c of s.cases) {
          this.expression(c.test);
          c.consequent.forEach((x: AnyNode) => this.statement(x));
        }
        return;
      case 'FunctionDeclaration':
        this.asyncFunction(s);
        return;
      case 'ClassDeclaration':
        this.expression(s.superClass);
        return;
    }
  }

  /** The body of a function that is async: its statements run like the script's. */
  private asyncFunction(fn: AnyNode): void {
    // Parameters are left alone: `await` isn't allowed in them.
    if (!fn.async) return;
    if (fn.body.type === 'BlockStatement') fn.body.body.forEach((s: AnyNode) => this.statement(s));
    else this.value(fn.body);
  }

  /**
   * Awaits the calls of an expression where they are. `wrapped`: the node itself is already awaited
   * as a whole. `chain`: its place in an optional chain, where a call after a `?.` that is followed by
   * more links (`a?.b().c`) can't be awaited alone without losing the chain's short-circuit.
   */
  private expression(n: AnyNode | null | undefined, wrapped = false, chain: Chain = 'none'): void {
    if (!n || typeof n.type !== 'string') return;
    switch (n.type) {
      case 'FunctionExpression':
      case 'ArrowFunctionExpression':
        this.asyncFunction(n);
        return;
      case 'ClassExpression':
        this.expression(n.superClass);
        return;
      case 'ChainExpression':
        this.expression(n.expression, wrapped, 'top');
        return;
      case 'CallExpression': {
        if (!wrapped && !(chain === 'link' && hasOptional(n))) this.wrap(n, false);
        const link: Chain = chain === 'none' ? 'none' : 'link';
        const callee = n.callee;
        if (callee.type === 'MemberExpression') {
          this.expression(callee.object, false, link);
          if (callee.computed) this.expression(callee.property);
        } else this.expression(callee, false, link);
        n.arguments.forEach((a: AnyNode, i: number) => {
          if (i === 0 && this.transactionCallback(n, a)) return;
          this.expression(a);
        });
        return;
      }
      case 'MemberExpression':
        this.expression(n.object, false, chain === 'none' ? 'none' : 'link');
        if (n.computed) this.expression(n.property);
        return;
      case 'TaggedTemplateExpression':
        if (!wrapped) this.wrap(n, false);
        this.expression(n.tag);
        this.expression(n.quasi);
        return;
      case 'Property':
        if (n.computed) this.expression(n.key);
        this.expression(n.value);
        return;
    }
    for (const c of childNodes(n)) this.expression(c);
  }

  /** `….withTransaction(fn)` with `fn` written in place: made async, and awaited inside like the script. */
  private transactionCallback(call: AnyNode, fn: AnyNode): boolean {
    const callee = call.callee;
    if (
      callee.type !== 'MemberExpression' ||
      callee.computed ||
      callee.property.name !== 'withTransaction' ||
      !isFunction(fn) ||
      fn.generator
    )
      return false;
    if (!fn.async) this.inserts.push({ at: fn.start, text: 'async ', order: this.order++, close: false });
    this.asyncFunction({ ...fn, async: true } as AnyNode);
    return true;
  }
}

function childNodes(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const value of Object.values(node)) {
    for (const v of Array.isArray(value) ? value : [value]) if (v && typeof v === 'object' && typeof v.type === 'string') out.push(v);
  }
  return out;
}
