// Files of saved connections, to import and export them: MongoDB Compass's export ("Compass Connections"),
// Mongoster's own JSON, and plain lists of connection strings. Pure functions (Node's crypto only), so that
// they can be tried without VS Code.
//
// Compass's format, as written by `serializeConnections` in compass/packages/connection-storage
// (import-export-connection.ts): EJSON `{ type: "Compass Connections", version: 1, connections: [...] }`, each
// connection `{ id, favorite: { name, color }, savedConnectionType, connectionOptions: { connectionString,
// sshTunnel: { host, port, username, password, identityKeyFile, identityKeyPassphrase }, fleOptions, … } }`.
// Exported with a passphrase, the secrets (`password` of the connection string, `sshTunnelPassword`,
// `sshTunnelPassphrase`, `tlsCertificateKeyFilePassword`, `proxyPassword`, `awsSessionToken`) are taken out
// and stored per connection in `connectionSecrets`: base64 of version (0x0001) ‖ salt (16) ‖ iv (16) ‖
// auth tag (16) ‖ AES-256-GCM ciphertext of `{"secrets":{…}}`, the key derived from the passphrase with
// PBKDF2-SHA512, 100,000 iterations (encrypt.ts). Mongoster's own file encrypts its secrets the same way.
import { createCipheriv, createDecipheriv, pbkdf2, randomBytes, randomUUID } from 'crypto';
import type { ConnectionColor } from '../connections';
import type { SshOptions, TlsOptions } from '../transport';
import type { RedisOplogSettings } from './oplog';

/** A connection as it goes into or comes out of a file, with its secrets when they are known. */
export interface PortableConnection {
  name: string;
  uri: string;
  folder?: string;
  color?: ConnectionColor;
  readOnly?: boolean;
  noHistory?: boolean;
  tls?: TlsOptions;
  ssh?: SshOptions;
  redis?: { url: string; settings: RedisOplogSettings };
  /** What is missing or was left out on import (no password, settings Mongoster doesn't have). */
  notes: string[];
}

export type ConnectionsFormat = 'mongoster' | 'compass' | 'list';
/** Without the passwords, with them in clear text, or with them encrypted with a passphrase. */
export type SecretsMode = 'remove' | 'include' | 'encrypt';

export interface ParsedConnections {
  format: ConnectionsFormat;
  connections: PortableConnection[];
  /** Lines of a list, or entries of a file, that aren't connections. */
  skipped: number;
}

export class PassphraseError extends Error {}

const MONGOSTER_TYPE = 'Mongoster Connections';
const COMPASS_TYPE = 'Compass Connections';
const FILE_VERSION = 1;
const COLORS: readonly ConnectionColor[] = ['red', 'orange', 'yellow', 'green', 'blue', 'purple'];

// ---- connection strings

/** scheme, user info (without its @), hosts, the rest (/db?options). */
const URI_PARTS = /^(mongodb(?:\+srv)?:\/\/)(?:([^@/?#]*)@)?([^/?#]*)(.*)$/is;

export function isConnectionString(text: string): boolean {
  return /^mongodb(\+srv)?:\/\/[^/?#]/i.test(text.trim());
}

/** The host part of a connection string, without credentials: the default name of a connection. */
export function hostOf(uri: string): string {
  return /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri)?.[1] ?? 'MongoDB';
}

/** User info of a URL of any scheme: the user and the password, as written (percent-encoded). */
function userInfo(url: string): { scheme: string; user: string; password?: string; rest: string } | undefined {
  const m = /^([a-z][a-z0-9+.-]*:\/\/)([^@/?#]*)@(.*)$/is.exec(url);
  if (!m) return undefined;
  const colon = m[2].indexOf(':');
  return colon < 0
    ? { scheme: m[1], user: m[2], rest: m[3] }
    : { scheme: m[1], user: m[2].slice(0, colon), password: m[2].slice(colon + 1), rest: m[3] };
}

/** The password in a URL (percent-encoded as written), if any. */
export function urlPassword(url: string): string | undefined {
  return userInfo(url)?.password || undefined;
}

/** The URL with another password (percent-encoded), or without one. Without a user, as `redis://:password@host`. */
export function withPassword(url: string, password: string | undefined): string {
  const info = userInfo(url);
  if (!info) return password ? url.replace(/^([a-z][a-z0-9+.-]*:\/\/)/i, `$1:${password}@`) : url;
  if (!password) return info.user ? `${info.scheme}${info.user}@${info.rest}` : `${info.scheme}${info.rest}`;
  return `${info.scheme}${info.user}:${password}@${info.rest}`;
}

function urlUser(url: string): string | undefined {
  return userInfo(url)?.user || undefined;
}

const decodeParam = (s: string) => {
  try {
    return decodeURIComponent(s.replace(/\+/g, ' '));
  } catch {
    return s;
  }
};

/** The options of a connection string, as [key, decoded value] in their order. */
export function uriParams(uri: string): [string, string][] {
  const rest = URI_PARTS.exec(uri.trim())?.[4] ?? '';
  const q = rest.indexOf('?');
  if (q < 0) return [];
  return rest
    .slice(q + 1)
    .split('&')
    .filter(Boolean)
    .map((p) => {
      const eq = p.indexOf('=');
      return eq < 0 ? [decodeParam(p), ''] : [decodeParam(p.slice(0, eq)), decodeParam(p.slice(eq + 1))];
    });
}

function uriParam(uri: string, key: string): string | undefined {
  return uriParams(uri).find(([k]) => k.toLowerCase() === key.toLowerCase())?.[1];
}

/**
 * The connection string with options removed (`undefined`) or set (added at the end, replacing those with the
 * same name, ignoring case). The other options stay as they were written.
 */
export function setUriParams(uri: string, changes: Record<string, string | undefined>): string {
  const parts = URI_PARTS.exec(uri.trim());
  if (!parts) return uri;
  const [, scheme, auth, hosts, rest] = parts;
  const q = rest.indexOf('?');
  const path = q < 0 ? rest : rest.slice(0, q);
  const keys = new Set(Object.keys(changes).map((k) => k.toLowerCase()));
  const kept = (q < 0 ? '' : rest.slice(q + 1)).split('&').filter((p) => p && !keys.has(decodeParam(p.split('=')[0]).toLowerCase()));
  const added = Object.entries(changes).flatMap(([k, v]) => (v === undefined ? [] : [`${k}=${encodeURIComponent(v)}`]));
  const query = [...kept, ...added].join('&');
  return `${scheme}${auth !== undefined ? `${auth}@` : ''}${hosts}${query ? `${path || '/'}?${query}` : path}`;
}

const TLS_PARAMS = ['tls', 'ssl', 'tlsCAFile', 'tlsCertificateKeyFile', 'tlsCertificateKeyFilePassword', 'tlsAllowInvalidCertificates', 'tlsAllowInvalidHostnames', 'tlsInsecure'];
const isTrue = (v: string | undefined) => v?.toLowerCase() === 'true';

/**
 * Moves the TLS certificate files of a connection string (`tlsCAFile`, `tlsCertificateKeyFile`, with their
 * related options) to Mongoster's TLS settings, which keep them apart. Without files the string stays as it is.
 */
export function tlsFromUri(uri: string): { uri: string; tls?: TlsOptions } {
  const get = (k: string) => uriParam(uri, k);
  const caFile = get('tlsCAFile');
  const certificateKeyFile = get('tlsCertificateKeyFile');
  if (!caFile && !certificateKeyFile) return { uri };
  if ((get('tls') ?? get('ssl'))?.toLowerCase() === 'false') return { uri };
  const insecure = isTrue(get('tlsInsecure'));
  const tls: TlsOptions = {
    ...(caFile && { caFile }),
    ...(certificateKeyFile && { certificateKeyFile }),
    ...(certificateKeyFile && get('tlsCertificateKeyFilePassword') && { certificateKeyFilePassword: get('tlsCertificateKeyFilePassword') }),
    ...((insecure || isTrue(get('tlsAllowInvalidCertificates'))) && { allowInvalidCertificates: true }),
    ...((insecure || isTrue(get('tlsAllowInvalidHostnames'))) && { allowInvalidHostnames: true }),
  };
  return { uri: setUriParams(uri, Object.fromEntries(TLS_PARAMS.map((k) => [k, undefined]))), tls };
}

/** Mongoster's TLS settings written into the connection string, for the formats that only have that. */
export function tlsIntoUri(uri: string, tls: TlsOptions | undefined, withSecrets: boolean): string {
  if (!tls) return uri;
  return setUriParams(uri, {
    tls: 'true',
    ssl: undefined,
    tlsCAFile: tls.caFile,
    tlsCertificateKeyFile: tls.certificateKeyFile,
    tlsCertificateKeyFilePassword: withSecrets ? tls.certificateKeyFilePassword : undefined,
    tlsAllowInvalidCertificates: tls.allowInvalidCertificates ? 'true' : undefined,
    tlsAllowInvalidHostnames: tls.allowInvalidHostnames ? 'true' : undefined,
    tlsInsecure: undefined,
  });
}

const NO_PASSWORD_MECHANISMS = ['MONGODB-X509', 'GSSAPI', 'MONGODB-AWS', 'MONGODB-OIDC'];

/** A user in the connection string whose password isn't there (and the mechanism needs one). */
export function lacksPassword(uri: string): boolean {
  if (!urlUser(uri) || urlPassword(uri)) return false;
  return !NO_PASSWORD_MECHANISMS.includes((uriParam(uri, 'authMechanism') ?? '').toUpperCase());
}

/** The notes about missing secrets, from the connection as it is now. */
function missingSecrets(c: PortableConnection): string[] {
  return [
    lacksPassword(c.uri) && 'no password',
    c.ssh?.auth === 'password' && !c.ssh.password && 'no SSH password',
  ].filter((n): n is string => !!n);
}

// ---- colors

/** Compass's color codes (use-connection-color.ts): Green, Teal, Blue, Iris, Purple, Red, Pink, Orange, Yellow, Gray. */
const FROM_COMPASS: Record<string, ConnectionColor | undefined> = {
  color1: 'green',
  color2: 'green',
  color3: 'blue',
  color4: 'blue',
  color5: 'purple',
  color6: 'red',
  color7: 'purple',
  color8: 'orange',
  color9: 'yellow',
  color10: undefined,
  teal: 'green',
  iris: 'blue',
  pink: 'purple',
};
const TO_COMPASS: Record<ConnectionColor, string> = { red: 'color6', orange: 'color8', yellow: 'color9', green: 'color1', blue: 'color3', purple: 'color5' };
const HUES: Record<ConnectionColor, number> = { red: 0, orange: 30, yellow: 55, green: 125, blue: 215, purple: 280 };

/** The closest of Mongoster's colors to a Compass color code, a color name or a hex color (older Compass). */
export function colorFrom(value: unknown): ConnectionColor | undefined {
  if (typeof value !== 'string') return undefined;
  const v = value.trim().toLowerCase();
  if ((COLORS as readonly string[]).includes(v)) return v as ConnectionColor;
  if (v in FROM_COMPASS) return FROM_COMPASS[v];
  const hex = /^#?([0-9a-f]{3}|[0-9a-f]{6})$/.exec(v)?.[1];
  if (!hex) return undefined;
  const full = hex.length === 3 ? hex.replace(/./g, '$&$&') : hex;
  const [r, g, b] = [0, 2, 4].map((i) => parseInt(full.slice(i, i + 2), 16) / 255);
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  // Grays have no color.
  if (max - min < 0.12) return undefined;
  const d = max - min;
  const hue = (max === r ? ((g - b) / d) % 6 : max === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60;
  const h = (hue + 360) % 360;
  const distance = (c: ConnectionColor) => Math.min(Math.abs(h - HUES[c]), 360 - Math.abs(h - HUES[c]));
  return COLORS.reduce((best, c) => (distance(c) < distance(best) ? c : best));
}

// ---- encryption, as Compass's Encrypter / Decrypter

const ENCRYPT_VERSION = 0x0001;
const SALT = 16;
const IV = 16;
const TAG = 16;

const deriveKey = (passphrase: string, salt: Buffer) =>
  new Promise<Buffer>((resolve, reject) => pbkdf2(Buffer.from(passphrase, 'utf8'), salt, 100_000, 32, 'sha512', (err, key) => (err ? reject(err) : resolve(key))));

/** Encrypts with one salt (and so one key derivation) for all the values of a file, as Compass does. */
export class Encrypter {
  private key?: Promise<{ salt: Buffer; key: Buffer }>;
  constructor(private readonly passphrase: string) {}

  async encrypt(plaintext: string): Promise<string> {
    this.key ??= (async () => {
      const salt = randomBytes(SALT);
      return { salt, key: await deriveKey(this.passphrase, salt) };
    })();
    const { salt, key } = await this.key;
    const iv = randomBytes(IV);
    const cipher = createCipheriv('aes-256-gcm', key, iv, { authTagLength: TAG });
    const ciphertext = Buffer.concat([cipher.update(Buffer.from(plaintext, 'utf8')), cipher.final()]);
    const version = Buffer.alloc(2);
    version.writeUInt16BE(ENCRYPT_VERSION);
    return Buffer.concat([version, salt, iv, cipher.getAuthTag(), ciphertext]).toString('base64');
  }
}

export class Decrypter {
  private readonly keys = new Map<string, Promise<Buffer>>();
  constructor(private readonly passphrase: string) {}

  async decrypt(base64: string): Promise<string> {
    const data = Buffer.from(base64, 'base64');
    if (data.length < 2 + SALT + IV + TAG) throw new Error('The encrypted data is too short');
    const version = data.readUInt16BE(0);
    if (version !== ENCRYPT_VERSION) throw new Error(`Unknown encrypted data version: 0x${version.toString(16)}`);
    const salt = data.subarray(2, 2 + SALT);
    const iv = data.subarray(2 + SALT, 2 + SALT + IV);
    const tag = data.subarray(2 + SALT + IV, 2 + SALT + IV + TAG);
    const cacheKey = salt.toString('base64');
    let key = this.keys.get(cacheKey);
    if (!key) this.keys.set(cacheKey, (key = deriveKey(this.passphrase, Buffer.from(salt))));
    const decipher = createDecipheriv('aes-256-gcm', await key, iv, { authTagLength: TAG });
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(data.subarray(2 + SALT + IV + TAG)), decipher.final()]).toString('utf8');
    } catch {
      throw new PassphraseError('Wrong passphrase, or the file is damaged');
    }
  }
}

// ---- reading

/** Canonical EJSON numbers and dates (`{ "$numberInt": "22" }`) as plain values. */
function plain(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(plain);
  if (!value || typeof value !== 'object') return value;
  const o = value as Record<string, unknown>;
  const keys = Object.keys(o);
  if (keys.length === 1) {
    const [k] = keys;
    if (k === '$numberInt' || k === '$numberLong' || k === '$numberDouble') return Number(o[k]);
    if (k === '$date') return typeof o[k] === 'object' ? plain(o[k]) : o[k];
    if (k === '$oid') return o[k];
  }
  return Object.fromEntries(keys.map((k) => [k, plain(o[k])]));
}

type Json = Record<string, unknown>;
const obj = (v: unknown): Json | undefined => (v && typeof v === 'object' && !Array.isArray(v) ? (v as Json) : undefined);
const str = (v: unknown): string | undefined => (typeof v === 'string' && v ? v : undefined);

function parseJson(text: string): Json | undefined {
  const t = text.replace(/^﻿/, '').trim();
  if (!t.startsWith('{')) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(t);
  } catch (err) {
    throw new Error(`Not a valid JSON file: ${(err as Error).message}`);
  }
  return obj(plain(parsed));
}

export function detectFormat(text: string): ConnectionsFormat {
  const json = parseJson(text);
  if (!json) return 'list';
  if (json.type === COMPASS_TYPE) return 'compass';
  if (json.type === MONGOSTER_TYPE) return 'mongoster';
  throw new Error('This JSON file is neither a Compass export ("Compass Connections") nor a Mongoster export');
}

/** Whether the file has passwords encrypted with a passphrase. */
export function isEncrypted(text: string): boolean {
  const json = parseJson(text);
  const list = Array.isArray(json?.connections) ? (json.connections as unknown[]) : [];
  return list.some((c) => !!str(obj(c)?.connectionSecrets) || !!str(obj(c)?.secrets));
}

/**
 * The connections of a file: Compass's or Mongoster's export, or a list of connection strings. Encrypted
 * passwords are decrypted with `passphrase` (a wrong one throws PassphraseError); without it they are left out.
 */
export async function parseConnections(text: string, passphrase?: string): Promise<ParsedConnections> {
  const format = detectFormat(text);
  if (format === 'list') return parseList(text);
  const json = parseJson(text)!;
  if (json.version !== FILE_VERSION) throw new Error(`Unsupported version of the file: ${String(json.version)} (expected ${FILE_VERSION})`);
  if (!Array.isArray(json.connections)) throw new Error('The file has no list of connections');
  const decrypter = passphrase ? new Decrypter(passphrase) : undefined;
  const connections: PortableConnection[] = [];
  let skipped = 0;
  for (const entry of json.connections as unknown[]) {
    const e = obj(entry);
    const c = e && (format === 'compass' ? await fromCompass(e, decrypter) : await fromMongoster(e, decrypter));
    if (c) connections.push(c);
    else skipped++;
  }
  return { format, connections, skipped };
}

/** One connection string per line, optionally `name = mongodb://…` or `name<TAB>mongodb://…`; `#` comments. */
export function parseList(text: string): ParsedConnections {
  const connections: PortableConnection[] = [];
  let skipped = 0;
  for (const raw of text.replace(/^﻿/, '').split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith('#') || line.startsWith('//')) continue;
    const at = line.search(/mongodb(\+srv)?:\/\//i);
    if (at < 0) {
      skipped++;
      continue;
    }
    const uri = line.slice(at).split(/\s/)[0].replace(/["'`,;]+$/, '');
    if (!isConnectionString(uri)) {
      skipped++;
      continue;
    }
    // What comes before: the name, without the separator and the quotes around it (`"name" = "mongodb://…"`).
    const name = line
      .slice(0, at)
      .replace(/[\s=:,;|"'`]+$/, '')
      .replace(/^["'`]+/, '')
      .trim();
    const { uri: rest, tls } = tlsFromUri(uri);
    const c: PortableConnection = { name: name || hostOf(uri), uri: rest, ...(tls && { tls }), notes: [] };
    c.notes = missingSecrets(c);
    connections.push(c);
  }
  return { format: 'list', connections, skipped };
}

interface CompassSecrets {
  password?: string;
  sshTunnelPassword?: string;
  sshTunnelPassphrase?: string;
  tlsCertificateKeyFilePassword?: string;
  proxyPassword?: string;
  awsSessionToken?: string;
}

async function decryptSecrets<T>(encrypted: string | undefined, decrypter: Decrypter | undefined): Promise<T | undefined | 'locked'> {
  if (!encrypted) return undefined;
  if (!decrypter) return 'locked';
  let parsed: unknown;
  try {
    parsed = JSON.parse(await decrypter.decrypt(encrypted));
  } catch (err) {
    if (err instanceof PassphraseError) throw err;
    throw new Error(`The encrypted passwords can't be read: ${(err as Error).message}`);
  }
  return (obj(obj(plain(parsed))?.secrets) ?? {}) as T;
}

async function fromCompass(entry: Json, decrypter: Decrypter | undefined): Promise<PortableConnection | undefined> {
  const options = obj(entry.connectionOptions) ?? {};
  let uri = str(options.connectionString)?.trim();
  if (!uri || !isConnectionString(uri)) return undefined;
  const notes: string[] = [];
  const secrets = await decryptSecrets<CompassSecrets>(str(entry.connectionSecrets), decrypter);
  const s: CompassSecrets = secrets === 'locked' ? {} : (secrets ?? {});
  if (secrets === 'locked') notes.push('passwords not imported (encrypted)');
  // As Compass's mergeSecrets: the password into the connection string, the other secrets into their options.
  if (s.password) uri = withPassword(uri, s.password);
  if (s.tlsCertificateKeyFilePassword) uri = setUriParams(uri, { tlsCertificateKeyFilePassword: s.tlsCertificateKeyFilePassword });
  if (s.proxyPassword) uri = setUriParams(uri, { proxyPassword: s.proxyPassword });
  if (s.awsSessionToken) {
    const props = (uriParam(uri, 'authMechanismProperties') ?? '').split(',').filter((p) => p && !p.startsWith('AWS_SESSION_TOKEN:'));
    uri = setUriParams(uri, { authMechanismProperties: [...props, `AWS_SESSION_TOKEN:${s.awsSessionToken}`].join(',') });
  }
  const { uri: withoutTls, tls } = tlsFromUri(uri);
  const favorite = obj(entry.favorite);
  const c: PortableConnection = {
    name: str(favorite?.name)?.trim() || hostOf(withoutTls),
    uri: withoutTls,
    ...(tls && { tls }),
    notes,
  };
  const color = colorFrom(favorite?.color);
  if (color) c.color = color;

  const tunnel = obj(options.sshTunnel);
  if (tunnel && str(tunnel.host)) {
    if (/^mongodb\+srv:/i.test(c.uri)) notes.push('SSH tunnel not imported: a mongodb+srv:// connection string can\'t go through one');
    else {
      const keyFile = Array.isArray(tunnel.identityKeyFile) ? str(tunnel.identityKeyFile[0]) : str(tunnel.identityKeyFile);
      const port = Number(tunnel.port) || 22;
      c.ssh = { host: str(tunnel.host)!, ...(port !== 22 && { port }), username: str(tunnel.username) ?? '', auth: keyFile ? 'privateKey' : 'password' };
      if (keyFile) {
        c.ssh.privateKeyFile = keyFile;
        const passphrase = s.sshTunnelPassphrase ?? str(tunnel.identityKeyPassphrase);
        if (passphrase) c.ssh.passphrase = passphrase;
      } else c.ssh.password = s.sshTunnelPassword ?? str(tunnel.password) ?? '';
      if (hostOf(c.uri).includes(',')) notes.push('the SSH tunnel goes to the first host only');
    }
  }
  const fle = obj(obj(options.fleOptions)?.autoEncryption);
  if (fle && Object.keys(fle).length) notes.push('In-Use Encryption settings not imported');
  if (options.useApplicationLevelProxy) notes.push('application proxy setting not imported');
  if (secrets !== 'locked') notes.push(...missingSecrets(c));
  return c;
}

interface MongosterSecrets {
  password?: string;
  tlsCertificateKeyFilePassword?: string;
  sshPassword?: string;
  sshPassphrase?: string;
  redisPassword?: string;
}

async function fromMongoster(entry: Json, decrypter: Decrypter | undefined): Promise<PortableConnection | undefined> {
  const uri = str(entry.uri)?.trim();
  if (!uri || !isConnectionString(uri)) return undefined;
  const notes: string[] = [];
  const secrets = await decryptSecrets<MongosterSecrets>(str(entry.secrets), decrypter);
  const s: MongosterSecrets = secrets === 'locked' ? {} : (secrets ?? {});
  if (secrets === 'locked') notes.push('passwords not imported (encrypted)');
  const c: PortableConnection = { name: str(entry.name)?.trim() || hostOf(uri), uri: s.password ? withPassword(uri, s.password) : uri, notes };
  if (str(entry.folder)?.trim()) c.folder = str(entry.folder)!.trim();
  const color = colorFrom(entry.color);
  if (color) c.color = color;
  if (entry.readOnly === true) c.readOnly = true;
  if (entry.noHistory === true) c.noHistory = true;

  const tls = obj(entry.tls);
  if (tls) {
    c.tls = {};
    if (str(tls.caFile)) c.tls.caFile = str(tls.caFile);
    if (str(tls.certificateKeyFile)) c.tls.certificateKeyFile = str(tls.certificateKeyFile);
    const keyPassword = s.tlsCertificateKeyFilePassword ?? str(tls.certificateKeyFilePassword);
    if (keyPassword && c.tls.certificateKeyFile) c.tls.certificateKeyFilePassword = keyPassword;
    if (tls.allowInvalidCertificates === true) c.tls.allowInvalidCertificates = true;
    if (tls.allowInvalidHostnames === true) c.tls.allowInvalidHostnames = true;
  }
  const ssh = obj(entry.ssh);
  if (ssh && str(ssh.host)) {
    const auth = ssh.auth === 'privateKey' || ssh.auth === 'agent' ? ssh.auth : 'password';
    const port = Number(ssh.port) || 22;
    c.ssh = { host: str(ssh.host)!, ...(port !== 22 && { port }), username: str(ssh.username) ?? '', auth };
    if (auth === 'password') c.ssh.password = s.sshPassword ?? str(ssh.password) ?? '';
    if (auth === 'privateKey') {
      c.ssh.privateKeyFile = str(ssh.privateKeyFile) ?? '';
      const passphrase = s.sshPassphrase ?? str(ssh.passphrase);
      if (passphrase) c.ssh.passphrase = passphrase;
    }
  }
  const redis = obj(entry.redisOplog);
  if (redis && str(redis.url)) {
    const list = (v: unknown) => (Array.isArray(v) ? v.filter((x): x is string => typeof x === 'string' && !!x.trim()).map((x) => x.trim()) : []);
    const namespaces = list(redis.namespaces);
    const scope = list(redis.scope);
    c.redis = {
      url: s.redisPassword ? withPassword(str(redis.url)!, s.redisPassword) : str(redis.url)!,
      settings: { ...(str(redis.prefix) && { prefix: str(redis.prefix) }), ...(namespaces.length && { namespaces }), ...(scope.length && { scope }) },
    };
  }
  if (secrets !== 'locked') notes.push(...missingSecrets(c));
  return c;
}

// ---- writing

export interface ExportOptions {
  secrets: SecretsMode;
  /** For `secrets: 'encrypt'`. */
  passphrase?: string;
}

export interface ExportResult {
  text: string;
  /** What the format couldn't keep. */
  notes: string[];
}

/** Writes the connections in one of the formats; 'list' can't encrypt (its passwords are removed or in clear). */
export async function serializeConnections(list: PortableConnection[], format: ConnectionsFormat, options: ExportOptions): Promise<ExportResult> {
  if (options.secrets === 'encrypt' && !options.passphrase) throw new Error('A passphrase is needed to encrypt the passwords');
  if (format === 'list' && options.secrets === 'encrypt') throw new Error('A list of connection strings can\'t be encrypted');
  const encrypter = options.secrets === 'encrypt' ? new Encrypter(options.passphrase!) : undefined;
  const notes = new Set<string>();
  const count = (n: number, what: string) => `${n} ${what}`;

  if (format === 'list') {
    const lines = [`# Connections exported from Mongoster: name = connection string${options.secrets === 'remove' ? ' (without passwords)' : ''}`];
    for (const c of list) {
      let uri = tlsIntoUri(c.uri, c.tls, options.secrets === 'include');
      if (options.secrets === 'remove') uri = withPassword(uri, undefined);
      lines.push(`${c.name.replace(/[\r\n=]+/g, ' ').trim()} = ${uri}`);
    }
    const ssh = list.filter((c) => c.ssh).length;
    if (ssh) notes.add(`${count(ssh, ssh === 1 ? 'SSH tunnel was' : 'SSH tunnels were')} left out (a connection string can't hold one)`);
    const other = list.filter((c) => c.folder || c.color || c.readOnly || c.redis).length;
    if (other) notes.add('folders, colors, read-only and redis-oplog were left out');
    return { text: `${lines.join('\n')}\n`, notes: [...notes] };
  }

  if (format === 'compass') {
    const connections = [];
    for (const c of list) {
      let uri = tlsIntoUri(c.uri, c.tls, true);
      const secrets: CompassSecrets = {};
      const tunnel: Json | undefined = c.ssh && { host: c.ssh.host, port: c.ssh.port ?? 22, username: c.ssh.username };
      if (c.ssh?.auth === 'privateKey' && c.ssh.privateKeyFile) tunnel!.identityKeyFile = c.ssh.privateKeyFile;
      if (c.ssh?.auth === 'agent') notes.add("Compass can't use the SSH agent: those tunnels have no password or key");
      // As Compass's extractSecrets, the secrets are taken out, then encrypted or dropped.
      if (urlPassword(uri)) secrets.password = urlPassword(uri);
      uri = withPassword(uri, undefined);
      const keyPassword = uriParam(uri, 'tlsCertificateKeyFilePassword');
      if (keyPassword) secrets.tlsCertificateKeyFilePassword = keyPassword;
      uri = setUriParams(uri, { tlsCertificateKeyFilePassword: undefined });
      if (c.ssh?.auth === 'password' && c.ssh.password) secrets.sshTunnelPassword = c.ssh.password;
      if (c.ssh?.auth === 'privateKey' && c.ssh.passphrase) secrets.sshTunnelPassphrase = c.ssh.passphrase;

      const entry: Json = {
        id: randomUUID(),
        favorite: { name: c.name, ...(c.color && { color: TO_COMPASS[c.color] }) },
        savedConnectionType: 'favorite',
        connectionOptions: { connectionString: uri, ...(tunnel && { sshTunnel: tunnel }) },
      };
      if (options.secrets === 'include') {
        const merged = entry.connectionOptions as Json;
        if (secrets.password) merged.connectionString = withPassword(uri, secrets.password);
        if (secrets.tlsCertificateKeyFilePassword) merged.connectionString = setUriParams(String(merged.connectionString), { tlsCertificateKeyFilePassword: secrets.tlsCertificateKeyFilePassword });
        if (secrets.sshTunnelPassword) tunnel!.password = secrets.sshTunnelPassword;
        if (secrets.sshTunnelPassphrase) tunnel!.identityKeyPassphrase = secrets.sshTunnelPassphrase;
      } else if (encrypter && Object.keys(secrets).length) entry.connectionSecrets = await encrypter.encrypt(JSON.stringify({ secrets }));
      connections.push(entry);
    }
    const other = list.filter((c) => c.folder || c.readOnly || c.redis).length;
    if (other) notes.add("folders, read-only and redis-oplog were left out (Compass doesn't have them)");
    return { text: `${JSON.stringify({ type: COMPASS_TYPE, version: FILE_VERSION, connections }, null, 2)}\n`, notes: [...notes] };
  }

  const connections = [];
  for (const c of list) {
    const secrets: MongosterSecrets = {};
    const entry: Json = { name: c.name, uri: withPassword(c.uri, undefined) };
    if (urlPassword(c.uri)) secrets.password = urlPassword(c.uri);
    if (c.folder) entry.folder = c.folder;
    if (c.color) entry.color = c.color;
    if (c.readOnly) entry.readOnly = true;
    if (c.noHistory) entry.noHistory = true;
    if (c.tls) {
      const { certificateKeyFilePassword, ...tls } = c.tls;
      if (certificateKeyFilePassword) secrets.tlsCertificateKeyFilePassword = certificateKeyFilePassword;
      entry.tls = tls;
    }
    if (c.ssh) {
      const { password, passphrase, ...ssh } = c.ssh;
      if (password) secrets.sshPassword = password;
      if (passphrase) secrets.sshPassphrase = passphrase;
      entry.ssh = ssh;
    }
    if (c.redis) {
      if (urlPassword(c.redis.url)) secrets.redisPassword = urlPassword(c.redis.url);
      entry.redisOplog = { url: withPassword(c.redis.url, undefined), ...c.redis.settings };
    }
    if (options.secrets === 'include') {
      // In clear text: each secret back in its place.
      entry.uri = c.uri;
      if (c.tls && secrets.tlsCertificateKeyFilePassword) (entry.tls as Json).certificateKeyFilePassword = secrets.tlsCertificateKeyFilePassword;
      if (c.ssh && secrets.sshPassword) (entry.ssh as Json).password = secrets.sshPassword;
      if (c.ssh && secrets.sshPassphrase) (entry.ssh as Json).passphrase = secrets.sshPassphrase;
      if (c.redis) (entry.redisOplog as Json).url = c.redis.url;
    } else if (encrypter && Object.keys(secrets).length) entry.secrets = await encrypter.encrypt(JSON.stringify({ secrets }));
    connections.push(entry);
  }
  const secrets = options.secrets === 'include' ? 'included' : options.secrets === 'encrypt' ? 'encrypted' : 'removed';
  return { text: `${JSON.stringify({ type: MONGOSTER_TYPE, version: FILE_VERSION, secrets, connections }, null, 2)}\n`, notes: [] };
}

/** `name`, or `name (2)`, `name (3)`… when it's taken. */
export function uniqueName(name: string, taken: ReadonlySet<string>): string {
  if (!taken.has(name)) return name;
  for (let i = 2; ; i++) if (!taken.has(`${name} (${i})`)) return `${name} (${i})`;
}
