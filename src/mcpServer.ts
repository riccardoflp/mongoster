// MCP server: lets an AI assistant (Claude Code, Copilot, Cursor…) explore the saved connections, read
// documents and open queries, aggregations and searches in Mongoster's tabs. Streamable HTTP on
// 127.0.0.1 only, behind a bearer token kept in the secret storage. It never writes to a database.
//
// Every VS Code window runs the extension, but only one can listen on the port: the window in use.
// A window that gets the focus asks the one holding the port to release it, so the tabs the AI opens
// appear in the window the user worked in last.
import * as vscode from 'vscode';
import * as http from 'http';
import * as net from 'net';
import { randomBytes, timingSafeEqual } from 'crypto';
import { McpTool, PARSE_ERROR, ServerInfo, handleMessage } from './shared/mcp';
import { ToolHost, mcpTools } from './mcpTools';

const TOKEN_KEY = 'mongoster.mcp.token';
const PATH = '/mcp';
/** Asked by another window of this VS Code when it gets the focus. */
const RELEASE_PATH = '/mcp/release';
/** On every response: how a window recognizes Mongoster on the port, without sending the token. */
const MARK = 'x-mongoster-mcp';
const MAX_BODY = 1024 * 1024;
export const DEFAULT_PORT = 37017;
export const MIN_PORT = 1024;
export const MAX_PORT = 65535;
/** A window without the port checks this often whether it is free (the window that had it closed). */
const RETRY_MS = 3000;
const PROBE_MS = 800;

const INSTRUCTIONS = `Mongoster is the MongoDB extension open in the user's VS Code. Its tools read the connections the user saved there and never write to a database.
Start with list_connections, then list_databases and list_collections. Call describe_collection before writing a filter or a pipeline, to use the real field names and types.
Filters, sorts, projections and pipelines are in mongosh syntax: ObjectId("…"), ISODate("…"), NumberLong(…), /regex/i.
find_documents and aggregate return the documents to you; open_query, open_aggregation and open_search show them to the user in a Mongoster tab, which is better when the user wants to see, browse or edit the results.`;

const config = () => vscode.workspace.getConfiguration('mongoster.mcp');
const focused = () => vscode.window.state?.focused ?? true;
const delay = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

export class McpServer implements vscode.Disposable {
  private server?: http.Server;
  private listening?: number;
  private token?: string;
  /** Another window of this VS Code has the port: nothing to fix, it comes here with the focus. */
  private elsewhere = false;
  /** Why the server can't run here. */
  private failure?: string;
  private lastLog = '';
  /** Ports already reported as taken: the warning shows once. */
  private readonly warned = new Set<number>();
  private readonly output = vscode.window.createOutputChannel('Mongoster MCP');
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.output, this.changed];
  private readonly info: ServerInfo;
  private readonly retry: ReturnType<typeof setInterval>;
  /** Starts and stops run one after the other: settings, focus and commands can ask at the same time. */
  private queue = Promise.resolve();

  constructor(
    private readonly context: vscode.ExtensionContext,
    private readonly host: ToolHost,
  ) {
    this.info = { name: 'mongoster', title: 'Mongoster', version: String(context.extension?.packageJSON?.version ?? '0.0.0'), instructions: INSTRUCTIONS };
    this.disposables.push(
      vscode.workspace.onDidChangeConfiguration((e) => {
        if (e.affectsConfiguration('mongoster.mcp.enabled') || e.affectsConfiguration('mongoster.mcp.port')) void this.restart();
      }),
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused) void this.claim();
      }),
    );
    // A new token generated in another window.
    const secretsChanged = context.secrets.onDidChange?.((e) => {
      if (e.key === TOKEN_KEY) void this.readToken();
    });
    if (secretsChanged) this.disposables.push(secretsChanged);
    this.retry = setInterval(() => {
      if (this.enabled() && this.listening === undefined) void this.enqueue(() => this.start(false, true));
    }, RETRY_MS);
    this.retry.unref?.();
    this.registerProvider();
  }

  enabled(): boolean {
    return config().get<boolean>('enabled', false);
  }

  port(): number {
    return config().get<number>('port', DEFAULT_PORT);
  }

  url(): string {
    return `http://127.0.0.1:${this.port()}${PATH}`;
  }

  private enqueue(task: () => Promise<void>): Promise<void> {
    this.queue = this.queue.then(task).catch((err) => this.log(`Error: ${err instanceof Error ? err.message : String(err)}`));
    return this.queue;
  }

  /** Starts or stops the server to match the settings. */
  restart(): Promise<void> {
    return this.enqueue(async () => {
      this.stop();
      this.elsewhere = false;
      this.failure = undefined;
      if (this.enabled()) await this.start(focused(), false);
      this.changed.fire();
    });
  }

  /** This window is in use: the port moves here, so the tabs the AI opens appear in it. */
  private claim(): Promise<void> {
    return this.enqueue(async () => {
      if (!this.enabled() || this.listening !== undefined) return;
      await this.start(true, false);
      this.changed.fire();
    });
  }

  /**
   * Listens on the port. When Mongoster in another window has it, `take` asks for it (this window
   * is the one in use); otherwise that window keeps it. `quiet` is the periodic check: a port
   * known to be taken isn't looked into again.
   */
  private async start(take: boolean, quiet: boolean): Promise<void> {
    this.token = await this.ensureToken();
    const port = this.port();
    for (let attempt = 0; attempt < 20; attempt++) {
      const error = await this.listen(port);
      if (!error) {
        this.elsewhere = false;
        this.failure = undefined;
        this.warned.delete(port);
        this.logOnce(`Listening on ${this.url()}`);
        return;
      }
      if (error.code !== 'EADDRINUSE') return this.blocked(port, error.message, take);
      if (quiet && (this.elsewhere || this.failure)) return;
      const owner = await probe(port);
      if (owner === 'free') {
        // Just released, or still closing.
        await delay(25);
        continue;
      }
      if (owner === 'other') return this.blocked(port, `Port ${port} is used by another program.`, take);
      if (!take) {
        this.elsewhere = true;
        this.failure = undefined;
        this.logOnce(`Port ${port} is with Mongoster in another VS Code window: it comes here when this window is used.`);
        return;
      }
      const status = await release(port, this.token);
      if (status === 401) return this.blocked(port, `Port ${port} is used by Mongoster in another VS Code installation, which has a different access token.`, take);
      if (status !== 200) await delay(50);
    }
    this.blocked(port, `Port ${port} is taken and was not released.`, take);
  }

  private listen(port: number): Promise<NodeJS.ErrnoException | undefined> {
    const server = http.createServer((req, res) => void this.handle(req, res, server, port));
    return new Promise((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => resolve(err));
      server.listen(port, '127.0.0.1', () => {
        this.server = server;
        this.listening = port;
        resolve(undefined);
      });
    });
  }

  /** Stops listening right away; the calls in progress finish. */
  private stop(): void {
    const server = this.server;
    this.server = undefined;
    if (this.listening !== undefined) this.logOnce('Stopped');
    this.listening = undefined;
    server?.close();
    server?.closeIdleConnections?.();
  }

  private blocked(port: number, message: string, notify: boolean): void {
    this.elsewhere = false;
    this.failure = message;
    this.logOnce(`Not started: ${message}`);
    if (!notify || !focused() || this.warned.has(port)) return;
    this.warned.add(port);
    void vscode.window.showWarningMessage(`Mongoster's MCP server is not running. ${message}`, 'Change Port').then((picked) => {
      if (picked === 'Change Port') void this.changePort();
    });
  }

  private async ensureToken(): Promise<string> {
    const saved = await this.context.secrets.get(TOKEN_KEY);
    if (saved) return saved;
    const token = randomBytes(32).toString('base64url');
    await this.context.secrets.store(TOKEN_KEY, token);
    return token;
  }

  private async readToken(): Promise<void> {
    this.token = await this.context.secrets.get(TOKEN_KEY);
    this.changed.fire();
  }

  async newToken(): Promise<void> {
    const token = randomBytes(32).toString('base64url');
    await this.context.secrets.store(TOKEN_KEY, token);
    this.token = token;
    this.log('New access token: the old one no longer works');
    this.changed.fire();
  }

  private tools(): McpTool[] {
    return mcpTools(this.host);
  }

  private log(line: string): void {
    this.lastLog = line;
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  /** The state of the server: not repeated by the periodic check. */
  private logOnce(line: string): void {
    if (line !== this.lastLog) this.log(line);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, server: http.Server, port: number): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      // No kept-alive connections: after the port moves to another window, no client stays on this one.
      res.writeHead(status, { ...(body !== undefined && { 'Content-Type': 'application/json' }), Connection: 'close', [MARK]: this.info.version, ...headers });
      res.end(text);
    };
    // DNS rebinding: only the loopback names, and no web page of another origin.
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) return send(403, { error: 'Forbidden host' });
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return send(403, { error: 'Forbidden origin' });
    const route = (req.url ?? '').split('?')[0];
    if (route !== PATH && route !== RELEASE_PATH) return send(404, { error: 'Not found' });
    if (!this.authorized(req.headers.authorization)) return send(401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed' }, { Allow: 'POST' });

    if (route === RELEASE_PATH) {
      req.resume();
      if (this.server === server) {
        this.stop();
        this.elsewhere = true;
        this.logOnce(`Port ${port} moved to the VS Code window in use: it comes back when this window is used.`);
        this.changed.fire();
      }
      return send(200, { released: true });
    }

    let body: string;
    try {
      body = await readBody(req);
    } catch {
      return send(413, { error: 'Request too large' });
    }
    let message: unknown;
    try {
      message = JSON.parse(body);
    } catch {
      return send(400, { jsonrpc: '2.0', id: null, error: { code: PARSE_ERROR, message: 'Parse error' } });
    }
    const tools = this.tools();
    const answer = (m: unknown) => handleMessage(m, tools, this.info, (tool, args, outcome) => this.log(`${tool} ${summary(args)} → ${outcome}`));
    if (Array.isArray(message)) {
      const responses = (await Promise.all(message.map(answer))).filter((r) => r !== undefined);
      return responses.length ? send(200, responses) : send(202);
    }
    const response = await answer(message);
    return response ? send(200, response) : send(202);
  }

  private authorized(header: string | undefined): boolean {
    const token = this.token;
    const given = /^Bearer\s+(.+)$/i.exec(header ?? '')?.[1]?.trim();
    if (!token || !given) return false;
    const a = Buffer.from(given);
    const b = Buffer.from(token);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  /** VS Code's own MCP support (Copilot agent mode): the server appears there with its token, nothing to configure. */
  private registerProvider(): void {
    const api = vscode as unknown as {
      lm?: { registerMcpServerDefinitionProvider?: (id: string, provider: unknown) => vscode.Disposable };
      McpHttpServerDefinition?: new (label: string, uri: vscode.Uri, headers?: Record<string, string>, version?: string) => unknown;
    };
    const Definition = api.McpHttpServerDefinition;
    if (!api.lm?.registerMcpServerDefinitionProvider || !Definition) return;
    try {
      this.disposables.push(
        api.lm.registerMcpServerDefinitionProvider('mongoster', {
          onDidChangeMcpServerDefinitions: this.changed.event,
          provideMcpServerDefinitions: async () => {
            if (!this.enabled()) return [];
            const token = this.token ?? (await this.ensureToken());
            return [new Definition('Mongoster', vscode.Uri.parse(this.url()), { Authorization: `Bearer ${token}` }, this.info.version)];
          },
        }),
      );
    } catch (err) {
      this.log(`VS Code's MCP support is not available: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  private status(): string {
    if (this.listening !== undefined) return `Running on ${this.url()}`;
    if (this.elsewhere) return 'Running in another VS Code window';
    return `Not running: ${this.failure ?? 'starting'}`;
  }

  /** The command: turns the server on and gives the configuration for the AI tools. */
  async setup(): Promise<void> {
    if (!this.enabled()) {
      await config().update('enabled', true, vscode.ConfigurationTarget.Global);
      await this.restart();
    } else await this.claim();
    const token = this.token ?? (await this.ensureToken());
    const url = this.url();
    const items: (vscode.QuickPickItem & { run: () => Promise<void> | void })[] = [
      {
        label: '$(terminal) Copy the command for Claude Code',
        detail: `claude mcp add --transport http mongoster ${url} --header "Authorization: Bearer …"`,
        run: () => copy(claudeCommand(url, token)),
      },
      {
        label: '$(json) Copy the JSON configuration',
        detail: 'For the mcpServers of .mcp.json, Cursor, Windsurf and other clients that support HTTP servers',
        run: () => copy(JSON.stringify({ mcpServers: { mongoster: { type: 'http', url, headers: { Authorization: `Bearer ${token}` } } } }, null, 2)),
      },
      { label: '$(output) Show the log', detail: 'The tools the AI called', run: () => this.output.show() },
      {
        label: '$(plug) Change the port…',
        detail: `Now ${this.port()}. The configured clients need the new address`,
        run: () => this.changePort(),
      },
      {
        label: '$(key) Generate a new access token',
        detail: 'The configured clients stop working until they get the new one',
        run: async () => {
          await this.newToken();
          void vscode.window.showInformationMessage("Mongoster's MCP server has a new access token: copy the configuration again.");
        },
      },
      {
        label: '$(circle-slash) Turn the server off',
        run: async () => {
          await config().update('enabled', false, vscode.ConfigurationTarget.Global);
          await this.restart();
        },
      },
    ];
    const picked = await vscode.window.showQuickPick(items, {
      title: `Mongoster MCP server · ${this.status()}`,
      placeHolder: 'GitHub Copilot in VS Code finds it on its own. For other AI tools, copy the configuration.',
    });
    await picked?.run();
  }

  /** The command: asks for another port, suggesting a free one when the current one is taken. */
  async changePort(): Promise<void> {
    const current = this.port();
    const taken = this.enabled() && this.listening === undefined && !this.elsewhere && !!this.failure;
    const suggested = taken ? await freePort(current + 1) : current;
    const answer = await vscode.window.showInputBox({
      title: "Port of Mongoster's MCP server",
      prompt: `On 127.0.0.1, now ${current}${taken ? ' (taken)' : ''}. The AI clients you configured need the new address afterwards.`,
      value: String(suggested),
      validateInput: (v) => (validPort(v) ? undefined : `A number from ${MIN_PORT} to ${MAX_PORT}`),
    });
    if (answer === undefined || !validPort(answer)) return;
    const port = Number(answer.trim());
    if (port === current) return;
    await config().update('port', port, vscode.ConfigurationTarget.Global);
    await this.restart();
    if (this.listening !== port) return;
    const again = 'Copy Configuration…';
    void vscode.window
      .showInformationMessage(`Mongoster's MCP server now listens on port ${port}. Give the new address to the AI clients configured with port ${current}; GitHub Copilot follows on its own.`, again)
      .then((picked) => {
        if (picked === again) void this.setup();
      });
  }

  dispose(): void {
    clearInterval(this.retry);
    const server = this.server;
    this.stop();
    server?.closeAllConnections?.();
    this.disposables.forEach((d) => d.dispose());
  }
}

export const claudeCommand = (url: string, token: string) => `claude mcp add --transport http mongoster ${url} --header "Authorization: Bearer ${token}"`;

const validPort = (text: string) => /^\d+$/.test(text.trim()) && Number(text) >= MIN_PORT && Number(text) <= MAX_PORT;

async function copy(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  void vscode.window.showInformationMessage('Copied. It contains the access token of the MCP server: keep it private.');
}

/** Who listens on the port: nobody, Mongoster (its responses carry the mark) or something else. The token is not sent. */
function probe(port: number): Promise<'free' | 'mongoster' | 'other'> {
  return new Promise((resolve) => {
    const req = http.request({ host: '127.0.0.1', port, path: PATH, method: 'GET', timeout: PROBE_MS, agent: false }, (res) => {
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

/** Asks Mongoster in another window for the port; the HTTP status, 0 when it didn't answer. */
function release(port: number, token: string): Promise<number> {
  return new Promise((resolve) => {
    const req = http.request(
      { host: '127.0.0.1', port, path: RELEASE_PATH, method: 'POST', timeout: PROBE_MS, agent: false, headers: { Authorization: `Bearer ${token}`, 'Content-Length': '0' } },
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

/** The first port from `from` nothing listens on. */
async function freePort(from: number): Promise<number> {
  for (let port = Math.max(from, MIN_PORT); port <= Math.min(from + 50, MAX_PORT); port++) {
    const free = await new Promise<boolean>((resolve) => {
      const server = net.createServer();
      server.once('error', () => resolve(false));
      server.listen(port, '127.0.0.1', () => server.close(() => resolve(true)));
    });
    if (free) return port;
  }
  return from;
}

function readBody(req: http.IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let size = 0;
    req.on('data', (c: Buffer) => {
      size += c.length;
      if (size > MAX_BODY) {
        reject(new Error('too large'));
        req.destroy();
        return;
      }
      chunks.push(c);
    });
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

/** The arguments for the log, on one line and short. */
function summary(args: Record<string, unknown>): string {
  const text = JSON.stringify(args);
  return text.length > 300 ? `${text.slice(0, 300)}…` : text;
}
