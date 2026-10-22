// What package.json contributes to VS Code, read by the standalone app: the commands with their titles
// and icons, the menus with their `when` clauses, the key bindings.
import type { MenuAction } from '../protocol';
import { runtime } from './runtime';

export type Context = Record<string, string | boolean | undefined>;

/** The keys the extension sets with the `setContext` command: every `when` clause sees them. */
const contextKeys: Context = {};

export function setContextKey(key: string, value: unknown): void {
  contextKeys[key] = typeof value === 'string' || typeof value === 'boolean' ? value : value === undefined || value === null ? undefined : !!value;
}

interface MenuEntry {
  command: string;
  group: string;
  order: number;
  when?: string;
}

/** `$(add)` → `add`. */
const iconId = (icon: string | undefined) => /^\$\(([^)]+)\)$/.exec(icon ?? '')?.[1];

export function commandInfo(command: string): { title: string; category?: string; icon?: string } | undefined {
  const found = runtime().packageJSON.contributes?.commands?.find((c) => c.command === command);
  return found && { title: found.title, category: found.category, icon: iconId(found.icon) };
}

export function action(command: string): MenuAction {
  const info = commandInfo(command);
  return { command, title: info?.title ?? command, icon: info?.icon };
}

/** The entries of a menu that apply in `context`, in order: by group (navigation first), then by `@order`. */
export function menu(id: string, context: Context): MenuEntry[] {
  const entries = (runtime().packageJSON.contributes?.menus?.[id] ?? [])
    .filter((e) => evaluate(e.when, context))
    .map((e) => {
      const [group = '', order = '0'] = (e.group ?? '').split('@');
      return { command: e.command, group, order: Number(order) || 0, when: e.when };
    });
  const rank = (group: string) => (group === 'navigation' ? '\u0000' : group);
  return entries.sort((a, b) => (rank(a.group) < rank(b.group) ? -1 : rank(a.group) > rank(b.group) ? 1 : a.order - b.order));
}

/** The commands shown in the command palette: all but those a `commandPalette` entry hides in `context`. */
export function paletteCommands(context: Context): MenuAction[] {
  const rules = runtime().packageJSON.contributes?.menus?.commandPalette ?? [];
  return (runtime().packageJSON.contributes?.commands ?? [])
    .filter((c) => rules.filter((r) => r.command === c.command).every((r) => evaluate(r.when, context)))
    .map((c) => ({ command: c.command, title: c.category ? `${c.category}: ${c.title}` : c.title, icon: iconId(c.icon) }));
}

/** The key bindings that apply in `context`, with the key of this platform (`ctrl+enter`). */
export function keybindings(context: Context): { key: string; command: string }[] {
  return (runtime().packageJSON.contributes?.keybindings ?? [])
    .filter((k) => evaluate(k.when, context))
    .map((k) => ({ key: (process.platform === 'darwin' && k.mac) || k.key, command: k.command }));
}

// ---- when clauses: `a == b`, `a != b`, `a =~ /re/`, `!a`, `a`, joined by && and ||

type Token = { type: 'op'; value: string } | { type: 'word'; value: string } | { type: 'regex'; value: RegExp };

function tokenize(text: string): Token[] {
  const tokens: Token[] = [];
  let i = 0;
  while (i < text.length) {
    const rest = text.slice(i);
    const space = /^\s+/.exec(rest);
    if (space) {
      i += space[0].length;
      continue;
    }
    const op = /^(&&|\|\||==|!=|=~|!|\(|\))/.exec(rest);
    if (op) {
      tokens.push({ type: 'op', value: op[0] });
      i += op[0].length;
      continue;
    }
    const previous = tokens[tokens.length - 1];
    if (rest[0] === '/' && previous?.type === 'op' && previous.value === '=~') {
      // A regular expression literal, up to its unescaped closing slash.
      let end = 1;
      while (end < rest.length && rest[end] !== '/') end += rest[end] === '\\' ? 2 : 1;
      const flags = /^[a-z]*/.exec(rest.slice(end + 1))![0];
      tokens.push({ type: 'regex', value: new RegExp(rest.slice(1, end), flags) });
      i += end + 1 + flags.length;
      continue;
    }
    const quoted = /^'([^']*)'/.exec(rest);
    if (quoted) {
      tokens.push({ type: 'word', value: quoted[1] });
      i += quoted[0].length;
      continue;
    }
    const word = /^[^\s()!=&|]+/.exec(rest);
    if (!word) throw new Error(`Unexpected "${rest[0]}" in the when clause: ${text}`);
    tokens.push({ type: 'word', value: word[0] });
    i += word[0].length;
  }
  return tokens;
}

export function evaluate(when: string | undefined, context: Context): boolean {
  if (!when) return true;
  context = { ...contextKeys, ...context };
  let tokens: Token[];
  try {
    tokens = tokenize(when);
  } catch {
    return false;
  }
  let pos = 0;
  const isOp = (value: string) => {
    const t = tokens[pos];
    return t?.type === 'op' && t.value === value;
  };

  const or = (): boolean => {
    let value = and();
    while (isOp('||')) {
      pos++;
      const right = and();
      value = value || right;
    }
    return value;
  };
  const and = (): boolean => {
    let value = unary();
    while (isOp('&&')) {
      pos++;
      const right = unary();
      value = value && right;
    }
    return value;
  };
  const unary = (): boolean => {
    if (isOp('!')) {
      pos++;
      return !unary();
    }
    if (isOp('(')) {
      pos++;
      const value = or();
      if (isOp(')')) pos++;
      return value;
    }
    const left = tokens[pos++];
    if (left?.type !== 'word') return false;
    const value = context[left.value];
    if (isOp('==') || isOp('!=')) {
      const negate = isOp('!=');
      pos++;
      const right = tokens[pos++];
      const same = right?.type === 'word' && String(value ?? '') === right.value;
      return negate ? !same : same;
    }
    if (isOp('=~')) {
      pos++;
      const right = tokens[pos++];
      return right?.type === 'regex' && right.value.test(String(value ?? ''));
    }
    if (left.value === 'true') return true;
    if (left.value === 'false') return false;
    return !!value;
  };

  return or();
}
