import { McpServer } from '@modelcontextprotocol/server';

import { registerDiscoTools, type ToolDeps } from './tools/register.js';

export const SERVER_NAME = 'idira-disco-mcp';
export const SERVER_VERSION = '0.1.0';

const INSTRUCTIONS = `Tools for the Idira Discovery & Context inventory of secrets, machine identities (workloads) and AI agents.

Typical flow for reporting what you discovered:
1. Discover entities with your own tools (cloud CLIs, kubectl, repository scans, agent configs).
2. Map each one to an entry. originId must be a stable identifier from the source system (ARN, resource ID, UID); providerId identifies the account, subscription or cluster; providerType is the platform ('aws', 'azure', 'gcp', 'kubernetes', ...).
3. Send them with disco_add_replace_secrets, disco_add_replace_workloads or disco_add_replace_ai_agents. Re-sending an originId replaces the entry.
4. Verify with the matching disco_query_* tool.

Report metadata about secrets (name, type, location, validity, tags), never the secret values themselves.
Deleting is irreversible: run disco_delete_* with dryRun: true and confirm with the user first.
Timestamps are ISO 8601 with a time zone, e.g. 2026-01-31T12:00:00Z.`;

/** Builds one MCP server instance. The HTTP handler calls this per request (stateless serving). */
export function createDiscoServer(deps: ToolDeps): McpServer {
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: INSTRUCTIONS });
  registerDiscoTools(server, deps);
  return server;
}
