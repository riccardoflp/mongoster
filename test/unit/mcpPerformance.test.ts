// The text of the performance diagnostics MCP tools, from data shaped as the server reports it.
import { describe, expect, it } from 'vitest';
import { adviceText, bytes, commandLine, duration, explainText, inNamespace, operationText } from '../../src/mcp/performance';
import type { Advice, AdvisorIndex } from '../../src/shared/advisor';
import type { ExplainSummary } from '../../src/shared/explain';

describe('units', () => {
  it('writes sizes and durations', () => {
    expect(bytes(0)).toBe('0 B');
    expect(bytes(812)).toBe('812 B');
    expect(bytes(1536)).toBe('1.5 KB');
    expect(bytes(3 * 1024 ** 3)).toBe('3.0 GB');
    expect(bytes(undefined)).toBe('?');
    expect(duration(80)).toBe('80 µs');
    expect(duration(450_000)).toBe('450 ms');
    expect(duration(12_345_678)).toBe('12.3 s');
  });

  it('matches a namespace by database or by collection', () => {
    expect(inNamespace('shop.orders', undefined)).toBe(true);
    expect(inNamespace('shop.orders', 'shop')).toBe(true);
    expect(inNamespace('shopping.orders', 'shop')).toBe(false);
    expect(inNamespace('shop.orders', 'shop.orders')).toBe(true);
    expect(inNamespace('shop.orders.archive', 'shop.orders')).toBe(false);
  });
});

describe('explainText', () => {
  const summary: ExplainSummary = {
    plan: {
      stage: 'SORT',
      details: { sortPattern: { createdAt: -1 } },
      children: [{ stage: 'COLLSCAN', details: { filter: { status: { $eq: 'A' } } }, children: [], nReturned: 3, docsExamined: 900 }],
      nReturned: 3,
    },
    indexes: [],
    collscan: true,
    inMemorySort: true,
    nReturned: 3,
    totalKeysExamined: 0,
    totalDocsExamined: 900,
    executionTimeMillis: 12,
    rejectedPlans: 0,
    pipeline: [{ stage: '$group', nReturned: 2, timeMs: 1 }],
  };

  it('gives the verdict, the numbers, the suggested index and the plan', () => {
    const text = explainText('shop.orders find:', 'orders', summary, { status: 1, createdAt: -1 });
    expect(text.split('\n')).toEqual([
      'shop.orders find:',
      'Plan: COLLSCAN (every document of the collection is read: no index serves the filter); in-memory sort (no index gives the order).',
      'returned 3, keys examined 0, documents examined 900, time 12 ms.',
      '300 documents examined for each one returned.',
      'Suggested index (equality fields, then the sort, then range fields: the ESR rule): { status: 1, createdAt: -1 }',
      '  db.getCollection("orders").createIndex({ status: 1, createdAt: -1 })',
      '',
      'Query plan:',
      'SORT (3 out)  sortPattern: { createdAt: -1 }',
      '  └ COLLSCAN (3 out, 900 docs)  filter: { status: { $eq: "A" } }',
      '',
      'Pipeline stages after the query:',
      '- $group (2 out, ~1 ms)',
    ]);
  });
});

describe('operationText', () => {
  it('writes the command without session noise, the client, locks and the transaction', () => {
    const text = operationText({
      opid: 42,
      active: true,
      microsecs_running: 2_500_000,
      op: 'update',
      ns: 'shop.orders',
      command: { update: 'orders', updates: [{ q: { _id: 1 }, u: { $set: { a: 1 } } }], lsid: { id: 'x' }, txnNumber: 3, $db: 'shop' },
      planSummary: 'IDHACK',
      client: '10.0.0.1:5000',
      desc: 'conn7',
      appName: 'api',
      effectiveUsers: [{ user: 'app', db: 'admin' }],
      waitingForLock: true,
      locks: { Global: 'w' },
      transaction: { parameters: { txnNumber: 3 }, timeOpenMicros: 4_000_000, timeActiveMicros: 1_000, expiryTime: new Date('2026-01-01T00:01:00Z') },
    });
    expect(text.split('\n')).toEqual([
      '- opid 42 · active · 2.5 s · update · shop.orders · plan IDHACK',
      '  { update: "orders", updates: [{ q: { _id: 1 }, u: { $set: { a: 1 } } }] }',
      '  client 10.0.0.1:5000 (conn7) app "api" user app@admin',
      '  WAITING FOR A LOCK · locks { Global: "w" }',
      '  transaction txnNumber 3, open 4.0 s, active 1 ms, expires 2026-01-01T00:01:00.000Z',
    ]);
  });

  it('says when an operation is the server\'s own, and cuts long commands', () => {
    expect(operationText({ opid: 1, active: true, op: 'none', desc: 'TTLMonitor' })).toContain('internal (no client) (TTLMonitor)');
    expect(commandLine({ find: 'x', filter: { s: 'y'.repeat(400) } })).toHaveLength(301);
  });
});

describe('adviceText', () => {
  const ix = (name: string, key: Record<string, unknown>, extra: Partial<AdvisorIndex> = {}): AdvisorIndex => ({ name, key, size: 2048, ops: 0, since: '2026-01-01T00:00:00.000Z', ...extra });

  it('lists unused and hidden indexes, and those too recent to tell', () => {
    const advice: Advice[] = [
      { kind: 'unused', id: 'u', database: 'shop', collection: 'orders', index: ix('old_1', { old: 1 }) },
      { kind: 'hidden', id: 'h', database: 'shop', collection: 'orders', index: ix('h_1', { h: 1 }, { hidden: true, ops: undefined, since: undefined }) },
    ];
    const lines = adviceText(advice, 2);
    expect(lines).toContain('- shop.orders old_1 { old: 1 } (2.0 KB, 0 uses since 2026-01-01T00:00:00.000Z)');
    expect(lines).toContain('- shop.orders h_1 { h: 1 } (2.0 KB)');
    expect(lines.some((l) => l.startsWith('Unused indexes'))).toBe(true);
    expect(lines.some((l) => l.startsWith('Hidden indexes'))).toBe(true);
    expect(lines[lines.length - 1]).toMatch(/^2 indexes not used yet, whose statistics started less than 24 hours ago/);
    expect(adviceText([], 0)).toEqual([]);
  });
});
