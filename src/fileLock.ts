// A lock shared by processes through a file: every VS Code window runs its own extension host, and a
// scheduled task must run in only one of them. The lock file is created atomically (`wx`: it fails if
// it exists) and holds the owner's pid and a random token; while held, its modification time is
// renewed (the heartbeat). A lock whose owner process is gone, or whose heartbeat stopped, is stale and
// can be taken over. The owner checks at each heartbeat that the file is still its own.
import * as fs from 'fs';
import { randomBytes } from 'crypto';

export interface LockOptions {
  /** A lock not renewed for this long is stale. */
  staleMs?: number;
  /** How often the holder renews it. */
  heartbeatMs?: number;
  /** Called once if the lock is found taken by someone else (it was considered stale). */
  onLost?: () => void;
}

interface LockContent {
  pid: number;
  token: string;
  time: number;
}

const DEFAULT_STALE_MS = 60_000;
const DEFAULT_HEARTBEAT_MS = 10_000;

/** Whether a process with this pid is running on this computer. */
export function processAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  if (pid === process.pid) return true;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    // EPERM: it exists, but belongs to another user.
    return (err as NodeJS.ErrnoException).code === 'EPERM';
  }
}

function readContent(file: string): LockContent | undefined {
  try {
    const content = JSON.parse(fs.readFileSync(file, 'utf8')) as LockContent;
    return typeof content.token === 'string' ? content : undefined;
  } catch {
    return undefined;
  }
}

/** Whether the lock file is held by a live owner (renewed recently, by a running process). */
export function lockHeld(file: string, staleMs = DEFAULT_STALE_MS, now = Date.now()): boolean {
  let mtime: number;
  try {
    mtime = fs.statSync(file).mtimeMs;
  } catch {
    return false;
  }
  const content = readContent(file);
  // Being written right now: held.
  if (!content) return now - mtime < 2_000;
  return now - mtime < staleMs && processAlive(content.pid);
}

export class FileLock {
  private timer?: ReturnType<typeof setInterval>;
  private lost = false;
  private released = false;

  private constructor(
    readonly file: string,
    private readonly token: string,
    private readonly options: LockOptions,
  ) {}

  /** Takes the lock, or returns undefined if a live owner has it. */
  static acquire(file: string, options: LockOptions = {}): FileLock | undefined {
    const staleMs = options.staleMs ?? DEFAULT_STALE_MS;
    for (let attempt = 0; attempt < 3; attempt++) {
      const token = randomBytes(12).toString('hex');
      try {
        const fd = fs.openSync(file, 'wx');
        try {
          fs.writeSync(fd, JSON.stringify({ pid: process.pid, token, time: Date.now() } satisfies LockContent));
        } finally {
          fs.closeSync(fd);
        }
        const lock = new FileLock(file, token, options);
        // Someone who found an older stale lock may have removed this one in the meantime.
        if (!lock.owned()) return undefined;
        lock.start();
        return lock;
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'EEXIST') throw err;
      }
      const judged = readContent(file);
      if (lockHeld(file, staleMs)) return undefined;
      // Stale: removed, unless it changed while it was judged (a new owner took it).
      try {
        if (readContent(file)?.token !== judged?.token) return undefined;
        fs.unlinkSync(file);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err;
      }
    }
    return undefined;
  }

  /** Whether the file still holds this lock. */
  owned(): boolean {
    return !this.released && readContent(this.file)?.token === this.token;
  }

  /** Whether the lock was taken by someone else while held. */
  get isLost(): boolean {
    return this.lost;
  }

  private start(): void {
    this.timer = setInterval(() => this.beat(), this.options.heartbeatMs ?? DEFAULT_HEARTBEAT_MS);
    this.timer.unref?.();
  }

  private beat(): void {
    if (this.released || this.lost) return;
    if (!this.owned()) {
      this.lost = true;
      clearInterval(this.timer);
      this.options.onLost?.();
      return;
    }
    const now = new Date();
    try {
      fs.utimesSync(this.file, now, now);
    } catch {
      // Checked again at the next beat.
    }
  }

  /** Releases the lock (deletes the file if it's still this lock's). */
  release(): void {
    if (this.released) return;
    clearInterval(this.timer);
    const mine = this.owned();
    this.released = true;
    if (!mine) return;
    try {
      fs.unlinkSync(this.file);
    } catch {
      // Already gone.
    }
  }
}
