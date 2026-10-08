// Users and roles tab: lists, forms to create users and roles, passwords, granting and revoking roles.
import type { RoleEntry, RoleRef, UserEntry, UsersHostMessage, UsersViewMessage } from '../shared/messages';
import { prettyShell } from '../shared/query';

type Tab = 'users' | 'roles';

interface State {
  tab: Tab;
  database: string;
  builtin: boolean;
  search: string;
}

declare function acquireVsCodeApi(): { postMessage(m: UsersViewMessage): void; getState(): Partial<State> | undefined; setState(s: State): void };

const vscode = acquireVsCodeApi();
const state: State = { tab: 'users', database: '', builtin: false, search: '', ...vscode.getState() };
const save = () => vscode.setState(state);
const post = (m: UsersViewMessage) => vscode.postMessage(m);
const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

/** Roles MongoDB provides, for the role pickers. */
const BUILTIN_ROLES = [
  'read',
  'readWrite',
  'dbAdmin',
  'dbOwner',
  'userAdmin',
  'clusterAdmin',
  'clusterManager',
  'clusterMonitor',
  'hostManager',
  'backup',
  'restore',
  'readAnyDatabase',
  'readWriteAnyDatabase',
  'userAdminAnyDatabase',
  'dbAdminAnyDatabase',
  'enableSharding',
  'root',
];
/** Built-in roles that exist only in the admin database. */
const ADMIN_ONLY = new Set(['clusterAdmin', 'clusterManager', 'clusterMonitor', 'hostManager', 'backup', 'restore', 'readAnyDatabase', 'readWriteAnyDatabase', 'userAdminAnyDatabase', 'dbAdminAnyDatabase', 'enableSharding', 'root']);

let readOnly = false;
let me: { users: { user: string; db: string }[]; roles: RoleRef[] } | undefined;
let users: UserEntry[] = [];
let roles: RoleEntry[] = [];
let databases: string[] = [];
let requestId = 0;
const expandedUsers = new Set<string>();
const expandedRoles = new Set<string>();
/** The password of the last user created or changed, until the next action: to copy it. */
let lastPassword: string | undefined;

const userKey = (u: { user: string; db: string }) => `${u.user}@${u.db}`;
const roleKey = (r: RoleRef) => `${r.role}@${r.db}`;
/** "readWrite" in the same database, "read@reporting" in another. */
const roleLabel = (r: RoleRef, db: string) => (r.db === db ? r.role : roleKey(r));
const isMe = (u: UserEntry) => !!me?.users.some((x) => x.user === u.user && x.db === u.db);

function button(label: string, className: string, onClick: () => void, title?: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.type = 'button';
  b.className = className;
  b.textContent = label;
  if (title) b.title = title;
  b.addEventListener('click', (e) => {
    e.stopPropagation();
    onClick();
  });
  return b;
}

function span(text: string, className = ''): HTMLSpanElement {
  const s = document.createElement('span');
  s.textContent = text;
  if (className) s.className = className;
  return s;
}

function cell(row: HTMLTableRowElement, text: string, className = '', title?: string): HTMLTableCellElement {
  const c = row.insertCell();
  c.textContent = text;
  if (className) c.className = className;
  if (title) c.title = title;
  return c;
}

function header(table: HTMLTableElement, labels: string[]): void {
  const row = table.createTHead().insertRow();
  for (const label of labels) {
    const th = document.createElement('th');
    th.textContent = label;
    row.append(th);
  }
}

function showError(id: string, error: string | undefined): void {
  el(id).textContent = error ?? '';
  el(id).classList.toggle('hidden', !error);
}

function showMessage(text: string, failed = false): void {
  const box = el('message');
  box.replaceChildren(span(text));
  box.classList.toggle('hidden', !text);
  box.classList.toggle('failed', failed);
  if (text && !failed && lastPassword) {
    const password = lastPassword;
    box.append(' ', button('Copy Password', 'secondary small', () => post({ type: 'copy', text: password }), "Copy the new password: it can't be read back from MongoDB"));
  }
}

function databaseSelect(selected: string, withAll = false): HTMLSelectElement {
  const select = document.createElement('select');
  const names = [...new Set([...(withAll ? [''] : []), ...databases, ...(selected ? [selected] : [])])];
  for (const name of names) {
    const o = document.createElement('option');
    o.value = name;
    o.textContent = name || 'All databases';
    select.append(o);
  }
  select.value = selected;
  return select;
}

function rawDetails(raw: unknown): HTMLDetailsElement {
  const details = document.createElement('details');
  const summary = document.createElement('summary');
  summary.textContent = 'Raw';
  const pre = document.createElement('pre');
  pre.textContent = prettyShell(raw, 0, 100);
  details.append(summary, button('Copy', 'secondary small', () => post({ type: 'copy', text: pre.textContent ?? '' })), pre);
  return details;
}

function load(): void {
  post({ type: 'load', requestId: ++requestId, database: state.database, builtin: state.builtin });
}

// ---------------------------------------------------------------------------
// Role pickers and passwords

/** Rows of role + database; returns the chosen roles. */
function rolePicker(container: HTMLElement, initial: RoleRef[], defaultDb: () => string): () => RoleRef[] {
  const list = document.createElement('div');
  list.className = 'role-list';
  const rows: { role: HTMLInputElement; db: HTMLSelectElement }[] = [];
  const add = (r?: RoleRef) => {
    const row = document.createElement('div');
    row.className = 'role-row';
    const role = document.createElement('input');
    role.setAttribute('list', 'roleNames');
    role.placeholder = 'role (readWrite, read, dbAdmin…)';
    role.spellcheck = false;
    role.value = r?.role ?? '';
    const db = databaseSelect(r?.db ?? defaultDb());
    // Roles that only exist in admin go there.
    role.addEventListener('change', () => {
      if (ADMIN_ONLY.has(role.value.trim())) db.value = 'admin';
    });
    const entry = { role, db };
    rows.push(entry);
    row.append(role, span('in'), db, button('✕', 'secondary small', () => {
      rows.splice(rows.indexOf(entry), 1);
      row.remove();
    }, 'Remove'));
    list.append(row);
    return role;
  };
  for (const r of initial) add(r);
  container.append(list, button('+ Role', 'secondary small', () => add().focus(), 'Add a role'));
  return () => rows.map((r) => ({ role: r.role.value.trim(), db: r.db.value })).filter((r) => r.role);
}

/** 24 letters and digits: about 143 bits, and nothing to escape in a connection string. */
function generatePassword(): string {
  const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789';
  const out: string[] = [];
  const bytes = new Uint8Array(64);
  while (out.length < 24) {
    crypto.getRandomValues(bytes);
    for (const b of bytes) if (b < 256 - (256 % chars.length) && out.length < 24) out.push(chars[b % chars.length]);
  }
  return out.join('');
}

function passwordField(container: HTMLElement): HTMLInputElement {
  const wrap = document.createElement('div');
  wrap.className = 'password';
  const input = document.createElement('input');
  input.type = 'password';
  input.autocomplete = 'new-password';
  input.spellcheck = false;
  input.placeholder = 'password';
  const show = button('Show', 'secondary small', () => {
    input.type = input.type === 'password' ? 'text' : 'password';
    show.textContent = input.type === 'password' ? 'Show' : 'Hide';
  });
  wrap.append(
    input,
    button('Generate', 'secondary small', () => {
      input.value = generatePassword();
      input.type = 'text';
      show.textContent = 'Hide';
    }, 'A random password of 24 letters and digits'),
    show,
    button('Copy', 'secondary small', () => input.value && post({ type: 'copy', text: input.value })),
  );
  container.append(wrap);
  return input;
}

function field(form: HTMLElement, label: string, control: HTMLElement | ((box: HTMLElement) => void), hint?: string): void {
  const row = document.createElement('div');
  row.className = 'field';
  const l = document.createElement('label');
  l.className = 'field-label';
  l.textContent = label;
  const box = document.createElement('div');
  box.className = 'field-control';
  if (typeof control === 'function') control(box);
  else box.append(control);
  if (hint) box.append(span(hint, 'hint'));
  row.append(l, box);
  form.append(row);
}

function formButtons(form: HTMLElement, label: string, onSave: () => void, onCancel: () => void): void {
  const row = document.createElement('div');
  row.className = 'form-buttons';
  // A submit button: Enter in the fields saves too.
  const save = document.createElement('button');
  save.type = 'submit';
  save.className = 'primary';
  save.textContent = label;
  row.append(save, button('Cancel', 'secondary', onCancel));
  form.append(row);
  form.onsubmit = (e) => {
    e.preventDefault();
    onSave();
  };
}

function closeForms(): void {
  for (const id of ['userForm', 'roleForm']) {
    el(id).classList.add('hidden');
    el(id).replaceChildren();
  }
}

// ---------------------------------------------------------------------------
// Users

function openUserForm(mode: { kind: 'create' } | { kind: 'password'; user: UserEntry }): void {
  closeForms();
  setTab('users');
  const form = el<HTMLFormElement>('userForm');
  form.classList.remove('hidden');
  const title = document.createElement('h3');
  title.textContent = mode.kind === 'create' ? 'New user' : `New password for ${userKey(mode.user)}`;
  form.append(title);
  if (mode.kind === 'password') {
    const password = (() => {
      let input!: HTMLInputElement;
      field(form, 'Password', (box) => (input = passwordField(box)), isMe(mode.user) ? 'This connection signs in as this user: update its connection string afterwards.' : undefined);
      return input;
    })();
    formButtons(form, 'Change Password', () => {
      lastPassword = password.value;
      post({ type: 'setPassword', database: mode.user.db, user: mode.user.user, password: password.value });
    }, closeForms);
    password.focus();
    return;
  }
  const name = document.createElement('input');
  name.spellcheck = false;
  name.placeholder = 'user name';
  field(form, 'Name', name);
  const db = databaseSelect(state.database || 'admin');
  field(form, 'Database', db, 'Where the user is defined (authSource in the connection string)');
  let password!: HTMLInputElement;
  field(form, 'Password', (box) => (password = passwordField(box)));
  let getRoles!: () => RoleRef[];
  field(form, 'Roles', (box) => (getRoles = rolePicker(box, state.database ? [{ role: 'readWrite', db: state.database }] : [], () => db.value)));
  const custom = document.createElement('input');
  custom.spellcheck = false;
  custom.placeholder = '{ team: "billing" }  (optional)';
  field(form, 'Custom data', custom);
  formButtons(form, 'Create User', () => {
    lastPassword = password.value;
    post({ type: 'createUser', database: db.value, user: name.value, password: password.value, roles: getRoles(), customData: custom.value });
  }, closeForms);
  name.focus();
}

function userMatches(u: UserEntry, needle: string): boolean {
  return !needle || [userKey(u), ...u.roles.map(roleKey), ...u.mechanisms].some((t) => t.toLowerCase().includes(needle));
}

function renderUsers(): void {
  const table = el<HTMLTableElement>('usersTable');
  table.replaceChildren();
  const needle = state.search.trim().toLowerCase();
  const shown = users.filter((u) => userMatches(u, needle));
  header(table, ['user', 'database', 'roles', 'mechanisms', '']);
  const body = table.createTBody();
  for (const u of shown) {
    const key = userKey(u);
    const row = body.insertRow();
    row.className = 'clickable';
    if (expandedUsers.has(key)) row.classList.add('expanded');
    const name = cell(row, u.user, 'name');
    if (isMe(u)) name.append(' ', span('you', 'tag'));
    cell(row, u.db, 'muted');
    cell(row, u.roles.map((r) => roleLabel(r, u.db)).join(', ') || '(no roles)', u.roles.length ? '' : 'muted', u.roles.map(roleKey).join('\n'));
    cell(row, u.mechanisms.join(', '), 'muted');
    const actions = row.insertCell();
    actions.className = 'action';
    if (!readOnly) {
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      wrap.append(
        button('Password…', 'secondary small', () => openUserForm({ kind: 'password', user: u }), 'Set a new password'),
        button('Delete', 'secondary small', () => post({ type: 'dropUser', database: u.db, user: u.user }), 'Delete the user'),
      );
      actions.append(wrap);
    }
    row.addEventListener('click', () => {
      if (expandedUsers.has(key)) expandedUsers.delete(key);
      else expandedUsers.add(key);
      renderUsers();
    });
    if (expandedUsers.has(key)) userDetail(body, u);
  }
  if (!shown.length) {
    const c = body.insertRow().insertCell();
    c.colSpan = 5;
    c.className = 'empty';
    c.textContent = users.length ? 'No user matches the filter.' : `No users${state.database ? ` in ${state.database}` : ''}.`;
  }
  el('usersInfo').textContent = users.length ? `${shown.length === users.length ? '' : `${shown.length} of `}${users.length} user${users.length === 1 ? '' : 's'}` : '';
}

function userDetail(body: HTMLTableSectionElement, u: UserEntry): void {
  const row = body.insertRow();
  row.className = 'detail';
  const c = row.insertCell();
  c.colSpan = 5;
  const box = document.createElement('div');
  box.className = 'detail-box';
  const list = document.createElement('div');
  list.className = 'chips';
  list.append(span('Roles', 'label'));
  for (const r of u.roles) {
    const chip = document.createElement('span');
    chip.className = 'chip';
    chip.append(span(roleKey(r)));
    chip.title = describeRole(r);
    if (!readOnly) chip.append(button('✕', 'chip-x', () => post({ type: 'revokeRole', database: u.db, user: u.user, role: r }), `Revoke ${roleKey(r)}`));
    list.append(chip);
  }
  if (!u.roles.length) list.append(span('none', 'muted'));
  box.append(list);
  if (!readOnly) {
    const grant = document.createElement('div');
    grant.className = 'grant';
    const role = document.createElement('input');
    role.setAttribute('list', 'roleNames');
    role.placeholder = 'role to grant';
    role.spellcheck = false;
    const db = databaseSelect(u.db);
    role.addEventListener('change', () => {
      if (ADMIN_ONLY.has(role.value.trim())) db.value = 'admin';
    });
    const go = () => role.value.trim() && post({ type: 'grantRoles', database: u.db, user: u.user, roles: [{ role: role.value.trim(), db: db.value }] });
    role.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') go();
    });
    for (const x of [role, db]) x.addEventListener('click', (e) => e.stopPropagation());
    grant.append(span('Grant', 'label'), role, span('in'), db, button('Grant', 'secondary small', go));
    box.append(grant);
  }
  if (u.customData !== undefined) {
    const pre = document.createElement('pre');
    pre.textContent = `customData: ${prettyShell(u.customData, 0, 100)}`;
    box.append(pre);
  }
  box.append(rawDetails(u.raw));
  c.append(box);
}

/** What a role grants, for tooltips: its privileges if loaded. */
function describeRole(r: RoleRef): string {
  const found = roles.find((x) => x.role === r.role && x.db === r.db);
  if (!found) return roleKey(r);
  const lines = found.privileges.slice(0, 12).map((p) => `${p.resource}: ${p.actions.slice(0, 8).join(', ')}${p.actions.length > 8 ? '…' : ''}`);
  return [roleKey(r), ...lines, ...(found.roles.length ? [`inherits ${found.roles.map(roleKey).join(', ')}`] : [])].join('\n');
}

// ---------------------------------------------------------------------------
// Roles

function openRoleForm(edit?: RoleEntry): void {
  closeForms();
  setTab('roles');
  const form = el<HTMLFormElement>('roleForm');
  form.classList.remove('hidden');
  const title = document.createElement('h3');
  title.textContent = edit ? `Edit ${roleKey(edit)}` : 'New role';
  form.append(title);
  const name = document.createElement('input');
  name.spellcheck = false;
  name.placeholder = 'role name';
  name.value = edit?.role ?? '';
  name.disabled = !!edit;
  field(form, 'Name', name);
  const db = databaseSelect(edit?.db ?? (state.database || 'admin'));
  db.disabled = !!edit;
  field(form, 'Database', db, 'Roles defined in admin can grant privileges on every database');
  const privileges = document.createElement('textarea');
  privileges.spellcheck = false;
  privileges.rows = 8;
  privileges.placeholder = '[\n  { resource: { db: "shop", collection: "orders" }, actions: ["find", "insert", "update"] },\n  { resource: { db: "shop", collection: "" }, actions: ["find"] }\n]';
  const rawPrivileges = (edit?.raw as { privileges?: unknown } | undefined)?.privileges;
  privileges.value = edit && Array.isArray(rawPrivileges) && rawPrivileges.length ? prettyShell(rawPrivileges, 0, 90) : '';
  field(form, 'Privileges', privileges, 'mongosh syntax; collection "" means every collection of the database');
  let getRoles!: () => RoleRef[];
  field(form, 'Inherits', (box) => (getRoles = rolePicker(box, edit?.roles ?? [], () => db.value)));
  formButtons(form, edit ? 'Save Role' : 'Create Role', () => post({ type: 'saveRole', create: !edit, database: db.value, role: name.value, privileges: privileges.value, roles: getRoles() }), closeForms);
  (edit ? privileges : name).focus();
}

function roleMatches(r: RoleEntry, needle: string): boolean {
  return !needle || [roleKey(r), ...r.roles.map(roleKey), ...r.privileges.flatMap((p) => [p.resource, ...p.actions])].some((t) => t.toLowerCase().includes(needle));
}

const holders = (r: RoleEntry) => users.filter((u) => u.roles.some((x) => x.role === r.role && x.db === r.db));

function privilegeSummary(r: RoleEntry): string {
  return r.privileges.map((p) => `${p.resource}: ${p.actions.length > 4 ? `${p.actions.slice(0, 4).join(', ')} +${p.actions.length - 4}` : p.actions.join(', ')}`).join(' · ');
}

function renderRoles(): void {
  const table = el<HTMLTableElement>('rolesTable');
  table.replaceChildren();
  const needle = state.search.trim().toLowerCase();
  const shown = roles.filter((r) => roleMatches(r, needle));
  header(table, ['role', 'database', 'privileges', 'inherits', 'users', '']);
  const body = table.createTBody();
  for (const r of shown) {
    const key = roleKey(r);
    const row = body.insertRow();
    row.className = `clickable${r.builtin ? ' builtin' : ''}`;
    if (expandedRoles.has(key)) row.classList.add('expanded');
    const name = cell(row, r.role, 'name');
    if (r.builtin) name.append(' ', span('built-in', 'tag'));
    cell(row, r.db, 'muted');
    const summary = privilegeSummary(r);
    cell(row, summary || (r.roles.length ? '(inherited only)' : '(none)'), 'command', summary);
    cell(row, r.roles.map((x) => roleLabel(x, r.db)).join(', '), 'muted', r.roles.map(roleKey).join('\n'));
    const n = holders(r).length;
    cell(row, n ? String(n) : '', 'num');
    const actions = row.insertCell();
    actions.className = 'action';
    if (!readOnly && !r.builtin) {
      const wrap = document.createElement('div');
      wrap.className = 'row-actions';
      wrap.append(
        button('Edit…', 'secondary small', () => openRoleForm(r), 'Change its privileges and inherited roles'),
        button('Delete', 'secondary small', () => post({ type: 'dropRole', database: r.db, role: r.role }), 'Delete the role'),
      );
      actions.append(wrap);
    }
    row.addEventListener('click', () => {
      if (expandedRoles.has(key)) expandedRoles.delete(key);
      else expandedRoles.add(key);
      renderRoles();
    });
    if (expandedRoles.has(key)) roleDetail(body, r);
  }
  if (!shown.length) {
    const c = body.insertRow().insertCell();
    c.colSpan = 6;
    c.className = 'empty';
    c.textContent = roles.length ? 'No role matches the filter.' : `No custom roles${state.database ? ` in ${state.database}` : ''}: Create Role… defines one, Built-in roles lists those of MongoDB.`;
  }
  const custom = roles.filter((r) => !r.builtin).length;
  el('rolesInfo').textContent = roles.length ? `${custom} custom role${custom === 1 ? '' : 's'}${roles.length > custom ? `, ${roles.length - custom} built-in` : ''}` : '';
}

function roleDetail(body: HTMLTableSectionElement, r: RoleEntry): void {
  const row = body.insertRow();
  row.className = 'detail';
  const c = row.insertCell();
  c.colSpan = 6;
  const box = document.createElement('div');
  box.className = 'detail-box';
  if (r.privileges.length) {
    const t = document.createElement('table');
    t.className = 'privileges';
    header(t, ['resource', 'actions']);
    const b = t.createTBody();
    for (const p of r.privileges) {
      const pr = b.insertRow();
      cell(pr, p.resource, 'name');
      cell(pr, p.actions.join(', '), 'actions');
    }
    box.append(t);
  }
  const info = document.createElement('div');
  info.className = 'chips';
  if (r.roles.length) info.append(span('Inherits', 'label'), ...r.roles.map((x) => Object.assign(span(roleKey(x), 'chip'), { title: describeRole(x) })));
  const who = holders(r);
  if (who.length) info.append(span('Users', 'label'), ...who.map((u) => span(userKey(u), 'chip')));
  if (info.childElementCount) box.append(info);
  box.append(rawDetails(r.raw));
  c.append(box);
}

// ---------------------------------------------------------------------------
// Tabs and messages

function setTab(tab: Tab): void {
  state.tab = tab;
  save();
  el('usersView').classList.toggle('hidden', tab !== 'users');
  el('rolesView').classList.toggle('hidden', tab !== 'roles');
  el('tabUsers').setAttribute('aria-selected', String(tab === 'users'));
  el('tabRoles').setAttribute('aria-selected', String(tab === 'roles'));
}

function fillDatabases(): void {
  const select = el<HTMLSelectElement>('database');
  const fresh = databaseSelect(state.database, true);
  select.replaceChildren(...fresh.options);
  select.value = state.database;
}

function fillRoleNames(): void {
  const names = [...new Set([...BUILTIN_ROLES, ...roles.filter((r) => !r.builtin).map((r) => r.role)])];
  el('roleNames').replaceChildren(
    ...names.map((n) => {
      const o = document.createElement('option');
      o.value = n;
      return o;
    }),
  );
}

window.addEventListener('message', (e: MessageEvent<UsersHostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'init': {
      readOnly = m.readOnly;
      me = m.me;
      document.body.classList.toggle('locked', readOnly);
      if (m.color) document.body.dataset.color = m.color;
      else delete document.body.dataset.color;
      el('title').textContent = m.connectionName;
      if (readOnly) {
        const badge = span('read-only', 'badge');
        badge.title = "The connection is read-only: users and roles can't be changed";
        el('title').append(' ', badge);
      }
      const who = m.me?.users.map(userKey).join(', ');
      el('me').textContent = m.meError
        ? `Signed-in user unknown: ${m.meError}`
        : who
          ? `Connected as ${who}${m.me!.roles.length ? ` · roles ${m.me!.roles.map(roleKey).join(', ')}` : ''}`
          : 'Connected without signing in: access control may be disabled on this server, so users and roles take effect only once it is enabled.';
      if (m.database !== undefined && m.database !== state.database) {
        state.database = m.database;
        save();
      }
      if (readOnly) closeForms();
      fillDatabases();
      renderUsers();
      renderRoles();
      load();
      break;
    }
    case 'data':
      if (m.requestId !== requestId) return;
      databases = m.databases;
      users = m.users ?? [];
      roles = m.roles ?? [];
      showError('usersError', m.usersError);
      showError('rolesError', m.rolesError);
      for (const k of [...expandedUsers]) if (!users.some((u) => userKey(u) === k)) expandedUsers.delete(k);
      for (const k of [...expandedRoles]) if (!roles.some((r) => roleKey(r) === k)) expandedRoles.delete(k);
      fillDatabases();
      fillRoleNames();
      renderUsers();
      renderRoles();
      break;
    case 'action':
      if (m.ok) closeForms();
      if (m.message || m.ok) showMessage(m.message ?? '', !m.ok);
      lastPassword = undefined;
      if (m.ok) load();
      break;
  }
});

el('tabUsers').addEventListener('click', () => setTab('users'));
el('tabRoles').addEventListener('click', () => setTab('roles'));
el('refresh').addEventListener('click', load);
el<HTMLSelectElement>('database').addEventListener('change', (e) => {
  state.database = (e.target as HTMLSelectElement).value;
  save();
  expandedUsers.clear();
  expandedRoles.clear();
  load();
});
const search = el<HTMLInputElement>('search');
search.value = state.search;
search.addEventListener('input', () => {
  state.search = search.value;
  save();
  renderUsers();
  renderRoles();
});
const builtin = el<HTMLInputElement>('builtin');
builtin.checked = state.builtin;
builtin.addEventListener('change', () => {
  state.builtin = builtin.checked;
  save();
  load();
});
el('createUser').addEventListener('click', () => openUserForm({ kind: 'create' }));
el('createRole').addEventListener('click', () => openRoleForm());

setTab(state.tab);
post({ type: 'ready' });
