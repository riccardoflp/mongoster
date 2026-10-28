// Playground scripts are written like mongosh: `const u = db.users.findOne(); u.name` works without
// `await`. The script becomes the body of an async function where every top-level expression and
// variable initializer is awaited, and the value of a final expression statement is returned.
import { parse } from 'acorn';
import type { Node } from 'acorn';

export const RESULT_VAR = '__mongosterResult';
export const RESOLVE_FN = '__mongosterResolve';

interface Edit {
  start: number;
  end: number;
  text: string;
}

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

/**
 * Source of an async arrow function expression running the script. Lines are preserved, so errors
 * thrown while running report the script's own line numbers.
 */
export function rewritePlayground(source: string): string {
  let body: Node[];
  const parseBody = (code: string) =>
    (
      parse(code, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        allowHashBang: true,
      }) as unknown as { body: Node[] }
    ).body;
  try {
    body = parseBody(source);
  } catch (err) {
    const loc = (err as { loc?: { line: number; column: number } }).loc;
    const message = (err as Error).message.replace(/\s*\(\d+:\d+\)$/, '');
    throw new ScriptSyntaxError(message, loc?.line ?? 1, (loc?.column ?? 0) + 1);
  }
  // withTransaction(() => { … }) callbacks are awaited like the script: rewritten first, then parsed again.
  const callbacks = transactionCallbacks(body);
  if (callbacks.length) {
    source = applyEdits(source, callbacks);
    body = parseBody(source);
  }
  const edits: Edit[] = [];
  const awaited = (node: Node) => `await ${RESOLVE_FN}((${source.slice(node.start, node.end)}))`;
  body.forEach((stmt, i) => {
    const s = stmt as Node & { expression?: Node; directive?: string; declarations?: { init: Node | null }[] };
    if (s.type === 'ExpressionStatement' && s.expression && !s.directive) {
      const last = i === body.length - 1;
      edits.push({ start: s.start, end: s.end, text: `${last ? `${RESULT_VAR} = ` : ''}${awaited(s.expression)};` });
    } else if (s.type === 'VariableDeclaration') {
      for (const d of s.declarations ?? []) if (d.init) edits.push({ start: d.init.start, end: d.init.end, text: awaited(d.init) });
    }
  });
  let code = source;
  for (const e of edits.sort((a, b) => b.start - a.start)) code = code.slice(0, e.start) + e.text + code.slice(e.end);
  // A hashbang is only valid at the very start of a file.
  code = code.replace(/^#!.*/, '');
  return `(async () => { let ${RESULT_VAR}; ${code}\n; return ${RESULT_VAR}; })()`;
}

/** The edits applied from the end, so the offsets of the others stay valid; ties keep their order. */
function applyEdits(source: string, edits: Edit[]): string {
  let code = source;
  const sorted = edits.map((e, i) => ({ e, i })).sort((a, b) => b.e.start - a.e.start || b.i - a.i);
  for (const { e } of sorted) code = code.slice(0, e.start) + e.text + code.slice(e.end);
  return code;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any -- acorn's ESTree nodes, read loosely
type AnyNode = Node & Record<string, any>;

function childNodes(node: AnyNode): AnyNode[] {
  const out: AnyNode[] = [];
  for (const value of Object.values(node)) {
    for (const v of Array.isArray(value) ? value : [value]) if (v && typeof v === 'object' && typeof v.type === 'string') out.push(v);
  }
  return out;
}

/**
 * The callbacks of `….withTransaction(fn)` written inline run like the script itself: `fn` becomes
 * async and its statements are awaited (also in its if / for / try blocks, not in nested functions), so
 * `session.withTransaction(() => { coll.insertOne(…); })` waits for every write before committing.
 * Only insertions on the same lines: line numbers stay those of the script.
 */
function transactionCallbacks(body: Node[]): Edit[] {
  const edits: Edit[] = [];
  const insert = (at: number, text: string) => edits.push({ start: at, end: at, text });
  const awaited = (n: AnyNode) => {
    insert(n.start, `await ${RESOLVE_FN}((`);
    insert(n.end, '))');
  };
  const statement = (s: AnyNode | null | undefined): void => {
    if (!s) return;
    switch (s.type) {
      case 'ExpressionStatement':
        if (!s.directive) awaited(s.expression);
        break;
      case 'VariableDeclaration':
        for (const d of s.declarations) if (d.init) awaited(d.init);
        break;
      case 'ReturnStatement':
        if (s.argument) awaited(s.argument);
        break;
      case 'BlockStatement':
        s.body.forEach(statement);
        break;
      case 'IfStatement':
        statement(s.consequent);
        statement(s.alternate);
        break;
      case 'ForStatement':
      case 'ForInStatement':
      case 'ForOfStatement':
      case 'WhileStatement':
      case 'DoWhileStatement':
      case 'LabeledStatement':
        statement(s.body);
        break;
      case 'TryStatement':
        statement(s.block);
        statement(s.handler?.body);
        statement(s.finalizer);
        break;
      case 'SwitchStatement':
        for (const c of s.cases) c.consequent.forEach(statement);
        break;
    }
  };
  const walk = (node: AnyNode): void => {
    const callee = node.type === 'CallExpression' ? node.callee : undefined;
    const fn = node.arguments?.[0];
    if (
      callee?.type === 'MemberExpression' &&
      !callee.computed &&
      callee.property.name === 'withTransaction' &&
      (fn?.type === 'ArrowFunctionExpression' || fn?.type === 'FunctionExpression') &&
      !fn.generator
    ) {
      if (!fn.async) insert(fn.start, 'async ');
      if (fn.body.type === 'BlockStatement') fn.body.body.forEach(statement);
      else awaited(fn.body);
    }
    childNodes(node).forEach(walk);
  };
  body.forEach((n) => walk(n as AnyNode));
  return edits;
}
