import * as fs from 'node:fs';
import { describe, expect, it } from 'vitest';
import { IconName, iconSvg } from '../../src/shared/icons';
import { queryBarHtml } from '../../src/queryBarHtml';

/** Each `<button …>…</button>` of the markup, with its id. */
function buttons(html: string): { id: string; html: string }[] {
  return [...html.matchAll(/<button\b[^>]*\bid="([^"]+)"[^>]*>[\s\S]*?<\/button>/g)].map((m) => ({ id: m[1], html: m[0] }));
}

describe('query.pane: the markup', () => {
  const html = queryBarHtml();
  const all = buttons(html);
  const byId = new Map(all.map((b) => [b.id, b.html]));

  it('gives every action an icon, and its text in a label the webview can rewrite', () => {
    const actions = all.filter((b) => !b.id.startsWith('mode') && b.id !== 'layoutToggle');
    expect(actions.length).toBeGreaterThan(15);
    for (const b of actions) {
      expect(b.html, b.id).toContain('<svg class="ico"');
      expect(b.html, b.id).toMatch(/<span class="label">[^<]+<\/span>/);
    }
  });

  it('has the elements the webview looks up', () => {
    for (const id of ['run', 'reset', 'builderToggle', 'explainFind', 'codeFind', 'updateMany', 'deleteMany', 'historyBtn', 'export', 'watch', 'insert', 'layoutToggle', 'runPipeline', 'addStage', 'pipelineTextToggle', 'clearPipeline', 'explainPipeline', 'codePipeline', 'copyPipeline', 'saveView']) {
      expect(byId.has(id), id).toBe(true);
    }
    for (const id of ['filter', 'sort', 'projection', 'builder', 'stages', 'pipelineText', 'queryPane', 'paneSplitter', 'previewInfo']) {
      expect(html, id).toContain(`id="${id}"`);
    }
  });

  it('puts Find and Reset beside the filter, and the writes apart', () => {
    const filterRow = html.slice(html.indexOf('class="row q-filter"'), html.indexOf('class="row q-tools"'));
    expect(filterRow).toContain('id="run"');
    expect(filterRow).toContain('id="reset"');
    const writes = html.slice(html.indexOf('q-write'), html.indexOf('id="builder"'));
    expect(writes).toContain('id="updateMany"');
    expect(writes).toContain('id="deleteMany"');
    expect(writes).not.toContain('id="explainFind"');
  });

  it('offers the toggle as a pressed or not pressed button', () => {
    expect(byId.get('layoutToggle')).toContain('aria-pressed="false"');
    expect(byId.get('layoutToggle')).toContain('<svg class="ico"');
  });
});

describe('query.pane: the icons', () => {
  // The codicons package the icons come from: each path must be the codicon's own.
  const sprite = fs.readFileSync('node_modules/@vscode/codicons/dist/codicon.svg', 'utf8');
  const names: IconName[] = ['add', 'clear-all', 'code', 'copy', 'discard', 'edit', 'export', 'history', 'json', 'layout-sidebar-right', 'list-filter', 'play', 'pulse', 'save-as', 'telescope', 'trash'];

  it('are the paths of the codicons of the same name', () => {
    for (const name of names) {
      const symbol = sprite.match(new RegExp(`<symbol[^>]*id="${name}"[^>]*>(.*?)</symbol>`));
      expect(symbol, name).not.toBeNull();
      const inner = symbol![1].replace(/ xmlns="[^"]*"/g, '');
      expect(iconSvg(name), name).toContain(inner);
    }
  });

  it('are hidden from screen readers and take the color of the text', () => {
    expect(iconSvg('play')).toMatch(/^<svg class="ico" viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">/);
  });
});
