/** The tokens of a query, a sort or a pipeline in mongosh syntax, to color it as the editor would. */

export type SyntaxRole = 'key' | 'op' | 'string' | 'ref' | 'number' | 'bool' | 'oid' | 'date' | 'regex' | 'comment';

export interface SyntaxToken {
  from: number;
  to: number;
  role: SyntaxRole;
}

/** The shell's helpers and constants, colored as the values they make. */
const WORDS: Record<string, SyntaxRole> = {
  ObjectId: 'oid',
  UUID: 'oid',
  BinData: 'oid',
  Binary: 'oid',
  HexData: 'oid',
  MD5: 'oid',
  DBRef: 'oid',
  ISODate: 'date',
  Date: 'date',
  Timestamp: 'date',
  NumberLong: 'number',
  NumberInt: 'number',
  NumberDecimal: 'number',
  Decimal128: 'number',
  Long: 'number',
  Int32: 'number',
  Double: 'number',
  NaN: 'number',
  Infinity: 'number',
  true: 'bool',
  false: 'bool',
  null: 'bool',
  undefined: 'bool',
  MinKey: 'bool',
  MaxKey: 'bool',
  new: 'op',
};

const IDENT = /[A-Za-z_$][\w$]*/y;
const NUMBER = /-?(?:0[xX][\da-fA-F]+|(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?)/y;
const REGEX = /\/(?:\\.|\[(?:\\.|[^\]\\\n])*\]|[^/\\\n[])+\/[a-z]*/y;
/** The argument of a helper, colored with it: `ObjectId("…")`, `NumberLong(5)`, `ISODate()`. */
const CALL = /\(\s*(?:"[^"\n]*"|'[^'\n]*'|-?[\d.eE+]*)\s*\)/y;

function stringEnd(src: string, start: number): number {
  const quote = src[start];
  for (let i = start + 1; i < src.length; i++) {
    if (src[i] === '\\') i++;
    else if (src[i] === quote || src[i] === '\n') return i + 1;
  }
  return src.length;
}

/** Whether a `:` follows `at`, past spaces: what was just read is a key. */
function beforeColon(src: string, at: number): boolean {
  while (at < src.length && /[ \t\r\n]/.test(src[at])) at++;
  return src[at] === ':';
}

export function tokenize(src: string): SyntaxToken[] {
  const out: SyntaxToken[] = [];
  const push = (from: number, to: number, role: SyntaxRole) => out.push({ from, to, role });
  let prev = ''; // the last character that isn't a space, outside comments
  let i = 0;
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    const start = i;
    if (c === '/' && src[i + 1] === '/') {
      const end = src.indexOf('\n', i);
      i = end === -1 ? src.length : end;
      push(start, i, 'comment');
      continue;
    }
    if (c === '/' && src[i + 1] === '*') {
      const end = src.indexOf('*/', i + 2);
      i = end === -1 ? src.length : end + 2;
      push(start, i, 'comment');
      continue;
    }
    if (c === '"' || c === "'" || c === '`') {
      i = stringEnd(src, i);
      const key = beforeColon(src, i);
      const dollar = src[start + 1] === '$';
      push(start, i, key ? (dollar ? 'op' : 'key') : dollar && /[A-Za-z_$]/.test(src[start + 2] ?? '') ? 'ref' : 'string');
      prev = c;
      continue;
    }
    // A `/` after a value is a division; where a value starts, it opens a regex.
    const valueStart = prev === '' || ':[,(=!&|?{'.includes(prev);
    if (c === '/' && valueStart) {
      REGEX.lastIndex = i;
      const m = REGEX.exec(src);
      if (m) {
        i += m[0].length;
        push(start, i, 'regex');
        prev = '/';
        continue;
      }
    }
    if (/[\d.]/.test(c) || (c === '-' && valueStart)) {
      NUMBER.lastIndex = i;
      const m = NUMBER.exec(src);
      if (m) {
        i += m[0].length;
        push(start, i, 'number');
        prev = '0';
        continue;
      }
    }
    IDENT.lastIndex = i;
    const word = IDENT.exec(src);
    if (word) {
      i += word[0].length;
      const role: SyntaxRole | undefined = beforeColon(src, i)
        ? word[0].startsWith('$')
          ? 'op'
          : 'key'
        : Object.prototype.hasOwnProperty.call(WORDS, word[0])
          ? WORDS[word[0]]
          : undefined;
      if (role === 'oid' || role === 'date' || role === 'number') {
        CALL.lastIndex = i;
        const call = CALL.exec(src);
        if (call) i += call[0].length;
      }
      if (role) push(start, i, role);
      prev = 'a';
      continue;
    }
    prev = c;
    i++;
  }
  return out;
}
