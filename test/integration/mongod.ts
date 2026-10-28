// Starts one mongod for the integration tests and gives its URI to them (`inject('mongoUri')`).
// mongodb-memory-server downloads a MongoDB binary the first time; a local installation is used
// instead when there is one: MONGOMS_SYSTEM_BINARY, or the newest MongoDB in Program Files on Windows.
// The server listens on the first free port from 27110 to 27119.
import * as fs from 'node:fs';
import * as net from 'node:net';
import * as path from 'node:path';
import { MongoMemoryServer } from 'mongodb-memory-server-core';
import type { TestProject } from 'vitest/node';

declare module 'vitest' {
  export interface ProvidedContext {
    mongoUri: string;
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
  let port: number | undefined;
  for (const p of PORTS) if (await freePort(p)) {
    port = p;
    break;
  }
  if (!port) throw new Error(`No free port from ${PORTS[0]} to ${PORTS[PORTS.length - 1]} for mongod`);
  const systemBinary = localBinary();
  const server = await MongoMemoryServer.create({
    instance: { port, ip: '127.0.0.1' },
    ...(systemBinary && { binary: { systemBinary } }),
  });
  project.provide('mongoUri', server.getUri());
  return async () => {
    await server.stop({ doCleanup: true, force: true });
  };
}
