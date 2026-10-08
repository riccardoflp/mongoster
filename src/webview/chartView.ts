// "Chart" tab: chart type and fields, drawing with Chart.js (loaded on first use), PNG export,
// and a click on a bar or slice to show its documents.
import type { Chart as ChartJs, ChartConfiguration, ChartEvent, ActiveElement, Plugin, TooltipItem } from 'chart.js';
import { CHART_LIMITS, ChartAgg, ChartData, ChartSpec, ChartType, DateUnit, formatDate, normalizeSpec, specError, toChartData } from '../shared/chart';

export interface ChartViewCallbacks {
  draw(): void;
  /** Show the documents of a clicked bar or slice: conditions on the category and series fields. */
  filter(conditions: { field: string; value: unknown }[]): void;
  code(): void;
  savePng(dataUrl: string): void;
  /** Field names for the inputs' suggestions. */
  fields(): string[];
  changed(spec: ChartSpec): void;
  error(message: string | null): void;
}

const TYPES: { id: ChartType; label: string; title: string }[] = [
  { id: 'bar', label: 'Bar', title: 'Count or measure per category' },
  { id: 'line', label: 'Line', title: 'Count or measure along a field, usually a date' },
  { id: 'pie', label: 'Pie', title: 'Share of each category' },
  { id: 'scatter', label: 'Scatter', title: 'Two number or date fields of a random sample of documents' },
  { id: 'histogram', label: 'Histogram', title: 'Distribution of a number or date field' },
];

const PALETTE: [string, string][] = [
  ['--vscode-charts-blue', '#3794ff'],
  ['--vscode-charts-orange', '#d18616'],
  ['--vscode-charts-green', '#89d185'],
  ['--vscode-charts-purple', '#b180d7'],
  ['--vscode-charts-red', '#f14c4c'],
  ['--vscode-charts-yellow', '#cca700'],
  ['', '#4ec9b0'],
  ['', '#ce9178'],
  ['', '#9cdcfe'],
  ['', '#c586c0'],
  ['', '#dcdcaa'],
  ['', '#808080'],
];

type ChartClass = typeof ChartJs;
let loader: Promise<ChartClass> | undefined;

/** Chart.js from its own bundle, inserted with the page's nonce. */
function loadChartJs(): Promise<ChartClass> {
  const w = window as unknown as { Chart?: ChartClass };
  if (w.Chart) return Promise.resolve(w.Chart);
  return (loader ??= new Promise<ChartClass>((resolve, reject) => {
    const script = document.createElement('script');
    script.src = document.body.dataset.chartSrc ?? '';
    script.nonce = document.querySelector<HTMLScriptElement>('script[nonce]')?.nonce ?? '';
    script.onload = () => (w.Chart ? resolve(w.Chart) : reject(new Error('Chart.js did not load')));
    script.onerror = () => {
      loader = undefined;
      reject(new Error('Could not load Chart.js'));
    };
    document.head.append(script);
  }));
}

function cssVar(name: string, fallback: string): string {
  return (name && getComputedStyle(document.body).getPropertyValue(name).trim()) || fallback;
}

function alpha(color: string, a: number): string {
  const hex = /^#([0-9a-f]{6})$/i.exec(color)?.[1] ?? (/^#([0-9a-f]{3})$/i.exec(color)?.[1]?.replace(/./g, '$&$&') as string | undefined);
  if (!hex) return color;
  const n = parseInt(hex, 16);
  return `rgba(${n >> 16}, ${(n >> 8) & 255}, ${n & 255}, ${a})`;
}

const el = <T extends HTMLElement = HTMLElement>(id: string) => document.getElementById(id) as T;

export class ChartView {
  private readonly types = el('chartTypes');
  private readonly x = el<HTMLInputElement>('chartX');
  private readonly unit = el<HTMLSelectElement>('chartUnit');
  private readonly agg = el<HTMLSelectElement>('chartAgg');
  private readonly y = el<HTMLInputElement>('chartY');
  private readonly series = el<HTMLInputElement>('chartSeries');
  private readonly limit = el<HTMLInputElement>('chartLimit');
  private readonly info = el('chartInfo');
  private readonly empty = el('chartEmpty');
  private readonly canvas = el<HTMLCanvasElement>('chartCanvas');
  private readonly fieldList = el('chartFieldList');
  private type: ChartType = 'bar';
  private chart?: ChartJs;
  /** What the current chart shows. */
  private drawn?: { spec: ChartSpec; data: ChartData };
  private filterable = false;

  constructor(
    private readonly cb: ChartViewCallbacks,
    initial?: Partial<ChartSpec>,
  ) {
    for (const t of TYPES) {
      const b = document.createElement('button');
      b.textContent = t.label;
      b.title = t.title;
      b.dataset.type = t.id;
      b.setAttribute('role', 'tab');
      b.addEventListener('click', () => this.setType(t.id, true));
      this.types.append(b);
    }
    this.x.value = initial?.x ?? '';
    this.y.value = initial?.y ?? '';
    this.series.value = initial?.series ?? '';
    this.agg.value = initial?.agg ?? 'count';
    this.unit.value = initial?.dateUnit ?? '';
    this.setType(initial?.type ?? 'bar', false);
    if (initial?.limit) this.limit.value = String(initial.limit);

    for (const input of [this.x, this.y, this.series, this.limit]) {
      input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
          e.preventDefault();
          this.cb.draw();
        }
      });
      input.addEventListener('focus', () => this.suggest());
    }
    // Choosing a suggestion fires `change` (typing fires `input`): draw right away.
    for (const input of [this.x, this.y, this.series]) input.addEventListener('change', () => this.redrawIfReady());
    this.agg.addEventListener('change', () => {
      this.updateFields();
      this.redrawIfReady();
    });
    this.unit.addEventListener('change', () => this.redrawIfReady());
    el('chartDraw').addEventListener('click', () => this.cb.draw());
    el('chartCode').addEventListener('click', () => this.cb.code());
    el('chartPng').addEventListener('click', () => {
      if (this.chart) this.cb.savePng(this.chart.toBase64Image('image/png', 1));
    });
    this.updateButtons();
  }

  spec(): ChartSpec {
    return {
      type: this.type,
      x: this.x.value.trim(),
      y: this.y.value.trim(),
      agg: this.agg.value as ChartAgg,
      series: this.series.value.trim(),
      dateUnit: this.unit.value as DateUnit,
      limit: Number(this.limit.value),
    };
  }

  /** The spec to draw, or undefined after showing what is missing. */
  validSpec(): ChartSpec | undefined {
    const spec = normalizeSpec(this.spec());
    const error = specError(spec);
    for (const [input, bad] of [
      [this.x, /field to measure|x axis|categories/.test(error ?? '')],
      [this.y, /y axis|field to (sum|average|min|max)/.test(error ?? '')],
      [this.series, /series/.test(error ?? '')],
      [this.limit, /must be from/.test(error ?? '')],
    ] as const)
      input.classList.toggle('invalid', bad);
    if (error) {
      this.cb.error(error);
      return undefined;
    }
    this.cb.changed(this.spec());
    return spec;
  }

  /** No field chosen yet: say what to do instead of reporting an error. */
  needsFields(): boolean {
    if (this.x.value.trim() || this.chart) return false;
    this.empty.textContent = 'Choose the fields of the chart, then Draw.';
    this.empty.classList.remove('hidden');
    this.x.classList.remove('invalid');
    return true;
  }

  loading(): void {
    this.canvas.classList.add('stale');
  }

  /** Output of the chart stages for `spec`. */
  async show(spec: ChartSpec, rows: unknown[], durationMs: number, filterable: boolean): Promise<void> {
    this.canvas.classList.remove('stale');
    const data = toChartData(spec, rows);
    this.filterable = filterable;
    const count = data.kind === 'scatter' ? data.points.reduce((n, g) => n + g.points.length, 0) : data.labels.length;
    if (!count) {
      this.destroy();
      this.drawn = undefined;
      this.empty.textContent = this.emptyMessage(spec);
      this.empty.classList.remove('hidden');
      this.info.textContent = `${durationMs} ms`;
      this.updateButtons();
      return;
    }
    this.empty.classList.add('hidden');
    this.info.textContent = [this.describe(spec, data, rows, count), data.note, `${durationMs} ms`].filter(Boolean).join(' · ');
    let Chart: ChartClass;
    try {
      Chart = await loadChartJs();
    } catch (err) {
      this.cb.error((err as Error).message);
      return;
    }
    this.destroy();
    this.drawn = { spec, data };
    this.chart = new Chart(this.canvas, this.config(spec, data));
    this.updateButtons();
  }

  /** The request failed: the previous chart stays, dimmed. */
  showError(): void {
    this.canvas.classList.add('stale');
  }

  /** The chart's image size follows its pane: redraw when the tab is shown again. */
  resize(): void {
    this.chart?.resize();
  }

  private setType(type: ChartType, redraw: boolean): void {
    const previous = this.type;
    this.type = type;
    for (const b of this.types.querySelectorAll<HTMLElement>('button')) b.setAttribute('aria-selected', String(b.dataset.type === type));
    // Keep a limit the user chose, unless it doesn't fit the new type.
    const current = Number(this.limit.value);
    if (!current || current === CHART_LIMITS[previous].default || current > CHART_LIMITS[type].max) this.limit.value = String(CHART_LIMITS[type].default);
    this.limit.max = String(CHART_LIMITS[type].max);
    this.updateFields();
    if (redraw) this.redrawIfReady();
  }

  /** Inputs and labels that make sense for the chart type. */
  private updateFields(): void {
    const t = this.type;
    const category = t === 'bar' || t === 'line' || t === 'pie';
    el('chartXLabel').textContent = category ? 'Category' : t === 'scatter' ? 'X' : 'Field';
    this.x.title = category
      ? 'The field whose values are the categories (each element for arrays)'
      : t === 'scatter'
        ? 'A number or date field for the x axis'
        : 'The number or date field whose distribution is shown';
    const show = (node: HTMLElement, visible: boolean) => node.classList.toggle('hidden', !visible);
    show(this.unit, t === 'bar' || t === 'line');
    show(el('chartAggLabel'), category);
    show(this.agg, category);
    show(el('chartYLabel'), t === 'scatter');
    show(this.y, t === 'scatter' || (category && this.agg.value !== 'count'));
    this.y.title = t === 'scatter' ? 'A number or date field for the y axis' : 'The number field to aggregate';
    show(el('chartSeriesLabel'), t !== 'pie' && t !== 'histogram');
    show(this.series, t !== 'pie' && t !== 'histogram');
    el('chartLimitLabel').textContent = CHART_LIMITS[t].label;
    this.limit.title = {
      bar: 'The categories with the largest values',
      pie: 'The categories with the largest values',
      line: 'The first points along the category',
      scatter: 'Documents in the random sample',
      histogram: 'Number of bins',
    }[t];
  }

  private redrawIfReady(): void {
    if (!specError(this.spec())) this.cb.draw();
  }

  private suggest(): void {
    const fields = this.cb.fields();
    if (this.fieldList.childElementCount === fields.length) return;
    this.fieldList.replaceChildren(
      ...fields.map((f) => {
        const o = document.createElement('option');
        o.value = f;
        return o;
      }),
    );
  }

  private updateButtons(): void {
    (el('chartPng') as HTMLButtonElement).disabled = !this.chart;
  }

  private destroy(): void {
    this.chart?.destroy();
    this.chart = undefined;
  }

  private emptyMessage(spec: ChartSpec): string {
    if (spec.type === 'scatter') return `No documents have numbers or dates in both ${spec.x} and ${spec.y}.`;
    if (spec.type === 'histogram') return `No documents have a number or a date in ${spec.x}.`;
    return 'No documents to chart.';
  }

  private describe(spec: ChartSpec, data: ChartData, rows: unknown[], count: number): string {
    switch (spec.type) {
      case 'scatter':
        return `${count.toLocaleString('en-US')} ${count === spec.limit ? 'sampled ' : ''}documents`;
      case 'histogram': {
        const total = data.series[0]?.values.reduce<number>((a, b) => a + (b ?? 0), 0) ?? 0;
        return `${total.toLocaleString('en-US')} documents in ${data.labels.length} bin${data.labels.length === 1 ? '' : 's'}`;
      }
      case 'line':
        return `${count.toLocaleString('en-US')} points${rows.length === spec.limit ? ` (the first ${spec.limit})` : ''}`;
      default:
        return `${count.toLocaleString('en-US')} categor${count === 1 ? 'y' : 'ies'}${rows.length === spec.limit ? ` (the top ${spec.limit})` : ''}`;
    }
  }

  private config(spec: ChartSpec, data: ChartData): ChartConfiguration {
    const fg = cssVar('--vscode-charts-foreground', cssVar('--vscode-foreground', '#cccccc'));
    const lines = cssVar('--vscode-charts-lines', 'rgba(128, 128, 128, 0.3)');
    const bg = cssVar('--vscode-editor-background', '#1e1e1e');
    const color = (i: number) => cssVar(...PALETTE[i % PALETTE.length]);
    const font = { family: cssVar('--vscode-font-family', 'sans-serif') };
    const background: Plugin = {
      id: 'background',
      beforeDraw: (chart) => {
        const { ctx } = chart;
        ctx.save();
        ctx.fillStyle = bg;
        ctx.fillRect(0, 0, chart.width, chart.height);
        ctx.restore();
      },
    };
    const many = data.series.length > 1;
    const clickable = this.filterable && spec.type !== 'scatter';
    const onClick = (_: ChartEvent, elements: ActiveElement[]) => {
      const hit = elements[0];
      if (!hit || !clickable) return;
      this.click(spec, data, hit.index, hit.datasetIndex);
    };
    const onHover = (_: ChartEvent, elements: ActiveElement[]) => {
      this.canvas.style.cursor = clickable && elements.length ? 'pointer' : '';
    };
    const footer = () => (clickable ? 'Click to show the documents' : '');
    const base = {
      responsive: true,
      maintainAspectRatio: false,
      animation: { duration: 250 },
      locale: 'en-US',
      color: fg,
      borderColor: lines,
      font,
      onClick,
      onHover,
    };
    const axis = (title: string, dates = false) => ({
      grid: { color: lines },
      ticks: { color: fg, font, ...(dates && { callback: (v: number | string) => formatDate(Number(v)) }) },
      title: { display: !!title, text: title, color: fg, font },
    });
    const measure = spec.agg === 'count' ? 'documents' : `${spec.agg} of ${spec.y}`;

    if (spec.type === 'pie') {
      const series = data.series[0];
      return {
        type: 'pie',
        data: {
          labels: data.labels,
          datasets: [{ label: measure, data: series.values, backgroundColor: data.labels.map((_, i) => color(i)), borderColor: bg, borderWidth: 1 }],
        },
        options: {
          ...base,
          plugins: {
            legend: { position: 'right', labels: { color: fg, font } },
            tooltip: {
              callbacks: {
                label: (item: TooltipItem<'pie'>) => {
                  const total = (item.dataset.data as number[]).reduce((a, b) => a + (b ?? 0), 0);
                  return ` ${item.formattedValue} (${total ? ((Number(item.raw) / total) * 100).toFixed(1) : 0}%)`;
                },
                footer,
              },
            },
          },
        },
        plugins: [background],
      } as ChartConfiguration;
    }

    if (data.kind === 'scatter') {
      const fmt = (v: number, dates: boolean) => (dates ? formatDate(v) : v.toLocaleString('en-US'));
      return {
        type: 'scatter',
        data: {
          datasets: data.points.map((g, i) => ({
            label: g.name,
            data: g.points,
            backgroundColor: alpha(color(i), 0.6),
            borderColor: color(i),
            pointRadius: g.points.length > 2000 ? 2 : 3,
          })),
        },
        options: {
          ...base,
          scales: { x: axis(spec.x, data.xDates), y: axis(spec.y, data.yDates) },
          plugins: {
            legend: { display: data.points.length > 1, labels: { color: fg, font } },
            tooltip: {
              callbacks: {
                label: (item: TooltipItem<'scatter'>) => {
                  const p = item.raw as { x: number; y: number };
                  return ` ${data.points.length > 1 ? `${item.dataset.label}: ` : ''}${spec.x} ${fmt(p.x, data.xDates)}, ${spec.y} ${fmt(p.y, data.yDates)}`;
                },
              },
            },
          },
        },
        plugins: [background],
      } as ChartConfiguration;
    }

    const histogram = spec.type === 'histogram';
    const line = spec.type === 'line';
    return {
      type: line ? 'line' : 'bar',
      data: {
        labels: data.labels,
        datasets: data.series.map((s, i) => ({
          label: s.name,
          data: s.values,
          backgroundColor: line ? alpha(color(i), 0.2) : color(i),
          borderColor: line ? color(i) : bg,
          borderWidth: line ? 2 : histogram ? 1 : 0,
          ...(line && { pointRadius: data.labels.length > 100 ? 0 : 3, tension: 0.2, spanGaps: true, fill: !many }),
          ...(histogram && { barPercentage: 1, categoryPercentage: 1 }),
        })),
      },
      options: {
        ...base,
        interaction: { mode: line ? 'index' : 'nearest', intersect: !line },
        scales: {
          x: axis(histogram ? spec.x : spec.dateUnit ? `${spec.x} (${spec.dateUnit})` : spec.x),
          y: { ...axis(many ? measure : histogram ? 'documents' : measure), beginAtZero: true },
        },
        plugins: {
          legend: { display: many, labels: { color: fg, font } },
          tooltip: { callbacks: { footer } },
        },
      },
      plugins: [background],
    } as ChartConfiguration;
  }

  private click(spec: ChartSpec, data: ChartData, index: number, datasetIndex: number): void {
    const conditions: { field: string; value: unknown }[] = [];
    const key = data.keys[index];
    if (key === undefined) return;
    conditions.push({ field: spec.x, value: key });
    const series = data.series[datasetIndex];
    if (spec.series && spec.type !== 'pie' && spec.type !== 'histogram' && data.series.length && series)
      conditions.push({ field: spec.series, value: series.key ?? null });
    this.cb.filter(conditions);
  }
}
