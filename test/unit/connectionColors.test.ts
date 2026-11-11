import { describe, expect, it } from 'vitest';
import * as vscode from 'vscode';
import { CONNECTION_SCHEME, ConnectionDecorations, ConnectionOfFiles, connectionUri, tabIcon } from '../../src/connectionColors';
import type { ConnectionInfo, ConnectionManager } from '../../src/connections';

function manager(list: ConnectionInfo[]) {
  const changed = new vscode.EventEmitter<void>();
  return {
    list: () => list,
    get: (id: string) => list.find((c) => c.id === id),
    onDidChange: changed.event,
    fire: () => changed.fire(),
  };
}

const prod: ConnectionInfo = { id: 'p1', name: 'prod', color: 'red' };
const local: ConnectionInfo = { id: 'l1', name: 'local' };

describe('connection decorations', () => {
  it('colors the tree node, the documents and the definitions of a colored connection', () => {
    const decorations = new ConnectionDecorations(manager([prod, local]) as unknown as ConnectionManager, ['mongoster', 'mongoster-def']);
    const node = decorations.provideFileDecoration(connectionUri('p1'));
    expect(connectionUri('p1').scheme).toBe(CONNECTION_SCHEME);
    expect(node?.color?.id).toBe('charts.red');
    expect(node?.tooltip).toBe('prod');
    const doc = vscode.Uri.from({ scheme: 'mongoster', authority: 'p1', path: '/db/coll/1.json' });
    expect(decorations.provideFileDecoration(doc)?.color?.id).toBe('charts.red');
    expect(decorations.provideFileDecoration(vscode.Uri.from({ scheme: 'mongoster-def', authority: 'p1', path: '/db/coll/indexes.json' }))?.color?.id).toBe('charts.red');
  });

  it('leaves alone connections without a color, unknown ones and other files', () => {
    const decorations = new ConnectionDecorations(manager([prod, local]) as unknown as ConnectionManager, ['mongoster']);
    expect(decorations.provideFileDecoration(connectionUri('l1'))).toBeUndefined();
    expect(decorations.provideFileDecoration(connectionUri('gone'))).toBeUndefined();
    expect(decorations.provideFileDecoration(vscode.Uri.from({ scheme: 'file', path: '/a.json' }))).toBeUndefined();
  });

  it('colors the files another source ties to a connection, such as playgrounds', () => {
    const changed = new vscode.EventEmitter<vscode.Uri | undefined>();
    const playground = vscode.Uri.from({ scheme: 'untitled', path: 'playground-1.mongodb.js' });
    const playgrounds: ConnectionOfFiles = { connectionOf: (uri) => (uri.toString() === playground.toString() ? 'p1' : undefined), onDidChange: changed.event };
    const decorations = new ConnectionDecorations(manager([prod]) as unknown as ConnectionManager, [], [playgrounds]);
    expect(decorations.provideFileDecoration(playground)?.color?.id).toBe('charts.red');
    const fired: unknown[] = [];
    decorations.onDidChangeFileDecorations((e) => fired.push(e));
    changed.fire(playground);
    expect(fired).toEqual([playground]);
  });

  it('tells the decorations changed only when a name or a color changed', () => {
    const list = [{ ...prod }, { ...local }];
    const connections = manager(list);
    const decorations = new ConnectionDecorations(connections as unknown as ConnectionManager, []);
    let fired = 0;
    decorations.onDidChangeFileDecorations(() => fired++);
    connections.fire(); // connecting, say
    expect(fired).toBe(0);
    list[1].color = 'blue';
    connections.fire();
    expect(fired).toBe(1);
    list[0].name = 'production';
    connections.fire();
    expect(fired).toBe(2);
  });
});

describe('tab icons', () => {
  const root = vscode.Uri.from({ scheme: 'file', path: '/ext' });
  it("takes the leaf in the connection's color, for light and dark themes", () => {
    const icon = tabIcon(root, 'green') as { light: vscode.Uri; dark: vscode.Uri };
    expect(icon.light.path).toBe('/ext/media/connection/green-light.svg');
    expect(icon.dark.path).toBe('/ext/media/connection/green-dark.svg');
  });

  it('keeps the usual icon without a color', () => {
    expect((tabIcon(root, undefined) as vscode.Uri).path).toBe('/ext/media/mongoster.svg');
    expect((tabIcon(root, undefined, 'collection.svg') as vscode.Uri).path).toBe('/ext/media/collection.svg');
  });
});
