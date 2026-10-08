// Charts of query or pipeline results: the aggregation stages that compute them on the server (appended to
// the filter or the pipeline), and the conversion of their output into labels and series to draw.
import { isEjsonWrapper, isPlainObject, toShell } from './query';

export type ChartType = 'bar' | 'line' | 'pie' | 'scatter' | 'histogram';
export type ChartAgg = 'count' | 'sum' | 'avg' | 'min' | 'max';
export type DateUnit = '' | 'hour' | 'day' | 'week' | 'month' | 'year';

export interface ChartSpec {
  type: ChartType;
  /** Category (bar, line, pie), x axis (scatter) or the measured field (histogram). */
  x: string;
  /** Measured field of sum/avg/min/max (bar, line, pie), or the y axis (scatter). */
  y: string;
  agg: ChartAgg;
  /** Field splitting the data into series (bar, line, scatter); empty for none. */
  series: string;
  /** Dates of the category grouped by this unit (bar, line). */
  dateUnit: DateUnit;
  /** Most categories (bar, pie), points (line), sampled documents (scatter) or bins (histogram). */
  limit: number;
}

export const CHART_LIMITS: Record<ChartType, { default: number; max: number; label: string }> = {
  bar: { default: 20, max: 500, label: 'Top' },
  pie: { default: 10, max: 50, label: 'Top' },
  line: { default: 500, max: 5000, label: 'Points' },
  scatter: { default: 1000, max: 20000, label: 'Sample' },
  histogram: { default: 20, max: 200, label: 'Bins' },
};

/** Series beyond this many are left out of the chart. */
export const MAX_SERIES = 12;

const ref = (path: string) => `$${path.trim()}`;

/** The spec without what its type doesn't use (fields left in hidden inputs). */
export function normalizeSpec(spec: ChartSpec): ChartSpec {
  const category = spec.type === 'bar' || spec.type === 'line' || spec.type === 'pie';
  return {
    type: spec.type,
    x: spec.x.trim(),
    y: spec.type === 'scatter' || (category && spec.agg !== 'count') ? spec.y.trim() : '',
    agg: category ? spec.agg : 'count',
    series: spec.type === 'pie' || spec.type === 'histogram' ? '' : spec.series.trim(),
    dateUnit: spec.type === 'bar' || spec.type === 'line' ? spec.dateUnit : '',
    limit: spec.limit,
  };
}

/** What is wrong with the spec, if anything. */
export function specError(spec: ChartSpec): string | undefined {
  const field = (v: string) => /^[^$\s][^\s]*$/.test(v.trim());
  if (!field(spec.x)) return spec.type === 'histogram' ? 'Choose the field to measure' : spec.type === 'scatter' ? 'Choose the field of the x axis' : 'Choose the field of the categories';
  if (spec.type === 'scatter' && !field(spec.y)) return 'Choose the field of the y axis';
  if ((spec.type === 'bar' || spec.type === 'line' || spec.type === 'pie') && spec.agg !== 'count' && !field(spec.y)) return `Choose the field to ${spec.agg === 'avg' ? 'average' : spec.agg}`;
  if (spec.series.trim() && !field(spec.series)) return 'The series field is not valid';
  if (!Number.isInteger(spec.limit) || spec.limit < 1 || spec.limit > CHART_LIMITS[spec.type].max) return `${CHART_LIMITS[spec.type].label} must be from 1 to ${CHART_LIMITS[spec.type].max}`;
  return undefined;
}

/** Stages appended to the query (as a $match) or to the pipeline. Plain values, valid as BSON and as relaxed EJSON. */
export function chartStages(spec: ChartSpec): Record<string, unknown>[] {
  const series = spec.series.trim() && spec.type !== 'pie' ? ref(spec.series) : undefined;
  switch (spec.type) {
    case 'bar':
    case 'line':
    case 'pie': {
      const x = spec.dateUnit ? { $dateTrunc: { date: ref(spec.x), unit: spec.dateUnit } } : ref(spec.x);
      const value = spec.agg === 'count' ? { $sum: 1 } : { [`$${spec.agg}`]: ref(spec.y) };
      return [
        // Arrays count once per element (tags, categories…); other values are unchanged.
        { $unwind: { path: ref(spec.x), preserveNullAndEmptyArrays: true } },
        { $group: { _id: series ? { x, s: series } : { x }, v: value } },
        { $group: { _id: '$_id.x', total: { $sum: '$v' }, items: { $push: { s: '$_id.s', v: '$v' } } } },
        { $sort: spec.type === 'line' ? { _id: 1 } : { total: -1, _id: 1 } },
        { $limit: spec.limit },
        // Grouped dates: the largest periods, in time order.
        ...(spec.type === 'bar' && spec.dateUnit ? [{ $sort: { _id: 1 } }] : []),
      ];
    }
    case 'scatter': {
      const match: Record<string, unknown> = { [spec.x.trim()]: { $type: ['number', 'date'] }, [spec.y.trim()]: { $type: ['number', 'date'] } };
      return [
        { $match: match },
        { $sample: { size: spec.limit } },
        { $project: { _id: 0, x: ref(spec.x), y: ref(spec.y), ...(series && { s: series }) } },
      ];
    }
    case 'histogram': {
      const bins = spec.limit;
      const v = '$v';
      return [
        { $match: { [spec.x.trim()]: { $type: ['number', 'date'] } } },
        // Dates as milliseconds, so numbers and dates share one scale.
        { $project: { _id: 0, v: { $toDouble: ref(spec.x) }, d: { $eq: [{ $type: ref(spec.x) }, 'date'] } } },
        { $setWindowFields: { output: { min: { $min: v }, max: { $max: v } } } },
        {
          $group: {
            _id: {
              $min: [bins - 1, { $floor: { $multiply: [{ $divide: [{ $subtract: [v, '$min'] }, { $max: [{ $subtract: ['$max', '$min'] }, 1e-300] }] }, bins] } }],
            },
            count: { $sum: 1 },
            min: { $first: '$min' },
            max: { $first: '$max' },
            dates: { $max: '$d' },
          },
        },
        { $sort: { _id: 1 } },
      ];
    }
  }
}

// ---------------------------------------------------------------------------
// Results → chart data

export interface CategorySeries {
  name: string;
  /** Raw series value, for the filter of a click. */
  key: unknown;
  values: (number | null)[];
}

export interface ChartData {
  kind: 'category' | 'scatter';
  /** Category labels (bar, line, pie, histogram). */
  labels: string[];
  /** Filter condition on the category field of each label (relaxed EJSON), undefined when there is none. */
  keys: unknown[];
  series: CategorySeries[];
  points: { name: string; key: unknown; points: { x: number; y: number }[] }[];
  xDates: boolean;
  yDates: boolean;
  /** Something left out or worth knowing, e.g. series not shown. */
  note?: string;
}

/** A number from a relaxed-EJSON value (numbers, number wrappers, dates as milliseconds), or NaN. */
export function toNumber(v: unknown): number {
  if (typeof v === 'number') return v;
  if (isEjsonWrapper(v)) {
    const [key] = Object.keys(v);
    const val = v[key] as any;
    if (key === '$date') return typeof val === 'string' ? Date.parse(val) : Number(val?.$numberLong ?? val);
    if (['$numberLong', '$numberDecimal', '$numberDouble', '$numberInt'].includes(key)) return Number(val);
  }
  return NaN;
}

const isDate = (v: unknown) => isEjsonWrapper(v) && Object.keys(v)[0] === '$date';

export function formatDate(ms: number, unit: DateUnit | 'auto' = 'auto'): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return String(ms);
  const iso = d.toISOString();
  switch (unit) {
    case 'year':
      return iso.slice(0, 4);
    case 'month':
      return iso.slice(0, 7);
    case 'week':
    case 'day':
      return iso.slice(0, 10);
    case 'hour':
      return `${iso.slice(0, 10)} ${iso.slice(11, 16)}`;
    default:
      return iso.endsWith('T00:00:00.000Z') ? iso.slice(0, 10) : iso.replace('T', ' ').replace(/:00\.000Z$|\.000Z$/, '').replace(/Z$/, '');
  }
}

/** A category or series value as a label. */
export function formatLabel(v: unknown, unit: DateUnit = ''): string {
  if (v === null || v === undefined) return '(none)';
  if (typeof v === 'string') return v || '(empty)';
  if (isDate(v)) return formatDate(toNumber(v), unit || 'auto');
  if (isPlainObject(v) && !isEjsonWrapper(v) && !Object.keys(v).length) return '{}';
  return toShell(v);
}

/** The dates of a $dateTrunc group (UTC, weeks from Sunday): { $gte: start, $lt: next start }. */
export function dateRange(start: unknown, unit: Exclude<DateUnit, ''>): unknown {
  const ms = toNumber(start);
  if (!isDate(start) || !Number.isFinite(ms)) return start ?? null;
  const d = new Date(ms);
  const next =
    unit === 'year'
      ? Date.UTC(d.getUTCFullYear() + 1, 0, 1)
      : unit === 'month'
        ? Date.UTC(d.getUTCFullYear(), d.getUTCMonth() + 1, 1)
        : ms + { hour: 3600e3, day: 86400e3, week: 7 * 86400e3 }[unit];
  return { $gte: { $date: d.toISOString() }, $lt: { $date: new Date(next).toISOString() } };
}

function formatNumber(n: number): string {
  if (!Number.isFinite(n)) return String(n);
  const abs = Math.abs(n);
  if (abs !== 0 && (abs >= 1e9 || abs < 1e-3)) return n.toExponential(2);
  return Number(n.toPrecision(4)).toLocaleString('en-US');
}

export function toChartData(spec: ChartSpec, rows: unknown[]): ChartData {
  const data: ChartData = { kind: 'category', labels: [], keys: [], series: [], points: [], xDates: false, yDates: false };
  const docs = rows.filter(isPlainObject);

  if (spec.type === 'histogram') {
    const first = docs[0];
    if (!first) return data;
    const min = toNumber(first.min);
    const max = toNumber(first.max);
    const bins = spec.limit;
    const width = (max - min) / bins;
    const counts = new Array<number>(bins).fill(0);
    for (const d of docs) {
      const bin = toNumber(d._id);
      if (bin >= 0 && bin < bins) counts[bin] = toNumber(d.count);
    }
    const dates = first.dates === true;
    // Bins of a day or more don't need the time of day.
    const label = (n: number) => (dates ? formatDate(n, width >= 86400e3 ? 'day' : 'hour') : formatNumber(n));
    const value = (n: number) => (dates ? { $date: new Date(n).toISOString() } : n);
    data.xDates = dates;
    data.series = [{ name: 'documents', key: undefined, values: counts }];
    if (!width) {
      data.labels = [label(min)];
      data.keys = [value(min)];
      data.series[0].values = [counts.reduce((a, b) => a + b, 0)];
      return data;
    }
    data.labels = counts.map((_, i) => `${label(min + i * width)} – ${label(i === bins - 1 ? max : min + (i + 1) * width)}`);
    data.keys = counts.map((_, i) =>
      i === bins - 1 ? { $gte: value(min + i * width), $lte: value(max) } : { $gte: value(min + i * width), $lt: value(min + (i + 1) * width) },
    );
    return data;
  }

  if (spec.type === 'scatter') {
    data.kind = 'scatter';
    const groups = new Map<string, { name: string; key: unknown; points: { x: number; y: number }[] }>();
    for (const d of docs) {
      const x = toNumber(d.x);
      const y = toNumber(d.y);
      if (!Number.isFinite(x) || !Number.isFinite(y)) continue;
      data.xDates ||= isDate(d.x);
      data.yDates ||= isDate(d.y);
      const name = spec.series.trim() ? formatLabel(d.s) : spec.y.trim();
      let g = groups.get(name);
      if (!g) groups.set(name, (g = { name, key: d.s, points: [] }));
      g.points.push({ x, y });
    }
    const all = [...groups.values()].sort((a, b) => b.points.length - a.points.length);
    data.points = all.slice(0, MAX_SERIES);
    if (all.length > MAX_SERIES) data.note = `${all.length - MAX_SERIES} more series not shown (the ${MAX_SERIES} largest are).`;
    return data;
  }

  // bar, line, pie: { _id: category, total, items: [{ s, v }] }
  const seriesTotals = new Map<string, { key: unknown; total: number }>();
  const byCategory: Map<string, number>[] = [];
  for (const d of docs) {
    data.labels.push(formatLabel(d._id, spec.dateUnit));
    data.keys.push(spec.dateUnit ? dateRange(d._id, spec.dateUnit) : d._id ?? null);
    data.xDates ||= isDate(d._id);
    const values = new Map<string, number>();
    for (const item of Array.isArray(d.items) ? d.items : []) {
      if (!isPlainObject(item)) continue;
      const name = spec.series.trim() && spec.type !== 'pie' ? formatLabel(item.s) : '';
      const v = toNumber(item.v);
      if (!Number.isFinite(v)) continue;
      values.set(name, v);
      const t = seriesTotals.get(name) ?? { key: item.s, total: 0 };
      t.total += Math.abs(v);
      seriesTotals.set(name, t);
    }
    byCategory.push(values);
  }
  const names = [...seriesTotals.entries()].sort((a, b) => b[1].total - a[1].total);
  const shown = names.slice(0, MAX_SERIES);
  if (names.length > MAX_SERIES) data.note = `${names.length - MAX_SERIES} more series not shown (the ${MAX_SERIES} largest are).`;
  const measure = spec.agg === 'count' ? 'documents' : `${spec.agg} of ${spec.y.trim()}`;
  data.series = (shown.length ? shown : [['', { key: undefined, total: 0 }] as const]).map(([name, { key }]) => ({
    name: name || measure,
    key,
    values: byCategory.map((m) => m.get(name) ?? (spec.type === 'line' ? null : 0)),
  }));
  return data;
}
