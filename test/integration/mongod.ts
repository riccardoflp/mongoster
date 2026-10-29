// Starts the servers of the integration tests and gives their URIs to them (`inject('mongoUri')`, a
// standalone mongod, and `inject('replSetUri')`, a single-node replica set for sessions and transactions).
// mongodb-memory-server downloads a MongoDB binary the first time; a local installation is used
// instead when there is one: MONGOMS_SYSTEM_BINARY, or the newest MongoDB in Program Files on Windows.
// The servers listen on the first free ports from 27110 to 27119.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { MongoMemoryReplSet, MongoMemoryServer } from 'mongodb-memory-server-core';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
    replSetUri: string;
  }
}

const PORTS = Array.from({ length: 10 }, (_, i) => 27110 + i);

function freePort(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const server = net.createServer();
    server.once('error', () => resolve(false));
    server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
  });
}

/** The first free port of the range not already taken by the servers started here. */
async function nextPort(taken: number[]): Promise<number> {
  for (const p of PORTS) if (!taken.includes(p) && (await freePort(p))) return p;
  throw new Error(`No free port from ${PORTS[0]} to ${PORTS[PORTS.length - 1]} for mongod`);
}

function localBinary(): string | undefined {
  if (process.env.MONGOMS_SYSTEM_BINARY || process.platform !== 'win32') return undefined;
  const root = 'C:/Program Files/MongoDB/Server';
  let versions: string[];
  try {
    versions = fs.readdirSync(root);
  } catch {
    return undefined;
  }
  const newest = versions
    .filter((v) => /^\d+\.\d+$/.test(v) && fs.existsSync(path.join(root, v, 'bin/mongod.exe')))
    .sort((a, b) => Number(b.split('.')[0]) - Number(a.split('.')[0]) || Number(b.split('.')[1]) - Number(a.split('.')[1]))[0];
  return newest && path.join(root, newest, 'bin/mongod.exe');
}

export default async function setup(project: TestProject): Promise<() => Promise<void>> {
  const systemBinary = localBinary();
  const binary = systemBinary ? { systemBinary } : undefined;
  const port = await nextPort([]);
  const server = await MongoMemoryServer.create({ instance: { port, ip: '127.0.0.1' }, ...(binary && { binary }) });
  let replSet: MongoMemoryReplSet | undefined;
  try {
    const replSetPort = await nextPort([port]);
    replSet = await MongoMemoryReplSet.create({
      replSet: { count: 1, storageEngine: 'wiredTiger', ip: '127.0.0.1' },
      instanceOpts: [{ port: replSetPort }],
      ...(binary && { binary }),
    });
  } catch (err) {
    await server.stop({ doCleanup: true, force: true });
    throw err;
  }
  project.provide('mongoUri', server.getUri());
  project.provide('replSetUri', replSet.getUri());
  return async () => {
    await Promise.all([replSet?.stop({ doCleanup: true, force: true }), server.stop({ doCleanup: true, force: true })]);
  };
}
