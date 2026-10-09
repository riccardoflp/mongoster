// MCP server: lets an AI assistant (Claude Code, Copilot, Cursor…) explore the saved connections, read
// documents and open queries, aggregations and searches in Mongoster's tabs. Streamable HTTP on
// 127.0.0.1 only, behind a bearer token kept in the secret storage. It never writes to a database.
import * as vscode from 'vscode';
import * as http from 'http';
import { randomBytes, timingSafeEqual } from 'crypto';
import { McpTool, PARSE_ERROR, ServerInfo, handleMessage } from './shared/mcp';
import { ToolHost, mcpTools } from './mcpTools';

const TOKEN_KEY = 'mongoster.mcp.token';
const PATH = '/mcp';
const MAX_BODY = 1024 * 1024;
export const DEFAULT_PORT = 37017;

const INSTRUCTIONS = `Mongoster is the MongoDB extension open in the user's VS Code. Its tools read the connections the user saved there and never write to a database.
Start with list_connections, then list_databases and list_collections. Call describe_collection before writing a filter or a pipeline, to use the real field names and types.
Filters, sorts, projections and pipelines are in mongosh syntax: ObjectId("…"), ISODate("…"), NumberLong(…), /regex/i.
find_documents and aggregate return the documents to you; open_query, open_aggregation and open_search show them to the user in a Mongoster tab, which is better when the user wants to see, browse or edit the results.`;

const config = () => vscode.workspace.getConfiguration('mongoster.mcp');

export class McpServer implements vscode.Disposable {
  private server?: http.Server;
  private listening?: number;
  private token?: string;
  private failure?: string;
  private readonly output = vscode.window.createOutputChannel('Mongoster MCP');
  private readonly changed = new vscode.EventEmitter<void>();
  private readonly disposables: vscode.Disposable[] = [this.output, this.changed];
  private readonly info: ServerInfo;
  /** Restarts run one after the other: a settings change and the setup command can ask at the same time. */
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
      // The port is taken by another window: try again when this one is focused (the other may have closed).
      vscode.window.onDidChangeWindowState((s) => {
        if (s.focused && this.enabled() && this.listening === undefined) void this.restart();
      }),
    );
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

  /** Starts or stops the server to match the settings. */
  restart(): Promise<void> {
    this.queue = this.queue.then(() => this.apply());
    return this.queue;
  }

  private async apply(): Promise<void> {
    await this.close();
    if (!this.enabled()) {
      this.changed.fire();
      return;
    }
    this.token = await this.ensureToken();
    const port = this.port();
    const server = http.createServer((req, res) => void this.handle(req, res, port));
    this.server = server;
    await new Promise<void>((resolve) => {
      server.once('error', (err: NodeJS.ErrnoException) => {
        this.failure = err.code === 'EADDRINUSE' ? `Port ${port} is in use, probably by Mongoster in another VS Code window: the AI opens tabs there.` : err.message;
        this.log(`Not started: ${this.failure}`);
        if (this.server === server) this.server = undefined;
        resolve();
      });
      server.listen(port, '127.0.0.1', () => {
        this.listening = port;
        this.failure = undefined;
        this.log(`Listening on ${this.url()}`);
        resolve();
      });
    });
    this.changed.fire();
  }

  private async close(): Promise<void> {
    const server = this.server;
    this.server = undefined;
    if (this.listening !== undefined) this.log('Stopped');
    this.listening = undefined;
    if (server?.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
    server?.closeAllConnections?.();
  }

  private async ensureToken(): Promise<string> {
    const saved = await this.context.secrets.get(TOKEN_KEY);
    if (saved) return saved;
    const token = randomBytes(32).toString('base64url');
    await this.context.secrets.store(TOKEN_KEY, token);
    return token;
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
    this.output.appendLine(`[${new Date().toLocaleTimeString()}] ${line}`);
  }

  private async handle(req: http.IncomingMessage, res: http.ServerResponse, port: number): Promise<void> {
    const send = (status: number, body?: unknown, headers: Record<string, string> = {}) => {
      const text = body === undefined ? '' : JSON.stringify(body);
      res.writeHead(status, { ...(body !== undefined && { 'Content-Type': 'application/json' }), ...headers });
      res.end(text);
    };
    // DNS rebinding: only the loopback names, and no web page of another origin.
    const hostHeader = (req.headers.host ?? '').toLowerCase();
    if (hostHeader !== `127.0.0.1:${port}` && hostHeader !== `localhost:${port}`) return send(403, { error: 'Forbidden host' });
    const origin = req.headers.origin;
    if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/i.test(origin)) return send(403, { error: 'Forbidden origin' });
    if ((req.url ?? '').split('?')[0] !== PATH) return send(404, { error: 'Not found' });
    if (!this.authorized(req.headers.authorization)) return send(401, { error: 'Unauthorized' }, { 'WWW-Authenticate': 'Bearer' });
    if (req.method !== 'POST') return send(405, { error: 'Method not allowed' }, { Allow: 'POST' });

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

  /** The command: turns the server on and gives the configuration for the AI tools. */
  async setup(): Promise<void> {
    if (!this.enabled()) {
      await config().update('enabled', true, vscode.ConfigurationTarget.Global);
      await this.restart();
    }
    if (this.listening === undefined && this.failure) void vscode.window.showWarningMessage(`Mongoster's MCP server: ${this.failure}`);
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
    const status = this.listening !== undefined ? `Running on ${url}` : `Not running: ${this.failure ?? 'starting'}`;
    const picked = await vscode.window.showQuickPick(items, {
      title: `Mongoster MCP server · ${status}`,
      placeHolder: 'GitHub Copilot in VS Code finds it on its own. For other AI tools, copy the configuration.',
    });
    await picked?.run();
  }

  dispose(): void {
    void this.close();
    this.disposables.forEach((d) => d.dispose());
  }
}

export const claudeCommand = (url: string, token: string) => `claude mcp add --transport http mongoster ${url} --header "Authorization: Bearer ${token}"`;

async function copy(text: string): Promise<void> {
  await vscode.env.clipboard.writeText(text);
  void vscode.window.showInformationMessage('Copied. It contains the access token of the MCP server: keep it private.');
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
