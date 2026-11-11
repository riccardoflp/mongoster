// What a collection tab does with its saved queries, for the user (QueryHistory, in globalState) or in
// the project (ProjectQueries, files in the repository): saving with the question of where, renaming,
// moving between the two, deleting, opening the file.
import * as path from 'path';
import * as vscode from 'vscode';
import { ProjectQueries, QueriesFolder, isProjectQueryId } from './projectQueries';
import { QueryHistory, sameQuery } from './queryHistory';
import type { QueryText, SavedQuery, SavedQuerySource } from './shared/messages';
import { QueryScope, mergeSavedQueries } from './shared/savedQueries';

/** Where the last query was saved: the save dialog offers it first. */
const LAST_PLACE_KEY = 'mongoster.savedQueries.lastPlace';

export class SavedQueryActions {
  constructor(
    private readonly state: vscode.Memento,
    private readonly history: QueryHistory,
    /** The tab's collection (its connection's name can change). */
    private readonly scope: () => QueryScope,
  ) {}

  /** The saved queries of the collection: the user's and the project's. */
  saved(): SavedQuery[] {
    return mergeSavedQueries(this.history.saved, ProjectQueries.instance?.list(this.scope()) ?? []);
  }

  /** Saves a query with a name, asking where unless `place` says it; true when saved. */
  async save(query: QueryText, place?: SavedQuerySource): Promise<boolean> {
    const scope = this.scope();
    const name = (
      await vscode.window.showInputBox({
        title: place === 'project' ? 'Save Query in the Project' : 'Save Query',
        prompt: `Name for this ${scope.collection} query`,
        value: this.saved().find((s) => sameQuery(s, query))?.name,
        validateInput: (v) => (v.trim() ? undefined : 'Enter a name'),
      })
    )?.trim();
    if (!name) return false;
    const where = place ?? (await this.askPlace(scope));
    if (!where) return false;
    if (where === 'user') await this.history.save(name, query);
    else if (!(await this.saveInProject(name, query))) return false;
    await this.state.update(LAST_PLACE_KEY, where);
    return true;
  }

  private async askPlace(scope: QueryScope): Promise<SavedQuerySource | undefined> {
    const folders = ProjectQueries.instance?.folders() ?? [];
    const relative = (f: QueriesFolder) => (f.root ? path.relative(f.root, f.folder).split(path.sep).join('/') : f.folder);
    const folder = !folders.length
      ? 'in a project folder you choose'
      : folders.length === 1
        ? `in ${relative(folders[0])}${folders[0].root ? ` of ${folders[0].label}` : ''}`
        : `in ${relative(folders[0])} of one of the ${folders.length} workspace folders`;
    const items: (vscode.QuickPickItem & { place: SavedQuerySource })[] = [
      { label: 'For me', description: `kept by Mongoster, on ${scope.connectionName} only`, place: 'user' },
      { label: 'In the project', description: `a file ${folder}, shared through git, on every connection with ${scope.database}.${scope.collection}`, place: 'project' },
    ];
    if (this.state.get<SavedQuerySource>(LAST_PLACE_KEY) === 'project') items.reverse();
    return (await vscode.window.showQuickPick(items, { title: 'Save Query', placeHolder: 'Where to save the query' }))?.place;
  }

  /** Saves in the project, after asking when another query there has the name; true when saved. */
  private async saveInProject(name: string, query: QueryText, description?: string): Promise<boolean> {
    const store = ProjectQueries.instance;
    if (!store) return false;
    const scope = this.scope();
    const other = store.list(scope).find((q) => q.name === name && !q.connection);
    if (other && !sameQuery(other, query)) {
      const replace = 'Replace';
      const answer = await vscode.window.showWarningMessage(
        `The project already has a query of ${scope.collection} named "${name}". Replace it?`,
        { modal: true, detail: `Its file ${other.file} is overwritten.` },
        replace,
      );
      if (answer !== replace) return false;
    }
    try {
      const file = await store.save(scope, name, query, description);
      if (!file) return false;
      vscode.window.setStatusBarMessage(`Mongoster: saved ${file}`, 4000);
      return true;
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not save the query in the project: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }

  /** Renames a saved query; true when renamed. */
  async rename(id: string): Promise<boolean> {
    const query = this.saved().find((q) => q.id === id);
    if (!query) return false;
    const others = this.saved().filter((q) => q.id !== id && q.source === query.source);
    const name = (
      await vscode.window.showInputBox({
        title: 'Rename Saved Query',
        prompt: query.source === 'project' ? `New name (the file ${query.file} is renamed too)` : 'New name',
        value: query.name,
        validateInput: (v) =>
          !v.trim() ? 'Enter a name' : others.some((q) => q.name === v.trim()) ? `Another saved query ${query.source === 'project' ? 'in the project' : 'of yours'} has this name` : undefined,
      })
    )?.trim();
    if (!name || name === query.name) return false;
    return this.attempt('rename the query', async () => {
      if (query.source === 'project') await ProjectQueries.instance?.rename(id, name);
      else await this.history.rename(id, name);
    });
  }

  /** Moves a saved query from the user's to the project's, or back; true when moved. */
  async move(id: string): Promise<boolean> {
    const query = this.saved().find((q) => q.id === id);
    if (!query?.name) return false;
    if (query.source !== 'project') {
      if (!(await this.saveInProject(query.name, query, query.description))) return false;
      await this.history.remove(id);
      return true;
    }
    const move = 'Move';
    const answer = await vscode.window.showWarningMessage(
      `Move "${query.name}" from the project to your queries?`,
      { modal: true, detail: `Its file ${query.file} is deleted from the project: once the change is committed, the others no longer have it.` },
      move,
    );
    if (answer !== move) return false;
    return this.attempt('move the query', async () => {
      await this.history.save(query.name!, query, query.description);
      await ProjectQueries.instance?.remove(id);
    });
  }

  /** Deletes a saved query (a project's after a confirmation) or removes a recent one; true when done. */
  async remove(id: string): Promise<boolean> {
    if (!isProjectQueryId(id)) {
      await this.history.remove(id);
      return true;
    }
    const query = this.saved().find((q) => q.id === id);
    if (!query) return false;
    const remove = 'Delete';
    const answer = await vscode.window.showWarningMessage(
      `Delete the saved query "${query.name}" from the project?`,
      { modal: true, detail: `Its file ${query.file} is deleted.` },
      remove,
    );
    if (answer !== remove) return false;
    return this.attempt('delete the query', () => ProjectQueries.instance?.remove(id));
  }

  async openFile(id: string): Promise<void> {
    await this.attempt('open the file', () => ProjectQueries.instance?.openFile(id));
  }

  private async attempt(what: string, run: () => Promise<unknown> | undefined): Promise<boolean> {
    try {
      await run();
      return true;
    } catch (err) {
      void vscode.window.showErrorMessage(`Could not ${what}: ${err instanceof Error ? err.message : String(err)}`);
      return false;
    }
  }
}
