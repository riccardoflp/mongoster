// Form to add a connection, or to change one, with its TLS certificates and SSH tunnel. Passwords stay
// in the SecretStorage: the form only knows whether one is saved, and an empty field keeps it.
import * as fs from 'fs';
import * as vscode from 'vscode';
import { ConnectionInfo, ConnectionManager } from './connections';
import type { ConnectionEditorHostMessage, ConnectionEditorViewMessage, ConnectionFileField, ConnectionForm } from './shared/messages';
import type { RedisOplogSettings } from './shared/oplog';
import { parseRedisUrl, testRedis } from './redisOplog';
import { ConnectionOptions, tunnelTarget } from './transport';
import { errorMessage } from './tree';

/** The redis-oplog section of the form: the Redis URL (secret) and the settings; undefined when off. */
export type RedisOplogForm = { url: string; settings: RedisOplogSettings } | undefined;
export type SaveConnection = (id: string, name: string, uri: string, options: ConnectionOptions | undefined, redis: RedisOplogForm) => Promise<void>;

const FILE_LABELS: Record<ConnectionFileField, string> = {
  caFile: 'CA certificate',
  certificateKeyFile: 'client certificate and key (PEM)',
  privateKeyFile: 'SSH private key',
};

class Invalid extends Error {
  constructor(
    message: string,
    readonly field?: string,
  ) {
    super(message);
  }
}

function hostOf(uri: string): string {
  return /^mongodb(?:\+srv)?:\/\/(?:[^@/]*@)?([^/?]+)/.exec(uri)?.[1] ?? 'MongoDB';
}

function emptyForm(): ConnectionForm {
  return {
    name: '',
    uri: 'mongodb://localhost:27017',
    tls: { enabled: false, caFile: '', certificateKeyFile: '', certificateKeyFilePassword: '', allowInvalidCertificates: false, allowInvalidHostnames: false },
    ssh: { enabled: false, host: '', port: '22', username: '', auth: 'password', password: '', privateKeyFile: '', passphrase: '' },
    redis: { enabled: false, url: 'redis://localhost:6379', prefix: '', namespaces: '', scope: '' },
  };
}

export class ConnectionEditor {
  private static readonly panels = new Map<string, ConnectionEditor>();
  private readonly panel: vscode.WebviewPanel;
  private busy = false;

  /** `existing` undefined: a new connection. */
  static show(context: vscode.ExtensionContext, connections: ConnectionManager, existing: ConnectionInfo | undefined, save: SaveConnection, folder?: string): void {
    const key = existing?.id ?? 'new';
    const open = ConnectionEditor.panels.get(key);
    if (open) {
      open.panel.reveal();
      return;
    }
    ConnectionEditor.panels.set(key, new ConnectionEditor(context, connections, existing, save, folder));
  }

  static close(id: string): void {
    ConnectionEditor.panels.get(id)?.panel.dispose();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private readonly existing: ConnectionInfo | undefined,
    private readonly save: SaveConnection,
    private readonly folder: string | undefined,
  ) {
    this.panel = vscode.window.createWebviewPanel(
      'mongoster.connection',
      existing ? `Connection: ${existing.name}` : 'New Connection',
      vscode.ViewColumn.Active,
      { enableScripts: true, localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')] },
    );
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => ConnectionEditor.panels.delete(existing?.id ?? 'new'));
    this.panel.webview.onDidReceiveMessage((m: ConnectionEditorViewMessage) => void this.receive(m));
  }

  private post(m: ConnectionEditorHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private async receive(m: ConnectionEditorViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.postInit();
        break;
      case 'browse':
        await this.browse(m.field);
        break;
      case 'test':
        await this.run('test', m.form);
        break;
      case 'save':
        await this.run('save', m.form);
        break;
      case 'cancel':
        this.panel.dispose();
        break;
    }
  }

  private async postInit(): Promise<void> {
    const form = emptyForm();
    const saved = { certificateKeyFilePassword: false, sshPassword: false, passphrase: false };
    if (this.existing) {
      const options = await this.connections.options(this.existing.id);
      form.name = this.existing.name;
      form.uri = (await this.connections.uri(this.existing.id)) ?? '';
      const tls = options?.tls;
      if (tls) {
        form.tls = {
          enabled: true,
          caFile: tls.caFile ?? '',
          certificateKeyFile: tls.certificateKeyFile ?? '',
          certificateKeyFilePassword: '',
          allowInvalidCertificates: !!tls.allowInvalidCertificates,
          allowInvalidHostnames: !!tls.allowInvalidHostnames,
        };
        saved.certificateKeyFilePassword = !!tls.certificateKeyFilePassword;
      }
      const ssh = options?.ssh;
      if (ssh) {
        form.ssh = { enabled: true, host: ssh.host, port: String(ssh.port ?? 22), username: ssh.username, auth: ssh.auth, password: '', privateKeyFile: ssh.privateKeyFile ?? '', passphrase: '' };
        saved.sshPassword = !!ssh.password;
        saved.passphrase = !!ssh.passphrase;
      }
      const redis = this.existing.redisOplog;
      if (redis) {
        form.redis = {
          enabled: true,
          url: (await this.connections.redisUrl(this.existing.id)) ?? '',
          prefix: redis.prefix ?? '',
          namespaces: (redis.namespaces ?? []).join(', '),
          scope: (redis.scope ?? []).join('\n'),
        };
      }
    }
    this.post({ type: 'init', isNew: !this.existing, form, saved });
  }

  private async browse(field: ConnectionFileField): Promise<void> {
    const files = await vscode.window.showOpenDialog({
      title: `Choose the ${FILE_LABELS[field]}`,
      canSelectMany: false,
      openLabel: 'Choose',
      filters: field === 'privateKeyFile' ? undefined : { Certificates: ['pem', 'crt', 'cer', 'key'], 'All files': ['*'] },
    });
    if (files?.[0]) this.post({ type: 'file', field, path: files[0].fsPath });
  }

  /** The form as connection string, name and options, with the saved secrets for the empty password fields. */
  private async parse(form: ConnectionForm): Promise<{ uri: string; name: string; options: ConnectionOptions | undefined; redis: RedisOplogForm }> {
    const uri = form.uri.trim();
    if (!/^mongodb(\+srv)?:\/\//.test(uri)) throw new Invalid('The connection string must start with mongodb:// or mongodb+srv://', 'uri');
    const saved = this.existing ? await this.connections.options(this.existing.id) : undefined;
    const options: ConnectionOptions = {};
    const file = (path: string, field: string, label: string) => {
      const p = path.trim();
      if (p && !fs.existsSync(p)) throw new Invalid(`The ${label} file does not exist: ${p}`, field);
      return p || undefined;
    };
    if (form.tls.enabled) {
      options.tls = {
        caFile: file(form.tls.caFile, 'caFile', 'CA certificate'),
        certificateKeyFile: file(form.tls.certificateKeyFile, 'certificateKeyFile', 'client certificate'),
        certificateKeyFilePassword: form.tls.certificateKeyFilePassword || saved?.tls?.certificateKeyFilePassword || undefined,
        allowInvalidCertificates: form.tls.allowInvalidCertificates || undefined,
        allowInvalidHostnames: form.tls.allowInvalidHostnames || undefined,
      };
      if (!options.tls.certificateKeyFile) delete options.tls.certificateKeyFilePassword;
    }
    if (form.ssh.enabled) {
      const s = form.ssh;
      if (!s.host.trim()) throw new Invalid('The SSH host is missing', 'sshHost');
      const port = Number(s.port || 22);
      if (!Number.isInteger(port) || port < 1 || port > 65535) throw new Invalid('The SSH port must be a number from 1 to 65535', 'sshPort');
      if (!s.username.trim()) throw new Invalid('The SSH username is missing', 'sshUsername');
      // The same SSH server keeps its saved password or passphrase.
      const same = saved?.ssh && saved.ssh.host === s.host.trim() && saved.ssh.username === s.username.trim();
      options.ssh = { host: s.host.trim(), port, username: s.username.trim(), auth: s.auth };
      if (s.auth === 'password') options.ssh.password = s.password || (same ? saved?.ssh?.password : undefined) || '';
      if (s.auth === 'privateKey') {
        options.ssh.privateKeyFile = file(s.privateKeyFile, 'privateKeyFile', 'private key');
        if (!options.ssh.privateKeyFile) throw new Invalid('Choose the private key file', 'privateKeyFile');
        const passphrase = s.passphrase || (same ? saved?.ssh?.passphrase : undefined);
        if (passphrase) options.ssh.passphrase = passphrase;
      }
      try {
        tunnelTarget(uri);
      } catch (err) {
        throw new Invalid(errorMessage(err), 'uri');
      }
    }
    // Drop the unset keys, so that the stored JSON stays small.
    const clean = JSON.parse(JSON.stringify(options)) as ConnectionOptions;
    return { uri, name: form.name.trim() || hostOf(uri), options: clean.tls || clean.ssh ? clean : undefined, redis: parseRedis(form.redis) };
  }

  private async run(what: 'test' | 'save', form: ConnectionForm): Promise<void> {
    if (this.busy) return;
    let parsed: Awaited<ReturnType<ConnectionEditor['parse']>>;
    try {
      parsed = await this.parse(form);
    } catch (err) {
      this.post({ type: 'result', ok: false, message: errorMessage(err), field: err instanceof Invalid ? err.field : undefined });
      return;
    }
    this.busy = true;
    this.post({ type: 'busy', what });
    try {
      if (what === 'test') {
        try {
          const version = await ConnectionManager.test(parsed.uri, parsed.options, this.connections.checkHostKey);
          const via = parsed.options?.ssh ? ` through ${parsed.options.ssh.username}@${parsed.options.ssh.host}` : '';
          const mongo = `Connected to ${hostOf(parsed.uri)}${via}: MongoDB ${version}.`;
          if (!parsed.redis) return this.post({ type: 'result', ok: true, message: mongo });
          try {
            this.post({ type: 'result', ok: true, message: `${mongo} ${await testRedis(parsed.redis.url)} answers.` });
          } catch (err) {
            this.post({ type: 'result', ok: false, message: `${mongo} Could not connect to Redis: ${errorMessage(err)}`, field: 'redisUrl' });
          }
        } catch (err) {
          this.post({ type: 'result', ok: false, message: `Could not connect: ${errorMessage(err)}` });
        }
        return;
      }
      if (this.existing) await this.save(this.existing.id, parsed.name, parsed.uri, parsed.options, parsed.redis);
      else {
        const info = await this.connections.add(parsed.name, parsed.uri, this.folder, parsed.options);
        if (parsed.redis) await this.connections.setRedisOplog(info.id, parsed.redis);
      }
      this.panel.dispose();
      void vscode.window.setStatusBarMessage(`Mongoster: connection ${parsed.name} saved`, 3000);
    } catch (err) {
      this.post({ type: 'result', ok: false, message: errorMessage(err) });
    } finally {
      this.busy = false;
    }
  }

  private html(): string {
    const webview = this.panel.webview;
    const asset = (...p: string[]) => webview.asWebviewUri(vscode.Uri.joinPath(this.context.extensionUri, ...p));
    const nonce = Array.from({ length: 32 }, () => Math.floor(Math.random() * 36).toString(36)).join('');
    return /* html */ `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src ${webview.cspSource}; font-src ${webview.cspSource}; script-src 'nonce-${nonce}';">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <link rel="stylesheet" href="${asset('media', 'connectionEditor.css')}">
  <link rel="stylesheet" href="${asset('media', 'controls.css')}">
  <title>Connection</title>
</head>
<body>
  <form id="form" autocomplete="off" novalidate>
    <h1 id="heading">New Connection</h1>

    <section>
      <label for="name">Name</label>
      <input id="name" type="text" spellcheck="false" placeholder="Shown in the tree (default: the host)">
      <label for="uri">Connection string</label>
      <input id="uri" class="mono" type="text" spellcheck="false" placeholder="mongodb://user:password@host:27017/?authSource=admin">
    </section>

    <section>
      <h2><label class="check"><input id="tlsEnabled" type="checkbox"> TLS / SSL</label></h2>
      <p class="hint">Encrypts the connection. Without certificates the system's trusted authorities are used (as with <code>tls=true</code> in the connection string).</p>
      <div class="fields" id="tlsFields">
        <label for="caFile">CA certificate</label>
        <div class="file"><input id="caFile" class="mono" type="text" spellcheck="false" placeholder="ca.pem — to trust a private certificate authority"><button type="button" class="secondary" data-browse="caFile">Browse…</button></div>
        <label for="certificateKeyFile">Client certificate</label>
        <div class="file"><input id="certificateKeyFile" class="mono" type="text" spellcheck="false" placeholder="client.pem — certificate and private key, when the server requires one"><button type="button" class="secondary" data-browse="certificateKeyFile">Browse…</button></div>
        <label for="certificateKeyFilePassword">Key password</label>
        <input id="certificateKeyFilePassword" type="password" placeholder="If the client key is encrypted">
        <span></span>
        <div class="checks">
          <label class="check" title="Accepts any certificate: the connection is encrypted but the server is not verified"><input id="allowInvalidCertificates" type="checkbox"> Allow invalid certificates <span class="warn">(insecure)</span></label>
          <label class="check" title="Accepts a valid certificate issued for another host name"><input id="allowInvalidHostnames" type="checkbox"> Allow invalid host names <span class="warn">(insecure)</span></label>
        </div>
      </div>
    </section>

    <section>
      <h2><label class="check"><input id="sshEnabled" type="checkbox"> SSH tunnel</label></h2>
      <p class="hint">Connects through an SSH server (a bastion) that can reach the database. The tunnel goes to the first host of the connection string, as a direct connection to that server.</p>
      <div class="fields" id="sshFields">
        <label for="sshHost">SSH server</label>
        <div class="host"><input id="sshHost" type="text" spellcheck="false" placeholder="bastion.example.com"><label for="sshPort">Port</label><input id="sshPort" type="number" min="1" max="65535" value="22"></div>
        <label for="sshUsername">Username</label>
        <input id="sshUsername" type="text" spellcheck="false">
        <span class="label">Authentication</span>
        <div class="radios" role="radiogroup">
          <label class="check"><input type="radio" name="sshAuth" value="password" checked> Password</label>
          <label class="check"><input type="radio" name="sshAuth" value="privateKey"> Private key</label>
          <label class="check"><input type="radio" name="sshAuth" value="agent"> SSH agent</label>
        </div>
        <label for="sshPassword" class="auth-password">Password</label>
        <input id="sshPassword" class="auth-password" type="password">
        <label for="privateKeyFile" class="auth-key">Private key</label>
        <div class="file auth-key"><input id="privateKeyFile" class="mono" type="text" spellcheck="false" placeholder="~/.ssh/id_ed25519"><button type="button" class="secondary" data-browse="privateKeyFile">Browse…</button></div>
        <label for="passphrase" class="auth-key">Passphrase</label>
        <input id="passphrase" class="auth-key" type="password" placeholder="If the key is encrypted">
        <span class="auth-agent"></span>
        <p class="hint auth-agent">Uses the keys loaded in the running agent (SSH_AUTH_SOCK, or the Windows OpenSSH agent).</p>
      </div>
    </section>

    <section>
      <h2><label class="check"><input id="redisEnabled" type="checkbox"> redis-oplog</label></h2>
      <p class="hint">Publishes the writes made in Mongoster to Redis as the Meteor package <code>cultofcoders:redis-oplog</code> does, so that the publications of the apps using it see them. Only Mongoster's own writes: edits, inserts, deletes, the playground and undo.</p>
      <div class="fields" id="redisFields">
        <label for="redisUrl">Redis URL</label>
        <input id="redisUrl" class="mono" type="text" spellcheck="false" placeholder="redis://user:password@localhost:6379 (rediss:// for TLS)">
        <label for="redisPrefix">Channel prefix</label>
        <input id="redisPrefix" class="mono" type="text" spellcheck="false" placeholder="The globalRedisPrefix of the app, if set">
        <label for="redisNamespaces">Namespaces</label>
        <input id="redisNamespaces" class="mono" type="text" spellcheck="false" placeholder="Also published on namespace::collection, comma separated">
        <label for="redisScope" class="top">Databases and collections</label>
        <textarea id="redisScope" class="mono" rows="3" spellcheck="false" placeholder="One per line: app (a whole database), app.users, app.*, *.logs. Empty: all of them"></textarea>
      </div>
    </section>

    <div id="result" class="result hidden" role="status"></div>
    <div class="actions">
      <button type="button" id="test" class="secondary">Test Connection</button>
      <span class="spacer"></span>
      <button type="button" id="cancel" class="secondary">Cancel</button>
      <button type="submit" id="save">Save</button>
    </div>
  </form>
  <script nonce="${nonce}" src="${asset('dist', 'connectionEditor.js')}"></script>
</body>
</html>`;
  }
}

/** The redis-oplog section: undefined when off. */
function parseRedis(form: ConnectionForm['redis']): RedisOplogForm {
  if (!form.enabled) return undefined;
  const url = form.url.trim();
  if (!url) throw new Invalid('The Redis URL is missing', 'redisUrl');
  try {
    parseRedisUrl(url);
  } catch (err) {
    throw new Invalid(errorMessage(err), 'redisUrl');
  }
  const list = (text: string) => text.split(/[\n,]/).map((s) => s.trim()).filter(Boolean);
  const scope = list(form.scope);
  const bad = scope.find((s) => s.split('.').some((part) => !part));
  if (bad) throw new Invalid(`Not a database or database.collection: ${bad}`, 'redisScope');
  const namespaces = list(form.namespaces);
  const settings: RedisOplogSettings = {
    ...(form.prefix.trim() && { prefix: form.prefix.trim() }),
    ...(namespaces.length && { namespaces }),
    ...(scope.length && { scope }),
  };
  return { url, settings };
}
