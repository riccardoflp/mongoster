// The host's end of the conversation with the shell: main.ts feeds it what the window sends.
import type { HostMessage, ShellMessage, ShellRequests } from '../protocol';
import { runtime } from './runtime';

type Of<T extends ShellMessage['type']> = Extract<ShellMessage, { type: T }>;

const handlers = new Map<string, ((message: ShellMessage) => void)[]>();
const requests = new Map<string, (args: unknown) => unknown>();

export function post(message: HostMessage): void {
  runtime().post(message);
}

export function onShell<T extends ShellMessage['type']>(type: T, handler: (message: Of<T>) => void): void {
  const list = handlers.get(type) ?? [];
  list.push(handler as (message: ShellMessage) => void);
  handlers.set(type, list);
}

export function onRequest<K extends keyof ShellRequests>(
  name: K,
  handler: (args: ShellRequests[K]['args']) => ShellRequests[K]['result'] | Promise<ShellRequests[K]['result']>,
): void {
  requests.set(name, handler as (args: unknown) => unknown);
}

export function dispatch(message: ShellMessage): void {
  for (const handler of handlers.get(message.type) ?? []) {
    try {
      handler(message);
    } catch (err) {
      console.error(err);
    }
  }
}

export async function answer(name: string, args: unknown): Promise<unknown> {
  const handler = requests.get(name);
  if (!handler) throw new Error(`Unknown request: ${name}`);
  return handler(args);
}
