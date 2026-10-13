// vscode.commands: the extension's commands, plus the few of VS Code's own that it runs.
import { Disposable } from './base';

type Handler = (...args: any[]) => unknown;

const registry = new Map<string, Handler>();

export function registerCommand(command: string, callback: Handler, thisArg?: unknown): Disposable {
  registry.set(command, thisArg ? callback.bind(thisArg) : callback);
  return new Disposable(() => {
    if (registry.get(command) === callback) registry.delete(command);
  });
}

export async function executeCommand<T = unknown>(command: string, ...args: unknown[]): Promise<T> {
  const handler = registry.get(command);
  if (!handler) throw new Error(`command '${command}' not found`);
  return (await handler(...args)) as T;
}

export function hasCommand(command: string): boolean {
  return registry.has(command);
}

/** Runs a command asked by the user (a click, a key): its failure is shown, as VS Code does. */
export function runCommand(command: string, ...args: unknown[]): void {
  executeCommand(command, ...args).catch((err: unknown) => {
    console.error(err);
    void import('./ui').then((ui) => ui.showErrorMessage(err instanceof Error ? err.message : String(err)));
  });
}
