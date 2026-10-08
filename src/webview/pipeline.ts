// Aggregation pipeline editor: a strip of stage cards, or the whole pipeline as text.
import { isPlainObject, mergeCondition, parseQuery, toShell } from '../shared/query';
import {
  PipelineStage,
  STAGE_TEMPLATES,
  WRITE_STAGES,
  parseStageBody,
  pipelineToText,
  textToPipeline,
} from '../shared/pipeline';

export interface PipelineCallbacks {
  /** Runs the pipeline (up to `previewUpto`). */
  run(): void;
  /** Stages or preview changed: persist the state. */
  changed(): void;
  notify(message: string): void;
  copy(text: string): void;
}

export class PipelineEditor {
  stages: PipelineStage[] = [];
  /** Index of the stage whose output is shown, or null for the whole pipeline. */
  previewUpto: number | null = null;
  private textMode = false;
  private errorStage: number | null = null;

  private readonly strip = document.getElementById('stages')!;
  private readonly textArea = document.getElementById('pipelineText') as HTMLTextAreaElement;
  private readonly info = document.getElementById('previewInfo')!;
  private readonly textToggle = document.getElementById('pipelineTextToggle') as HTMLButtonElement;

  constructor(private readonly cb: PipelineCallbacks) {
    const ops = document.getElementById('stageOps')!;
    for (const op of Object.keys(STAGE_TEMPLATES)) {
      const option = document.createElement('option');
      option.value = op;
      ops.append(option);
    }
    document.getElementById('addStage')!.addEventListener('click', () => this.addStage());
    document.getElementById('runPipeline')!.addEventListener('click', () => this.runAll());
    document.getElementById('clearPipeline')!.addEventListener('click', () => {
      this.setStages([]);
      this.cb.run();
    });
    document.getElementById('copyPipeline')!.addEventListener('click', () => {
      if (!this.textMode || this.applyText()) this.cb.copy(pipelineToText(this.stages));
    });
    this.textToggle.addEventListener('click', () => this.setTextMode(!this.textMode));
    this.textArea.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.runAll();
      }
    });
    this.textArea.addEventListener('input', () => this.textArea.classList.remove('invalid'));
  }

  /** Index the pipeline runs up to. */
  get upto(): number {
    return this.previewUpto ?? this.stages.length - 1;
  }

  setStages(stages: PipelineStage[], previewUpto: number | null = null): void {
    this.stages = stages.map((s) => ({ ...s }));
    this.previewUpto = previewUpto !== null && previewUpto < this.stages.length - 1 ? previewUpto : null;
    this.errorStage = null;
    if (this.textMode) this.textArea.value = pipelineToText(this.stages);
    this.render();
    this.cb.changed();
  }

  /** Called before running: in text mode the text must parse first. */
  prepare(): boolean {
    return !this.textMode || this.applyText();
  }

  markError(stage: number | null): void {
    this.errorStage = stage;
    this.strip.querySelectorAll('.stage').forEach((card, i) => card.classList.toggle('error', i === stage));
    if (stage !== null) this.strip.querySelector('.stage.error')?.scrollIntoView({ block: 'nearest', inline: 'nearest' });
  }

  /** Where drag & drop conditions go, for the drop bar caption. */
  dropTarget(): string {
    const i = this.upto;
    const stage = this.stages[i];
    if (stage?.enabled && stage.op.trim() === '$match') return `into $match (stage ${i + 1})`;
    return i < 0 ? 'as a new $match stage' : `as a new $match after stage ${i + 1}`;
  }

  /**
   * Adds a filter condition on the output shown in the grid: merged into the shown
   * stage when it's a $match, otherwise a new $match right after it.
   */
  addCondition(key: string, condition: unknown, within?: string): boolean {
    if (!this.prepare()) return false;
    const i = this.upto;
    const stage = this.stages[i];
    try {
      if (stage?.enabled && stage.op.trim() === '$match') {
        stage.body = mergeCondition(stage.body, key, condition, within);
        this.focusStage(i);
      } else {
        this.insert(i + 1, { op: '$match', body: mergeCondition('', key, condition, within), enabled: true });
      }
    } catch (err) {
      this.cb.notify(`Fix stage ${i + 1} before adding conditions by drag & drop: ${(err as Error).message}`);
      this.markError(i);
      return false;
    }
    this.afterEdit();
    return true;
  }

  /** Sort of the shown output: the shown stage's body when it's a $sort. */
  currentSort(): Record<string, unknown> {
    const stage = this.stages[this.upto];
    if (!stage?.enabled || stage.op.trim() !== '$sort') return {};
    try {
      const v = parseQuery(stage.body);
      return isPlainObject(v) ? v : {};
    } catch {
      return {};
    }
  }

  /** Header click: ascending → descending → off, on a $sort stage after the shown output. */
  toggleSort(key: string): void {
    if (!this.prepare()) return;
    const i = this.upto;
    const stage = this.stages[i];
    if (stage?.enabled && stage.op.trim() === '$sort') {
      // Same cycle as the Find sort: one key at a time.
      const dir = this.currentSort()[key];
      if (dir === -1) this.remove(i, false);
      else stage.body = toShell({ [key]: dir === 1 ? -1 : 1 });
    } else {
      this.insert(i + 1, { op: '$sort', body: toShell({ [key]: 1 }), enabled: true });
    }
    this.afterEdit();
  }

  private afterEdit(): void {
    if (this.textMode) this.textArea.value = pipelineToText(this.stages);
    this.render();
    this.cb.changed();
    this.cb.run();
  }

  /** Inserts a stage; when previewing, the preview moves to the new stage. */
  private insert(index: number, stage: PipelineStage): void {
    this.stages.splice(index, 0, stage);
    if (this.previewUpto !== null) this.previewUpto = index < this.stages.length - 1 ? index : null;
    this.focusAfterRender = index;
  }

  private remove(index: number, rerender = true): void {
    this.stages.splice(index, 1);
    if (this.previewUpto !== null) {
      if (index <= this.previewUpto) this.previewUpto--;
      if (this.previewUpto < 0 || this.previewUpto >= this.stages.length - 1) this.previewUpto = null;
    }
    if (rerender) {
      this.render();
      this.cb.changed();
    }
  }

  private focusAfterRender: number | null = null;

  private focusStage(i: number): void {
    this.focusAfterRender = i;
  }

  private addStage(): void {
    if (!this.prepare()) return;
    if (this.textMode) this.setTextMode(false);
    this.stages.push({ op: '$match', body: STAGE_TEMPLATES.$match, enabled: true });
    this.previewUpto = null;
    this.render();
    this.cb.changed();
    const card = this.strip.lastElementChild?.previousElementSibling;
    card?.scrollIntoView({ inline: 'end', block: 'nearest' });
    const op = card?.querySelector<HTMLInputElement>('.stage-op');
    op?.focus();
    op?.select();
  }

  private runAll(): void {
    if (!this.prepare()) return;
    this.previewUpto = null;
    this.render();
    this.cb.changed();
    this.cb.run();
  }

  private preview(i: number): void {
    this.previewUpto = this.previewUpto === i || i >= this.stages.length - 1 ? null : i;
    this.render();
    this.cb.changed();
    this.cb.run();
  }

  private setTextMode(on: boolean): void {
    if (!on && !this.applyText()) return;
    this.textMode = on;
    this.textToggle.textContent = on ? 'Edit as stages' : 'Edit as text';
    this.textToggle.classList.toggle('active', on);
    this.strip.classList.toggle('hidden', on);
    this.textArea.classList.toggle('hidden', !on);
    if (on) {
      this.textArea.value = pipelineToText(this.stages);
      this.textArea.focus();
    }
    this.render();
  }

  /** Text mode → stages. Disabled stages aren't in the text, so they're kept only if the text is unchanged. */
  private applyText(): boolean {
    if (!this.textMode) return true;
    if (this.textArea.value === pipelineToText(this.stages)) return true;
    try {
      this.stages = textToPipeline(this.textArea.value);
    } catch (err) {
      this.textArea.classList.add('invalid');
      this.cb.notify(`Invalid pipeline: ${(err as Error).message}`);
      return false;
    }
    this.previewUpto = null;
    this.textArea.value = pipelineToText(this.stages);
    this.cb.changed();
    return true;
  }

  render(): void {
    this.renderInfo();
    if (this.textMode) return;
    this.strip.replaceChildren();
    this.stages.forEach((stage, i) => {
      if (i > 0) this.strip.append(span('stage-arrow', '→'));
      this.strip.append(this.card(stage, i));
    });
    if (this.stages.length) {
      const add = document.createElement('button');
      add.className = 'stage-add secondary';
      add.textContent = '+';
      add.title = 'Add a stage at the end';
      add.addEventListener('click', () => this.addStage());
      this.strip.append(add);
    } else {
      this.strip.append(
        span('stages-empty', 'No stages: the pipeline returns the documents unchanged. Add a stage, paste a pipeline with "Edit as text", or drag a cell here.'),
      );
    }
    if (this.errorStage !== null) this.markError(this.errorStage);
    if (this.focusAfterRender !== null) {
      const card = this.strip.querySelectorAll<HTMLElement>('.stage')[this.focusAfterRender];
      card?.scrollIntoView({ inline: 'nearest', block: 'nearest' });
      card?.classList.add('flash');
      this.focusAfterRender = null;
    }
  }

  private renderInfo(): void {
    this.info.replaceChildren();
    const enabled = this.stages.filter((s) => s.enabled).length;
    if (this.previewUpto !== null) {
      const stage = this.stages[this.previewUpto];
      this.info.append(`Output of stage ${this.previewUpto + 1} (${stage.op}) · `);
      const all = document.createElement('button');
      all.className = 'link';
      all.textContent = 'show full pipeline';
      all.addEventListener('click', () => this.runAll());
      this.info.append(all);
    } else if (this.stages.length) {
      this.info.textContent = `${enabled} of ${this.stages.length} stage${this.stages.length === 1 ? '' : 's'} enabled`;
    }
    if (this.textMode && enabled < this.stages.length) this.info.append(' · disabled stages are not shown in text');
  }

  private card(stage: PipelineStage, i: number): HTMLElement {
    const card = document.createElement('div');
    card.className = 'stage';
    card.classList.toggle('disabled', !stage.enabled);
    card.classList.toggle('write', WRITE_STAGES.has(stage.op.trim()));
    card.classList.toggle('previewed', this.previewUpto === i);
    card.classList.toggle('skipped', this.previewUpto !== null && i > this.previewUpto);

    const head = document.createElement('div');
    head.className = 'stage-head';

    const num = document.createElement('button');
    num.className = 'stage-num';
    num.textContent = String(i + 1);
    num.title =
      this.previewUpto === i ? 'Previewing this stage — click to show the full pipeline' : 'Show the output up to this stage';
    num.addEventListener('click', () => this.preview(i));

    const op = document.createElement('input');
    op.className = 'stage-op';
    op.value = stage.op;
    op.spellcheck = false;
    op.setAttribute('list', 'stageOps');
    op.title = 'Stage operator';
    op.classList.toggle('invalid', !isValidOp(stage.op));
    op.addEventListener('focus', () => (op.dataset.before = stage.op));
    op.addEventListener('input', () => {
      const before = op.dataset.before ?? stage.op;
      stage.op = op.value;
      // Swap in the new operator's template while the body is still the old template (or empty).
      const template = STAGE_TEMPLATES[op.value.trim()];
      if (template && (!stage.body.trim() || stage.body === STAGE_TEMPLATES[before.trim()])) {
        stage.body = body.value = template;
        autosize(body);
      }
      op.dataset.before = op.value;
      op.classList.toggle('invalid', !isValidOp(op.value));
      card.classList.toggle('write', WRITE_STAGES.has(stage.op.trim()));
      this.renderInfo();
      this.cb.changed();
    });

    const enabled = document.createElement('input');
    enabled.type = 'checkbox';
    enabled.checked = stage.enabled;
    enabled.title = 'Enabled (uncheck to skip this stage)';
    enabled.addEventListener('change', () => {
      stage.enabled = enabled.checked;
      card.classList.toggle('disabled', !stage.enabled);
      this.renderInfo();
      this.cb.changed();
    });

    head.append(num, op, enabled, span('spacer', ''));
    if (WRITE_STAGES.has(stage.op.trim())) head.append(span('stage-badge', 'writes'));
    const move = (label: string, title: string, to: number) => {
      const b = document.createElement('button');
      b.className = 'icon';
      b.textContent = label;
      b.title = title;
      b.disabled = to < 0 || to >= this.stages.length;
      b.addEventListener('click', () => {
        const [s] = this.stages.splice(i, 1);
        this.stages.splice(to, 0, s);
        this.previewUpto = null;
        this.errorStage = null;
        this.render();
        this.cb.changed();
      });
      return b;
    };
    const del = document.createElement('button');
    del.className = 'icon';
    del.textContent = '✕';
    del.title = 'Remove stage';
    del.addEventListener('click', () => {
      this.errorStage = null;
      this.remove(i);
    });
    head.append(move('‹', 'Move left', i - 1), move('›', 'Move right', i + 1), del);

    const body = document.createElement('textarea');
    body.className = 'stage-body';
    body.spellcheck = false;
    body.value = stage.body;
    body.addEventListener('input', () => {
      stage.body = body.value;
      body.classList.toggle('invalid', !isValidBody(stage));
      card.classList.remove('error');
      autosize(body);
      this.cb.changed();
    });
    body.addEventListener('keydown', (e) => {
      if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
        e.preventDefault();
        this.cb.run();
      }
    });
    body.classList.toggle('invalid', !isValidBody(stage));

    card.append(head, body);
    requestAnimationFrame(() => autosize(body));
    return card;
  }
}

function isValidBody(stage: PipelineStage): boolean {
  try {
    parseStageBody({ ...stage, op: '$stage' });
    return true;
  } catch {
    return false;
  }
}

const isValidOp = (op: string) => /^\$[A-Za-z]+$/.test(op.trim());

function autosize(t: HTMLTextAreaElement): void {
  t.style.height = 'auto';
  const borders = t.offsetHeight - t.clientHeight;
  t.style.height = `${Math.min(t.scrollHeight + borders, 220)}px`;
}

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}
