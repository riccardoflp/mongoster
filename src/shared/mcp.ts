/**
 * A minimal Model Context Protocol server: JSON-RPC 2.0 messages for initialization, ping and tools,
 * answered as plain JSON (the Streamable HTTP transport without server-sent events or sessions).
 */

export const PROTOCOL_VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];

export interface ToolResult {
  content: { type: 'text'; text: string }[];
  isError?: boolean;
}

export interface McpTool {
  name: string;
  title: string;
  description: string;
  inputSchema: { type: 'object'; properties: Record<string, unknown>; required?: string[]; additionalProperties?: boolean };
  /** Only reads: opening a tab or reading data, never a write. */
  readOnly: boolean;
  run(args: Record<string, unknown>): Promise<string>;
}

export interface ServerInfo {
  name: string;
  title: string;
  version: string;
  instructions: string;
}

interface Request {
  jsonrpc?: string;
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
}

type Response = { jsonrpc: '2.0'; id: string | number | null } & ({ result: unknown } | { error: { code: number; message: string } });

export const PARSE_ERROR = -32700;
export const INVALID_REQUEST = -32600;
export const METHOD_NOT_FOUND = -32601;
export const INVALID_PARAMS = -32602;

const error = (id: Request['id'], code: number, message: string): Response => ({ jsonrpc: '2.0', id: id ?? null, error: { code, message } });

/** An error a tool reports to the model (bad arguments, a failed query), as opposed to a protocol error. */
export class ToolError extends Error {}

/**
 * Answers one message; undefined for notifications (no id), which get no response. Tool failures
 * are results with `isError`, so the model sees what went wrong.
 */
export async function handleMessage(
  message: unknown,
  tools: McpTool[],
  info: ServerInfo,
  log?: (tool: string, args: Record<string, unknown>, outcome: string) => void,
): Promise<Response | undefined> {
  if (!message || typeof message !== 'object' || Array.isArray(message)) return error(null, INVALID_REQUEST, 'Invalid request');
  const m = message as Request;
  const isNotification = m.id === undefined;
  if (m.jsonrpc !== '2.0' || typeof m.method !== 'string') return isNotification ? undefined : error(m.id, INVALID_REQUEST, 'Invalid request');
  if (isNotification) return undefined;
  const ok = (result: unknown): Response => ({ jsonrpc: '2.0', id: m.id!, result });

  switch (m.method) {
    case 'initialize': {
      const asked = m.params?.protocolVersion;
      const protocolVersion = typeof asked === 'string' && PROTOCOL_VERSIONS.includes(asked) ? asked : PROTOCOL_VERSIONS[0];
      return ok({
        protocolVersion,
        capabilities: { tools: { listChanged: false } },
        serverInfo: { name: info.name, title: info.title, version: info.version },
        instructions: info.instructions,
      });
    }
    case 'ping':
      return ok({});
    case 'tools/list':
      return ok({
        tools: tools.map((t) => ({
          name: t.name,
          title: t.title,
          description: t.description,
          inputSchema: t.inputSchema,
          annotations: { title: t.title, readOnlyHint: t.readOnly, destructiveHint: false, openWorldHint: false },
        })),
      });
    case 'tools/call': {
      const name = m.params?.name;
      const tool = tools.find((t) => t.name === name);
      if (!tool) return error(m.id, INVALID_PARAMS, `Unknown tool: ${String(name)}`);
      const raw = m.params?.arguments ?? {};
      if (typeof raw !== 'object' || Array.isArray(raw)) return error(m.id, INVALID_PARAMS, 'The arguments must be an object');
      const args = raw as Record<string, unknown>;
      const missing = (tool.inputSchema.required ?? []).filter((k) => args[k] === undefined || args[k] === null || args[k] === '');
      if (missing.length) {
        log?.(tool.name, args, `missing ${missing.join(', ')}`);
        return ok(toolResult(`Missing argument${missing.length === 1 ? '' : 's'}: ${missing.join(', ')}.`, true));
      }
      try {
        const text = await tool.run(args);
        log?.(tool.name, args, 'ok');
        return ok(toolResult(text));
      } catch (err) {
        const text = err instanceof Error ? err.message : String(err);
        log?.(tool.name, args, `error: ${text}`);
        return ok(toolResult(text, true));
      }
    }
    default:
      return error(m.id, METHOD_NOT_FOUND, `Method not found: ${m.method}`);
  }
}

const toolResult = (text: string, isError = false): ToolResult => ({ content: [{ type: 'text', text }], ...(isError && { isError: true }) });

/** The text cut at `max` characters on a line boundary, saying so. */
export function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  const cut = text.lastIndexOf('\n', max);
  return `${text.slice(0, cut > max / 2 ? cut : max)}\n… (output truncated at ${max.toLocaleString('en-US')} characters)`;
}

/** A string argument, trimmed; undefined when absent or empty. Anything else is refused. */
export function stringArg(args: Record<string, unknown>, key: string): string | undefined {
  const v = args[key];
  if (v === undefined || v === null) return undefined;
  if (typeof v !== 'string') throw new ToolError(`${key} must be a string.`);
  return v.trim() || undefined;
}

/** A whole-number argument within bounds, or the default. */
export function intArg(args: Record<string, unknown>, key: string, def: number, min: number, max: number): number {
  const v = args[key];
  if (v === undefined || v === null || v === '') return def;
  const n = typeof v === 'string' ? Number(v) : v;
  if (typeof n !== 'number' || !Number.isInteger(n)) throw new ToolError(`${key} must be a whole number.`);
  if (n < min || n > max) throw new ToolError(`${key} must be between ${min} and ${max}.`);
  return n;
}

export function boolArg(args: Record<string, unknown>, key: string, def: boolean): boolean {
  const v = args[key];
  if (v === undefined || v === null) return def;
  if (typeof v !== 'boolean') throw new ToolError(`${key} must be true or false.`);
  return v;
}
