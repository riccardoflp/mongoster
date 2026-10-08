import type { Memento } from 'vscode';
import type { QueryText, SavedQuery } from './shared/messages';
import type { PipelineStage } from './shared/pipeline';
import { parseQuery } from './shared/query';

const MAX_RECENT = 50;

/** Recent and saved (named) queries of one collection, persisted in globalState. */
export class QueryHistory {
  private readonly recentKey: string;
  private readonly savedKey: string;

  constructor(
    private readonly state: Memento,
    collectionKey: string,
  ) {
    this.recentKey = `mongoster.history.${collectionKey}`;
    this.savedKey = `mongoster.saved.${collectionKey}`;
  }

  get recent(): SavedQuery[] {
    return this.state.get<SavedQuery[]>(this.recentKey, []);
  }

  get saved(): SavedQuery[] {
    return this.state.get<SavedQuery[]>(this.savedKey, []);
  }

  /** Adds a successful query on top; an identical older entry is moved instead of duplicated. */
  async record(query: QueryText): Promise<boolean> {
    const q = normalize(query);
    if (q.pipeline ? !q.pipeline.some((s) => s.enabled) : !q.filter && !q.sort && !q.projection) return false;
    const rest = this.recent.filter((e) => !sameQuery(e, q));
    const entry: SavedQuery = { id: newId(), ...q, at: Date.now() };
    await this.state.update(this.recentKey, [entry, ...rest].slice(0, MAX_RECENT));
    return true;
  }

  /** Saves a query under a name; a saved query with the same name is replaced. */
  async save(name: string, query: QueryText): Promise<void> {
    const entry: SavedQuery = { id: newId(), name, ...normalize(query), at: Date.now() };
    await this.state.update(this.savedKey, [entry, ...this.saved.filter((e) => e.name !== name)]);
  }

  async remove(id: string): Promise<void> {
    await this.state.update(this.savedKey, emptyToUndefined(this.saved.filter((e) => e.id !== id)));
    await this.state.update(this.recentKey, emptyToUndefined(this.recent.filter((e) => e.id !== id)));
  }

  async clearRecent(): Promise<void> {
    await this.state.update(this.recentKey, undefined);
  }
}

function normalize(q: QueryText): QueryText {
  const base = { filter: q.filter.trim(), sort: q.sort.trim(), projection: q.projection.trim() };
  return q.pipeline ? { ...base, pipeline: q.pipeline.map((s) => ({ op: s.op.trim(), body: s.body, enabled: s.enabled })) } : base;
}

/** Same query, ignoring formatting (whitespace, quoting style): compares the parsed values. */
export function sameQuery(a: QueryText, b: QueryText): boolean {
  if (a.pipeline || b.pipeline) return canonicalPipeline(a.pipeline) === canonicalPipeline(b.pipeline);
  return canonical(a.filter) === canonical(b.filter) && canonical(a.sort) === canonical(b.sort) && canonical(a.projection) === canonical(b.projection);
}

function canonicalPipeline(stages: PipelineStage[] | undefined): string {
  return JSON.stringify((stages ?? []).map((s) => [s.op.trim(), canonical(s.body), s.enabled]));
}

function canonical(text: string): string {
  if (!text.trim()) return '';
  try {
    return JSON.stringify(parseQuery(text));
  } catch {
    return text.trim();
  }
}

function newId(): string {
  return Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
}

function emptyToUndefined<T>(list: T[]): T[] | undefined {
  return list.length ? list : undefined;
}
