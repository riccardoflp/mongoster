// The HTTP side of the MCP server: which requests reach the tools (Host, Origin, path, access token,
// method, body size, batch size), and how a window asks the one holding the port to release it without
// ever sending the access token. No vscode dependency, so the checks are tested against a real socket.
import * as http from 'http';
import { createHmac, randomBytes, timingSafeEqual } from 'crypto';
import { INVALID_REQUEST, PARSE_ERROR } from '../shared/mcp';

export const MCP_PATH = '/mcp';
/** Asked by another window of this VS Code when it gets the focus. */
export const RELEASE_PATH = '/mcp/release';
/** On every response: how a window recognizes Mongoster on the port, without sending anything secret. */
export const MARK = 'x-mongoster-mcp';
/** Carries the proof of a release request. */
export const PROOF_HEADER = 'x-mongoster-release';
export const MAX_BODY = 1024 * 1024;
/** Requests of one JSON-RPC batch: each one can run a query for MAX_TIME_MS. */
export const MAX_BATCH = 20;
/** A release proof is accepted this long after it was made. */
export const PROOF_MAX_AGE_MS = 30_000;
/** A body over MAX_BODY is read and thrown away up to here, so that its sender gets the 413; past it the connection is cut. */
const DRAIN_MAX = 32 * MAX_BODY;
const PROBE_MS = 800;

// ---- release proof

const proofMac = (token: string, port: number, nonce: string, time: number): Buffer =>
  createHmac('sha256', token).update(`release\n${port}\n${nonce}\n${time}`).digest();

/**
 * The proof a window sends to ask for the port: a random nonce, the time and an HMAC-SHA256 of both and
 * the port, keyed with the access token. Whoever listens on the port learns that the sender has the
 * token but not the token itself, so a program squatting the port gets nothing it can use on Mongoster.
 */
export function releaseProof(token: string, port: number, now = Date.now(), nonce = randomBytes(16).toString('hex')): string {
  return `v1.${nonce}.${now}.${proofMac(token, port, nonce, now).toString('hex')}`;
}

/** Checks release proofs, each accepted once: one read off the wire can't be sent again. */
export class ProofChecker {
  /** The nonces seen, with the time their proof stops being accepted anyway. */
  private readonly seen = new Map<string, number>();

  accepts(header: string | undefined, token: string | undefined, port: number, now = Date.now()): boolean {
    const match = /^v1\.([0-9a-f]{32})\.(\d{1,15})\.([0-9a-f]{64})$/.exec(header ?? '');
    if (!match || !token) return false;
    const [, nonce, timeText, mac] = match;
    const time = Number(timeText);
    if (Math.abs(now - time) > PROOF_MAX_AGE_MS) return false;
    const given = Buffer.from(mac, 'hex');
    const expected = proofMac(token, port, nonce, time);
    if (given.length !== expected.length || !timingSafeEqual(given, expected)) return false;
    for (const [n, until] of this.seen) if (until < now) this.seen.delete(n);
    if (this.seen.has(nonce)) return false;
    this.seen.set(nonce, time + PROOF_MAX_AGE_MS);
    return true;
  }
}

/** Whether the Authorization header carries the access token. */
export function bearerMatches(header: string | undefined, token: string | undefined): boolean {
  const given = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim();
  if (!token || !given) return false;
  const a = Buffer.from(given);
  const b = Buffer.from(token);
  return a.length === b.length && timingSafeEqual(a, b);
}

// ---- server side

/** What the HTTP handler needs from the server. */
export interface HttpHost {
  /** The port the server listens on: the only one accepted in the Host header. */
  port(): number;
  /** Mongoster's version, the value of the mark. */
  version: string;
  token(): string | undefined;
  /** Answers one JSON-RPC message; undefined for a notification. */
  answer(message: unknown): Promise<unknown>;
  /** Another window proved it has the token and asks for the port. */
  release(): void;
}

/**
 * The body as text; undefined when it is over `max`. A body too large is still read to its end (and thrown
 * away), because an answer written while the client is sending is lost with the connection.
 */
export function readBody(req: http.IncomingMessage, max = MAX_BODY, drainMax = DRAIN_MAX): Promise<string | undefined> {
  return new Promise((resolve, reject) => {
    let chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > drainMax) {
        reject(new Error('The request is too large to answer'));
        req.destroy();
      } else if (size > max) chunks = [];
      else chunks.push(c);
    });
    req.on('end', () => resolve(size > max ? undefined : Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/**
 * Answers one HTTP request. The checks, in this order: Host (403), Origin (403), path (404), the access
 * token or, to release the port, the proof of having it (401), method (405), body size (413), JSON (400),
 * batch size (400).
 */
export async function handleRequest(req: http.IncomingMessage, res: http.ServerResponse, host: HttpHost, proofs: ProofChecker): Promise<void> {
  const port = host.port();
  const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
    const text = body === undefined ? '' : JSON.stringify(body);
    // What the client is still sending is thrown away instead of being left unread on the connection.
    req.resume();
    // No kept-alive connections: after the port moves to another window, no client stays on this one.
    res.writeHead(status, { ...(body !== undefined && { 'Content-Type': 'application/json' }), Connection: 'close', [MARK]: host.version, ...headers });
    res.end(text);
  };
  const rpcError = (code: number, message: string) => send(400, { jsonrpc: '2.0', id: null, error: { code, message } });
  // DNS rebinding: only the loopback names, and no web page of another origin.
  const hostHeader = (req.headers.host ?? '').toLowerCase();
  if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) return send(403, { error: 'Forbidden host' });
  const origin = req.headers.origin;
  if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return send(403, { error: 'Forbidden origin' });
  const route = (req.url ?? '').split('?')[0];
  if (route !== MCP_PATH && route !== RELEASE_PATH) return send(404, { error: 'Not found' });

  if (route === RELEASE_PATH) {
    const proof = req.headers[PROOF_HEADER];
    if (!proofs.accepts(Array.isArray(proof) ? proof[0] : proof, host.token(), port)) return send(401, { error: 'Unauthorized' });
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed' }, { Allow: 'POST' });
    req.resume();
    host.release();
    return send(200, { released: true });
  }

  if (!bearerMatches(req.headers.authorization, host.token())) return send(401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
  if (req.method !== 'POST') return send(405, { error: 'Method not allowed' }, { Allow: 'POST' });

  let body: string | undefined;
  try {
    body = await readBody(req);
  } catch {
    // The connection is gone or was cut: there is nobody to answer.
    return;
  }
  if (body === undefined) return send(413, { error: 'Request too large' });
  let message: unknown;
  try {
    message = JSON.parse(body);
  } catch {
    return rpcError(PARSE_ERROR, 'Parse error');
  }
  if (Array.isArray(message)) {
    if (message.length > MAX_BATCH) return rpcError(INVALID_REQUEST, `Too many requests in one batch: at most ${MAX_BATCH}`);
    const responses = (await Promise.all(message.map((m) => host.answer(m)))).filter((r) => r !== undefined);
    return responses.length ? send(200, responses) : send(202);
  }
  const response = await host.answer(message);
  return response ? send(200, response) : send(202);
}

// ---- client side: a window looking at the port another one holds

/** Who listens on the port: nobody, Mongoster (its responses carry the mark) or something else. Nothing secret is sent. */
export function probe(port: number): Promise<'free' | 'mongoster' | 'other'> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: MCP_PATH, method: 'GET', timeout: PROBE_MS, agent: false }, (res) => {
      res.resume();
      resolve(res.headers[MARK] ? 'mongoster' : 'other');
    });
    req.on('timeout', () => {
      resolve('other');
      req.destroy();
    });
    req.on('error', (err: NodeJS.ErrnoException) => resolve(err.code === 'ECONNREFUSED' ? 'free' : 'other'));
    req.end();
  });
}

/**
 * Asks Mongoster in another window for the port; the HTTP status, 0 when it didn't answer. The mark only
 * says that the listener claims to be Mongoster, and any local program can claim it: the request carries
 * a proof of having the access token (releaseProof), never the token.
 */
export function requestRelease(port: number, token: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: RELEASE_PATH, method: 'POST', timeout: PROBE_MS, agent: false, headers: { [PROOF_HEADER]: releaseProof(token, port), 'Content-Length': '0' } },
      (res) => {
        res.resume();
        resolve(res.statusCode ?? 0);
      },
    );
    req.on('timeout', () => {
      resolve(0);
      req.destroy();
    });
    req.on('error', () => resolve(0));
    req.end();
  });
}
