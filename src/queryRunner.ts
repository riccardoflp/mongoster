// Running what fills a collection's table: the find and the pipeline with their counts, under the time limit of
// the setting `mongoster.query.timeout`, each as a run the user can cancel. A run tags its operations with a
// comment of its own and gives them an abort signal: cancelling aborts the wait in the driver and kills, on the
// server, the operations that carry the comment. Nothing here writes, but a pipeline that ends with $out or
// $merge, which the panel confirms before it gets here. No vscode dependency.
import { randomUUID } from 'node:crypto';
import type { Collection, CollationOptions, Document, MongoClient } from 'mongodb';
import { findOptions, toBson } from './queries';
import type { FindExtras } from './shared/messages';

/** The setting, under `mongoster.`: seconds a find or a pipeline may run; 0 for no limit. */
export const TIMEOUT_SETTING = 'query.timeout';
export const DEFAULT_TIMEOUT_SECONDS = 60;
/** The setting's highest value: a day. */
export const MAX_TIMEOUT_SECONDS = 86_400;
/** A pipeline that writes ($out, $merge) gets this many times the limit: it goes through every document. */
const WRITE_FACTOR = 10;
/** The count beside a page of results is given up after this long: the page shows without a total. */
const COUNT_MS = 10_000;
/** MongoDB's error for an operation stopped by its maxTimeMS. */
const MAX_TIME_EXPIRED = 50;

/** The seconds of the setting as given by the user: the default for what isn't a number of seconds from 0 to a day. */
export function timeoutSeconds(setting: unknown): number {
  if (typeof setting !== 'number' || !Number.isFinite(setting) || setting < 0) return DEFAULT_TIMEOUT_SECONDS;
  return Math.min(Math.floor(setting), MAX_TIMEOUT_SECONDS);
}

/** Thrown in place of the driver's error by a cancelled run. */
export class QueryCancelled extends Error {
  constructor() {
    super('Query cancelled.');
  }
}

/** One run of a query, a schema analysis or a chart: what its operations carry, and how it is cancelled. */
export class QueryRun {
  /** On every operation of the run: it is how they are found again on the server. */
  readonly comment = `mongoster:${randomUUID()}`;
  private readonly controller = new AbortController();
  private stopped = false;

  /** `seconds`: the time limit of the setting, 0 for none. */
  constructor(readonly seconds = DEFAULT_TIMEOUT_SECONDS) {}

  get cancelled(): boolean {
    return this.stopped;
  }

  /** Driver options for an operation of the run, with a time limit in milliseconds (0: none). */
  options(maxTimeMS = this.seconds * 1000): { comment: string; signal: AbortSignal; maxTimeMS?: number } {
    return { comment: this.comment, signal: this.controller.signal, ...(maxTimeMS > 0 && { maxTimeMS }) };
  }

  /**
   * Stops the run: the driver gives up its wait at once (it closes the connection the operation is on), and the
   * operations still running on the server are killed. Returns how many were killed there; a server that doesn't
   * let the user list or kill them still stops them when it sees the connection closed.
   */
  async cancel(client: MongoClient): Promise<number> {
    if (this.stopped) return 0;
    this.stopped = true;
    this.controller.abort(new QueryCancelled());
    return killOperations(client, this.comment);
  }

  /** What to tell the user for an error of the run; undefined when the error says it well enough itself. */
  describe(err: unknown): string | undefined {
    if (this.stopped) return new QueryCancelled().message;
    if ((err as { code?: unknown })?.code !== MAX_TIME_EXPIRED) return undefined;
    return `Stopped after ${this.seconds} seconds, the time limit of the setting mongoster.${TIMEOUT_SETTING}. Raise it, or narrow the query.`;
  }
}

/** Kills the user's own operations that carry `comment`; returns how many. Never throws. */
export async function killOperations(client: MongoClient, comment: string): Promise<number> {
  try {
    const admin = client.db('admin');
    // allUsers: false needs no privilege: everyone can list and kill their own operations.
    const ops = await admin
      .aggregate([
        { $currentOp: { allUsers: false, idleCursors: false } },
        { $match: { $or: [{ 'command.comment': comment }, { 'cursor.originatingCommand.comment': comment }] } },
        { $project: { opid: 1 } },
      ])
      .toArray();
    let killed = 0;
    for (const op of ops) {
      try {
        await admin.command({ killOp: 1, op: op.opid });
        killed++;
      } catch {
        // Already finished, or not ours to kill.
      }
    }
    return killed;
  } catch {
    return 0;
  }
}

export interface FindPage extends FindExtras {
  filter: string;
  sort: string;
  projection: string;
  skip: number;
  limit: number;
}

export interface Page {
  docs: Document[];
  /** Null when the count failed or took too long: the page is shown without a total. */
  count: number | null;
}

/** A page of a find and the number of documents its filter matches. Throws on a text that isn't valid. */
export async function findPage(coll: Collection, q: FindPage, run: QueryRun): Promise<Page> {
  const filter = toBson(q.filter, 'Filter') ?? {};
  const options = findOptions(q);
  const [docs, count] = await Promise.all([
    coll.find(filter, { ...options, skip: q.skip, limit: q.limit, promoteLongs: false, ...run.options() }).toArray(),
    countFind(coll, filter, options, run),
  ]);
  return { docs, count };
}

/** A page of a pipeline's output and the number of documents it gives. */
export async function pipelinePage(coll: Collection, pipeline: Document[], skip: number, limit: number, run: QueryRun): Promise<Page> {
  const [docs, count] = await Promise.all([
    coll.aggregate([...pipeline, { $skip: skip }, { $limit: limit }], { allowDiskUse: true, promoteLongs: false, ...run.options() }).toArray(),
    countPipeline(coll, pipeline, run),
  ]);
  return { docs, count };
}

/** Runs a pipeline that ends with $out or $merge, for what it writes. */
export async function runWritePipeline(coll: Collection, pipeline: Document[], run: QueryRun): Promise<void> {
  await coll.aggregate(pipeline, { allowDiskUse: true, ...run.options(run.seconds * 1000 * WRITE_FACTOR) }).toArray();
}

async function countFind(coll: Collection, filter: Document, options: { collation?: CollationOptions; hint?: string | Document }, run: QueryRun): Promise<number | null> {
  try {
    if (!Object.keys(filter).length) return await coll.estimatedDocumentCount(run.options(COUNT_MS));
    return await coll.countDocuments(filter, {
      ...(options.collation && { collation: options.collation }),
      ...(options.hint !== undefined && { hint: options.hint }),
      ...run.options(COUNT_MS),
    });
  } catch {
    return null;
  }
}

async function countPipeline(coll: Collection, pipeline: Document[], run: QueryRun): Promise<number | null> {
  try {
    const [res] = await coll.aggregate([...pipeline, { $count: 'n' }], { allowDiskUse: true, ...run.options(COUNT_MS) }).toArray();
    return res?.n ?? 0;
  } catch {
    return null;
  }
}
