// The HTTP side of the MCP server against a real socket on 127.0.0.1: which requests reach the tools,
// and the release of the port between windows, which must never put the access token on the wire.
import { afterEach, describe, expect, it } from 'vitest';
import * as http from 'http';
import type { AddressInfo } from 'net';
import { MARK, MAX_BATCH, MAX_BODY, PROOF_HEADER, PROOF_MAX_AGE_MS, ProofChecker, RELEASE_PATH, bearerMatches, handleRequest, probe, releaseProof, requestRelease } from '../../src/mcp/http';
import { INVALID_REQUEST, PARSE_ERROR, logText } from '../../src/shared/mcp';

const TOKEN = 'the-access-token-of-this-test';
const servers: http.Server[] = [];

afterEach(async () => {
  await Promise.all(servers.splice(0).map((s) => new Promise((resolve) => s.close(resolve))));
});

async function listen(handler: http.RequestListener): Promise<number> {
  const server = http.createServer(handler);
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return (server.address() as AddressInfo).port;
}

/** The MCP server's handler on a free port; `answered` collects the messages that reached the tools. */
async function mcp(): Promise<{ port: number; answered: unknown[]; released: () => number }> {
  const answered: unknown[] = [];
  let released = 0;
  const proofs = new ProofChecker();
  let port = 0;
  port = await listen(
    (req, res) =>
      void handleRequest(
        req,
        res,
        {
          port: () => port,
          version: '1.2.3',
          token: () => TOKEN,
          answer: async (m) => {
            answered.push(m);
            return (m as { id?: unknown }).id === undefined ? undefined : { jsonrpc: '2.0', id: (m as { id: unknown }).id, result: {} };
          },
          release: () => void released++,
        },
        proofs,
      ),
  );
  return { port, answered, released: () => released };
}

interface Answer {
  status: number;
  headers: http.IncomingHttpHeaders;
  body: string;
}

function request(port: number, options: { method?: string; path?: string; headers?: Record<string, string>; body?: string | Buffer }): Promise<Answer> {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: options.path ?? '/mcp', method: options.method ?? 'POST', headers: options.headers, agent: false }, (res) => {
      const chunks: Buffer[] = [];
      res.on('data', (c: Buffer) => chunks.push(c));
      res.on('end', () => resolve({ status: res.statusCode ?? 0, headers: res.headers, body: Buffer.concat(chunks).toString('utf8') }));
    });
    req.on('error', reject);
    req.end(options.body);
  });
}

const auth = { Authorization: `Bearer ${TOKEN}` };
const rpc = (id: number) => ({ jsonrpc: '2.0', id, method: 'ping' });

describe('releaseProof', () => {
  it('is accepted once by a window with the same token, for the same port', () => {
    const proofs = new ProofChecker();
    const proof = releaseProof(TOKEN, 37017, 1_000_000);
    expect(proof).not.toContain(TOKEN);
    expect(new ProofChecker().accepts(proof, 'another-token', 37017, 1_000_000)).toBe(false);
    expect(new ProofChecker().accepts(proof, TOKEN, 37018, 1_000_000)).toBe(false);
    expect(new ProofChecker().accepts(proof, undefined, 37017, 1_000_000)).toBe(false);
    expect(proofs.accepts(proof, TOKEN, 37017, 1_000_500)).toBe(true);
    // The same proof again: read off the wire and replayed.
    expect(proofs.accepts(proof, TOKEN, 37017, 1_000_600)).toBe(false);
  });

  it('is refused when it is old, from the future, altered or not a proof', () => {
    const proof = releaseProof(TOKEN, 37017, 1_000_000);
    expect(new ProofChecker().accepts(proof, TOKEN, 37017, 1_000_000 + PROOF_MAX_AGE_MS + 1)).toBe(false);
    expect(new ProofChecker().accepts(proof, TOKEN, 37017, 1_000_000 - PROOF_MAX_AGE_MS - 1)).toBe(false);
    const [v, nonce, time, mac] = proof.split('.');
    expect(new ProofChecker().accepts([v, nonce, String(Number(time) + 1), mac].join('.'), TOKEN, 37017, 1_000_000)).toBe(false);
    expect(new ProofChecker().accepts([v, 'f'.repeat(32), time, mac].join('.'), TOKEN, 37017, 1_000_000)).toBe(false);
    expect(new ProofChecker().accepts([v, nonce, time, '0'.repeat(64)].join('.'), TOKEN, 37017, 1_000_000)).toBe(false);
    for (const bad of [undefined, '', TOKEN, `Bearer ${TOKEN}`, 'v1.x.y.z']) expect(new ProofChecker().accepts(bad, TOKEN, 37017, 1_000_000)).toBe(false);
  });

  it('accepts two different proofs made at the same time', () => {
    const proofs = new ProofChecker();
    expect(proofs.accepts(releaseProof(TOKEN, 37017, 5000), TOKEN, 37017, 5000)).toBe(true);
    expect(proofs.accepts(releaseProof(TOKEN, 37017, 5000), TOKEN, 37017, 5000)).toBe(true);
  });
});

describe('bearerMatches', () => {
  it('takes only the exact token', () => {
    expect(bearerMatches(`Bearer ${TOKEN}`, TOKEN)).toBe(true);
    expect(bearerMatches(`bearer   ${TOKEN} `, TOKEN)).toBe(true);
    for (const bad of [undefined, '', TOKEN, `Bearer ${TOKEN}x`, `Bearer ${TOKEN.slice(1)}`, 'Basic abc']) expect(bearerMatches(bad, TOKEN)).toBe(false);
    expect(bearerMatches(`Bearer ${TOKEN}`, undefined)).toBe(false);
  });
});

describe('requestRelease', () => {
  it('never sends the access token to whoever listens on the port', async () => {
    // A program squatting the port, answering with Mongoster's mark to pass for it.
    const seen: { url?: string; headers: http.IncomingHttpHeaders }[] = [];
    const port = await listen((req, res) => {
      seen.push({ url: req.url, headers: req.headers });
      res.writeHead(200, { [MARK]: '9.9.9', Connection: 'close' });
      res.end('{}');
    });
    expect(await probe(port)).toBe('mongoster');
    expect(await requestRelease(port, TOKEN)).toBe(200);
    expect(seen).toHaveLength(2);
    for (const r of seen) {
      expect(r.headers.authorization).toBeUndefined();
      expect(JSON.stringify(r.headers)).not.toContain(TOKEN);
    }
    expect(seen[1].url).toBe(RELEASE_PATH);
    // What it got is of no use on a Mongoster listening elsewhere: the proof names the port.
    expect(new ProofChecker().accepts(seen[1].headers[PROOF_HEADER] as string, TOKEN, port + 1)).toBe(false);
  });

  it('moves the port when the other window has the same token, and is refused with another one', async () => {
    const server = await mcp();
    expect(await requestRelease(server.port, 'another-token')).toBe(401);
    expect(server.released()).toBe(0);
    expect(await requestRelease(server.port, TOKEN)).toBe(200);
    expect(server.released()).toBe(1);
  });

  it('says a free port is free and a port without the mark is another program', async () => {
    const other = await listen((_req, res) => res.end('hello'));
    expect(await probe(other)).toBe('other');
    const server = http.createServer();
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const free = (server.address() as AddressInfo).port;
    await new Promise((resolve) => server.close(resolve));
    expect(await probe(free)).toBe('free');
    expect(await requestRelease(free, TOKEN)).toBe(0);
  });
});

describe('handleRequest', () => {
  it('answers a message that carries the token, with the mark and no kept-alive connection', async () => {
    const server = await mcp();
    const res = await request(server.port, { headers: auth, body: JSON.stringify(rpc(1)) });
    expect(res.status).toBe(200);
    expect(JSON.parse(res.body)).toEqual({ jsonrpc: '2.0', id: 1, result: {} });
    expect(res.headers[MARK]).toBe('1.2.3');
    expect(res.headers.connection).toBe('close');
    expect(server.answered).toEqual([rpc(1)]);
    // A notification has no answer.
    expect((await request(server.port, { headers: auth, body: JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) })).status).toBe(202);
  });

  it('refuses another Host and the Origin of a web page', async () => {
    const server = await mcp();
    const body = JSON.stringify(rpc(1));
    expect((await request(server.port, { headers: { ...auth, Host: `evil.example:${server.port}` }, body })).status).toBe(403);
    expect((await request(server.port, { headers: { ...auth, Host: '127.0.0.1:1' }, body })).status).toBe(403);
    expect((await request(server.port, { headers: { ...auth, Origin: 'https://evil.example' }, body })).status).toBe(403);
    expect((await request(server.port, { headers: { ...auth, Origin: 'http://localhost.evil.example' }, body })).status).toBe(403);
    expect((await request(server.port, { headers: { ...auth, Host: `localhost:${server.port}`, Origin: 'http://localhost:3000' }, body })).status).toBe(200);
    expect(server.answered).toHaveLength(1);
  });

  it('refuses another path, a missing or wrong token and another method', async () => {
    const server = await mcp();
    const body = JSON.stringify(rpc(1));
    expect((await request(server.port, { path: '/other', headers: auth, body })).status).toBe(404);
    const none = await request(server.port, { body });
    expect(none.status).toBe(401);
    expect(none.headers['www-authenticate']).toBe('Bearer');
    expect((await request(server.port, { headers: { Authorization: 'Bearer wrong' }, body })).status).toBe(401);
    const get = await request(server.port, { method: 'GET', headers: auth });
    expect(get.status).toBe(405);
    expect(get.headers.allow).toBe('POST');
    expect(server.answered).toEqual([]);
  });

  it('does not release the port for the token alone, a replayed proof or a GET', async () => {
    const server = await mcp();
    // What a Mongoster older than the proof sends: refused, and the token is not what moves the port.
    expect((await request(server.port, { path: RELEASE_PATH, headers: auth })).status).toBe(401);
    const proof = releaseProof(TOKEN, server.port);
    expect((await request(server.port, { path: RELEASE_PATH, method: 'GET', headers: { [PROOF_HEADER]: releaseProof(TOKEN, server.port) } })).status).toBe(405);
    expect(server.released()).toBe(0);
    expect((await request(server.port, { path: RELEASE_PATH, headers: { [PROOF_HEADER]: proof } })).status).toBe(200);
    expect((await request(server.port, { path: RELEASE_PATH, headers: { [PROOF_HEADER]: proof } })).status).toBe(401);
    expect(server.released()).toBe(1);
    // The proof is no token: it does not reach the tools.
    expect((await request(server.port, { headers: { [PROOF_HEADER]: releaseProof(TOKEN, server.port), Authorization: `Bearer ${proof}` }, body: JSON.stringify(rpc(1)) })).status).toBe(401);
    expect(server.answered).toEqual([]);
  });

  it('answers 413 to a body over the limit, and the client receives it', async () => {
    const server = await mcp();
    const res = await request(server.port, { headers: auth, body: Buffer.alloc(MAX_BODY + 200_000, 0x20) });
    expect(res.status).toBe(413);
    expect(JSON.parse(res.body)).toEqual({ error: 'Request too large' });
    expect(server.answered).toEqual([]);
    // Just under the limit it is read.
    const ok = await request(server.port, { headers: auth, body: JSON.stringify(rpc(2)).padEnd(MAX_BODY - 10, ' ') });
    expect(ok.status).toBe(200);
  });

  it('answers a parse error to what is not JSON', async () => {
    const server = await mcp();
    const res = await request(server.port, { headers: auth, body: '{ not json' });
    expect(res.status).toBe(400);
    expect(JSON.parse(res.body).error.code).toBe(PARSE_ERROR);
  });

  it('answers a batch up to the limit and refuses a longer one without running any of it', async () => {
    const server = await mcp();
    const batch = (n: number) => JSON.stringify(Array.from({ length: n }, (_, i) => rpc(i + 1)));
    const ok = await request(server.port, { headers: auth, body: batch(MAX_BATCH) });
    expect(ok.status).toBe(200);
    expect(JSON.parse(ok.body)).toHaveLength(MAX_BATCH);
    expect(server.answered).toHaveLength(MAX_BATCH);
    const tooMany = await request(server.port, { headers: auth, body: batch(MAX_BATCH + 1) });
    expect(tooMany.status).toBe(400);
    expect(JSON.parse(tooMany.body)).toMatchObject({ jsonrpc: '2.0', id: null, error: { code: INVALID_REQUEST } });
    expect(server.answered).toHaveLength(MAX_BATCH);
  });
});

describe('logText', () => {
  it('keeps a line of the log on one line and short', () => {
    expect(logText('a\nb\r\n  c')).toBe('a b c');
    const long = logText('x'.repeat(5000));
    expect(long).toHaveLength(301);
    expect(long.endsWith('…')).toBe(true);
  });
});
