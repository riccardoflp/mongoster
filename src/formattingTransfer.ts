// `Export Formatting…` and `Import Formatting…` of the Formatting pane: the questions, the file dialogs, reading and
// writing the file. The file's form and the merge are in src/shared/formattingFile.ts; the keys in
// src/formattingStore.ts.
import * as os from 'os';
import * as path from 'path';
import * as vscode from 'vscode';
import { FormatPlace, readFormatting, writeFormatting } from './formattingStore';
import { FORMAT_SCOPES, FormatScope, ScopedRules, newRuleId } from './shared/formatting';
import { FORMATTING_FILE_SUFFIX, MAX_FORMATTING_FILE, formattingFile, groupLabel, importSummary, mergeImport, readFormattingFile } from './shared/formattingFile';
import { noLinks } from './shared/plainText';

const TITLE_EXPORT = 'Export Formatting';
const TITLE_IMPORT = 'Import Formatting';
const FILTERS = { 'Formatting rules (JSON)': ['json'] };

/** A collection and the names its sections show. */
export interface FormatTarget extends FormatPlace {
  connectionName: string;
}

const count = (n: number) => `${n} rule${n === 1 ? '' : 's'}`;

function scopeLabel(scope: FormatScope, target: FormatTarget): string {
  return { collection: `Collection ${target.collection}`, database: `Database ${target.database}`, connection: `Connection ${target.connectionName}`, global: 'Everywhere' }[scope];
}

/**
 * Feature: query.format-transfer
 * Writes the rules of the scopes the user chooses, among the ones that reach the collection, to a file.
 */
export async function exportFormatting(state: vscode.Memento, target: FormatTarget): Promise<void> {
  const rules = readFormatting(state, target);
  const scopes = FORMAT_SCOPES.filter((scope) => rules[scope].length);
  if (!scopes.length) {
    void vscode.window.showInformationMessage('There are no formatting rules to export.');
    return;
  }
  const picked = await vscode.window.showQuickPick(
    scopes.map((scope) => ({ label: scopeLabel(scope, target), description: count(rules[scope].length), picked: true, scope })),
    { title: TITLE_EXPORT, placeHolder: 'Choose the rules to export', canPickMany: true, ignoreFocusOut: true },
  );
  if (!picked?.length) return;
  const uri = await vscode.window.showSaveDialog({
    title: TITLE_EXPORT,
    saveLabel: 'Export',
    defaultUri: vscode.Uri.file(path.join(os.homedir(), `${target.collection.replace(/[^\w.-]+/g, '_')}${FORMATTING_FILE_SUFFIX}`)),
    filters: FILTERS,
  });
  if (!uri) return;
  const chosen = picked.map((p) => p.scope);
  try {
    await vscode.workspace.fs.writeFile(uri, new TextEncoder().encode(formattingFile(rules, chosen, target)));
  } catch (err) {
    void vscode.window.showErrorMessage(noLinks(`The formatting rules could not be exported: ${err instanceof Error ? err.message : String(err)}`));
    return;
  }
  const total = chosen.reduce((n, scope) => n + rules[scope].length, 0);
  void vscode.window.showInformationMessage(noLinks(`${count(total)} exported to ${path.basename(uri.fsPath)}. The file has nothing of the connection: no name, no address, no password.`));
}

/**
 * Feature: query.format-transfer
 * Reads a file of formatting rules and adds the groups the user chooses to the scopes of the collection: each to its
 * own scope, or all to one. Returns the lists of the scopes that changed.
 */
export async function importFormatting(state: vscode.Memento, target: FormatTarget): Promise<Partial<ScopedRules> | undefined> {
  const files = await vscode.window.showOpenDialog({ title: TITLE_IMPORT, openLabel: 'Import', canSelectMany: false, filters: { ...FILTERS, 'All files': ['*'] } });
  if (!files?.[0]) return undefined;
  let text: string;
  try {
    const stat = await vscode.workspace.fs.stat(files[0]);
    if (stat.size > MAX_FORMATTING_FILE) throw new Error('the file is larger than 1 MB.');
    text = new TextDecoder().decode(await vscode.workspace.fs.readFile(files[0]));
  } catch (err) {
    void vscode.window.showErrorMessage(noLinks(`The file could not be read: ${err instanceof Error ? err.message : String(err)}`));
    return undefined;
  }
  const file = readFormattingFile(text);
  if ('error' in file) {
    void vscode.window.showErrorMessage(noLinks(file.error));
    return undefined;
  }
  if (!file.groups.length) {
    void vscode.window.showInformationMessage(file.dropped ? `The file has no formatting rule that can be read (${file.dropped} could not).` : 'The file has no formatting rules.');
    return undefined;
  }
  const groups = await vscode.window.showQuickPick(
    file.groups.map((group) => ({ label: noLinks(groupLabel(group)), description: count(group.rules.length), picked: true, group })),
    { title: TITLE_IMPORT, placeHolder: 'Choose the rules to import', canPickMany: true, ignoreFocusOut: true },
  );
  if (!groups?.length) return undefined;
  const where = await vscode.window.showQuickPick<vscode.QuickPickItem & { scope?: FormatScope }>(
    [
      { label: 'The Same Scopes', description: `into ${target.collection}, ${target.database}, ${target.connectionName} and everywhere, each group in its own` },
      ...FORMAT_SCOPES.map((scope) => ({ label: `All Into ${scopeLabel(scope, target)}`, scope })),
    ],
    { title: TITLE_IMPORT, placeHolder: 'Where do the rules go? They are added after the ones already there', ignoreFocusOut: true },
  );
  if (!where) return undefined;

  const rules = readFormatting(state, target);
  const changes: Partial<ScopedRules> = {};
  let added = 0;
  let already = 0;
  let over = 0;
  for (const { group } of groups) {
    const scope = where.scope ?? group.scope;
    const merged = mergeImport(changes[scope] ?? rules[scope], group.rules, newRuleId);
    if (merged.added) changes[scope] = merged.rules;
    added += merged.added;
    already += merged.already;
    over += merged.over;
  }
  for (const scope of FORMAT_SCOPES) {
    const list = changes[scope];
    if (list) await writeFormatting(state, target, scope, list);
  }
  void vscode.window.showInformationMessage(importSummary(added, already, file.dropped, over));
  return changes;
}
