import { describe, expect, it } from 'vitest';
import {
  CHART_LIMITS,
  ChartSpec,
  MAX_SERIES,
  chartStages,
  dateRange,
  formatDate,
  formatLabel,
  normalizeSpec,
  specError,
  toChartData,
  toNumber,
} from '../../src/shared/chart';

const spec = (s: Partial<ChartSpec>): ChartSpec => ({ type: 'bar', x: 'status', y: '', agg: 'count', series: '', dateUnit: '', limit: 20, ...s });

describe('normalizeSpec', () => {
  it('drops what the chart type does not use', () => {
    expect(normalizeSpec(spec({ type: 'pie', x: ' a ', y: 'b', agg: 'count', series: 's', dateUnit: 'day' }))).toEqual({
      type: 'pie',
      x: 'a',
      y: '',
      agg: 'count',
      series: '',
      dateUnit: '',
      limit: 20,
    });
    expect(normalizeSpec(spec({ type: 'bar', y: ' n ', agg: 'sum', series: ' s ' }))).toMatchObject({ y: 'n', agg: 'sum', series: 's' });
    expect(normalizeSpec(spec({ type: 'scatter', y: 'n', agg: 'sum', dateUnit: 'day' }))).toMatchObject({ y: 'n', agg: 'count', dateUnit: '' });
    expect(normalizeSpec(spec({ type: 'histogram', y: 'n', series: 's' }))).toMatchObject({ y: '', series: '' });
  });
});

describe('specError', () => {
  it('accepts a complete spec', () => {
    expect(specError(spec({}))).toBeUndefined();
    expect(specError(spec({ type: 'scatter', x: 'a', y: 'b', limit: 1000 }))).toBeUndefined();
  });

  it('asks for the fields each type needs', () => {
    expect(specError(spec({ x: '' }))).toBe('Choose the field of the categories');
    expect(specError(spec({ type: 'histogram', x: ' ' }))).toBe('Choose the field to measure');
    expect(specError(spec({ type: 'scatter', y: '' }))).toBe('Choose the field of the y axis');
    expect(specError(spec({ agg: 'avg', y: '' }))).toBe('Choose the field to average');
    expect(specError(spec({ agg: 'sum', y: '' }))).toBe('Choose the field to sum');
  });

  it('rejects field references and bad series', () => {
    expect(specError(spec({ x: '$status' }))).toBe('Choose the field of the categories');
    expect(specError(spec({ series: 'a b' }))).toBe('The series field is not valid');
  });

  it('checks the limit against the type’s maximum', () => {
    expect(specError(spec({ limit: 0 }))).toBe('Top must be from 1 to 500');
    expect(specError(spec({ limit: 1.5 }))).toBe('Top must be from 1 to 500');
    expect(specError(spec({ type: 'pie', limit: CHART_LIMITS.pie.max + 1 }))).toBe('Top must be from 1 to 50');
    expect(specError(spec({ type: 'histogram', limit: 201 }))).toBe('Bins must be from 1 to 200');
  });
});

describe('chartStages', () => {
  it('bar: unwinds arrays, groups by category (and series), keeps the top categories', () => {
    const stages = chartStages(spec({ x: 'tags', limit: 5 }));
    expect(stages).toEqual([
      { $unwind: { path: '$tags', preserveNullAndEmptyArrays: true } },
      { $group: { _id: { x: '$tags' }, v: { $sum: 1 } } },
      { $group: { _id: '$_id.x', total: { $sum: '$v' }, items: { $push: { s: '$_id.s', v: '$v' } } } },
      { $sort: { total: -1, _id: 1 } },
      { $limit: 5 },
    ]);
    const withSeries = chartStages(spec({ agg: 'avg', y: 'price', series: 'kind' }));
    expect(withSeries[1]).toEqual({ $group: { _id: { x: '$status', s: '$kind' }, v: { $avg: '$price' } } });
  });

  it('pie ignores the series; line sorts by category', () => {
    expect(chartStages(spec({ type: 'pie', series: 'kind' }))[1]).toEqual({ $group: { _id: { x: '$status' }, v: { $sum: 1 } } });
    expect(chartStages(spec({ type: 'line' }))[3]).toEqual({ $sort: { _id: 1 } });
  });

  it('groups dates by unit; bars of periods end in time order', () => {
    const stages = chartStages(spec({ x: 'at', dateUnit: 'month' }));
    expect(stages[1]).toEqual({ $group: { _id: { x: { $dateTrunc: { date: '$at', unit: 'month' } } }, v: { $sum: 1 } } });
    expect(stages[stages.length - 1]).toEqual({ $sort: { _id: 1 } });
  });

  it('scatter samples documents with numbers or dates on both axes', () => {
    expect(chartStages(spec({ type: 'scatter', x: 'a', y: 'b', series: 's', limit: 100 }))).toEqual([
      { $match: { a: { $type: ['number', 'date'] }, b: { $type: ['number', 'date'] } } },
      { $sample: { size: 100 } },
      { $project: { _id: 0, x: '$a', y: '$b', s: '$s' } },
    ]);
  });

  it('histogram computes as many bins as the limit', () => {
    const stages = chartStages(spec({ type: 'histogram', x: 'n', limit: 7 }));
    expect(stages[0]).toEqual({ $match: { n: { $type: ['number', 'date'] } } });
    const group = stages[3].$group as { _id: { $min: unknown[] } };
    expect(group._id.$min[0]).toBe(6);
    expect(stages[stages.length - 1]).toEqual({ $sort: { _id: 1 } });
  });
});

describe('values and labels', () => {
  it('toNumber reads numbers, number wrappers and dates', () => {
    expect(toNumber(3)).toBe(3);
    expect(toNumber({ $numberLong: '12' })).toBe(12);
    expect(toNumber({ $numberDecimal: '1.5' })).toBe(1.5);
    expect(toNumber({ $date: '1970-01-01T00:00:01.000Z' })).toBe(1000);
    expect(toNumber({ $date: { $numberLong: '5' } })).toBe(5);
    expect(toNumber('3')).toBeNaN();
    expect(toNumber({ a: 1 })).toBeNaN();
  });

  it('formatDate drops what the unit does not need', () => {
    const ms = Date.UTC(2024, 4, 6, 7, 8, 9);
    expect(formatDate(ms, 'year')).toBe('2024');
    expect(formatDate(ms, 'month')).toBe('2024-05');
    expect(formatDate(ms, 'day')).toBe('2024-05-06');
    expect(formatDate(ms, 'hour')).toBe('2024-05-06 07:08');
    expect(formatDate(ms)).toBe('2024-05-06 07:08:09');
    expect(formatDate(Date.UTC(2024, 4, 6))).toBe('2024-05-06');
    expect(formatDate(Date.UTC(2024, 4, 6, 7, 8))).toBe('2024-05-06 07:08');
    expect(formatDate(NaN)).toBe('NaN');
  });

  it('formatLabel names missing and empty values', () => {
    expect(formatLabel(null)).toBe('(none)');
    expect(formatLabel(undefined)).toBe('(none)');
    expect(formatLabel('')).toBe('(empty)');
    expect(formatLabel({})).toBe('{}');
    expect(formatLabel(true)).toBe('true');
    expect(formatLabel({ $oid: '64b000000000000000000001' })).toBe('ObjectId("64b000000000000000000001")');
    expect(formatLabel({ $date: '2024-05-01T00:00:00.000Z' }, 'month')).toBe('2024-05');
  });

  it('dateRange covers one period, rolling over months and years', () => {
    expect(dateRange({ $date: '2024-12-01T00:00:00.000Z' }, 'month')).toEqual({
      $gte: { $date: '2024-12-01T00:00:00.000Z' },
      $lt: { $date: '2025-01-01T00:00:00.000Z' },
    });
    expect(dateRange({ $date: '2024-01-01T00:00:00.000Z' }, 'year')).toEqual({
      $gte: { $date: '2024-01-01T00:00:00.000Z' },
      $lt: { $date: '2025-01-01T00:00:00.000Z' },
    });
    expect(dateRange({ $date: '2024-03-10T00:00:00.000Z' }, 'week')).toEqual({
      $gte: { $date: '2024-03-10T00:00:00.000Z' },
      $lt: { $date: '2024-03-17T00:00:00.000Z' },
    });
    // Not a date: the value itself.
    expect(dateRange('x', 'day')).toBe('x');
    expect(dateRange(undefined, 'day')).toBeNull();
  });
});

describe('toChartData: categories', () => {
  it('makes one series of counts without a series field', () => {
    const data = toChartData(spec({}), [
      { _id: 'a', total: 3, items: [{ v: 3 }] },
      { _id: null, total: 1, items: [{ v: 1 }] },
    ]);
    expect(data).toMatchObject({ kind: 'category', labels: ['a', '(none)'], keys: ['a', null] });
    expect(data.series).toEqual([{ name: 'documents', key: undefined, values: [3, 1] }]);
  });

  it('names the measure of an aggregate', () => {
    const data = toChartData(spec({ agg: 'avg', y: 'price' }), [{ _id: 'a', items: [{ v: 2.5 }] }]);
    expect(data.series[0].name).toBe('avg of price');
  });

  it('orders series by their total; missing values are 0 for bars and gaps for lines', () => {
    const rows = [
      { _id: 'a', items: [{ s: 'x', v: 1 }, { s: 'y', v: 5 }] },
      { _id: 'b', items: [{ s: 'y', v: 2 }] },
    ];
    const bar = toChartData(spec({ series: 'kind' }), rows);
    expect(bar.series).toEqual([
      { name: 'y', key: 'y', values: [5, 2] },
      { name: 'x', key: 'x', values: [1, 0] },
    ]);
    const line = toChartData(spec({ type: 'line', series: 'kind' }), rows);
    expect(line.series[1].values).toEqual([1, null]);
  });

  it(`keeps the ${MAX_SERIES} largest series and says so`, () => {
    const items = Array.from({ length: MAX_SERIES + 3 }, (_, i) => ({ s: `s${i}`, v: i + 1 }));
    const data = toChartData(spec({ series: 'kind' }), [{ _id: 'a', items }]);
    expect(data.series).toHaveLength(MAX_SERIES);
    expect(data.series[0].name).toBe(`s${MAX_SERIES + 2}`);
    expect(data.note).toBe(`3 more series not shown (the ${MAX_SERIES} largest are).`);
  });

  it('labels grouped dates by unit, with a date range as the key', () => {
    const data = toChartData(spec({ x: 'at', dateUnit: 'month' }), [{ _id: { $date: '2024-02-01T00:00:00.000Z' }, items: [{ v: 1 }] }]);
    expect(data.labels).toEqual(['2024-02']);
    expect(data.xDates).toBe(true);
    expect(data.keys[0]).toEqual({ $gte: { $date: '2024-02-01T00:00:00.000Z' }, $lt: { $date: '2024-03-01T00:00:00.000Z' } });
  });

  it('skips non-numeric values and non-document rows', () => {
    const data = toChartData(spec({}), [{ _id: 'a', items: [{ v: 'x' }, 'junk'] }, 'junk', 3]);
    expect(data.labels).toEqual(['a']);
    expect(data.series).toEqual([{ name: 'documents', key: undefined, values: [0] }]);
  });
});

describe('toChartData: histogram', () => {
  it('labels the bins and gives each a range, the last one closed', () => {
    const data = toChartData(spec({ type: 'histogram', x: 'n', limit: 4 }), [
      { _id: 0, count: 2, min: 0, max: 8, dates: false },
      { _id: 3, count: 5, min: 0, max: 8, dates: false },
    ]);
    expect(data.labels).toEqual(['0 – 2', '2 – 4', '4 – 6', '6 – 8']);
    expect(data.series[0].values).toEqual([2, 0, 0, 5]);
    expect(data.keys[0]).toEqual({ $gte: 0, $lt: 2 });
    expect(data.keys[3]).toEqual({ $gte: 6, $lte: 8 });
  });

  it('is one bar when every value is the same', () => {
    const data = toChartData(spec({ type: 'histogram', x: 'n', limit: 4 }), [{ _id: 0, count: 9, min: 5, max: 5, dates: false }]);
    expect(data.labels).toEqual(['5']);
    expect(data.keys).toEqual([5]);
    expect(data.series[0].values).toEqual([9]);
  });

  it('uses dates for date fields', () => {
    const min = Date.UTC(2024, 0, 1);
    const data = toChartData(spec({ type: 'histogram', x: 'at', limit: 2 }), [{ _id: 1, count: 1, min, max: min + 4 * 86400e3, dates: true }]);
    expect(data.xDates).toBe(true);
    expect(data.labels).toEqual(['2024-01-01 – 2024-01-03', '2024-01-03 – 2024-01-05']);
    expect(data.keys[0]).toEqual({ $gte: { $date: '2024-01-01T00:00:00.000Z' }, $lt: { $date: '2024-01-03T00:00:00.000Z' } });
  });

  it('is empty without rows', () => {
    expect(toChartData(spec({ type: 'histogram', x: 'n' }), []).labels).toEqual([]);
  });
});

describe('toChartData: scatter', () => {
  it('groups points by series, largest first, skipping points without numbers', () => {
    const data = toChartData(spec({ type: 'scatter', x: 'a', y: 'b', series: 'k' }), [
      { x: 1, y: 2, s: 'p' },
      { x: 2, y: 3, s: 'q' },
      { x: 3, y: 4, s: 'q' },
      { x: 'bad', y: 1, s: 'q' },
      { x: { $date: '1970-01-01T00:00:00.010Z' }, y: { $numberLong: '7' }, s: 'q' },
    ]);
    expect(data.kind).toBe('scatter');
    expect(data.points.map((p) => [p.name, p.points.length])).toEqual([
      ['q', 3],
      ['p', 1],
    ]);
    expect(data.points[0].points[2]).toEqual({ x: 10, y: 7 });
    expect(data.xDates).toBe(true);
    expect(data.yDates).toBe(false);
  });

  it('names the only series after the y field', () => {
    const data = toChartData(spec({ type: 'scatter', x: 'a', y: 'b' }), [{ x: 1, y: 1 }]);
    expect(data.points.map((p) => p.name)).toEqual(['b']);
  });
});
