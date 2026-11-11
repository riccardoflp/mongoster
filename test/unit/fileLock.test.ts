// The lock that makes a scheduled task run in one VS Code window only: atomic, released, taken over
// when its owner is gone or stopped renewing it, and lost (detected) when someone takes it over.
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { FileLock, lockHeld, processAlive } from '../../src/fileLock';

let dir: string;
let file: string;
beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mongoster-lock-'));
  file = path.join(dir, 'task.lock');
});
afterEach(() => fs.rmSync(dir, { recursive: true, force: true }));

/** A process id that isn't running. */
function deadPid(): number {
  for (let pid = 4_000_000; ; pid++) if (!processAlive(pid)) return pid;
}

describe('file lock', () => {
  it('is held by one owner at a time and free again once released', () => {
    const first = FileLock.acquire(file);
    expect(first).toBeDefined();
    expect(lockHeld(file)).toBe(true);
    expect(FileLock.acquire(file)).toBeUndefined();
    first!.release();
    expect(fs.existsSync(file)).toBe(false);
    const second = FileLock.acquire(file);
    expect(second).toBeDefined();
    second!.release();
  });

  it('is taken over when its owner process is gone', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: deadPid(), token: 'old', time: Date.now() }));
    expect(lockHeld(file)).toBe(false);
    const lock = FileLock.acquire(file);
    expect(lock).toBeDefined();
    lock!.release();
  });

  it('is taken over when its heartbeat stopped', () => {
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'old', time: 0 }));
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(file, old, old);
    expect(lockHeld(file, 60_000)).toBe(false);
    expect(FileLock.acquire(file, { staleMs: 60_000 })).toBeDefined();
  });

  it('renews itself, and tells its owner when it was taken over', async () => {
    let lost = false;
    const lock = FileLock.acquire(file, { heartbeatMs: 20, onLost: () => (lost = true) })!;
    const old = new Date(Date.now() - 120_000);
    fs.utimesSync(file, old, old);
    await new Promise((r) => setTimeout(r, 80));
    expect(Date.now() - fs.statSync(file).mtimeMs).toBeLessThan(10_000);
    // Someone judged it stale and replaced it.
    fs.writeFileSync(file, JSON.stringify({ pid: process.pid, token: 'other', time: Date.now() }));
    await new Promise((r) => setTimeout(r, 80));
    expect(lost).toBe(true);
    expect(lock.isLost).toBe(true);
    // Releasing it leaves the other owner's file alone.
    lock.release();
    expect(fs.existsSync(file)).toBe(true);
  });
});
