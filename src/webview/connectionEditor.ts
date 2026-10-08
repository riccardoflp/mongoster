// Connection form: name, connection string, TLS certificates and SSH tunnel; Test and Save run on the host.
import type { ConnectionEditorHostMessage, ConnectionEditorViewMessage, ConnectionForm, SavedSecrets } from '../shared/messages';

declare function acquireVsCodeApi(): { postMessage(message: ConnectionEditorViewMessage): void };

const vscode = acquireVsCodeApi();
const input = (id: string) => document.getElementById(id) as HTMLInputElement;
const el = (id: string) => document.getElementById(id)!;

const TEXT = ['name', 'uri', 'caFile', 'certificateKeyFile', 'certificateKeyFilePassword', 'sshHost', 'sshPort', 'sshUsername', 'sshPassword', 'privateKeyFile', 'passphrase'];
let busy = false;

function auth(): ConnectionForm['ssh']['auth'] {
  return ((document.querySelector('input[name="sshAuth"]:checked') as HTMLInputElement | null)?.value ?? 'password') as ConnectionForm['ssh']['auth'];
}

function read(): ConnectionForm {
  return {
    name: input('name').value,
    uri: input('uri').value,
    tls: {
      enabled: input('tlsEnabled').checked,
      caFile: input('caFile').value,
      certificateKeyFile: input('certificateKeyFile').value,
      certificateKeyFilePassword: input('certificateKeyFilePassword').value,
      allowInvalidCertificates: input('allowInvalidCertificates').checked,
      allowInvalidHostnames: input('allowInvalidHostnames').checked,
    },
    ssh: {
      enabled: input('sshEnabled').checked,
      host: input('sshHost').value,
      port: input('sshPort').value,
      username: input('sshUsername').value,
      auth: auth(),
      password: input('sshPassword').value,
      privateKeyFile: input('privateKeyFile').value,
      passphrase: input('passphrase').value,
    },
  };
}

function fill(form: ConnectionForm, saved: SavedSecrets): void {
  input('name').value = form.name;
  input('uri').value = form.uri;
  input('tlsEnabled').checked = form.tls.enabled;
  input('caFile').value = form.tls.caFile;
  input('certificateKeyFile').value = form.tls.certificateKeyFile;
  input('certificateKeyFilePassword').value = '';
  input('allowInvalidCertificates').checked = form.tls.allowInvalidCertificates;
  input('allowInvalidHostnames').checked = form.tls.allowInvalidHostnames;
  input('sshEnabled').checked = form.ssh.enabled;
  input('sshHost').value = form.ssh.host;
  input('sshPort').value = form.ssh.port;
  input('sshUsername').value = form.ssh.username;
  for (const r of document.querySelectorAll<HTMLInputElement>('input[name="sshAuth"]')) r.checked = r.value === form.ssh.auth;
  input('sshPassword').value = '';
  input('privateKeyFile').value = form.ssh.privateKeyFile;
  input('passphrase').value = '';
  const keep = 'Saved — leave empty to keep it';
  input('certificateKeyFilePassword').placeholder = saved.certificateKeyFilePassword ? keep : 'If the client key is encrypted';
  input('sshPassword').placeholder = saved.sshPassword ? keep : '';
  input('passphrase').placeholder = saved.passphrase ? keep : 'If the key is encrypted';
  sync();
}

/** Enables the fields of the checked sections and shows those of the chosen SSH authentication. */
function sync(): void {
  const tls = input('tlsEnabled').checked;
  const ssh = input('sshEnabled').checked;
  for (const c of el('tlsFields').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) c.disabled = !tls;
  for (const c of el('sshFields').querySelectorAll<HTMLInputElement | HTMLButtonElement>('input, button')) c.disabled = !ssh;
  el('tlsFields').classList.toggle('off', !tls);
  el('sshFields').classList.toggle('off', !ssh);
  const a = auth();
  for (const c of document.querySelectorAll<HTMLElement>('.auth-password')) c.classList.toggle('hidden', a !== 'password');
  for (const c of document.querySelectorAll<HTMLElement>('.auth-key')) c.classList.toggle('hidden', a !== 'privateKey');
  for (const c of document.querySelectorAll<HTMLElement>('.auth-agent')) c.classList.toggle('hidden', a !== 'agent');
}

function setBusy(what: 'test' | 'save' | undefined): void {
  busy = !!what;
  for (const id of ['test', 'save', 'cancel']) (el(id) as HTMLButtonElement).disabled = busy;
  el('test').textContent = what === 'test' ? 'Testing…' : 'Test Connection';
  el('save').textContent = what === 'save' ? 'Saving…' : 'Save';
}

function showResult(ok: boolean, message: string, field?: string): void {
  const result = el('result');
  result.textContent = message;
  result.classList.remove('hidden');
  result.classList.toggle('ok', ok);
  result.classList.toggle('fail', !ok);
  for (const id of TEXT) input(id).classList.remove('invalid');
  if (field && document.getElementById(field)) {
    input(field).classList.add('invalid');
    input(field).focus();
  }
}

window.addEventListener('message', (e: MessageEvent<ConnectionEditorHostMessage>) => {
  const m = e.data;
  switch (m.type) {
    case 'init':
      el('heading').textContent = m.isNew ? 'New Connection' : `Connection ${m.form.name}`;
      fill(m.form, m.saved);
      input(m.isNew ? 'uri' : 'name').focus();
      break;
    case 'file':
      input(m.field).value = m.path;
      input(m.field).classList.remove('invalid');
      break;
    case 'busy':
      setBusy(m.what);
      el('result').classList.add('hidden');
      break;
    case 'result':
      setBusy(undefined);
      showResult(m.ok, m.message, m.field);
      break;
  }
});

for (const id of ['tlsEnabled', 'sshEnabled']) input(id).addEventListener('change', sync);
for (const r of document.querySelectorAll<HTMLInputElement>('input[name="sshAuth"]')) r.addEventListener('change', sync);
for (const id of TEXT) input(id).addEventListener('input', () => input(id).classList.remove('invalid'));
for (const b of document.querySelectorAll<HTMLButtonElement>('[data-browse]')) {
  b.addEventListener('click', () => vscode.postMessage({ type: 'browse', field: b.dataset.browse as 'caFile' | 'certificateKeyFile' | 'privateKeyFile' }));
}
el('test').addEventListener('click', () => !busy && vscode.postMessage({ type: 'test', form: read() }));
el('cancel').addEventListener('click', () => vscode.postMessage({ type: 'cancel' }));
el('form').addEventListener('submit', (e) => {
  e.preventDefault();
  if (!busy) vscode.postMessage({ type: 'save', form: read() });
});
document.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') vscode.postMessage({ type: 'cancel' });
});

sync();
vscode.postMessage({ type: 'ready' });
