import * as vscode from 'vscode';

export const DOC_SCHEME = 'mongoster';

/** Serves read-only JSON documents opened from a collection grid. */
export class DocumentProvider implements vscode.TextDocumentContentProvider {
  private readonly contents = new Map<string, string>();
  private readonly changeEmitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.changeEmitter.event;

  provideTextDocumentContent(uri: vscode.Uri): string {
    return this.contents.get(uri.toString()) ?? '';
  }

  async show(namespace: string, idLabel: string, json: string): Promise<void> {
    const safe = (s: string) => s.replace(/[\\/:*?"<>|#%]/g, '_').slice(0, 80);
    const uri = vscode.Uri.from({ scheme: DOC_SCHEME, path: `/${safe(namespace)}/${safe(idLabel)}.json` });
    this.contents.set(uri.toString(), json);
    this.changeEmitter.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.window.showTextDocument(doc, { viewColumn: vscode.ViewColumn.Beside, preview: true });
  }
}
