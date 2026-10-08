// Users and roles of a connection: one tab per connection listing the users (usersInfo) and roles
// (rolesInfo) of a database or of all of them, to create users, change passwords, grant and revoke
// roles, and create, edit and delete custom roles.
import * as vscode from 'vscode';
import { BSON, Document, MongoClient } from 'mongodb';
import type { ConnectionInfo, ConnectionManager } from './connections';
import type { Privilege, RoleEntry, RoleRef, UserEntry, UsersHostMessage, UsersViewMessage } from './shared/messages';
import { isPlainObject, parseQuery, relaxEjson } from './shared/query';
import { toBson } from './queries';
import { errorMessage } from './tree';

const { EJSON } = BSON;
const relaxed = (v: unknown) => relaxEjson(EJSON.serialize(v, { relaxed: false }));

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (isPlainObject(v) ? v : {});

/** A role reference of usersInfo / rolesInfo, which can also be a bare name in the given database. */
function roleRef(v: unknown, db: string): RoleRef {
  if (typeof v === 'string') return { role: v, db };
  return { role: String(obj(v).role ?? ''), db: String(obj(v).db ?? db) };
}

/** "shop.users", "shop.*", "*.users", "*.*", "cluster", "any resource". */
export function resourceText(resource: unknown): string {
  const r = obj(resource);
  if (r.cluster) return 'cluster';
  if (r.anyResource) return 'any resource';
  if ('db' in r || 'collection' in r) return `${r.db || '*'}.${r.collection || '*'}`;
  return JSON.stringify(resource);
}

export function toUser(raw: Document): UserEntry {
  const r = relaxed(raw) as Obj;
  const db = String(r.db ?? '');
  return {
    user: String(r.user ?? ''),
    db,
    roles: ((r.roles as unknown[]) ?? []).map((x) => roleRef(x, db)),
    mechanisms: (r.mechanisms as string[]) ?? [],
    customData: r.customData,
    raw: r,
  };
}

export function toRole(raw: Document): RoleEntry {
  const r = relaxed(raw) as Obj;
  const db = String(r.db ?? '');
  return {
    role: String(r.role ?? ''),
    db,
    builtin: r.isBuiltin === true,
    privileges: ((r.privileges as unknown[]) ?? []).map((p): Privilege => ({ resource: resourceText(obj(p).resource), actions: (obj(p).actions as string[]) ?? [] })),
    roles: ((r.roles as unknown[]) ?? []).map((x) => roleRef(x, db)),
    raw: r,
  };
}

/** Roles as the commands take them: a bare name in the user's or role's own database. */
const rolesArg = (roles: RoleRef[], database: string) => roles.map((r) => (r.db === database ? r.role : { role: r.role, db: r.db }));
const refText = (r: RoleRef) => `${r.role}@${r.db}`;

export class UsersPanel {
  private static readonly panels = new Map<string, UsersPanel>();
  private readonly panel: vscode.WebviewPanel;

  static show(context: vscode.ExtensionContext, connections: ConnectionManager, info: ConnectionInfo, database = ''): void {
    const existing = UsersPanel.panels.get(info.id);
    if (existing) {
      existing.database = database;
      existing.panel.reveal();
      void existing.postInit();
      return;
    }
    UsersPanel.panels.set(info.id, new UsersPanel(context, connections, info, database));
  }

  static connectionChanged(info: ConnectionInfo): void {
    const p = UsersPanel.panels.get(info.id);
    if (!p) return;
    p.info = info;
    p.panel.title = `Users: ${info.name}`;
    void p.postInit();
  }

  static close(connectionId: string): void {
    UsersPanel.panels.get(connectionId)?.panel.dispose();
  }

  private constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly connections: ConnectionManager,
    private info: ConnectionInfo,
    private database: string,
  ) {
    this.panel = vscode.window.createWebviewPanel('mongoster.users', `Users: ${info.name}`, vscode.ViewColumn.Active, {
      enableScripts: true,
      retainContextWhenHidden: true,
      localResourceRoots: [vscode.Uri.joinPath(context.extensionUri, 'dist'), vscode.Uri.joinPath(context.extensionUri, 'media')],
    });
    this.panel.iconPath = vscode.Uri.joinPath(context.extensionUri, 'media', 'mongoster.svg');
    this.panel.webview.html = this.html();
    this.panel.onDidDispose(() => UsersPanel.panels.delete(info.id));
    this.panel.webview.onDidReceiveMessage((m: UsersViewMessage) => void this.receive(m));
  }

  private post(m: UsersHostMessage): void {
    void this.panel.webview.postMessage(m);
  }

  private client(): Promise<MongoClient> {
    return this.connections.getClient(this.info.id);
  }

  /** Who the connection is signed in as. */
  private async me(): Promise<{ users: { user: string; db: string }[]; roles: RoleRef[] }> {
    const status = await (await this.client()).db('admin').command({ connectionStatus: 1 });
    const auth = (status.authInfo ?? {}) as Document;
    return {
      users: ((auth.authenticatedUsers as Document[]) ?? []).map((u) => ({ user: String(u.user), db: String(u.db) })),
      roles: ((auth.authenticatedUserRoles as Document[]) ?? []).map((r) => ({ role: String(r.role), db: String(r.db) })),
    };
  }

  private async postInit(): Promise<void> {
    const base = { type: 'init' as const, connectionName: this.info.name, readOnly: !!this.info.readOnly, color: this.info.color, database: this.database };
    try {
      this.post({ ...base, me: await this.me() });
    } catch (err) {
      this.post({ ...base, meError: errorMessage(err) });
    }
  }

  private async receive(m: UsersViewMessage): Promise<void> {
    switch (m.type) {
      case 'ready':
        await this.postInit();
        break;
      case 'load':
        await this.load(m.requestId, m.database, m.builtin);
        break;
      case 'copy':
        await vscode.env.clipboard.writeText(m.text);
        void vscode.window.setStatusBarMessage('Copied to the clipboard', 2000);
        break;
      default:
        await this.change(m);
    }
  }

  private async load(requestId: number, database: string, builtin: boolean): Promise<void> {
    const client = await this.client().catch((err: unknown) => err as Error);
    if (client instanceof Error) {
      this.post({ type: 'data', requestId, database, usersError: errorMessage(client), databases: [] });
      return;
    }
    const admin = client.db('admin');
    const names = new Set<string>(['admin']);
    try {
      for (const d of (await admin.admin().listDatabases({ nameOnly: true })).databases) names.add(d.name);
    } catch {
      // Users without listDatabases still see the databases of their users and roles.
    }

    let users: UserEntry[] | undefined;
    let usersError: string | undefined;
    try {
      const res = database ? await client.db(database).command({ usersInfo: 1 }) : await admin.command({ usersInfo: { forAllDBs: true } });
      users = (res.users as Document[]).map(toUser).sort((a, b) => a.db.localeCompare(b.db) || a.user.localeCompare(b.user));
      for (const u of users) names.add(u.db);
    } catch (err) {
      usersError = errorMessage(err);
    }

    let roles: RoleEntry[] | undefined;
    let rolesError: string | undefined;
    try {
      // Custom roles can be in any database: those that have some are found in admin.system.roles.
      let dbs = database ? [database] : [...names];
      if (!database) {
        try {
          dbs = [...new Set(['admin', ...((await admin.collection('system.roles').distinct('db')) as string[])])];
        } catch {
          // Without access to admin.system.roles: every known database.
        }
      }
      roles = [];
      for (const db of dbs) {
        const res = await client.db(db).command({ rolesInfo: 1, showPrivileges: true, showBuiltinRoles: builtin && (!!database || db === 'admin') });
        roles.push(...(res.roles as Document[]).map(toRole));
      }
      roles.sort((a, b) => Number(a.builtin) - Number(b.builtin) || a.db.localeCompare(b.db) || a.role.localeCompare(b.role));
      for (const r of roles) names.add(r.db);
    } catch (err) {
      rolesError = errorMessage(err);
    }
    if (database) names.add(database);
    this.post({ type: 'data', requestId, database, users, roles, usersError, rolesError, databases: [...names].filter((n) => n !== 'local' && n !== 'config').sort() });
  }

  /** Writes; each one replies with an `action` message. */
  private async change(m: Exclude<UsersViewMessage, { type: 'ready' | 'load' | 'copy' }>): Promise<void> {
    const reply = (ok: boolean, message?: string) => this.post({ type: 'action', ok, message });
    if (this.info.readOnly) return reply(false, `The connection ${this.info.name} is read-only: users and roles can't be changed.`);
    const isMe = async (user: string, db: string) => {
      try {
        return (await this.me()).users.some((u) => u.user === user && u.db === db);
      } catch {
        return false;
      }
    };
    try {
      const db = (await this.client()).db(m.database);
      switch (m.type) {
        case 'createUser': {
          const user = m.user.trim();
          if (!user) return reply(false, 'Enter the name of the user.');
          if (!m.password) return reply(false, 'Enter a password, or generate one.');
          const customData = toBson(m.customData, 'Custom data');
          await db.command({ createUser: user, pwd: m.password, roles: rolesArg(m.roles, m.database), ...(customData && { customData }) });
          return reply(true, `Created the user ${user}@${m.database}${m.roles.length ? ` with ${m.roles.map(refText).join(', ')}` : ' without roles'}.`);
        }
        case 'setPassword': {
          if (!m.password) return reply(false, 'Enter a password, or generate one.');
          await db.command({ updateUser: m.user, pwd: m.password });
          const self = await isMe(m.user, m.database);
          return reply(true, `Changed the password of ${m.user}@${m.database}.${self ? ' This connection signs in as that user: update its connection string with Edit Connection… before it reconnects.' : ''}`);
        }
        case 'grantRoles': {
          if (!m.roles.length) return reply(false, 'Choose a role to grant.');
          await db.command({ grantRolesToUser: m.user, roles: rolesArg(m.roles, m.database) });
          return reply(true, `Granted ${m.roles.map(refText).join(', ')} to ${m.user}@${m.database}.`);
        }
        case 'revokeRole': {
          const self = await isMe(m.user, m.database);
          const answer = await vscode.window.showWarningMessage(
            `Revoke ${refText(m.role)} from ${m.user}@${m.database}?`,
            { modal: true, detail: self ? 'This connection signs in as that user: it may lose access.' : 'The user loses the privileges of the role.' },
            'Revoke',
          );
          if (answer !== 'Revoke') return reply(false);
          await db.command({ revokeRolesFromUser: m.user, roles: rolesArg([m.role], m.database) });
          return reply(true, `Revoked ${refText(m.role)} from ${m.user}@${m.database}.`);
        }
        case 'dropUser': {
          const self = await isMe(m.user, m.database);
          const answer = await vscode.window.showWarningMessage(
            `Delete the user ${m.user}@${m.database}?`,
            { modal: true, detail: `${self ? 'This connection signs in as that user. ' : ''}Applications that use it can no longer sign in. This can't be undone.` },
            'Delete',
          );
          if (answer !== 'Delete') return reply(false);
          await db.command({ dropUser: m.user });
          return reply(true, `Deleted the user ${m.user}@${m.database}.`);
        }
        case 'saveRole': {
          const role = m.role.trim();
          if (!role) return reply(false, 'Enter the name of the role.');
          let privileges: unknown = [];
          if (m.privileges.trim()) {
            try {
              privileges = parseQuery(m.privileges);
            } catch (err) {
              return reply(false, `Privileges: ${errorMessage(err)}`);
            }
          }
          if (!Array.isArray(privileges)) return reply(false, 'Privileges must be an array: [{ resource: { db: "shop", collection: "" }, actions: ["find"] }]');
          const bson = EJSON.deserialize({ v: privileges }, { relaxed: false }).v as Document[];
          await db.command({ [m.create ? 'createRole' : 'updateRole']: role, privileges: bson, roles: rolesArg(m.roles, m.database) });
          return reply(true, `${m.create ? 'Created' : 'Updated'} the role ${role}@${m.database}.`);
        }
        case 'dropRole': {
          const answer = await vscode.window.showWarningMessage(
            `Delete the role ${m.role}@${m.database}?`,
            { modal: true, detail: "The users and roles that have it lose its privileges. This can't be undone." },
            'Delete',
          );
          if (answer !== 'Delete') return reply(false);
          await db.command({ dropRole: m.role });
          return reply(true, `Deleted the role ${m.role}@${m.database}.`);
        }
      }
    } catch (err) {
      reply(false, errorMessage(err));
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
  <link rel="stylesheet" href="${asset('media', 'monitor.css')}">
  <link rel="stylesheet" href="${asset('media', 'users.css')}">
  <title>Users</title>
</head>
<body>
  <header class="bar">
    <span id="title" class="title"></span>
    <div class="tabs" role="tablist">
      <button id="tabUsers" role="tab" aria-selected="true">Users</button>
      <button id="tabRoles" role="tab" aria-selected="false">Roles</button>
    </div>
    <label>Database <select id="database"></select></label>
    <input id="search" type="search" placeholder="Filter by name, role or privilege" spellcheck="false">
    <div class="spacer"></div>
    <button id="refresh" class="secondary" title="Reload the users and roles">Refresh</button>
  </header>
  <div id="me" class="me"></div>
  <div id="message" class="message hidden"></div>

  <section id="usersView" class="view">
    <div class="toolbar">
      <button id="createUser" class="not-locked">Create User…</button>
      <span id="usersInfo" class="info"></span>
    </div>
    <form id="userForm" class="form-panel hidden" autocomplete="off"></form>
    <div id="usersError" class="error hidden"></div>
    <div class="table-wrap"><table id="usersTable"></table></div>
  </section>

  <section id="rolesView" class="view hidden">
    <div class="toolbar">
      <button id="createRole" class="not-locked">Create Role…</button>
      <label title="Also list the roles MongoDB provides (read, readWrite, dbAdmin…)"><input id="builtin" type="checkbox"> Built-in roles</label>
      <span id="rolesInfo" class="info"></span>
    </div>
    <form id="roleForm" class="form-panel hidden" autocomplete="off"></form>
    <div id="rolesError" class="error hidden"></div>
    <div class="table-wrap"><table id="rolesTable"></table></div>
  </section>
  <datalist id="roleNames"></datalist>
  <script nonce="${nonce}" src="${asset('dist', 'users.js')}"></script>
</body>
</html>`;
  }
}
