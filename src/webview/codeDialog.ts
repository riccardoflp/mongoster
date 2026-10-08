// "Code" dialog: the current find query or pipeline as code for mongosh or a driver, to copy or open in an editor.
import { CODE_LANGUAGES, CodeLanguage, CodeQuery, generateCode } from '../shared/codegen';
import type { WebviewMessage } from '../shared/messages';
import { isPlainObject, parseQuery } from '../shared/query';
import { parseStageBody, PipelineStage } from '../shared/pipeline';
import type { QuerySource } from '../shared/messages';

export interface CodePrefs {
  language: CodeLanguage;
  program: boolean;
}

export interface CodeDialogCallbacks {
  post(message: WebviewMessage): void;
  prefs(): CodePrefs;
  savePrefs(prefs: CodePrefs): void;
}

/** The query of a find or the enabled stages of a pipeline, as values (throws on invalid syntax). */
export function toCodeQuery(source: QuerySource): CodeQuery {
  if (source.kind === 'aggregate') {
    return { kind: 'aggregate', pipeline: source.stages.filter((s: PipelineStage) => s.enabled).map((s) => ({ [s.op.trim()]: parseStageBody(s) })) };
  }
  const value = (text: string, label: string) => {
    if (!text.trim()) return undefined;
    const v = parseQuery(text);
    if (!isPlainObject(v)) throw new Error(`${label} must be an object`);
    return v;
  };
  return { kind: 'find', filter: value(source.filter, 'Filter') ?? {}, projection: value(source.projection, 'Project'), sort: value(source.sort, 'Sort') };
}

export class CodeDialog {
  private readonly modal = document.getElementById('codeModal')!;
  private readonly title = document.getElementById('codeTitle')!;
  private readonly langs = document.getElementById('codeLangs')!;
  private readonly program = document.getElementById('codeProgram') as HTMLInputElement;
  private readonly text = document.getElementById('codeText')!;
  private readonly error = document.getElementById('codeError')!;
  private query?: CodeQuery;
  private target = { database: '', collection: '' };

  constructor(private readonly cb: CodeDialogCallbacks) {
    for (const lang of CODE_LANGUAGES) {
      const b = document.createElement('button');
      b.textContent = lang.label;
      b.dataset.lang = lang.id;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.setPrefs({ ...this.cb.prefs(), language: lang.id }));
      this.langs.append(b);
    }
    this.program.addEventListener('change', () => this.setPrefs({ ...this.cb.prefs(), program: this.program.checked }));
    document.getElementById('codeClose')!.addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
    document.getElementById('codeCopy')!.addEventListener('click', () => this.cb.post({ type: 'copy', text: this.text.textContent ?? '' }));
    document.getElementById('codeOpen')!.addEventListener('click', () => {
      const language = CODE_LANGUAGES.find((l) => l.id === this.cb.prefs().language)?.editorLanguage ?? 'plaintext';
      this.cb.post({ type: 'openCode', language, text: this.text.textContent ?? '' });
    });
  }

  get isOpen(): boolean {
    return !this.modal.classList.contains('hidden');
  }

  open(source: QuerySource, database: string, collection: string): void {
    let query: CodeQuery | undefined;
    let error: string | undefined;
    try {
      query = toCodeQuery(source);
    } catch (err) {
      error = `Invalid query: ${(err as Error).message}`;
    }
    const what = source.kind === 'aggregate' ? `aggregate (${query?.kind === 'aggregate' ? query.pipeline.length : 0} stages)` : 'find';
    this.show(query, error, what, database, collection);
  }

  /** A query built elsewhere (e.g. the chart's pipeline); `what` goes in the title. */
  show(query: CodeQuery | undefined, error: string | undefined, what: string, database: string, collection: string): void {
    this.target = { database, collection };
    this.query = query;
    this.error.textContent = error ?? '';
    this.error.classList.toggle('hidden', !error);
    this.title.textContent = `Code · ${collection} · ${what}`;
    this.render();
    this.modal.classList.remove('hidden');
    (this.langs.querySelector('[aria-selected="true"]') as HTMLElement | null)?.focus();
  }

  close(): void {
    this.modal.classList.add('hidden');
  }

  private setPrefs(prefs: CodePrefs): void {
    this.cb.savePrefs(prefs);
    this.render();
  }

  private render(): void {
    const { language, program } = this.cb.prefs();
    for (const b of this.langs.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-selected', String(b.dataset.lang === language));
    this.program.checked = program;
    this.text.textContent = this.query ? generateCode(language, this.query, { ...this.target, program }) : '';
    for (const id of ['codeCopy', 'codeOpen']) (document.getElementById(id) as HTMLButtonElement).disabled = !this.query;
  }
}
