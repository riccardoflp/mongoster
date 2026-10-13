// What the `vscode` module of the standalone app needs from the Electron app around it: set once by main.ts.
import type { BrowserWindow } from 'electron';
import type { HostMessage } from '../protocol';

export interface PackageJson {
  name: string;
  displayName?: string;
  version: string;
  contributes?: {
    commands?: { command: string; title: string; category?: string; icon?: string }[];
    menus?: Record<string, { command: string; when?: string; group?: string }[]>;
    keybindings?: { command: string; key: string; mac?: string; when?: string }[];
    views?: Record<string, { id: string; name: string }[]>;
    viewsWelcome?: { view: string; contents: string }[];
    configuration?: { title?: string; properties?: Record<string, ConfigurationProperty> };
  };
}

export interface ConfigurationProperty {
  type?: string;
  default?: unknown;
  minimum?: number;
  maximum?: number;
  enum?: string[];
  description?: string;
  markdownDescription?: string;
  order?: number;
}

export interface Runtime {
  /** The folder holding dist/ and media/. */
  appRoot: string;
  /** The folder of the user's data: connections, settings, undo history. */
  userData: string;
  packageJSON: PackageJson;
  /** Sends a message to the shell (queued until its window is ready). */
  post(message: HostMessage): void;
  window(): BrowserWindow | undefined;
}

let current: Runtime | undefined;

export function setRuntime(value: Runtime): void {
  current = value;
}

export function runtime(): Runtime {
  if (!current) throw new Error('The standalone runtime is not set up yet');
  return current;
}
