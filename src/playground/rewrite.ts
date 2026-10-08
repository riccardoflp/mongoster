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
  try {
    body = (
      parse(source, {
        ecmaVersion: 'latest',
        sourceType: 'script',
        allowAwaitOutsideFunction: true,
        allowReturnOutsideFunction: true,
        allowHashBang: true,
      }) as unknown as { body: Node[] }
    ).body;
  } catch (err) {
    const loc = (err as { loc?: { line: number; column: number } }).loc;
    const message = (err as Error).message.replace(/\s*\(\d+:\d+\)$/, '');
    throw new ScriptSyntaxError(message, loc?.line ?? 1, (loc?.column ?? 0) + 1);
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
