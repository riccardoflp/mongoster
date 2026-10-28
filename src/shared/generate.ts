// Fake documents that look like those of a schema analysis (see schema.ts): each field appears as often as
// it was seen, with the same mix of BSON types, values re-sampled from the frequent ones or drawn from the
// observed ranges and histograms, and strings shaped after their field name and examples (emails, URLs,
// UUIDs, phones, names, codes, words). Pure: documents are canonical Extended JSON, and the random source
// can be seeded for reproducible output.
import { isPlainObject } from './query';
import { MAX_DECIMALS, type FieldSchema, type SchemaSummary, type TypeSchema, type ValueCount } from './schema';

/** Numbers in [0, 1), like Math.random. */
export type Random = () => number;

/** A seeded random source (sfc32 over a cyrb128 hash of the seed): the same seed gives the same numbers. */
export function seededRandom(seed: string | number): Random {
  const str = String(seed);
  let h1 = 1779033703;
  let h2 = 3144134277;
  let h3 = 1013904242;
  let h4 = 2773480762;
  for (let i = 0; i < str.length; i++) {
    const k = str.charCodeAt(i);
    h1 = h2 ^ Math.imul(h1 ^ k, 597399067);
    h2 = h3 ^ Math.imul(h2 ^ k, 2869860233);
    h3 = h4 ^ Math.imul(h3 ^ k, 951274213);
    h4 = h1 ^ Math.imul(h4 ^ k, 2716044179);
  }
  h1 = Math.imul(h3 ^ (h1 >>> 18), 597399067);
  h2 = Math.imul(h4 ^ (h2 >>> 22), 2869860233);
  h3 = Math.imul(h1 ^ (h3 >>> 17), 951274213);
  h4 = Math.imul(h2 ^ (h4 >>> 19), 2716044179);
  let a = (h1 ^ h2 ^ h3 ^ h4) >>> 0;
  let b = (h2 ^ a) >>> 0;
  let c = (h3 ^ a) >>> 0;
  let d = (h4 ^ a) >>> 0;
  return () => {
    const t = (((a + b) | 0) + d) | 0;
    d = (d + 1) | 0;
    a = b ^ (b >>> 9);
    b = (c + (c << 3)) | 0;
    c = (c << 21) | (c >>> 11);
    c = (c + t) | 0;
    return (t >>> 0) / 4294967296;
  };
}

export interface GenerateOptions {
  /** Default Math.random. */
  random?: Random;
  /** First value of integer `_id`s (default: the largest analyzed + 1); they then count up. */
  nextId?: number;
  /** Time of the new `_id` ObjectIds, in ms (default now). */
  now?: number;
}

type Doc = Record<string, unknown>;

const DAY = 86_400_000;
const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

/** Generates documents one at a time (canonical EJSON), so that any number can be streamed. */
export class DocumentGenerator {
  private readonly rnd: Random;
  private readonly now: number;
  private readonly plans = new Map<TypeSchema, () => unknown>();
  private oidCounter: number;
  private tsCounter = 0;
  private nextId?: number;
  /** `_id`s generated that aren't ObjectIds or sequences, to avoid duplicates. */
  private readonly ids = new Set<string>();

  constructor(
    private readonly schema: SchemaSummary,
    options: GenerateOptions = {},
  ) {
    this.rnd = options.random ?? Math.random;
    this.now = options.now ?? Date.now();
    this.nextId = options.nextId;
    this.oidCounter = Math.floor(this.rnd() * 0xffffff);
  }

  next(): Doc {
    const id = this.schema.fields.find((f) => f.name === '_id');
    const doc: Doc = { _id: id ? this.id(id) : { $oid: this.objectId(this.now / 1000) } };
    return Object.assign(doc, this.object(this.schema.fields.filter((f) => f !== id)));
  }

  // -------------------------------------------------------------------------
  // Structure

  private object(fields: FieldSchema[]): Doc {
    const out: Doc = {};
    for (const f of fields) {
      if (!f.of || this.rnd() >= f.count / f.of) continue;
      out[f.name] = this.field(f, f.name);
    }
    return out;
  }

  /** A value of the field, of one of its types as often as seen. `name` names array elements after their array. */
  private field(f: FieldSchema, name: string): unknown {
    return this.value(this.pickType(f), f, name);
  }

  private pickType(f: FieldSchema): TypeSchema {
    if (f.types.length === 1) return f.types[0];
    return pickWeighted(this.rnd, f.types, (t) => t.count);
  }

  private value(t: TypeSchema, f: FieldSchema, name: string): unknown {
    switch (t.type) {
      case 'object':
        return this.object(f.fields ?? []);
      case 'array':
        return this.array(t, name);
      case 'null':
        return null;
      default: {
        let plan = this.plans.get(t);
        if (!plan) this.plans.set(t, (plan = this.plan(t, name)));
        return plan();
      }
    }
  }

  private array(t: TypeSchema, name: string): unknown[] {
    const len = this.arrayLength(t);
    const out: unknown[] = [];
    if (t.elements) for (let i = 0; i < len; i++) out.push(this.field(t.elements, name));
    return out;
  }

  private arrayLength(t: TypeSchema): number {
    const l = t.lengths ?? { min: 0, max: 0, avg: 0 };
    const counts = t.details?.lengths;
    if (counts?.length) {
      const covered = counts.reduce((s, c) => s + c.count, 0);
      const r = this.rnd() * Math.max(t.count, covered);
      if (r < covered) return pickWeighted(() => r / covered, counts, (c) => c.count).value as number;
    }
    return l.min + Math.floor(this.rnd() * (l.max - l.min + 1));
  }

  // -------------------------------------------------------------------------
  // _id

  private id(f: FieldSchema): unknown {
    const t = this.pickType(f);
    if (t.type === 'objectId') return { $oid: this.objectId(this.now / 1000) };
    if (t.type === 'int' || t.type === 'long') {
      this.nextId ??= Math.floor(toNumber(t.max) ?? 0) + 1;
      const n = this.nextId++;
      return t.type === 'int' && n <= INT32_MAX ? { $numberInt: String(n) } : { $numberLong: String(n) };
    }
    // Strings, UUIDs and the rest: values like the others, without repeating one.
    let v: unknown;
    for (let tries = 0; tries < 20; tries++) {
      v = this.value(t, f, '_id');
      const key = JSON.stringify(v);
      if (this.ids.has(key)) continue;
      this.ids.add(key);
      break;
    }
    return v;
  }

  // -------------------------------------------------------------------------
  // Scalars

  /** The generator of values of one type of a field. */
  private plan(t: TypeSchema, name: string): () => unknown {
    const pool = poolOf(t);
    // Low cardinality (status, category, rating, a few referenced ids): the values seen, as often. Numbers
    // and dates with more values follow their histogram instead, which gives new values too.
    const few = pool && (pool.length <= NUMBER_POOL || !(NUMERIC.has(t.type) || t.type === 'date'));
    if (pool && few && name !== '_id' && (t.type === 'bool' || pool.length <= 1 || t.count >= 2 * pool.length)) {
      const values = pool.map((v) => canonical(v.value, t.type));
      return () => pickWeighted(this.rnd, values, (_, i) => pool[i].count);
    }
    switch (t.type) {
      case 'int':
      case 'long':
      case 'double':
      case 'decimal':
        return this.numberPlan(t);
      case 'date':
        return this.datePlan(t);
      case 'string':
        return this.stringPlan(t, name);
      case 'objectId':
        return this.objectIdPlan(t);
      case 'bool':
        return () => this.rnd() < 0.5;
      default:
        return this.otherPlan(t);
    }
  }

  /** A number in the observed range, following the histogram; integers stay integers. */
  private draw(t: TypeSchema, integer: boolean): number {
    const min = toNumber(t.min) ?? 0;
    const max = toNumber(t.max) ?? min;
    const top = integer ? max + 1 : max;
    let lo = min;
    let hi = top;
    if (t.bins?.length) {
      const bin = pickWeighted(this.rnd, t.bins, (b) => b.count);
      lo = Math.max(min, toNumber(bin.from) ?? min);
      hi = Math.min(top, toNumber(bin.to) ?? top);
      if (hi < lo) hi = lo;
    }
    const x = lo + this.rnd() * (hi - lo);
    return integer ? Math.min(max, Math.floor(x)) : Math.min(max, x);
  }

  private numberPlan(t: TypeSchema): () => unknown {
    const decimals = t.details?.decimals;
    switch (t.type) {
      case 'int':
        return () => ({ $numberInt: String(Math.max(INT32_MIN, Math.min(INT32_MAX, this.draw(t, true)))) });
      case 'long':
        return () => ({ $numberLong: String(this.draw(t, true)) });
      case 'decimal':
        return () => ({ $numberDecimal: this.draw(t, false).toFixed(Math.min(decimals ?? 2, 20)) });
      default:
        return () => {
          const x = this.draw(t, false);
          const v = decimals !== undefined && decimals < MAX_DECIMALS ? Number(x.toFixed(decimals)) : x;
          return { $numberDouble: String(v) };
        };
    }
  }

  private datePlan(t: TypeSchema): () => unknown {
    const dateOnly = t.details?.dateOnly;
    return () => {
      let ms = Math.round(this.draw(t, false));
      if (dateOnly) ms = Math.floor(ms / DAY) * DAY;
      return { $date: { $numberLong: String(ms) } };
    };
  }

  private objectIdPlan(t: TypeSchema): () => unknown {
    // References and other ObjectIds: new ones, created within the time span of those seen.
    const times = (poolOf(t) ?? t.top ?? [])
      .map((v) => (isPlainObject(v.value) && typeof v.value.$oid === 'string' ? parseInt(v.value.$oid.slice(0, 8), 16) : NaN))
      .filter((n) => !Number.isNaN(n));
    const from = times.length ? Math.min(...times) : this.now / 1000;
    const to = times.length ? Math.max(...times) : this.now / 1000;
    return () => ({ $oid: this.objectId(from + this.rnd() * (to - from)) });
  }

  private objectId(seconds: number): string {
    this.oidCounter = (this.oidCounter + 1) % 0x1000000;
    return hex(Math.floor(seconds), 8) + this.hexChars(10) + hex(this.oidCounter, 6);
  }

  private otherPlan(t: TypeSchema): () => unknown {
    const ex = t.details?.example;
    if (t.type === 'binData' && isPlainObject(ex) && isPlainObject(ex.$binary)) {
      const subType = String(ex.$binary.subType ?? '00');
      const base64 = String(ex.$binary.base64 ?? '');
      const size = Math.max(0, Math.floor((base64.length * 3) / 4) - (base64.endsWith('==') ? 2 : base64.endsWith('=') ? 1 : 0));
      return () => {
        const bytes = Array.from({ length: size }, () => Math.floor(this.rnd() * 256));
        if (subType === '04' && size === 16) {
          bytes[6] = (bytes[6] & 0x0f) | 0x40;
          bytes[8] = (bytes[8] & 0x3f) | 0x80;
        }
        return { $binary: { base64: base64Encode(bytes), subType } };
      };
    }
    if (t.type === 'timestamp') return () => ({ $timestamp: { t: Math.floor(this.now / 1000), i: ++this.tsCounter } });
    return () => ex ?? null;
  }

  // -------------------------------------------------------------------------
  // Strings

  private stringPlan(t: TypeSchema, name: string): () => string {
    const seen = (poolOf(t) ?? t.top ?? []).filter((v): v is ValueCount & { value: string } => typeof v.value === 'string');
    const examples = seen.map((v) => v.value).filter((s) => s.length);
    const empty = seen.find((v) => v.value === '')?.count ?? 0;
    const chars = t.details?.chars ?? lengthsOf(examples);
    const length = this.lengthPlan(examples, chars);
    const make = this.stringKind(key(name), examples, length);
    const emptyRate = t.count ? empty / t.count : 0;
    return () => (emptyRate && this.rnd() < emptyRate ? '' : make());
  }

  /** Lengths like the examples' (or the observed range), for words and text. */
  private lengthPlan(examples: string[], chars: { min: number; max: number; avg: number }): () => number {
    const clamp = (n: number) => Math.max(chars.min, Math.min(chars.max, Math.round(n)));
    if (examples.length >= 5) {
      // The most frequent values may be shorter or longer than most: scaled to the average length.
      const mean = examples.reduce((s, e) => s + e.length, 0) / examples.length;
      const scale = mean ? chars.avg / mean : 1;
      return () => clamp(examples[Math.floor(this.rnd() * examples.length)].length * scale * (0.85 + 0.3 * this.rnd()));
    }
    // Triangular between min and max, with the mode that gives the average.
    const { min, max } = chars;
    const mode = Math.max(min, Math.min(max, 3 * chars.avg - min - max));
    return () => {
      if (max <= min) return min;
      const u = this.rnd();
      const c = (mode - min) / (max - min);
      return clamp(u < c ? min + Math.sqrt(u * (max - min) * (mode - min)) : max - Math.sqrt((1 - u) * (max - min) * (max - mode)));
    };
  }

  /** Picks how to make strings of a field from its name and examples. */
  private stringKind(k: string, ex: string[], length: () => number): () => string {
    const most = (re: RegExp) => ex.length > 0 && ex.filter((s) => re.test(s)).length >= 0.8 * ex.length;
    const none = !ex.length;
    if (most(UUID) || (none && /uuid|guid/.test(k))) {
      const upper = ex.length > 0 && ex[0] === ex[0].toUpperCase();
      return () => (upper ? this.uuid().toUpperCase() : this.uuid());
    }
    if (most(EMAIL) || (none && /e?mail$/.test(k))) return this.emailPlan(ex);
    if (most(URL_RE) || (none && /(url|link|website|href)$/.test(k))) return this.urlPlan(ex);
    if (most(ISO_DATE)) return this.isoPlan(ex);
    if ((ex.length && ex.every(isPhone)) || (none && /phone|mobile|^tel|fax/.test(k))) {
      return ex.length ? this.shapePlan(ex, true) : () => `+1 555-${this.digits(3)}-${this.digits(4)}`;
    }
    // Values with a common prefix (`user1234`, `cat-45`, `ORD-2024-…`): the same shape.
    if (ex.length >= 3 && ex.every((s) => !/\s/.test(s) && /\d/.test(s)) && commonPrefix(ex).length >= 2) return this.shapePlan(ex, false, k === 'id');
    if (/^(first|given|fore)name$|^name(first|given)$/.test(k)) return () => this.pick(FIRST_NAMES);
    if (/^(last|family|sur)name$|^surname$|^name(last|family)$/.test(k)) return () => this.pick(LAST_NAMES);
    if (/^(user|login|nick|screen)name$|^handle$|^login$/.test(k)) return () => this.username();
    if (this.personLike(k, ex)) return () => `${this.pick(FIRST_NAMES)} ${this.pick(LAST_NAMES)}`;
    if (/city$|town$/.test(k)) return () => this.pick(CITIES);
    if (/country(code)?$/.test(k)) {
      if (ex.length && ex.every((s) => /^[A-Z]{2}$/.test(s))) return () => this.pick(COUNTRY_CODES);
      return () => this.pick(COUNTRIES);
    }
    if (/^(street|address|addressline\d?|address\d)$/.test(k)) {
      // The streets seen with other numbers, in their format (`Via Roma 12`, `12 Oak Street`).
      if (ex.some((s) => /\d/.test(s))) return () => this.pick(ex).replace(/\d+/g, (d) => this.numberLike(d));
      return () => `${1 + Math.floor(this.rnd() * 250)} ${this.pick(STREETS)} ${this.pick(STREET_TYPES)}`;
    }
    if (k === 'id' && ex.length && ex.every((s) => !/\s/.test(s))) return this.shapePlan(ex, false, true);
    const sameLength = ex.length > 0 && ex.every((s) => s.length === ex[0].length);
    if (sameLength && ex[0].length >= 8 && ex.every((s) => HEX.test(s)) && ex.some((s) => /\d/.test(s))) {
      const upper = ex.some((s) => /[A-F]/.test(s));
      return () => (upper ? this.hexChars(ex[0].length).toUpperCase() : this.hexChars(ex[0].length));
    }
    // Codes and identifiers (SKU-1042, INV/2024/0031, 9f3Ka2): the same shape with other characters.
    if (ex.length && ex.every((s) => !/\s/.test(s)) && ex.filter((s) => /\d/.test(s)).length >= 0.5 * ex.length) {
      return this.shapePlan(ex, false);
    }
    const words = vocabulary(ex);
    if (ex.length && ex.every((s) => !/\s/.test(s))) return this.tokenPlan(ex, length, words);
    return this.textPlan(ex, length, words);
  }

  /** Names of people: by the field's name, or because the examples start with known first names. */
  private personLike(k: string, ex: string[]): boolean {
    const shaped = ex.filter((s) => /^\p{Lu}[\p{L}'-]+( \p{Lu}[\p{L}'.-]*){1,2}$/u.test(s));
    if (ex.length && shaped.length < 0.8 * ex.length) return false;
    if (/^(full|display|contact|customer|owner|author|employee|person|patient|student|teacher|manager)name$|^(author|owner|customer|contact|employee|person|patient|student|teacher|manager|assignee|reporter)$/.test(k)) {
      return true;
    }
    if (!ex.length) return k === 'fullname';
    return shaped.filter((s) => FIRST_NAME_SET.has(s.split(' ')[0])).length >= 0.3 * ex.length;
  }

  private emailPlan(ex: string[]): () => string {
    const domains = ex.map((s) => s.slice(s.lastIndexOf('@') + 1).toLowerCase()).filter((d) => d.includes('.'));
    const pool = domains.length ? domains : ['example.com', 'example.org', 'example.net'];
    return () => {
      const first = this.pick(FIRST_NAMES).toLowerCase();
      const last = this.pick(LAST_NAMES).toLowerCase();
      const style = Math.floor(this.rnd() * 4);
      const local = style === 0 ? `${first}.${last}` : style === 1 ? `${first[0]}${last}` : style === 2 ? `${first}${this.digits(2)}` : `${first}_${last}${this.digits(1)}`;
      return `${ascii(local)}@${this.pick(pool)}`;
    };
  }

  private urlPlan(ex: string[]): () => string {
    // Path segments that take few values among the examples (`/p/`, `/en/`) are kept, the others replaced.
    const segments = new Map<number, Set<string>>();
    for (const url of ex) {
      urlPath(url)?.split('/').forEach((seg, i) => {
        const set = segments.get(i) ?? new Set<string>();
        segments.set(i, set.add(seg));
      });
    }
    const keep = (i: number) => ex.length >= 3 && (segments.get(i)?.size ?? ex.length) <= Math.max(1, ex.length / 4);
    const vocab = vocabulary(ex.map((url) => urlPath(url) ?? ''));
    return () => {
      const sample = ex.length ? this.pick(ex) : 'https://www.example.com/a';
      const m = /^([a-z][a-z0-9+.-]*:\/\/[^/?#\s]+)([^?#]*)/i.exec(sample);
      if (!m) return sample;
      const path = m[2]
        .split('/')
        .map((seg, i) => (!seg || keep(i) ? seg : /\d/.test(seg) ? this.mimic(seg, false) : this.slug(seg, vocab)))
        .join('/');
      return m[1] + path;
    };
  }

  /**
   * Strings shaped like the examples (codes, ids, phones): a random example with its letters and digits
   * replaced, except where all the examples of that length have the same character (`ORD-2024-…`).
   * For `_id`s digits always change, so that the values stay distinct.
   */
  private shapePlan(ex: string[], phone: boolean, id = false): () => string {
    const byLength = new Map<number, string[]>();
    for (const s of ex) byLength.set(s.length, [...(byLength.get(s.length) ?? []), s]);
    const fixed = new Map<number, boolean[]>();
    for (const [len, list] of byLength) {
      if (list.length < 3) continue;
      fixed.set(
        len,
        Array.from({ length: len }, (_, i) => list.every((s) => s[i] === list[0][i]) && !(id && /\d/.test(list[0][i]))),
      );
    }
    return () => {
      const sample = this.pick(ex);
      return this.mimic(sample, phone, fixed.get(sample.length));
    };
  }

  private isoPlan(ex: string[]): () => string {
    const times = ex.map((s) => Date.parse(s.length === 10 ? `${s}T00:00:00Z` : s)).filter((n) => !Number.isNaN(n));
    let from = times.length ? Math.min(...times) : this.now - 365 * DAY;
    let to = times.length ? Math.max(...times) : this.now;
    if (to - from < DAY) {
      from -= 182 * DAY;
      to += 182 * DAY;
    }
    return () => {
      const sample = this.pick(ex);
      const iso = new Date(from + this.rnd() * (to - from)).toISOString();
      if (sample.length === 10) return iso.slice(0, 10);
      const time = /^.{11}\d{2}:\d{2}:\d{2}/.test(sample) ? iso.slice(11, 19) : iso.slice(11, 16);
      const frac = /\.(\d+)/.exec(sample.slice(19))?.[1];
      const zone = /(Z|[+-]\d{2}:?\d{2})$/.exec(sample)?.[1] ?? '';
      return `${iso.slice(0, 10)}${sample[10]}${time}${frac ? `.${iso.slice(20, 23).padEnd(frac.length, '0').slice(0, frac.length)}` : ''}${zone}`;
    };
  }

  /** Single words or slugs (no spaces): words joined like the examples, with their case. */
  private tokenPlan(ex: string[], length: () => number, vocab: string[]): () => string {
    const sep = ['-', '_', '.'].find((c) => ex.filter((s) => s.includes(c)).length >= 0.3 * ex.length) ?? '';
    const style = caseStyle(ex);
    return () => {
      const target = length();
      const words: string[] = [];
      let len = 0;
      do {
        const w = sep || words.length === 0 ? this.wordNear(vocab, target - len - (words.length ? sep.length : 0)) : this.word(vocab);
        words.push(w);
        len += w.length + (words.length > 1 ? sep.length : 0);
      } while (len < target - 2 && words.length < 8);
      const joined = sep ? words.join(sep) : words.map((w, i) => (i && style !== 'lower' && style !== 'upper' ? cap(w) : w)).join('');
      return applyCase(joined, style);
    };
  }

  /** Text with spaces: words up to a similar length, capitalized and ended like the examples. */
  private textPlan(ex: string[], length: () => number, vocab: string[]): () => string {
    const capital = ex.length > 0 && ex.filter((s) => /^\p{Lu}/u.test(s)).length >= 0.5 * ex.length;
    const title = ex.length > 0 && ex.filter((s) => s.split(/\s+/).every((w) => !/^\p{Ll}/u.test(w))).length >= 0.6 * ex.length;
    const period = ex.length > 0 && ex.filter((s) => /[.!?]$/.test(s)).length >= 0.5 * ex.length;
    return () => {
      const target = Math.max(1, length() - (period ? 1 : 0));
      const words: string[] = [];
      let len = 0;
      while (len < target) {
        const w = this.word(vocab);
        const next = len + (words.length ? 1 : 0) + w.length;
        // The last word only when it gets closer to the length.
        if (words.length && next - target > target - len) break;
        words.push(w);
        len = next;
      }
      let s = (title ? words.map(cap) : words).join(' ');
      if (capital) s = cap(s);
      return period ? `${s}.` : s;
    };
  }

  // -------------------------------------------------------------------------
  // Helpers

  private pick<T>(list: readonly T[]): T {
    return list[Math.floor(this.rnd() * list.length)];
  }

  /** A word of the examples (or of the built-in list when they have few), now and then one of the list. */
  private word(vocab: readonly string[] = WORDS): string {
    return this.pick(vocab.length >= MIN_VOCABULARY && this.rnd() < 0.9 ? vocab : WORDS);
  }

  /** A word close to `n` characters, when there's one. */
  private wordNear(vocab: readonly string[], n: number): string {
    let best = this.word(vocab);
    for (let i = 0; i < 12 && Math.abs(best.length - n) > 1; i++) {
      const w = this.word(vocab);
      if (Math.abs(w.length - n) < Math.abs(best.length - n)) best = w;
    }
    return best;
  }

  private slug(seg: string, vocab: string[]): string {
    const sep = seg.includes('_') ? '_' : '-';
    const parts = Math.max(1, seg.split(/[-_]/).length);
    return Array.from({ length: Math.min(parts, 4) }, () => this.word(vocab)).join(sep);
  }

  /** A number with as many digits as `d` (1–9 for one digit), without leading zeros. */
  private numberLike(d: string): string {
    const len = Math.min(d.length, 9);
    const low = len === 1 ? 1 : 10 ** (len - 1);
    return String(low + Math.floor(this.rnd() * (10 ** len - low)));
  }

  private digits(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += Math.floor(this.rnd() * 10);
    return s;
  }

  private hexChars(n: number): string {
    let s = '';
    for (let i = 0; i < n; i++) s += HEX_DIGITS[Math.floor(this.rnd() * 16)];
    return s;
  }

  private uuid(): string {
    const h = this.hexChars(32).split('');
    h[12] = '4';
    h[16] = HEX_DIGITS[8 + Math.floor(this.rnd() * 4)];
    const s = h.join('');
    return `${s.slice(0, 8)}-${s.slice(8, 12)}-${s.slice(12, 16)}-${s.slice(16, 20)}-${s.slice(20)}`;
  }

  private username(): string {
    const first = ascii(this.pick(FIRST_NAMES).toLowerCase());
    const last = ascii(this.pick(LAST_NAMES).toLowerCase());
    const style = Math.floor(this.rnd() * 3);
    return style === 0 ? `${first[0]}${last}${this.digits(2)}` : style === 1 ? `${first}.${last}` : `${first}${this.digits(3)}`;
  }

  /**
   * The example with its digits and letters replaced by others of the same kind, except at the `fixed`
   * positions (a `+39` prefix stays for phones).
   */
  private mimic(example: string, phone: boolean, fixed?: boolean[]): string {
    const keep = phone && example.startsWith('+') ? (/^\+\d{1,3}/.exec(example)?.[0].length ?? 1) : 0;
    let out = example.slice(0, keep);
    const hexOnly = HEX.test(example);
    for (let i = keep; i < example.length; i++) {
      const ch = example[i];
      if (fixed?.[i]) out += ch;
      else if (ch >= '0' && ch <= '9') out += Math.floor(this.rnd() * 10);
      else if (hexOnly && /[a-f]/.test(ch)) out += HEX_DIGITS[10 + Math.floor(this.rnd() * 6)];
      else if (hexOnly && /[A-F]/.test(ch)) out += HEX_DIGITS[10 + Math.floor(this.rnd() * 6)].toUpperCase();
      else if (ch >= 'a' && ch <= 'z') out += LOWER[Math.floor(this.rnd() * 26)];
      else if (ch >= 'A' && ch <= 'Z') out += LOWER[Math.floor(this.rnd() * 26)].toUpperCase();
      else out += ch;
    }
    return out;
  }
}

/** `count` documents at once (see DocumentGenerator for streaming). */
export function generateDocuments(schema: SchemaSummary, count: number, options: GenerateOptions = {}): Doc[] {
  const gen = new DocumentGenerator(schema, options);
  return Array.from({ length: count }, () => gen.next());
}

// ---------------------------------------------------------------------------
// Values

/** Every value of the type with its count: from the details, or the top values when they are all of them. */
function poolOf(t: TypeSchema): ValueCount[] | undefined {
  if (t.details?.values) return t.details.values;
  if (t.top && !t.distinctCapped && t.distinct !== undefined && t.distinct === t.top.length) return t.top;
  return undefined;
}

/** A relaxed EJSON value of the schema (top values, min, max, bins) as canonical EJSON of its BSON type. */
function canonical(v: unknown, type: TypeSchema['type']): unknown {
  if (isPlainObject(v)) {
    if (type === 'date' && typeof v.$date === 'string') return { $date: { $numberLong: String(Date.parse(v.$date)) } };
    return v;
  }
  if (typeof v !== 'number') return v;
  switch (type) {
    case 'int':
      return { $numberInt: String(v) };
    case 'long':
      return { $numberLong: String(v) };
    case 'decimal':
      return { $numberDecimal: String(v) };
    case 'double':
      return { $numberDouble: String(v) };
    default:
      return v;
  }
}

/** Numbers and dates (in ms) of the schema as a JS number. */
function toNumber(v: unknown): number | undefined {
  if (typeof v === 'number') return v;
  if (!isPlainObject(v)) return undefined;
  if (v.$date !== undefined) {
    const d = v.$date;
    return isPlainObject(d) ? Number(d.$numberLong) : typeof d === 'string' ? Date.parse(d) : Number(d);
  }
  const inner = Object.values(v)[0];
  const n = Number(inner);
  return Number.isNaN(n) ? undefined : n;
}

function pickWeighted<T>(rnd: Random, items: readonly T[], weight: (item: T, i: number) => number): T {
  let total = 0;
  for (let i = 0; i < items.length; i++) total += weight(items[i], i);
  let r = rnd() * total;
  for (let i = 0; i < items.length; i++) {
    r -= weight(items[i], i);
    if (r < 0) return items[i];
  }
  return items[items.length - 1];
}

function lengthsOf(ex: string[]): { min: number; max: number; avg: number } {
  if (!ex.length) return { min: 5, max: 20, avg: 10 };
  const lens = ex.map((s) => s.length);
  return { min: Math.min(...lens), max: Math.max(...lens), avg: lens.reduce((a, b) => a + b, 0) / lens.length };
}

/** The field name lowercase without separators: `first_name` → `firstname`. */
const key = (name: string) => name.toLowerCase().replace(/[^a-z0-9]/g, '');

const hex = (n: number, width: number) => (n >>> 0).toString(16).padStart(width, '0').slice(-width);
const cap = (s: string) => s.charAt(0).toUpperCase() + s.slice(1);
const ascii = (s: string) => s.normalize('NFD').replace(/[^a-z0-9._]/g, '');

type CaseStyle = 'lower' | 'upper' | 'capital' | 'camel';

function caseStyle(ex: string[]): CaseStyle {
  const count = (re: RegExp) => ex.filter((s) => re.test(s)).length;
  if (count(/^[^a-z]*$/) >= 0.6 * ex.length && count(/[A-Z]/) > 0) return 'upper';
  if (count(/^[A-Z]/) >= 0.6 * ex.length) return 'capital';
  if (count(/^[a-z]+[A-Z]/) >= 0.6 * ex.length) return 'camel';
  return 'lower';
}

function applyCase(s: string, style: CaseStyle): string {
  if (style === 'upper') return s.toUpperCase();
  if (style === 'capital') return cap(s);
  return s.charAt(0).toLowerCase() + s.slice(1);
}

/** Distinct words of the examples, without punctuation: the vocabulary of generated text. */
function vocabulary(ex: string[]): string[] {
  const words = new Set<string>();
  for (const s of ex) for (const w of s.split(/[\s\-_.,;:!?()"/]+/)) if (/^\p{L}{2,}$/u.test(w)) words.add(w.toLowerCase());
  return [...words];
}

function commonPrefix(ex: string[]): string {
  let prefix = ex[0] ?? '';
  for (const s of ex) while (!s.startsWith(prefix)) prefix = prefix.slice(0, -1);
  return prefix;
}

function urlPath(url: string): string | undefined {
  return /^[a-z][a-z0-9+.-]*:\/\/[^/?#\s]+([^?#]*)/i.exec(url)?.[1];
}

function isPhone(s: string): boolean {
  const digits = s.replace(/\D/g, '').length;
  return /^\+?[\d\s().\/-]{7,20}$/.test(s) && digits >= 7 && /[\s().\/+-]/.test(s);
}

const BASE64 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/';

function base64Encode(bytes: number[]): string {
  let out = '';
  for (let i = 0; i < bytes.length; i += 3) {
    const [a, b = 0, c = 0] = [bytes[i], bytes[i + 1], bytes[i + 2]];
    const n = (a << 16) | (b << 8) | c;
    out += BASE64[(n >> 18) & 63] + BASE64[(n >> 12) & 63];
    out += i + 1 < bytes.length ? BASE64[(n >> 6) & 63] : '=';
    out += i + 2 < bytes.length ? BASE64[n & 63] : '=';
  }
  return out;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const HEX = /^[0-9a-f]+$/i;
const EMAIL = /^[^@\s]+@[^@\s]+\.[a-z]{2,}$/i;
const URL_RE = /^[a-z][a-z0-9+.-]*:\/\/[^\s/]+/i;
const ISO_DATE = /^\d{4}-\d{2}-\d{2}(?:[T ]\d{2}:\d{2}(?::\d{2}(?:\.\d+)?)?(?:Z|[+-]\d{2}:?\d{2})?)?$/;
const HEX_DIGITS = '0123456789abcdef';
const NUMERIC = new Set(['int', 'long', 'double', 'decimal']);
/** Distinct numbers or dates re-sampled as they are; with more, the histogram. */
const NUMBER_POOL = 50;
/** Distinct words the examples need for text made of them. */
const MIN_VOCABULARY = 8;
const LOWER = 'abcdefghijklmnopqrstuvwxyz';

// ---------------------------------------------------------------------------
// Word lists

const WORDS = (
  'time year people way day thing world life hand part child eye place work week case point number group problem fact ' +
  'home water room money story month book job word business issue side kind head house service friend power hour game ' +
  'line end member city name team minute idea body information level office door health art history party result change ' +
  'morning reason research moment air teacher force education music market sense plan interest experience effect class ' +
  'control care field development role rate heart show leader light voice mind price report decision view town road ' +
  'value building action model season society position player record paper space ground form event matter center site ' +
  'project activity star table need cost industry figure street image phone data picture practice piece land product ' +
  'wall worker news test movie support technology step computer type film tree source window song garden river summer ' +
  'winter coffee bread cloud stone paper glass silver orange yellow green blue simple quick bright quiet modern small ' +
  'large local social national early real best free whole special easy clear recent certain open single current private ' +
  'common natural similar ready central final main nice huge popular classic fresh smart rapid solid daily global urban'
).split(' ');

const FIRST_NAMES = (
  'James Mary John Patricia Robert Jennifer Michael Linda William Elizabeth David Barbara Richard Susan Joseph Jessica ' +
  'Thomas Sarah Charles Karen Christopher Lisa Daniel Nancy Matthew Betty Anthony Sandra Mark Margaret Steven Emily Paul ' +
  'Laura Andrew Michelle Joshua Rachel Kevin Amanda Brian Melissa George Julia Luca Giulia Marco Francesca Sofia Matteo ' +
  'Emma Lucas Mia Noah Olivia Liam Ava Elena Hugo Chloe Yuki Hana Wei Mei Arjun Priya Omar Fatima Carlos Ana Lars Ingrid'
).split(' ');
const FIRST_NAME_SET = new Set(FIRST_NAMES);

const LAST_NAMES = (
  'Smith Johnson Williams Brown Jones Garcia Miller Davis Rodriguez Martinez Hernandez Lopez Gonzalez Wilson Anderson ' +
  'Thomas Taylor Moore Jackson Martin Lee Perez Thompson White Harris Sanchez Clark Ramirez Lewis Robinson Walker Young ' +
  'Allen King Wright Scott Torres Nguyen Hill Flores Green Adams Nelson Baker Hall Rivera Campbell Mitchell Carter ' +
  'Roberts Rossi Russo Ferrari Esposito Bianchi Romano Colombo Ricci Schmidt Schneider Dubois Laurent Tanaka Suzuki Kim ' +
  'Park Chen Wang Singh Patel Larsen Novak'
).split(' ');

const CITIES = [
  'New York', 'London', 'Paris', 'Tokyo', 'Berlin', 'Madrid', 'Rome', 'Milan', 'Toronto', 'Sydney', 'Chicago',
  'Los Angeles', 'San Francisco', 'Seattle', 'Boston', 'Amsterdam', 'Barcelona', 'Lisbon', 'Vienna', 'Prague', 'Dublin',
  'Stockholm', 'Oslo', 'Copenhagen', 'Zurich', 'Munich', 'Seoul', 'Singapore', 'Mumbai', 'São Paulo', 'Mexico City',
  'Buenos Aires', 'Cape Town', 'Istanbul', 'Dubai', 'Bangkok', 'Melbourne', 'Vancouver', 'Turin', 'Naples', 'Florence',
];

const COUNTRIES = [
  'United States', 'United Kingdom', 'France', 'Germany', 'Italy', 'Spain', 'Portugal', 'Netherlands', 'Belgium',
  'Switzerland', 'Austria', 'Sweden', 'Norway', 'Denmark', 'Ireland', 'Poland', 'Canada', 'Mexico', 'Brazil', 'Argentina',
  'Japan', 'South Korea', 'China', 'India', 'Australia', 'New Zealand', 'South Africa', 'Egypt', 'Turkey', 'Singapore',
];

const COUNTRY_CODES = 'US GB FR DE IT ES PT NL BE CH AT SE NO DK IE PL CA MX BR AR JP KR CN IN AU NZ ZA EG TR SG'.split(' ');

const STREETS = 'Main Oak Pine Maple Cedar Elm Washington Lake Hill Park Church High Mill River Station Garden Victoria King Queen Market Bridge Spring Sunset Forest Meadow'.split(' ');
const STREET_TYPES = 'Street Avenue Road Lane Drive Boulevard Way Court'.split(' ');
