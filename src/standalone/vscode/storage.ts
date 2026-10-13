// The state VS Code keeps for an extension, as files in the app's data folder: globalState and
// workspaceState (JSON), the secrets (encrypted by the operating system) and the settings.
import * as fs from 'fs';
import * as path from 'path';
import { safeStorage } from 'electron';
import { ConfigurationTarget, Event, EventEmitter } from './base';
import { ConfigurationProperty, runtime } from './runtime';

/** A JSON object in a file: read once, written a moment after each change. */
class JsonFile {
  private data: Record<string, unknown> = {};
  private timer: NodeJS.Timeout | undefined;

  constructor(private readonly file: string) {
    try {
      const parsed: unknown = JSON.parse(fs.readFileSync(file, 'utf8'));
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) this.data = parsed as Record<string, unknown>;
    } catch {
      // Missing or unreadable: starts empty.
    }
  }

  get(key: string): unknown {
    return this.data[key];
  }

  keys(): string[] {
    return Object.keys(this.data);
  }

  set(key: string, value: unknown): void {
    if (value === undefined) delete this.data[key];
    else this.data[key] = value;
    this.timer ??= setTimeout(() => this.flush(), 200);
  }

  /** Writes the file now, through a temporary one so a crash can't leave it half written. */
  flush(): void {
    if (!this.timer) return;
    clearTimeout(this.timer);
    this.timer = undefined;
    try {
      fs.mkdirSync(path.dirname(this.file), { recursive: true });
      const tmp = `${this.file}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(this.data, null, 2));
      fs.renameSync(tmp, this.file);
    } catch (err) {
      console.error(`Could not write ${this.file}:`, err);
    }
  }
}

const files: JsonFile[] = [];

function open(name: string): JsonFile {
  const file = new JsonFile(path.join(runtime().userData, name));
  files.push(file);
  return file;
}

/** Writes what is still waiting, before the app quits. */
export function flushStorage(): void {
  files.forEach((f) => f.flush());
}

export class Memento {
  private readonly file: JsonFile;

  constructor(name: string) {
    this.file = open(name);
  }

  keys(): readonly string[] {
    return this.file.keys();
  }

  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  get<T>(key: string, defaultValue?: T): T | undefined {
    const value = this.file.get(key);
    // A copy, as VS Code gives: changing it must not change what is stored.
    return value === undefined ? defaultValue : (structuredClone(value) as T);
  }

  update(key: string, value: unknown): Promise<void> {
    this.file.set(key, value === undefined ? undefined : structuredClone(value));
    return Promise.resolve();
  }

  setKeysForSync(): void {}
}

/** Secrets encrypted with the operating system's keychain (DPAPI, Keychain, libsecret). */
export class SecretStorage {
  private readonly file = open('secrets.json');
  private readonly changed = new EventEmitter<{ key: string }>();
  readonly onDidChange = this.changed.event;

  get(key: string): Promise<string | undefined> {
    const stored = this.file.get(key);
    if (typeof stored !== 'string') return Promise.resolve(undefined);
    try {
      if (stored.startsWith('plain:')) return Promise.resolve(stored.slice(6));
      return Promise.resolve(safeStorage.decryptString(Buffer.from(stored, 'base64')));
    } catch {
      return Promise.resolve(undefined);
    }
  }

  store(key: string, value: string): Promise<void> {
    // Without a keychain (some Linux sessions) there is nothing to encrypt with: the secret is kept as it is.
    const stored = safeStorage.isEncryptionAvailable() ? safeStorage.encryptString(value).toString('base64') : `plain:${value}`;
    this.file.set(key, stored);
    this.changed.fire({ key });
    return Promise.resolve();
  }

  delete(key: string): Promise<void> {
    this.file.set(key, undefined);
    this.changed.fire({ key });
    return Promise.resolve();
  }
}

// ---- settings

export interface ConfigurationChangeEvent {
  affectsConfiguration(section: string): boolean;
}

export interface WorkspaceConfiguration {
  get<T>(key: string): T | undefined;
  get<T>(key: string, defaultValue: T): T;
  has(key: string): boolean;
  update(key: string, value: unknown, target?: ConfigurationTarget | boolean): Promise<void>;
}

/** The settings of the app itself, beside those the extension declares. */
const APP_PROPERTIES: Record<string, ConfigurationProperty> = {
  'app.theme': {
    type: 'string',
    enum: ['system', 'dark', 'light'],
    default: 'system',
    description: 'Color theme: follow the operating system, or always dark or light.',
    order: -1,
  },
};

/** The settings: the user's values in settings.json over the defaults declared in package.json. */
export class Settings {
  private file: JsonFile | undefined;
  private readonly changed = new EventEmitter<ConfigurationChangeEvent>();
  readonly onDidChange: Event<ConfigurationChangeEvent> = this.changed.event;
  /** Values the app computes, e.g. the name of the color theme. */
  private readonly computed = new Map<string, () => unknown>();

  private store(): JsonFile {
    return (this.file ??= open('settings.json'));
  }

  properties(): Record<string, ConfigurationProperty> {
    return { ...APP_PROPERTIES, ...runtime().packageJSON.contributes?.configuration?.properties };
  }

  compute(key: string, value: () => unknown): void {
    this.computed.set(key, value);
  }

  value(key: string): unknown {
    const computed = this.computed.get(key);
    if (computed) return computed();
    const stored = this.store().get(key);
    const property = this.properties()[key];
    if (stored !== undefined && (!property || valid(stored, property))) return stored;
    return property?.default;
  }

  set(key: string, value: unknown): void {
    const property = this.properties()[key];
    // The default isn't stored, so a later change of the default reaches who never chose a value.
    this.store().set(key, value === undefined || (property && value === property.default) ? undefined : value);
    this.fire([key]);
  }

  fire(keys: string[]): void {
    this.changed.fire({
      affectsConfiguration: (section) => keys.some((k) => k === section || k.startsWith(`${section}.`) || section.startsWith(`${k}.`)),
    });
  }

  section(section?: string): WorkspaceConfiguration {
    const full = (key: string) => (section ? `${section}.${key}` : key);
    return {
      get: <T>(key: string, defaultValue?: T) => {
        const value = this.value(full(key));
        return (value === undefined ? defaultValue : value) as T;
      },
      has: (key) => this.value(full(key)) !== undefined,
      update: (key, value) => {
        this.set(full(key), value);
        return Promise.resolve();
      },
    };
  }
}

function valid(value: unknown, property: ConfigurationProperty): boolean {
  if (property.type === 'boolean') return typeof value === 'boolean';
  if (property.type === 'number' || property.type === 'integer') {
    return (
      typeof value === 'number' &&
      Number.isFinite(value) &&
      (property.minimum === undefined || value >= property.minimum) &&
      (property.maximum === undefined || value <= property.maximum)
    );
  }
  if (property.type === 'string') return typeof value === 'string' && (!property.enum || property.enum.includes(value));
  return true;
}

export const settings = new Settings();
