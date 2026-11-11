// A document's versions rebuilt from its oplog entries: both update formats, arrays, nested fields,
// replacements, delete and insert again, transactions, and what can't be known.
import { BSON, Double, Long, Timestamp, UUID } from 'mongodb';
import { describe, expect, it } from 'vitest';
import { DocOp, UNKNOWN_TEXT, applyUpdate, buildHistory, displayValue, documentOps, idKey, opKey, revertUpdate, updateChanges } from '../../src/shared/docHistory';

const { EJSON } = BSON;
type Obj = Record<string, unknown>;
const canon = (v: object) => EJSON.serialize(v, { relaxed: false }) as Obj;
const NS = 'shop.orders';
const KEY = idKey(canon({ v: 1 }).v);

let tick = 0;
/** An oplog entry, canonical EJSON, one second after the previous one. */
function entry(fields: Obj): Obj {
  tick++;
  return canon({ ts: new Timestamp({ t: 1_700_000_000 + tick, i: 1 }), wall: new Date((1_700_000_000 + tick) * 1000), v: 2, ...fields });
}
const insert = (doc: Obj) => entry({ op: 'i', ns: NS, o: doc });
const update = (o: Obj, id: unknown = 1) => entry({ op: 'u', ns: NS, o2: { _id: id }, o });
const remove = (id: unknown = 1) => entry({ op: 'd', ns: NS, o: { _id: id } });
const opsOf = (...entries: Obj[]): DocOp[] => entries.flatMap((e) => documentOps(e, NS, KEY));
/** The versions as the views show them: relaxed, unknown values as "?". */
const shown = (v: unknown) => JSON.parse(JSON.stringify(displayValue(v)).split(JSON.stringify(UNKNOWN_TEXT)).join('"?"'));

describe('documentOps', () => {
  it('keeps the writes to the document: insert, update by o2._id, delete', () => {
    const ops = opsOf(insert({ _id: 1, a: 1 }), insert({ _id: 2 }), update({ $v: 2, diff: { u: { a: 2 } } }), update({ $set: { a: 3 } }, 2), remove(), entry({ op: 'i', ns: 'shop.other', o: { _id: 1 } }));
    expect(ops.map((o) => o.op)).toEqual(['i', 'u', 'd']);
    expect(ops[0].wall).toMatch(/^2023-11-14T/);
    expect(ops[0].index).toBe(-1);
  });

  it('matches _id by value: 1, 1.0 and NumberLong(1) are one _id', () => {
    const ops = opsOf(insert({ _id: new Double(1) }), update({ $set: { a: 1 } }, Long.fromNumber(1)), remove(1));
    expect(ops).toHaveLength(3);
    expect(idKey(canon({ v: 'x' }).v)).not.toBe(KEY);
  });

  it('expands transactions, with their session and number', () => {
    const lsid = new UUID('0e1c3f5a-6b7d-4e8f-9a0b-1c2d3e4f5a6b');
    const txn = entry({
      op: 'c',
      ns: 'admin.$cmd',
      lsid: { id: lsid, uid: new BSON.Binary(Buffer.alloc(32)) },
      txnNumber: Long.fromNumber(3),
      prevOpTime: { ts: new Timestamp({ t: 0, i: 0 }), t: Long.fromNumber(-1) },
      o: { applyOps: [{ op: 'i', ns: NS, o: { _id: 2 } }, { op: 'u', ns: NS, o2: { _id: 1 }, o: { $v: 2, diff: { u: { a: 5 } } } }, { op: 'd', ns: NS, o: { _id: 1 } }] },
    });
    const ops = opsOf(txn);
    expect(ops.map((o) => [o.op, o.index, o.group])).toEqual([
      ['u', 1, 'transaction'],
      ['d', 2, 'transaction'],
    ]);
    expect(ops[0].lsid).toBe('UUID("0e1c3f5a-6b7d-4e8f-9a0b-1c2d3e4f5a6b")');
    expect(ops[0].txnNumber).toBe('3');
    expect(ops[0].partial).toBeUndefined();
    expect(opKey(ops[1])).toBe(`${ops[1].t}:1:2`);
  });

  it('tells batched writes and parts of large transactions apart', () => {
    const batch = entry({ op: 'c', ns: 'admin.$cmd', lsid: { id: new UUID() }, txnNumber: Long.fromNumber(1), o: { applyOps: [{ op: 'd', ns: NS, o: { _id: 1 }, stmtId: 0 }] } });
    expect(opsOf(batch)[0].group).toBe('batch');
    const part = entry({ op: 'c', ns: 'admin.$cmd', lsid: { id: new UUID() }, txnNumber: Long.fromNumber(1), partialTxn: true, o: { applyOps: [{ op: 'd', ns: NS, o: { _id: 1 } }] } });
    expect(opsOf(part)[0]).toMatchObject({ group: 'transaction', partial: true });
  });

  it('keeps drops and renames of the collection', () => {
    const ops = opsOf(
      entry({ op: 'c', ns: 'shop.$cmd', o: { drop: 'orders' } }),
      entry({ op: 'c', ns: 'shop.$cmd', o: { drop: 'others' } }),
      entry({ op: 'c', ns: 'shop.$cmd', o: { renameCollection: 'shop.old', to: NS, dropTarget: true } }),
      entry({ op: 'c', ns: 'shop.$cmd', o: { renameCollection: NS, to: 'shop.archive' } }),
      entry({ op: 'c', ns: 'other.$cmd', o: { dropDatabase: 1 } }),
    );
    expect(ops.map((o) => o.command)).toEqual(['collection dropped', 'renamed into this collection from shop.old', 'collection renamed to shop.archive']);
  });
});

describe('updateChanges', () => {
  it('reads $v 2 diffs (nested, arrays, canonical lengths) and $set / $unset', () => {
    expect(updateChanges(canon({ $v: 2, diff: { u: { s: 'x' }, i: { n: 1 }, d: { old: false }, sa: { u: { b: 2 } }, sitems: { a: true, l: 2, u1: 'y' } } }))).toEqual({
      set: ['s', 'n', 'a.b', 'items.1'],
      unset: ['old'],
      truncated: ['items to 2'],
    });
    expect(updateChanges({ $set: { 'a.b': 1 }, $unset: { c: true } })).toEqual({ set: ['a.b'], unset: ['c'], truncated: [] });
    expect(updateChanges({ _id: 1, a: 1 })).toBeUndefined();
  });
});

describe('applyUpdate', () => {
  const apply = (doc: object, o: object) => shown(applyUpdate(canon(doc), canon(o)));

  it('applies $set / $unset with dotted paths, creating sub-documents and padding arrays', () => {
    expect(apply({ _id: 1, a: { b: 1 }, tags: ['x'] }, { $set: { 'a.c': 2, 'n.m.o': 3, 'tags.3': 'z' }, $unset: { 'a.b': true, 'tags.0': true } })).toEqual({
      _id: 1,
      a: { c: 2 },
      tags: [null, null, null, 'z'],
      n: { m: { o: 3 } },
    });
  });

  it('applies $v 2 diffs: updates in place, inserts at the end, deletes, nested sub-documents', () => {
    const doc = applyUpdate(canon({ _id: 1, a: 1, b: { c: 1, d: 2 }, e: 5 }), canon({ $v: 2, diff: { u: { a: 2 }, d: { e: false }, i: { f: 6 }, sb: { u: { c: 9 }, i: { x: 1 } } } }));
    expect(Object.keys(doc)).toEqual(['_id', 'a', 'b', 'f']);
    expect(shown(doc)).toEqual({ _id: 1, a: 2, b: { c: 9, d: 2, x: 1 }, f: 6 });
  });

  it('applies array diffs: new elements, resizing, changes inside elements', () => {
    expect(apply({ _id: 1, items: [1, 2, 3] }, { $v: 2, diff: { sitems: { a: true, u3: 4 } } })).toEqual({ _id: 1, items: [1, 2, 3, 4] });
    expect(apply({ _id: 1, items: [1, 2, 3] }, { $v: 2, diff: { sitems: { a: true, l: 2 } } })).toEqual({ _id: 1, items: [1, 2] });
    expect(apply({ _id: 1, items: [1] }, { $v: 2, diff: { sitems: { a: true, u3: 4 } } })).toEqual({ _id: 1, items: [1, null, null, 4] });
    expect(apply({ _id: 1, items: [{ p: 1 }, { p: 2 }] }, { $v: 2, diff: { sitems: { a: true, s1: { u: { p: 3 } } } } })).toEqual({ _id: 1, items: [{ p: 1 }, { p: 3 }] });
    expect(apply({ _id: 1, m: [[1, 2]] }, { $v: 2, diff: { sm: { a: true, s0: { a: true, u1: 5 } } } })).toEqual({ _id: 1, m: [[1, 5]] });
  });

  it('refuses an update that doesn\'t fit the document', () => {
    expect(() => applyUpdate(canon({ _id: 1 }), canon({ $v: 2, diff: { sb: { u: { c: 1 } } } }))).toThrow(/doesn't have/);
    expect(() => applyUpdate(canon({ _id: 1, b: 5 }), canon({ $v: 2, diff: { sb: { u: { c: 1 } } } }))).toThrow(/not a sub-document/);
    expect(() => applyUpdate(canon({ _id: 1, b: 5 }), canon({ $set: { 'b.c': 1 } }))).toThrow(/can't hold fields/);
    expect(() => applyUpdate(canon({ _id: 1 }), canon({ $inc: { n: 1 } }))).toThrow(/Unknown update format/);
  });
});

describe('revertUpdate', () => {
  const revert = (doc: object, o: object) => shown(revertUpdate(canon(doc), canon(o)));

  it('makes what a $set / $unset changed unknown, and sub-documents it may have created', () => {
    expect(revert({ _id: 1, a: 1, x: { y: 5 }, z: { k: 1, w: 2 } }, { $set: { a: 1, 'x.y': 5, 'z.k': 1 }, $unset: { gone: true } })).toEqual({
      _id: 1,
      a: '?',
      x: '?',
      z: { k: '?', w: 2 },
      gone: '?',
    });
    // An array element set past the end: the nulls padded before it may not have been there.
    expect(revert({ _id: 1, tags: ['a', null, 'c'] }, { $set: { 'tags.2': 'c' } })).toEqual({ _id: 1, tags: ['a', '?', '?'] });
  });

  it('undoes $v 2 diffs: changed fields unknown, sub-documents walked, resized arrays unknown', () => {
    expect(revert({ _id: 1, a: 2, b: { c: 9, d: 2 }, f: 6, items: [1, 2, 3, 4], list: [1] }, { $v: 2, diff: { u: { a: 2 }, d: { e: false }, i: { f: 6 }, sb: { u: { c: 9 } }, sitems: { a: true, u1: 2 }, slist: { a: true, l: 1 } } })).toEqual({
      _id: 1,
      a: '?',
      b: { c: '?', d: 2 },
      f: '?',
      items: [1, '?', 3, 4],
      list: '?',
      e: '?',
    });
  });
});

describe('buildHistory', () => {
  const states = (h: ReturnType<typeof buildHistory>) => h.versions.map((v) => v.state);

  it('rebuilds every version forwards from an insert ($v 2 updates)', () => {
    const ops = opsOf(
      insert({ _id: 1, status: 'new', qty: 1 }),
      update({ $v: 2, diff: { u: { status: 'paid' }, i: { paidAt: 'today' } } }),
      update({ $v: 2, diff: { d: { qty: false } } }),
    );
    const h = buildHistory(ops, canon({ _id: 1, status: 'paid', paidAt: 'today' }));
    expect(states(h)).toEqual(['exact', 'exact', 'exact']);
    expect(h.conflict).toBe(false);
    expect(h.versions.map((v) => v.kind)).toEqual(['insert', 'update', 'update']);
    expect(shown(h.versions[1].doc)).toEqual({ _id: 1, status: 'paid', qty: 1, paidAt: 'today' });
    expect(h.versions[1].changes).toEqual({ set: ['status', 'paidAt'], unset: [], truncated: [] });
    expect(h.versions[1].diff).toEqual([
      { path: 'status', left: 'new', right: 'paid' },
      { path: 'paidAt', right: 'today' },
    ]);
    expect(h.versions[2].diff).toEqual([{ path: 'qty', left: 1 }]);
    // The insert: every field added.
    expect(h.versions[0].diff.map((d) => d.path)).toEqual(['_id', 'status', 'qty']);
    expect(h.before.state).toBe('absent');
  });

  it('rebuilds forwards with $set / $unset too, nested and in arrays', () => {
    const ops = opsOf(insert({ _id: 1, a: { b: 1 }, tags: ['x'] }), update({ $set: { 'a.c': 2, 'tags.1': 'y' } }), update({ $unset: { 'a.b': true } }));
    const h = buildHistory(ops, canon({ _id: 1, a: { c: 2 }, tags: ['x', 'y'] }));
    expect(states(h)).toEqual(['exact', 'exact', 'exact']);
    expect(shown(h.versions[1].doc)).toEqual({ _id: 1, a: { b: 1, c: 2 }, tags: ['x', 'y'] });
    expect(h.versions[1].diff).toEqual([
      { path: 'a.c', right: 2 },
      { path: 'tags', left: ['x'], right: ['x', 'y'] },
    ]);
  });

  it('walks backwards from the current document when the insert is older than the oplog', () => {
    const ops = opsOf(update({ $v: 2, diff: { u: { a: 3 } } }), update({ $v: 2, diff: { sb: { u: { c: 1 } } } }));
    const h = buildHistory(ops, canon({ _id: 1, a: 3, b: { c: 1, d: 2 } }));
    expect(states(h)).toEqual(['partial', 'exact']);
    expect(h.versions[0].unknown).toEqual(['b.c']);
    expect(shown(h.versions[0].doc)).toEqual({ _id: 1, a: 3, b: { c: '?', d: 2 } });
    expect(h.versions[1].diff).toEqual([{ path: 'b.c', leftUnknown: true, right: 1 }]);
    expect(h.before).toMatchObject({ state: 'partial', unknown: ['a', 'b.c'] });
    expect(h.versions[0].diff).toEqual([{ path: 'a', leftUnknown: true, right: 3 }]);
  });

  it('is exact after a replacement, unknown before it when nothing older is known', () => {
    const ops = opsOf(update({ $set: { a: 1 } }), update({ _id: 1, name: 'new' }), update({ $set: { n: 2 } }));
    const h = buildHistory(ops, canon({ _id: 1, name: 'new', n: 2 }));
    expect(h.versions.map((v) => v.kind)).toEqual(['update', 'replace', 'update']);
    expect(states(h)).toEqual(['unknown', 'exact', 'exact']);
    expect(shown(h.versions[1].doc)).toEqual({ _id: 1, name: 'new' });
    expect(h.versions[1].diff).toEqual([
      { path: '_id', leftUnknown: true, right: 1 },
      { path: 'name', leftUnknown: true, right: 'new' },
    ]);
  });

  it('follows a delete and an insert again', () => {
    const ops = opsOf(insert({ _id: 1, v: 1 }), update({ $v: 2, diff: { u: { v: 2 } } }), remove(), insert({ _id: 1, w: 1 }), update({ $v: 2, diff: { i: { x: true } } }));
    const h = buildHistory(ops, canon({ _id: 1, w: 1, x: true }));
    expect(states(h)).toEqual(['exact', 'exact', 'absent', 'exact', 'exact']);
    expect(h.versions[2].diff).toEqual([
      { path: '_id', left: 1 },
      { path: 'v', left: 2 },
    ]);
    expect(shown(h.versions[1].doc)).toEqual({ _id: 1, v: 2 });
    expect(h.conflict).toBe(false);
  });

  it('knows a deleted document from before its delete only when rebuilt forwards', () => {
    const forward = buildHistory(opsOf(insert({ _id: 1, v: 1 }), remove()), null);
    expect(states(forward)).toEqual(['exact', 'absent']);
    const backward = buildHistory(opsOf(update({ $set: { v: 2 } }), remove()), null);
    expect(states(backward)).toEqual(['unknown', 'absent']);
  });

  it('applies the operations of transactions in order, by entry and position', () => {
    const first = insert({ _id: 1, n: 1 });
    const txn = entry({
      op: 'c',
      ns: 'admin.$cmd',
      lsid: { id: new UUID() },
      txnNumber: Long.fromNumber(1),
      o: { applyOps: [{ op: 'u', ns: NS, o2: { _id: 1 }, o: { $v: 2, diff: { u: { n: 2 } } } }, { op: 'u', ns: NS, o2: { _id: 1 }, o: { $v: 2, diff: { u: { n: 3 } } } }] },
    });
    const ops = opsOf(first, txn);
    const h = buildHistory([...ops].reverse(), canon({ _id: 1, n: 3 }));
    expect(states(h)).toEqual(['exact', 'exact', 'exact']);
    expect(h.versions.map((v) => shown(v.doc).n)).toEqual([1, 2, 3]);
    expect(h.versions[1].op.group).toBe('transaction');
  });

  it("doesn't show wrong data when an operation is missing: the update that doesn't fit and the stretch before it", () => {
    // The update that created b is not among the operations read.
    const ops = opsOf(insert({ _id: 1, a: 1 }), update({ $v: 2, diff: { sb: { u: { c: 2 } } } }));
    const h = buildHistory(ops, canon({ _id: 1, a: 1, b: { c: 2 } }));
    expect(h.versions[1].mismatch).toMatch(/doesn't have/);
    expect(h.conflict).toBe(true);
    expect(states(h)).toEqual(['partial', 'exact']);
    expect(shown(h.versions[0].doc)).toEqual({ _id: 1, a: 1, b: { c: '?' } });
  });

  it('prefers what is known backwards when the forward rebuild leads elsewhere', () => {
    // Written after the oplog was read: the current document has a field no operation explains.
    const h = buildHistory(opsOf(insert({ _id: 1, a: 1 }), update({ $v: 2, diff: { u: { a: 2 } } })), canon({ _id: 1, a: 2, late: true }));
    expect(h.conflict).toBe(true);
    expect(states(h)).toEqual(['partial', 'exact']);
    expect(shown(h.versions[0].doc)).toEqual({ _id: 1, a: '?', late: true });
  });

  it('keeps numeric types: an int and a double differ', () => {
    const ops = opsOf(insert({ _id: 1, n: 1 }), update({ $v: 2, diff: { u: { n: new Double(1) } } }));
    const h = buildHistory(ops, canon({ _id: 1, n: new Double(1) }));
    expect(h.conflict).toBe(false);
    expect(h.versions[1].diff).toEqual([{ path: 'n', left: 1, right: 1, types: ['int', 'double'] }]);
    expect(h.versions[0].doc).toEqual({ _id: { $numberInt: '1' }, n: { $numberInt: '1' } });
  });

  it('marks a dropped collection as no document, and a collection renamed onto this one as unknown', () => {
    const h = buildHistory(opsOf(insert({ _id: 1 }), entry({ op: 'c', ns: 'shop.$cmd', o: { drop: 'orders' } }), entry({ op: 'c', ns: 'shop.$cmd', o: { renameCollection: 'shop.old', to: NS } })), canon({ _id: 1, from: 'old' }));
    expect(h.versions.map((v) => v.kind)).toEqual(['insert', 'drop', 'renamed']);
    expect(states(h)).toEqual(['exact', 'absent', 'exact']);
  });

  it('has nothing to rebuild without operations', () => {
    expect(buildHistory([], canon({ _id: 1 }))).toEqual({ versions: [], before: { state: 'exact', doc: canon({ _id: 1 }) }, conflict: false });
  });
});
