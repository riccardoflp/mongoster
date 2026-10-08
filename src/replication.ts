// Replica set status and oplog entries, from replSetGetStatus, replSetGetConfig and local.oplog.rs
// (all values relaxed EJSON).
import type { Document } from 'mongodb';
import type { OplogEntry, OplogOp, ReplMember } from './shared/messages';
import { isPlainObject, toShell } from './shared/query';

const SUMMARY_MAX = 300;
const OPS: Record<string, string> = { i: 'insert', u: 'update', d: 'delete', c: 'command', n: 'noop' };

type Obj = Record<string, unknown>;
const obj = (v: unknown): Obj => (isPlainObject(v) ? v : {});

/** A relaxed date ({ $date: "…" }) or Date as ISO text. */
function iso(v: unknown): string | undefined {
  if (v instanceof Date) return v.toISOString();
  const d = obj(v).$date;
  if (typeof d === 'string') return d;
  if (typeof d === 'number') return new Date(d).toISOString();
  return undefined;
}

const num = (v: unknown): number | undefined => {
  if (typeof v === 'number') return v;
  const n = Number(obj(v).$numberLong ?? obj(v).$numberInt ?? obj(v).$numberDouble ?? NaN);
  return Number.isFinite(n) ? n : undefined;
};

const clip = (text: string, max = SUMMARY_MAX) => (text.length > max ? `${text.slice(0, max)}…` : text);

/** Members from replSetGetStatus and replSetGetConfig, with their lag behind the primary. */
export function replMembers(statusMembers: unknown[], configMembers: unknown[]): ReplMember[] {
  const config = new Map(configMembers.map((c) => [num(obj(c)._id), obj(c)]));
  const optimes = statusMembers.map((m) => iso(obj(m).optimeDate)).filter((t): t is string => !!t && !t.startsWith('1970'));
  const primary = statusMembers.map(obj).find((m) => m.stateStr === 'PRIMARY');
  const reference = iso(primary?.optimeDate) ?? optimes.sort().at(-1);
  return statusMembers.map((raw) => {
    const m = obj(raw);
    const id = num(m._id) ?? -1;
    const c = config.get(id) ?? {};
    const optime = iso(m.optimeDate);
    const valid = optime && !optime.startsWith('1970') && m.stateStr !== 'ARBITER' ? optime : undefined;
    const heartbeat = iso(m.lastHeartbeat);
    const tags = obj(c.tags);
    return {
      id,
      name: String(m.name ?? c.host ?? ''),
      state: String(m.stateStr ?? '?'),
      health: num(m.health) ?? 0,
      self: m.self === true,
      uptime: num(m.uptime),
      optime: valid,
      lag: valid && reference ? Math.max(0, (Date.parse(reference) - Date.parse(valid)) / 1000) : undefined,
      lastHeartbeat: heartbeat && !heartbeat.startsWith('1970') ? heartbeat : undefined,
      pingMs: num(m.pingMs),
      syncSource: (m.syncSourceHost as string) || undefined,
      message: ((m.infoMessage || m.lastHeartbeatMessage) as string) || undefined,
      priority: num(c.priority),
      votes: num(c.votes),
      hidden: c.hidden === true || undefined,
      arbiter: c.arbiterOnly === true || m.stateStr === 'ARBITER' || undefined,
      delay: num(c.secondaryDelaySecs ?? c.slaveDelay) || undefined,
      tags: Object.keys(tags).length ? (Object.fromEntries(Object.entries(tags).map(([k, v]) => [k, String(v)])) as Record<string, string>) : undefined,
      buildIndexes: c.buildIndexes === false ? false : undefined,
      raw: { status: raw, config: Object.keys(c).length ? c : undefined },
    };
  });
}

/** Members known from hello alone (replSetGetStatus not allowed): names and whether primary. */
export function helloMembers(hello: Document): ReplMember[] {
  const list = [
    ...((hello.hosts as string[]) ?? []).map((name) => ({ name })),
    ...((hello.passives as string[]) ?? []).map((name) => ({ name, priority: 0 })),
    ...((hello.arbiters as string[]) ?? []).map((name) => ({ name, arbiter: true as const })),
  ];
  return list.map((m, id) => ({
    id,
    health: 1,
    self: m.name === hello.me,
    state: m.name === hello.primary ? 'PRIMARY' : 'arbiter' in m ? 'ARBITER' : m.name === hello.me && hello.secondary ? 'SECONDARY' : '?',
    raw: { hello: m },
    ...m,
  }));
}

/** The fields an update sets and unsets, from its oplog entry ($v 2 diff, or $set / $unset). */
export function updatedFields(o: Obj): { set: string[]; unset: string[] } | undefined {
  const set: string[] = [];
  const unset: string[] = [];
  const walk = (diff: Obj, prefix: string) => {
    for (const [k, v] of Object.entries(diff)) {
      if (k === 'u' || k === 'i') set.push(...Object.keys(obj(v)).map((f) => prefix + f));
      else if (k === 'd') unset.push(...Object.keys(obj(v)).map((f) => prefix + f));
      else if (k === 'a') continue;
      else if (k === 'l') set.push(`${prefix.slice(0, -1)} (length)`);
      else if (/^u\d+$/.test(k)) set.push(prefix + k.slice(1));
      else if (/^s/.test(k)) walk(obj(v), `${prefix}${k.slice(1)}.`);
    }
  };
  if (isPlainObject(o.diff)) walk(o.diff, '');
  else if (o.$set || o.$unset) {
    set.push(...Object.keys(obj(o.$set)));
    unset.push(...Object.keys(obj(o.$unset)));
  } else return undefined;
  return { set: [...new Set(set)], unset: [...new Set(unset)] };
}

/** An oplog entry ready to display. */
export function oplogEntry(e: Obj): OplogEntry {
  const ts = obj(obj(e.ts).$timestamp);
  const t = num(ts.t) ?? 0;
  const o = obj(e.o);
  const ns = String(e.ns ?? '');
  const base = { key: `${t}:${num(ts.i) ?? 0}`, time: iso(e.wall) ?? new Date(t * 1000).toISOString(), ns, raw: e };
  const idOf = (v: unknown) => (v === undefined ? undefined : toShell(v));
  switch (e.op) {
    case 'i':
      return { ...base, op: 'insert', id: idOf(o._id), summary: clip(toShell(o)) };
    case 'u': {
      const fields = updatedFields(o);
      const summary = fields
        ? [fields.set.length ? `set ${fields.set.join(', ')}` : '', fields.unset.length ? `unset ${fields.unset.join(', ')}` : ''].filter(Boolean).join(' · ') || 'no change'
        : `replace with ${toShell(o)}`;
      return { ...base, op: 'update', id: idOf(obj(e.o2)._id), summary: clip(summary) };
    }
    case 'd':
      return { ...base, op: 'delete', id: idOf(o._id), summary: '' };
    case 'n':
      return { ...base, op: 'noop', summary: clip(typeof o.msg === 'string' ? o.msg : toShell(o)) };
    case 'c': {
      if (Array.isArray(o.applyOps)) {
        const inner = o.applyOps.map(obj);
        const counts = new Map<string, number>();
        for (const x of inner) {
          const command = x.op === 'c' ? Object.keys(obj(x.o))[0] : undefined;
          const target = command && obj(x.o)[command];
          const label = command
            ? `${command} ${typeof target === 'string' ? `${String(x.ns).split('.')[0]}.${target}` : x.ns}`
            : `${OPS[String(x.op)] ?? x.op} ${x.ns}`;
          counts.set(label, (counts.get(label) ?? 0) + 1);
        }
        const parts = [...counts].map(([label, n]) => (n > 1 ? `${n} × ${label}` : label));
        // Large transactions take several entries, linked by prevOpTime (a null time in the first one).
        const prev = num(obj(obj(obj(e.prevOpTime).ts).$timestamp).t);
        const more = e.partialTxn || prev ? ' (part of a larger transaction)' : '';
        return { ...base, op: 'transaction', summary: clip(`${inner.length} operation${inner.length === 1 ? '' : 's'}: ${parts.join(', ')}${more}`) };
      }
      const [name] = Object.keys(o);
      const rest = Object.fromEntries(Object.entries(o).filter(([k]) => k !== name));
      const target = o[name];
      const db = ns.split('.')[0];
      return {
        ...base,
        op: 'command',
        summary: clip(`${name}${typeof target === 'string' ? ` ${db}.${target}` : ''}${Object.keys(rest).length ? ` ${toShell(rest)}` : ''}`),
      };
    }
    default:
      return { ...base, op: String(e.op ?? '?'), summary: clip(toShell(o)) };
  }
}

const escapeRegex = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/** The oplog filter: operation kind, and a database ("shop") or collection ("shop.users"), also inside transactions. */
export function oplogFilter(ns: string, op: OplogOp): Document {
  const filter: Document = {};
  if (op === '') filter.op = { $ne: 'n' };
  else if (op !== '*') filter.op = op;
  const name = ns.trim();
  if (name) {
    const match = name.includes('.') ? name : { $regex: `^${escapeRegex(name)}\\.` };
    filter.$or = [{ ns: match }, { 'o.applyOps.ns': match }];
  }
  return filter;
}
