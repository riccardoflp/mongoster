// Explain dialog: how the server ran the query, what it examined, and an index suggestion.
import type { ExplainSummary, PlanNode } from '../shared/explain';
import { toShell } from '../shared/query';

export interface ExplainResult {
  summary?: ExplainSummary;
  raw?: unknown;
  suggestion?: Record<string, 1 | -1> | null;
  error?: string;
}

export interface ExplainOptions {
  /** Renders the raw explain output (the JSON tree of the document dialog). */
  jsonTree(value: unknown): HTMLElement;
  /** "Create this index": switch to the Indexes tab with the index dialog filled. */
  suggest(keys: Record<string, 1 | -1>): void;
}

export class ExplainView {
  private readonly modal = document.getElementById('explainModal')!;
  private readonly body = document.getElementById('explainBody')!;
  private readonly title = document.getElementById('explainTitle')!;
  private readonly rawButton = document.getElementById('explainRaw') as HTMLButtonElement;
  private result: ExplainResult | null = null;
  private showRaw = false;

  constructor(private readonly opts: ExplainOptions) {
    document.getElementById('explainClose')!.addEventListener('click', () => this.close());
    this.modal.addEventListener('click', (e) => {
      if (e.target === this.modal) this.close();
    });
    this.rawButton.addEventListener('click', () => {
      this.showRaw = !this.showRaw;
      this.render();
    });
  }

  get isOpen(): boolean {
    return !this.modal.classList.contains('hidden');
  }

  loading(title: string): void {
    this.result = null;
    this.title.textContent = title;
    this.body.replaceChildren(el('div', 'explain-loading', 'Running explain…'));
    this.rawButton.disabled = true;
    this.modal.classList.remove('hidden');
    document.getElementById('explainClose')!.focus();
  }

  show(result: ExplainResult): void {
    this.result = result;
    this.render();
  }

  close(): void {
    this.modal.classList.add('hidden');
  }

  private render(): void {
    const r = this.result;
    if (!r) return;
    this.rawButton.disabled = !r.raw;
    this.rawButton.textContent = this.showRaw ? 'Summary' : 'Raw';
    this.body.replaceChildren();
    if (r.error) {
      this.body.append(el('div', 'error', r.error));
      return;
    }
    if (this.showRaw) {
      this.body.append(this.opts.jsonTree(r.raw));
      return;
    }
    const s = r.summary!;

    // Verdict
    const verdict = el('div', 'explain-verdict');
    if (s.collscan) verdict.append(badge('COLLSCAN', 'warn', 'Every document of the collection is read: no index is used for the filter'));
    for (const name of s.indexes) verdict.append(badge(`index ${name}`, 'good'));
    if (!s.collscan && !s.indexes.length && s.plan) verdict.append(badge(s.plan.stage, ''));
    if (s.inMemorySort) verdict.append(badge('in-memory sort', 'warn', 'No index provides the sort order: results are sorted in memory (limited to 100 MB unless spilling to disk)'));
    if (s.rejectedPlans) verdict.append(badge(`${s.rejectedPlans} rejected plan${s.rejectedPlans === 1 ? '' : 's'}`, ''));
    this.body.append(verdict);

    // Stats
    const stats = el('div', 'explain-stats');
    const stat = (label: string, value: number | undefined, unit = '') => {
      if (value === undefined) return;
      const box = el('div', 'explain-stat');
      box.append(el('div', 'explain-stat-value', value.toLocaleString() + unit), el('div', 'explain-stat-label', label));
      stats.append(box);
    };
    stat('returned', s.nReturned);
    stat('keys examined', s.totalKeysExamined);
    stat('documents examined', s.totalDocsExamined);
    stat('time', s.executionTimeMillis, ' ms');
    this.body.append(stats);

    const examined = s.totalDocsExamined ?? 0;
    const returned = s.nReturned ?? 0;
    if (examined > 0 && examined >= Math.max(returned, 1) * 10) {
      this.body.append(
        el('div', 'explain-note warn', returned
          ? `${Math.round(examined / returned).toLocaleString()} documents examined for each one returned.`
          : `${examined.toLocaleString()} documents examined, none returned.`),
      );
    }

    if (r.suggestion) {
      const box = el('div', 'explain-suggest');
      box.append(el('span', '', 'Suggested index: '), el('code', '', toShell(r.suggestion)));
      const create = document.createElement('button');
      create.className = 'secondary editable';
      create.textContent = 'Create…';
      create.title = 'Open the Indexes tab with this index ready to create';
      create.addEventListener('click', () => {
        this.close();
        this.opts.suggest(r.suggestion!);
      });
      box.append(create);
      box.title = 'Equality fields first, then the sort, then range fields (ESR rule)';
      this.body.append(box);
    }

    // Plan
    if (s.plan) {
      this.body.append(el('div', 'explain-section', 'Query plan'));
      this.body.append(planTree(s.plan));
    }
    if (s.pipeline.length) {
      this.body.append(el('div', 'explain-section', 'Pipeline stages after the query'));
      const list = el('div', 'explain-pipeline');
      for (const p of s.pipeline) {
        const row = el('div', 'plan-node');
        row.append(el('span', 'plan-stage', p.stage));
        const counts = [p.nReturned !== undefined && `${p.nReturned.toLocaleString()} out`, p.timeMs !== undefined && `~${p.timeMs} ms`].filter(Boolean).join(' · ');
        if (counts) row.append(el('span', 'plan-stats', counts));
        list.append(row);
      }
      this.body.append(list);
    }
  }
}

/** Plan stages from the result backwards to the scans, children indented. */
function planTree(node: PlanNode): HTMLElement {
  const wrap = el('div', 'plan');
  const add = (n: PlanNode, depth: number) => {
    const row = el('div', 'plan-node');
    row.style.paddingLeft = `${depth * 18}px`;
    const cls = n.stage === 'COLLSCAN' ? 'warn' : /IXSCAN|IDHACK/.test(n.stage) ? 'good' : n.stage === 'SORT' ? 'warn' : '';
    row.append(el('span', `plan-stage ${cls}`, (depth ? '└ ' : '') + n.stage));
    const counts = [
      n.nReturned !== undefined && `${n.nReturned.toLocaleString()} out`,
      n.keysExamined !== undefined && `${n.keysExamined.toLocaleString()} keys`,
      n.docsExamined !== undefined && `${n.docsExamined.toLocaleString()} docs`,
    ]
      .filter(Boolean)
      .join(' · ');
    if (counts) row.append(el('span', 'plan-stats', counts));
    const details = Object.entries(n.details)
      .map(([k, v]) => `${k}: ${toShell(v)}`)
      .join('  ');
    if (details) {
      const d = el('div', 'plan-details', details);
      d.style.paddingLeft = `${depth * 18 + 16}px`;
      d.title = details;
      wrap.append(row, d);
    } else wrap.append(row);
    n.children.forEach((c) => add(c, depth + 1));
  };
  add(node, 0);
  return wrap;
}

function badge(text: string, cls: string, title = ''): HTMLElement {
  const b = el('span', `badge ${cls}`, text);
  b.title = title;
  return b;
}

function el(tag: string, className: string, text = ''): HTMLElement {
  const node = document.createElement(tag);
  if (className) node.className = className;
  node.textContent = text;
  return node;
}
