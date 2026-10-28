// Import and export of saved connections: from a Compass export, a Mongoster export or a list of connection
// strings (a file or the clipboard), and to those same formats. The files are read and written by
// shared/connectionsFile.ts; here are the questions and the saving into the ConnectionManager.
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { ConnectionInfo, ConnectionManager } from './connections';
import {
  ConnectionsFormat,
  hostOf,
  isEncrypted,
  parseConnections,
  ParsedConnections,
  PassphraseError,
  PortableConnection,
  SecretsMode,
  serializeConnections,
  uniqueName,
} from './shared/connectionsFile';
import { errorMessage } from './tree';

/** Saves changes to a connection and applies them to its open tabs. */
export type UpdateConnection = (id: string, changes: Partial<Omit<ConnectionInfo, 'id'>>, uri?: string) => Promise<void>;

const TITLE_IMPORT = 'Import Connections';
const TITLE_EXPORT = 'Export Connections';
const plural = (n: number, one: string, many = `${one}s`) => `${n.toLocaleString('en-US')} ${n === 1 ? one : many}`;

function summary(c: PortableConnection): string {
  return [
    c.folder && `folder ${c.folder}`,
    c.color,
    c.readOnly && 'read-only',
    c.tls && 'TLS',
    c.ssh && `SSH ${c.ssh.username}@${c.ssh.host}`,
    c.redis && 'redis-oplog',
    ...c.notes,
  ]
    .filter(Boolean)
    .join(' · ');
}

/** Reads the text to import: a file, or the clipboard. */
async function readSource(): Promise<{ text: string; from: string } | undefined> {
  const source = await vscode.window.showQuickPick(
    [
      {
        label: '$(file) From a File…',
        detail: "MongoDB Compass's export (Export saved connections), Mongoster's export, or a text file with one connection string per line",
        file: true,
      },
      {
        label: '$(clippy) From the Clipboard',
        detail: 'Connection strings, one per line (also name = mongodb://… or name<Tab>mongodb://…), or the content of an exported file',
        file: false,
      },
    ],
    { title: TITLE_IMPORT, placeHolder: 'Where are the connections?' },
  );
  if (!source) return undefined;
  if (!source.file) return { text: await vscode.env.clipboard.readText(), from: 'the clipboard' };
  const files = await vscode.window.showOpenDialog({
    title: TITLE_IMPORT,
    openLabel: 'Import',
    canSelectMany: false,
    filters: { 'Connections (JSON, text)': ['json', 'txt', 'text', 'list', 'csv'], 'All files': ['*'] },
  });
  if (!files?.[0]) return undefined;
  return { text: new TextDecoder().decode(await vscode.workspace.fs.readFile(files[0])), from: path.basename(files[0].fsPath) };
}

/** Parses the text, asking for the passphrase of encrypted passwords (empty: import without them). */
async function parse(text: string): Promise<ParsedConnections | undefined> {
  if (!isEncrypted(text)) return parseConnections(text);
  let prompt = 'The passwords in this file are encrypted: enter the passphrase used to export it. Leave it empty to import without the passwords.';
  for (;;) {
    const passphrase = await vscode.window.showInputBox({ title: `${TITLE_IMPORT}: Passphrase`, prompt, password: true, ignoreFocusOut: true });
    if (passphrase === undefined) return undefined;
    try {
      return await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Decrypting the passwords…' }, () =>
        parseConnections(text, passphrase || undefined),
      );
    } catch (err) {
      if (!(err instanceof PassphraseError)) throw err;
      prompt = 'Wrong passphrase: try again, or leave it empty to import without the passwords.';
    }
  }
}

/** Asks where the imported connections go; undefined: cancelled. `fromFile`: each keeps the folder it has in the file. */
async function askFolder(connections: ConnectionManager, withFolders: boolean): Promise<{ folder?: string; fromFile?: boolean } | undefined> {
  const NEW = '$(new-folder) New Folder…';
  const items = [
    ...(withFolders ? [{ label: '$(folder-library) Folders from the File', value: { fromFile: true } }] : []),
    { label: '$(root-folder) No Folder', value: {} },
    ...connections.folders().map((f) => ({ label: `$(folder) ${f}`, value: { folder: f } })),
    { label: NEW, value: {} },
  ];
  const pick = await vscode.window.showQuickPick(items, { title: `${TITLE_IMPORT}: Folder`, placeHolder: 'Where to put the imported connections' });
  if (!pick) return undefined;
  if (pick.label !== NEW) return pick.value;
  const folder = (
    await vscode.window.showInputBox({ title: 'New Folder', prompt: 'Folder name', validateInput: (v) => (v.trim() ? undefined : 'Enter a name') })
  )?.trim();
  return folder ? { folder } : undefined;
}

export async function importConnections(connections: ConnectionManager, updateConnection: UpdateConnection, folder?: string): Promise<void> {
  try {
    const source = await readSource();
    if (!source) return;
    const parsed = await parse(source.text);
    if (!parsed) return;
    const skippedText = parsed.skipped ? ` (${plural(parsed.skipped, parsed.format === 'list' ? 'line was' : 'entry was', parsed.format === 'list' ? 'lines were' : 'entries were')} not a connection)` : '';
    if (!parsed.connections.length) {
      void vscode.window.showInformationMessage(`No connections found in ${source.from}${skippedText}.`);
      return;
    }

    const existing = new Map<string, ConnectionInfo>(connections.list().map((c) => [c.name, c]));
    const identical = new Set<PortableConnection>();
    for (const c of parsed.connections) {
      const same = existing.get(c.name);
      if (same && (await connections.uri(same.id)) === c.uri) identical.add(c);
    }
    const kind = { compass: 'Compass export', mongoster: 'Mongoster export', list: 'list' }[parsed.format];
    const picked = await vscode.window.showQuickPick(
      parsed.connections.map((c) => ({
        label: c.name,
        description: [hostOf(c.uri), existing.has(c.name) && (identical.has(c) ? '✓ already exists (same connection string)' : '✓ already exists')].filter(Boolean).join(' · '),
        detail: summary(c) || undefined,
        picked: !identical.has(c),
        connection: c,
      })),
      {
        title: `${TITLE_IMPORT} from ${source.from}`,
        placeHolder: `${kind}: ${plural(parsed.connections.length, 'connection')}${skippedText}. Choose those to import`,
        canPickMany: true,
        ignoreFocusOut: true,
      },
    );
    if (!picked?.length) return;
    const chosen = picked.map((p) => p.connection);

    let duplicates: 'skip' | 'replace' | 'keep' = 'keep';
    const clashes = chosen.filter((c) => existing.has(c.name));
    if (clashes.length) {
      const names = clashes.slice(0, 10).map((c) => c.name);
      const answer = await vscode.window.showWarningMessage(
        clashes.length === 1 ? `A connection named ${clashes[0].name} already exists.` : `${plural(clashes.length, 'connection')} with the same name already exist.`,
        {
          modal: true,
          detail: `${names.join(', ')}${clashes.length > names.length ? '…' : ''}\n\nSkip: leave them out. Replace: the existing connections take the connection string and the settings of the imported ones. Keep Both: the imported ones are added with a number after the name.`,
        },
        'Skip',
        'Replace',
        'Keep Both',
      );
      if (!answer) return;
      duplicates = answer === 'Skip' ? 'skip' : answer === 'Replace' ? 'replace' : 'keep';
    }

    const target = folder !== undefined ? { folder } : await askFolder(connections, chosen.some((c) => c.folder));
    if (!target) return;

    const taken = new Set(existing.keys());
    let added = 0;
    let replaced = 0;
    let skipped = 0;
    const missing: string[] = [];
    for (const c of chosen) {
      const into = target.fromFile ? c.folder : target.folder;
      const options = c.tls || c.ssh ? { ...(c.tls && { tls: c.tls }), ...(c.ssh && { ssh: c.ssh }) } : undefined;
      const settings = { color: c.color, readOnly: c.readOnly, noHistory: c.noHistory };
      const same = existing.get(c.name);
      if (same && duplicates === 'skip') {
        skipped++;
        continue;
      }
      if (same && duplicates === 'replace') {
        await connections.setOptions(same.id, options);
        await connections.setRedisOplog(same.id, c.redis);
        // A read-only connection stays read-only: formats without the setting don't take the safeguard away.
        await updateConnection(same.id, { ...settings, readOnly: c.readOnly || same.readOnly, folder: into }, c.uri);
        replaced++;
      } else {
        const name = uniqueName(c.name, taken);
        const info = await connections.add(name, c.uri, into, options);
        if (c.redis) await connections.setRedisOplog(info.id, c.redis);
        if (c.color || c.readOnly || c.noHistory) await connections.update(info.id, settings);
        taken.add(name);
        added++;
      }
      if (c.notes.some((n) => n.startsWith('no ') || n.startsWith('passwords not'))) missing.push(c.name);
    }

    const done = [added && `${plural(added, 'connection')} imported`, replaced && `${plural(replaced, 'connection')} replaced`, skipped && `${skipped} skipped`]
      .filter(Boolean)
      .join(', ');
    const lacking = missing.length
      ? ` Without a password: ${missing.slice(0, 5).join(', ')}${missing.length > 5 ? '…' : ''}; set it with Edit Connection… or Connection Settings (TLS / SSH)….`
      : '';
    void vscode.window.showInformationMessage(`${done || 'Nothing imported'}.${lacking}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not import the connections: ${errorMessage(err)}`);
  }
}

/** The connection with its connection string and secrets, as the files take it. */
async function portable(connections: ConnectionManager, info: ConnectionInfo): Promise<PortableConnection | undefined> {
  const uri = await connections.uri(info.id);
  if (!uri) return undefined;
  const options = await connections.options(info.id);
  const redisUrl = info.redisOplog ? await connections.redisUrl(info.id) : undefined;
  return {
    name: info.name,
    uri,
    ...(info.folder && { folder: info.folder }),
    ...(info.color && { color: info.color }),
    ...(info.readOnly && { readOnly: true }),
    ...(info.noHistory && { noHistory: true }),
    ...(options?.tls && { tls: options.tls }),
    ...(options?.ssh && { ssh: options.ssh }),
    ...(info.redisOplog && redisUrl && { redis: { url: redisUrl, settings: info.redisOplog } }),
    notes: [],
  };
}

async function askPassphrase(): Promise<string | undefined> {
  const passphrase = await vscode.window.showInputBox({
    title: `${TITLE_EXPORT}: Passphrase (1/2)`,
    prompt: 'Passphrase to encrypt the passwords with: it will be asked when importing the file',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v.length >= 8 ? undefined : 'At least 8 characters'),
  });
  if (!passphrase) return undefined;
  const again = await vscode.window.showInputBox({
    title: `${TITLE_EXPORT}: Passphrase (2/2)`,
    prompt: 'The same passphrase again',
    password: true,
    ignoreFocusOut: true,
    validateInput: (v) => (v === passphrase ? undefined : "The passphrases don't match"),
  });
  return again === passphrase ? passphrase : undefined;
}

export async function exportConnections(connections: ConnectionManager, folder?: string): Promise<void> {
  try {
    const all = connections.list();
    if (!all.length) {
      void vscode.window.showInformationMessage('There are no connections to export.');
      return;
    }
    const sorted = [...all].sort((a, b) => (a.folder ?? '').localeCompare(b.folder ?? '') || a.name.localeCompare(b.name));
    const picked = await vscode.window.showQuickPick(
      sorted.map((c) => ({
        label: c.name,
        description: [c.folder && `$(folder) ${c.folder}`, c.ssh && 'SSH', c.tls && 'TLS', c.redisOplog && 'redis-oplog', c.readOnly && 'read-only'].filter(Boolean).join(' · '),
        picked: folder === undefined || c.folder === folder,
        info: c,
      })),
      { title: TITLE_EXPORT, placeHolder: 'Choose the connections to export', canPickMany: true, ignoreFocusOut: true },
    );
    if (!picked?.length) return;

    const format = await vscode.window.showQuickPick(
      [
        {
          label: 'Mongoster (JSON)',
          detail: 'All the settings: folders, colors, read-only, TLS, SSH tunnel, redis-oplog. To import into Mongoster, the extension or the desktop app',
          format: 'mongoster' as ConnectionsFormat,
          file: 'mongoster-connections.json',
        },
        {
          label: 'MongoDB Compass (JSON)',
          detail: "Name, color, connection string with the TLS options, SSH tunnel. Compass's Import saved connections reads it",
          format: 'compass' as ConnectionsFormat,
          file: 'compass-connections.json',
        },
        {
          label: 'Connection strings (text)',
          detail: 'One "name = connection string" per line, with the TLS options in it; SSH tunnels and the other settings are left out',
          format: 'list' as ConnectionsFormat,
          file: 'connections.txt',
        },
      ],
      { title: `${TITLE_EXPORT}: Format`, placeHolder: `${plural(picked.length, 'connection')}: choose the format` },
    );
    if (!format) return;

    const secretsPick = await vscode.window.showQuickPick(
      [
        {
          label: 'Without passwords',
          detail: 'Passwords are removed from the connection strings; SSH and Redis passwords and key passphrases are left out',
          mode: 'remove' as SecretsMode,
        },
        ...(format.format === 'list'
          ? []
          : [
              {
                label: 'With passwords, encrypted with a passphrase',
                detail: `AES-256-GCM with a key derived from the passphrase, as Compass does${format.format === 'compass' ? ': Compass asks for it when importing' : ': importing asks for it'}`,
                mode: 'encrypt' as SecretsMode,
              },
            ]),
        { label: 'With passwords in clear text', detail: 'Whoever reads the file can use them', mode: 'include' as SecretsMode },
      ],
      { title: `${TITLE_EXPORT}: Passwords`, placeHolder: 'Include the passwords?' },
    );
    if (!secretsPick) return;
    let passphrase: string | undefined;
    if (secretsPick.mode === 'encrypt') {
      passphrase = await askPassphrase();
      if (!passphrase) return;
    } else if (secretsPick.mode === 'include') {
      const answer = await vscode.window.showWarningMessage(
        'Export the passwords in clear text?',
        { modal: true, detail: 'The file will contain the passwords of the connection strings, SSH and Redis as they are: whoever reads it can connect. Keep it safe, or export with a passphrase instead.' },
        'Export with Passwords',
      );
      if (answer !== 'Export with Passwords') return;
    }

    const list = (await Promise.all(picked.map((p) => portable(connections, p.info)))).filter((c): c is PortableConnection => !!c);
    const { text, notes } = await vscode.window.withProgress(
      { location: vscode.ProgressLocation.Notification, title: passphrase ? 'Encrypting the passwords…' : 'Exporting the connections…' },
      () => serializeConnections(list, format.format, { secrets: secretsPick.mode, passphrase }),
    );
    const ext = path.extname(format.file).slice(1);
    const uri = await vscode.window.showSaveDialog({
      title: TITLE_EXPORT,
      saveLabel: 'Export',
      defaultUri: vscode.Uri.file(path.join(os.homedir(), format.file)),
      filters: ext === 'json' ? { JSON: ['json'] } : { Text: ['txt'] },
    });
    if (!uri) return;
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(text));
    const extra = notes.length ? ` Note: ${notes.join('; ')}.` : '';
    void vscode.window.showInformationMessage(`${plural(list.length, 'connection')} exported to ${path.basename(uri.fsPath)}.${extra}`);
  } catch (err) {
    void vscode.window.showErrorMessage(`Could not export the connections: ${errorMessage(err)}`);
  }
}
