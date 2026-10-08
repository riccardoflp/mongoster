// Schema tab: fields of a sample of documents with presence, types, frequent values and histograms.
// Clicking a value, a bar or a type adds it to the filter, which analyzes the narrower set again.
import type { BsonType, FieldSchema, SchemaSummary, TypeSchema } from '../shared/schema';
import { isPlainObject, toShell } from '../shared/query';

export interface SchemaResult {
  schema?: SchemaSummary;
  /** Documents matching the filter. */
  total?: number;
  durationMs?: number;
  error?: string;
}

export interface SchemaOptions {
  /** Adds `condition` on `path` to the filter and analyzes again. */
  filter(path: string, condition: unknown): void;
}

const TYPE_CLASS: Partial<Record<BsonType, string>> = {
  string: 't-string',
  int: 't-number',
  double: 't-number',
  long: 't-number',
  decimal: 't-number',
  bool: 't-bool',
  date: 't-date',
  timestamp: 't-date',
  objectId: 't-oid',
  null: 't-null',
  regex: 't-regex',
  object: 't-object',
  array: 't-array',
};
const typeClass = (t: BsonType) => TYPE_CLASS[t] ?? 't-special';

export class SchemaView {
  private readonly info = document.getElementById('schemaInfo')!;
  private readonly body = document.getElementById('schemaBody')!;
  private result: SchemaResult | null = null;
  /** Labels of the expanded fields. */
  private readonly expanded = new Set<string>();

  constructor(private readonly opts: SchemaOptions) {
    document.getElementById('schemaExpand')!.addEventListener('click', () => {
      const all = (fields: FieldSchema[]) =>
        fields.forEach((f) => {
          const kids = nested(f);
          if (kids.length) this.expanded.add(f.label);
          all(kids);
        });
      all(this.result?.schema?.fields ?? []);
      this.render();
    });
    document.getElementById('schemaCollapse')!.addEventListener('click', () => {
      this.expanded.clear();
      this.render();
    });
  }

  loading(): void {
    this.info.textContent = 'Analyzing…';
    this.body.classList.add('stale');
  }

  show(result: SchemaResult): void {
    this.result = result;
    this.render();
  }

  private render(): void {
    const r = this.result;
    this.body.classList.remove('stale');
    this.body.replaceChildren();
    if (!r) return;
    if (r.error) {
      this.info.textContent = '';
      this.body.append(div('error', r.error));
      return;
    }
    const s = r.schema!;
    const n = s.sampled.toLocaleString();
    const time = r.durationMs !== undefined ? ` · ${r.durationMs} ms` : '';
    this.info.textContent =
      r.total !== undefined && r.total > s.sampled
        ? `Random sample of ${n} out of ${r.total.toLocaleString()} documents${time}`
        : `All ${n} document${s.sampled === 1 ? '' : 's'}${time}`;
    if (!s.sampled) {
      this.body.append(div('empty', 'No documents match the filter.'));
      return;
    }
    const table = document.createElement('table');
    table.className = 'schema-table';
    const head = table.createTHead().insertRow();
    for (const h of ['Field', 'Present', 'Types', 'Values']) head.append(Object.assign(document.createElement('th'), { textContent: h }));
    const tbody = table.createTBody();
    this.addRows(tbody, s.fields, 0, '');
    this.body.append(table);
    if (s.moreFields) this.body.append(div('schema-note', 'Too many different fields: only the first 500 were analyzed.'));
  }

  private addRows(tbody: HTMLTableSectionElement, fields: FieldSchema[], depth: number, parentLabel: string): void {
    for (const f of fields) {
      const row = tbody.insertRow();
      const kids = nested(f);
      const open = this.expanded.has(f.label);

      // Field
      const name = row.insertCell();
      name.className = 'schema-name';
      name.style.paddingLeft = `${8 + depth * 18}px`;
      name.title = f.label;
      const toggle = document.createElement('span');
      toggle.className = 'schema-toggle';
      if (kids.length) {
        toggle.textContent = open ? '▾' : '▸';
        name.classList.add('expandable');
        name.addEventListener('click', () => {
          if (open) this.expanded.delete(f.label);
          else this.expanded.add(f.label);
          this.render();
        });
      }
      name.append(toggle, span('', parentLabel ? f.label.slice(parentLabel.length).replace(/^\./, '') : f.label));
      if (f.moreFields) name.append(span('schema-muted', ' (500+ fields)'));

      // Presence
      const present = row.insertCell();
      present.className = 'schema-present';
      present.append(bar(f.count / f.of), span('schema-pct', pct(f.count, f.of)));
      present.title =
        f.count < f.of ? `In ${f.count.toLocaleString()} of ${f.of.toLocaleString()}, missing in ${(f.of - f.count).toLocaleString()}` : `In all ${f.of.toLocaleString()}`;

      // Types
      const types = row.insertCell();
      types.className = 'schema-types';
      types.append(this.typeBar(f));

      // Values
      const values = row.insertCell();
      values.className = 'schema-values';
      this.addValues(values, f);

      if (open) this.addRows(tbody, kids, depth + 1, f.label);
    }
  }

  private typeBar(f: FieldSchema): HTMLElement {
    const wrap = div('schema-typebar', '');
    if (f.types.length > 1) {
      const stack = div('stack', '');
      for (const t of f.types) {
        const seg = span(`seg ${typeClass(t.type)}`, '');
        seg.style.flexGrow = String(t.count);
        seg.title = `${t.type}: ${pct(t.count, f.count)}`;
        stack.append(seg);
      }
      wrap.append(stack);
    }
    const legend = div('legend', '');
    for (const t of f.types) {
      const chip = button(`type-chip ${typeClass(t.type)}`, f.types.length > 1 ? `${t.type} ${pct(t.count, f.count)}` : t.type);
      chip.title = `Filter on ${f.path} of type ${t.type}`;
      chip.addEventListener('click', () => this.opts.filter(f.path, { $type: t.type }));
      legend.append(chip);
    }
    wrap.append(legend);
    return wrap;
  }

  private addValues(cell: HTMLElement, f: FieldSchema): void {
    const shown = f.types.filter((t) => t.top || t.bins || t.lengths || (t.type === 'object' && f.fields));
    for (const t of shown) {
      const block = div('schema-type-values', '');
      if (shown.length > 1) block.append(span(`schema-type-label ${typeClass(t.type)}`, t.type));
      if (t.bins) block.append(this.histogram(f, t));
      else if (t.top) block.append(this.topValues(f, t));
      else if (t.lengths) block.append(this.arrayValues(t));
      else block.append(span('schema-muted', `{ ${f.fields!.length} field${f.fields!.length === 1 ? '' : 's'} }`));
      cell.append(block);
    }
  }

  private topValues(f: FieldSchema, t: TypeSchema): HTMLElement {
    const wrap = div('schema-top', '');
    const allDistinct = !t.distinctCapped && t.distinct === t.count && t.count > 1;
    const top = allDistinct ? t.top!.slice(0, 3) : t.top!;
    if (allDistinct) wrap.append(span('schema-muted', 'all distinct, e.g.'));
    for (const v of top) {
      const chip = button('value-chip', '');
      chip.append(span(`v ${typeClass(t.type)}`, short(v.value)));
      if (!allDistinct) chip.append(span('schema-pct', pct(v.count, t.count)));
      chip.title = `${toShell(v.value)}: ${v.count.toLocaleString()} of ${t.count.toLocaleString()}. Click to filter on it.`;
      chip.addEventListener('click', () => this.opts.filter(f.path, v.value));
      wrap.append(chip);
    }
    const more = (t.distinct ?? 0) - top.length;
    if (!allDistinct && more > 0) wrap.append(span('schema-muted', `+${more.toLocaleString()}${t.distinctCapped ? '+' : ''} more`));
    return wrap;
  }

  private histogram(f: FieldSchema, t: TypeSchema): HTMLElement {
    const wrap = div('schema-hist', '');
    const bars = div('bars', '');
    const max = Math.max(...t.bins!.map((b) => b.count));
    for (const b of t.bins!) {
      const col = button('hbar', '');
      const fill = span(`fill ${typeClass(t.type)}`, '');
      fill.style.height = b.count ? `${Math.max(4, (b.count / max) * 100)}%` : '0';
      col.append(fill);
      col.title = `${short(b.from)} – ${short(b.to)}: ${b.count.toLocaleString()}. Click to filter on this range.`;
      col.disabled = !b.count;
      col.addEventListener('click', () => this.opts.filter(f.path, { $gte: b.from, $lt: b.to }));
      bars.append(col);
    }
    const range = div('range', '');
    range.append(span(`v ${typeClass(t.type)}`, short(t.min)), span('spacer', ''), span(`v ${typeClass(t.type)}`, short(t.max)));
    range.title = `${toShell(t.min)} – ${toShell(t.max)}`;
    wrap.append(bars, range);
    return wrap;
  }

  private arrayValues(t: TypeSchema): HTMLElement {
    const wrap = div('schema-array', '');
    const l = t.lengths!;
    wrap.append(span('schema-muted', l.min === l.max ? `${l.min} element${l.min === 1 ? '' : 's'}` : `${l.min}–${l.max} elements, avg ${l.avg}`));
    const e = t.elements;
    if (!e) return wrap;
    // Values of scalar elements: filtering on the array path matches documents containing the value.
    const inner = div('schema-elements', '');
    const legend = this.typeBar(e);
    legend.classList.add('inline');
    inner.append(legend);
    this.addValues(inner, e);
    wrap.append(inner);
    return wrap;
  }
}

/** Child rows of a field: fields of its object values and of objects inside its arrays. */
function nested(f: FieldSchema): FieldSchema[] {
  const fromArrays = f.types.flatMap((t) => t.elements?.fields ?? []);
  return [...(f.fields ?? []), ...fromArrays];
}

/** Compact label: dates without the ISODate() wrapper and without a midnight time. */
function short(v: unknown): string {
  if (isPlainObject(v) && typeof v.$date === 'string') {
    const iso = v.$date;
    return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace(/:00\.000Z$|\.000Z$/, '').replace('T', ' ');
  }
  return toShell(v);
}

function pct(n: number, of: number): string {
  if (!of) return '';
  const p = (n / of) * 100;
  return `${p >= 99.95 || p < 0.05 ? Math.round(p) : p < 10 ? p.toFixed(1) : Math.round(p)}%`;
}

function bar(ratio: number): HTMLElement {
  const b = span('pbar', '');
  const fill = span('', '');
  fill.style.width = `${Math.round(ratio * 100)}%`;
  b.append(fill);
  return b;
}

function div(className: string, text: string): HTMLDivElement {
  const d = document.createElement('div');
  d.className = className;
  d.textContent = text;
  return d;
}

function span(className: string, text: string): HTMLSpanElement {
  const s = document.createElement('span');
  if (className) s.className = className;
  s.textContent = text;
  return s;
}

function button(className: string, text: string): HTMLButtonElement {
  const b = document.createElement('button');
  b.className = className;
  b.textContent = text;
  return b;
}
