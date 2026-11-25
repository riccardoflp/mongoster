// Drag & drop from a collection's table into its query: a cell or a header dragged from the table shows zones
// over the filter (conditions), Sort and Project (in `Find`) or over the pipeline (in `Aggregate`), and a drop
// writes into that box. A condition and a sort run the query at once; a field put into Project waits for `Find`,
// so that several can be dragged from the same table (the zones say which: src/shared/dropZones.ts).
// This module only wires the zones to the DOM; the table tells it what a cell holds.
import { isPlainObject, mergeCondition, mergeProjection, mergeSort, parseQuery, toShell } from '../shared/query';
import { DragPayload, projectionZones, sortZones } from '../shared/dropZones';

/** A condition the filter (or the pipeline) can get from what is dragged. */
interface ConditionZone {
  label: string;
  title: string;
  condition: (p: DragPayload) => unknown;
}

export interface QueryDropOptions {
  grid: HTMLElement;
  filter: HTMLTextAreaElement;
  sort: HTMLInputElement;
  projection: HTMLInputElement;
  mode(): string;
  /** The field and value of a cell; `within`: the array whose element it is in. Null for a cell with no value. */
  cellValue(td: HTMLElement): { key: string; value: unknown; within?: string } | null;
  /** The CSS class of a value's type (`t-number`…), which decides the comparisons offered. */
  typeClass(value: unknown): string;
  /** The sort of the query, or of the pipeline in Aggregate. */
  currentSort(): Record<string, unknown>;
  /** In Aggregate the conditions go into a `$match` stage. */
  pipeline: { addCondition(key: string, condition: unknown, within?: string): void; dropTarget(): string };
  /** The filter's text changed: its height and the builder follow. */
  filterChanged(): void;
  /** The text of Sort or Project changed without the query being run. */
  optionChanged(): void;
  run(): void;
  notify(message: string): void;
}

const COMPARABLE = new Set(['t-number', 't-date', 't-string']);

const byId = (id: string) => document.getElementById(id)!;

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  s.className = className;
  s.textContent = text;
  return s;
}

/** Shows for a moment that a box was written into. */
export function flash(node: HTMLElement): void {
  node.classList.remove('flash');
  void node.offsetWidth;
  node.classList.add('flash');
}

/** "items[].sku" for a field of an array element, else the dotted key. */
export function displayKey(p: DragPayload): string {
  return p.kind === 'cell' && p.within ? `${p.within}[].${p.key.slice(p.within.length + 1)}` : p.key;
}

export class QueryDrop {
  /** What is being dragged from the table, if anything. */
  drag: DragPayload | null = null;
  private readonly dropzones = byId('dropzones');
  private readonly sortDrop = byId('sortDrop');
  private readonly projectionDrop = byId('projectionDrop');
  private readonly pipelineDrop = byId('pipelineDrop');

  constructor(private readonly opts: QueryDropOptions) {
    opts.grid.addEventListener('dragstart', (e) => {
      const target = e.target as HTMLElement;
      if (target.tagName === 'TH' && target.dataset.key) {
        this.drag = { kind: 'column', key: target.dataset.key };
      } else if (target.tagName === 'TD') {
        const cell = opts.cellValue(target);
        if (!cell) return;
        this.drag = { kind: 'cell', ...cell };
      } else {
        return;
      }
      const label = this.drag.kind === 'cell' ? `${displayKey(this.drag)}: ${toShell(this.drag.value)}` : this.drag.key;
      e.dataTransfer!.setData('text/plain', label);
      // Columns can also be moved onto another header.
      e.dataTransfer!.effectAllowed = this.drag.kind === 'column' ? 'copyMove' : 'copy';
      this.showZones(this.drag);
    });
    opts.grid.addEventListener('dragend', () => this.end());
  }

  /** Ends the drag and takes the zones away. */
  end(): void {
    this.drag = null;
    document.body.classList.remove('dragging');
    this.dropzones.replaceChildren();
    this.sortDrop.replaceChildren();
    this.projectionDrop.replaceChildren();
    this.pipelineDrop.replaceChildren();
  }

  /** Adds a condition to the filter (to the pipeline in Aggregate) and runs the query. */
  addCondition(key: string, condition: unknown, within?: string): void {
    const { filter } = this.opts;
    if (this.opts.mode() === 'aggregate') {
      this.opts.pipeline.addCondition(key, condition, within);
      return;
    }
    try {
      filter.value = mergeCondition(filter.value, key, condition, within);
    } catch (err) {
      this.opts.notify(`Fix the filter before adding conditions by drag & drop: ${(err as Error).message}`);
      filter.classList.add('invalid');
      return;
    }
    this.opts.filterChanged();
    flash(byId('filterWrap'));
    this.opts.run();
  }

  private conditionZones(p: DragPayload): ConditionZone[] {
    if (p.kind === 'column') {
      return [
        { label: 'exists', title: `${p.key}: { $exists: true }`, condition: () => ({ $exists: true }) },
        { label: 'missing', title: `${p.key}: { $exists: false }`, condition: () => ({ $exists: false }) },
        { label: 'is null', title: `${p.key}: null`, condition: () => null },
      ];
    }
    const zones: ConditionZone[] = [
      { label: '= equals', title: 'Match this exact value', condition: (d) => (d as { value: unknown }).value },
      { label: '≠ not equal', title: '$ne', condition: (d) => ({ $ne: (d as { value: unknown }).value }) },
    ];
    if (COMPARABLE.has(this.opts.typeClass(p.value))) {
      zones.push(
        { label: '≥ from', title: '$gte (combines with ≤ for a range)', condition: (d) => ({ $gte: (d as { value: unknown }).value }) },
        { label: '≤ to', title: '$lte (combines with ≥ for a range)', condition: (d) => ({ $lte: (d as { value: unknown }).value }) },
      );
    }
    if (Array.isArray(p.value) && p.value.length) {
      zones.push({ label: '∈ in', title: '$in: any of these values', condition: (d) => ({ $in: (d as { value: unknown }).value }) });
    }
    return zones;
  }

  private showZones(p: DragPayload): void {
    const aggregate = this.opts.mode() === 'aggregate';
    const container = aggregate ? document.createElement('div') : this.dropzones;
    if (aggregate) {
      container.className = 'dz-row';
      this.pipelineDrop.replaceChildren(span('dz-caption', `Drop to add the condition ${this.opts.pipeline.dropTarget()}`), container);
    }
    this.dropzones.replaceChildren();
    for (const zone of this.conditionZones(p)) {
      const div = this.zone(zone.label, zone.title, displayKey(p), () => {
        const d = this.drag;
        if (d) this.addCondition(d.key, zone.condition(d), d.kind === 'cell' ? d.within : undefined);
      });
      if (p.kind === 'cell' && p.within) div.title += ` · same element of ${p.within} ($elemMatch)`;
      container.append(div);
    }
    this.showOptionZones(p);
    document.body.classList.add('dragging');
  }

  private zone(label: string, title: string, key: string, drop: () => void): HTMLDivElement {
    const div = document.createElement('div');
    div.className = 'dropzone';
    div.title = title;
    div.append(span('dz-label', label), span('dz-key', key));
    div.addEventListener('dragover', (e) => {
      e.preventDefault();
      e.dataTransfer!.dropEffect = 'copy';
      div.classList.add('over');
    });
    div.addEventListener('dragleave', () => div.classList.remove('over'));
    div.addEventListener('drop', (e) => {
      e.preventDefault();
      drop();
      this.end();
    });
    return div;
  }

  /** A column or a cell dropped on Sort sorts by its field, on Project includes or excludes it; a field already there can be removed. */
  private showOptionZones(p: DragPayload): void {
    const { sort, projection } = this.opts;
    const key = p.key;
    const mode = this.opts.mode();
    this.sortDrop.replaceChildren(
      ...sortZones(p, mode, this.opts.currentSort()).map((z) =>
        this.zone(z.label, z.title, key, () => this.setOption(sort, byId('sortWrap'), (text) => mergeSort(text, key, z.value), z.runs)),
      ),
    );
    this.projectionDrop.replaceChildren(
      ...projectionZones(p, mode, this.currentProjection()).map((z) =>
        this.zone(z.label, z.title, key, () =>
          this.setOption(projection, byId('projectionWrap'), (text) => mergeProjection(text, key, z.value), z.runs),
        ),
      ),
    );
  }

  private currentProjection(): Record<string, unknown> {
    try {
      const text = this.opts.projection.value;
      const v = text.trim() ? parseQuery(text) : {};
      return isPlainObject(v) ? v : {};
    } catch {
      return {};
    }
  }

  /** Puts a dropped field into the sort or the projection; `runs`: and runs the query. */
  private setOption(input: HTMLInputElement, wrap: HTMLElement, merge: (text: string) => string, runs: boolean): void {
    try {
      input.value = merge(input.value);
    } catch (err) {
      this.opts.notify(`Fix the ${input.id} before adding fields by drag & drop: ${(err as Error).message}`);
      input.classList.add('invalid');
      return;
    }
    input.classList.remove('invalid');
    flash(wrap);
    if (runs) this.opts.run();
    else this.opts.optionChanged();
  }
}
