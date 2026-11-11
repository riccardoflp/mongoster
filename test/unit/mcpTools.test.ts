// The whole list of MCP tools: unique names, all read-only, and those that return documents or field
// values left out when mongoster.mcp.readDocuments is off.
import { describe, expect, it } from 'vitest';
import { ToolHost, mcpTools } from '../../src/mcpTools';
import type { WorkspaceHost } from '../../src/mcp/workspace';

const host = (readDocuments: boolean): ToolHost => ({
  connections: { list: () => [], getClient: () => Promise.reject(new Error('no server')), isConnected: () => false },
  openSearch: () => undefined,
  readDocuments: () => readDocuments,
  workspace: {} as WorkspaceHost,
});

const DOCUMENT_TOOLS = ['aggregate', 'distinct_values', 'find_documents', 'mongoster_write_details', 'watch_changes', 'write_history'];

describe('mcpTools', () => {
  const all = mcpTools(host(true));

  it('gives every tool a unique name, a description and an object schema', () => {
    const names = all.map((t) => t.name);
    expect(new Set(names).size).toBe(names.length);
    for (const t of all) {
      expect(t.name).toMatch(/^[a-z_]+$/);
      expect(t.description.length).toBeGreaterThan(20);
      expect(t.inputSchema.type).toBe('object');
      for (const key of t.inputSchema.required ?? []) expect(t.inputSchema.properties).toHaveProperty(key);
    }
  });

  it('offers only read-only tools', () => {
    expect(all.filter((t) => !t.readOnly).map((t) => t.name)).toEqual([]);
  });

  it('has the debugging, performance, deployment and workspace tools', () => {
    const names = all.map((t) => t.name);
    for (const name of [
      'watch_changes',
      'write_history',
      'explain_query',
      'slow_queries',
      'current_operations',
      'index_advice',
      'collection_stats',
      'server_status',
      'database_stats',
      'replica_set_status',
      'sharding_status',
      'count_documents',
      'distinct_values',
      'describe_relations',
      'collection_options',
      'mongoster_writes',
      'mongoster_write_details',
      'redis_oplog_status',
      'list_saved_queries',
      'open_watch',
      'open_monitor',
      'open_explain',
      'open_history',
    ]) {
      expect(names).toContain(name);
    }
  });

  it('leaves out the tools that return documents when readDocuments is off', () => {
    expect(all.filter((t) => t.documents).map((t) => t.name).sort()).toEqual(DOCUMENT_TOOLS);
    const without = mcpTools(host(false)).map((t) => t.name);
    for (const name of DOCUMENT_TOOLS) expect(without).not.toContain(name);
    expect(without.length).toBe(all.length - DOCUMENT_TOOLS.length);
  });
});
