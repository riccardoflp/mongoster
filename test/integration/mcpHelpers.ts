// Helpers of the MCP tool tests: a connection list with one connection to a test server, and a call
// that runs a tool as the MCP server does (missing arguments and errors become results with isError).
import { MongoClient } from 'mongodb';
import type { ConnectionInfo } from '../../src/connections';
import { McpTool, handleMessage } from '../../src/shared/mcp';
import { ToolConnections, ToolContext, toolContext } from '../../src/mcp/context';

export const TEST_CONNECTION = 'test';

/** One connection named "test" (id "test-id") to `client`. */
export function testContext(client: MongoClient, info: Partial<ConnectionInfo> = {}): ToolContext {
  const connection = { id: 'test-id', name: TEST_CONNECTION, ...info } as ConnectionInfo;
  const connections: ToolConnections = {
    list: () => [connection],
    getClient: async () => client,
    isConnected: () => true,
  };
  return toolContext(connections);
}

export interface CallResult {
  text: string;
  isError: boolean;
}

/** Runs the tool through the MCP message handler and returns its text. */
export async function callTool(tools: McpTool[], name: string, args: Record<string, unknown>): Promise<CallResult> {
  const res = await handleMessage({ jsonrpc: '2.0', id: 1, method: 'tools/call', params: { name, arguments: args } }, tools, {
    name: 'mongoster',
    title: 'Mongoster',
    version: 'test',
    instructions: '',
  });
  if (!res || !('result' in res)) throw new Error(`Protocol error: ${JSON.stringify(res)}`);
  const result = res.result as { content: { text: string }[]; isError?: boolean };
  return { text: result.content.map((c) => c.text).join('\n'), isError: !!result.isError };
}
