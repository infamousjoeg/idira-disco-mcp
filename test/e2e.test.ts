/**
 * End-to-end tests: a real MCP client talks Streamable HTTP to the real server, which
 * validates OAuth 2.1 bearer tokens from a mock authorization server and calls a mock
 * Idira tenant that executes every operation against the documented GraphQL schema.
 */
import { request } from 'node:http';

import type { Client } from '@modelcontextprotocol/client';
import type { GraphQLInputObjectType } from 'graphql';
import { SignJWT } from 'jose';
import { afterAll, beforeAll, beforeEach, describe, expect, it } from 'vitest';

import { ENTITY_SPECS, type EntityKind } from '../src/disco/operations.js';
import { RESPONSE_CHAR_LIMIT, TOOL_OPERATIONS } from '../src/tools/register.js';
import { type Harness, startHarness } from './helpers/harness.js';
import { buildDiscoSchema } from './helpers/mockIdira.js';

interface ToolOutcome {
  isError: boolean;
  text: string;
  data: Record<string, any>;
}

async function call(client: Client, name: string, args: Record<string, unknown>): Promise<ToolOutcome> {
  const result = await client.callTool({ name, arguments: args });
  const content = result.content as Array<{ type: string; text?: string }>;
  return {
    isError: result.isError === true,
    text: content.map((block) => block.text ?? '').join('\n'),
    data: (result.structuredContent ?? {}) as Record<string, any>,
  };
}

function reset(harness: Harness): void {
  harness.idira.store.secrets = [];
  harness.idira.store.workloads = [];
  harness.idira.store.aiAgents = [];
  harness.idira.requests.length = 0;
  harness.idira.graphqlFaults.length = 0;
}

const INIT_BODY = {
  jsonrpc: '2.0',
  id: 1,
  method: 'initialize',
  params: { protocolVersion: '2025-06-18', capabilities: {}, clientInfo: { name: 'legacy', version: '1' } },
};
const MCP_HEADERS = { 'content-type': 'application/json', accept: 'application/json, text/event-stream' };

function post(harness: Harness, token: string | undefined, body: unknown = INIT_BODY): Promise<Response> {
  return fetch(harness.url, {
    method: 'POST',
    headers: { ...MCP_HEADERS, ...(token && { authorization: `Bearer ${token}` }) },
    body: JSON.stringify(body),
  });
}

/** Reads a JSON-RPC answer whether the server replied with JSON or with an SSE stream. */
async function rpcResult(response: Response): Promise<any> {
  const text = await response.text();
  if (response.headers.get('content-type')?.includes('text/event-stream')) {
    const data = text
      .split('\n')
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).trim())
      .filter(Boolean);
    return JSON.parse(data.at(-1)!);
  }
  return JSON.parse(text);
}

const SECRET = {
  originId: 'arn:aws:secretsmanager:us-east-1:111122223333:secret:prod/db-AbCdEf',
  providerId: '111122223333',
  providerType: 'aws',
  name: 'prod/db',
  type: 'Secret',
  subType: 'database',
  location: 'us-east-1',
  description: 'Production database credentials',
  validityFrom: '2026-01-01T00:00:00Z',
  validityTo: '2027-01-01T00:00:00+02:00',
  username: 'app_user',
  tags: [
    { type: 'TAG', key: 'env', value: 'prod' },
    { type: 'LABEL', key: 'team' },
  ],
  originLastRetrieved: '2026-09-30T08:15:30.123Z',
  additionalData: { rotation: { enabled: true, days: 30 }, kmsKey: 'alias/prod' },
  originUpdatedAt: '2026-09-01T10:00:00Z',
  permanence: 'STATIC',
  originCreatedAt: '2025-05-05T05:05:05Z',
};

const WORKLOAD = {
  originId: 'arn:aws:lambda:us-east-1:111122223333:function:billing',
  providerId: '111122223333',
  providerType: 'aws',
  name: 'billing',
  type: 'serverless',
  subType: 'lambda',
  description: 'Billing function',
  location: 'us-east-1',
  tags: [{ type: 'ANNOTATION', key: 'owner', value: 'finance' }],
  additionalData: { runtime: 'nodejs22.x' },
  originUpdatedAt: '2026-08-01T00:00:00Z',
  originCreatedAt: '2026-02-01T00:00:00Z',
};

const AI_AGENT = {
  originId: 'claude-code:joe-laptop',
  providerId: 'joe-laptop',
  providerType: 'workstation',
  name: 'Claude Code (joe-laptop)',
  type: 'coding-assistant',
  subType: 'cli',
  description: 'Claude Code CLI',
  instructions: 'You are a careful engineer.',
  model: 'claude-fable-5-1',
  location: 'us',
  tags: [{ type: 'TAG', key: 'managed', value: 'false' }],
  additionalData: { mcpServers: ['idira-disco'] },
  originUpdatedAt: '2026-10-01T00:00:00Z',
  originCreatedAt: '2026-09-01T00:00:00Z',
};

describe('OAuth 2.1 protected resource', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness();
  });
  afterAll(() => harness.close());
  beforeEach(() => reset(harness));

  it('publishes RFC 9728 protected resource metadata at the path-specific and root locations', async () => {
    for (const path of ['/.well-known/oauth-protected-resource/mcp', '/.well-known/oauth-protected-resource']) {
      const response = await fetch(`${harness.origin}${path}`);
      expect(response.status, path).toBe(200);
      const metadata = (await response.json()) as Record<string, unknown>;
      expect(metadata.resource).toBe(harness.url);
      expect(metadata.authorization_servers).toEqual([harness.as.issuer]);
    }
  });

  it('relays the authorization server metadata for clients that probe the resource origin', async () => {
    const response = await fetch(`${harness.origin}/.well-known/oauth-authorization-server`);
    const metadata = (await response.json()) as Record<string, unknown>;
    expect(metadata.issuer).toBe(harness.as.issuer);
    expect(metadata.code_challenge_methods_supported).toEqual(['S256']);
  });

  it('answers 401 with a WWW-Authenticate challenge pointing at the metadata when no token is sent', async () => {
    const response = await post(harness, undefined);
    expect(response.status).toBe(401);
    const challenge = response.headers.get('www-authenticate')!;
    expect(challenge).toMatch(/^Bearer /);
    expect(challenge).toContain(`resource_metadata="${harness.origin}/.well-known/oauth-protected-resource/mcp"`);
  });

  it('refuses GET and DELETE without a token as well', async () => {
    for (const method of ['GET', 'DELETE']) {
      const response = await fetch(harness.url, { method, headers: { accept: 'text/event-stream' } });
      expect(response.status, method).toBe(401);
    }
  });

  it.each([
    ['a token for another audience', (h: Harness) => h.as.sign({ aud: 'https://other.example.com/mcp', sub: 'u' })],
    ['a token without an audience', (h: Harness) => h.as.sign({ sub: 'u' })],
    ['a token from another issuer', (h: Harness) => h.as.sign({ aud: h.url }, { issuer: 'https://evil.example.com' })],
    ['an expired token', (h: Harness) => h.as.sign({ aud: h.url }, { expiresIn: -120 })],
    ['a token without an expiry', (h: Harness) => h.as.sign({ aud: h.url }, { expiresIn: null })],
    ['a token signed with an unknown key', (h: Harness) => h.as.sign({ aud: h.url }, { foreignKey: true })],
    [
      'a token signed with a shared secret',
      (h: Harness) =>
        new SignJWT({ aud: h.url })
          .setProtectedHeader({ alg: 'HS256' })
          .setIssuer(h.as.issuer)
          .setExpirationTime('5m')
          .sign(new TextEncoder().encode('0123456789abcdef0123456789abcdef')),
    ],
    [
      'an unsigned token',
      async (h: Harness) => {
        const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString('base64url');
        const exp = Math.floor(Date.now() / 1000) + 300;
        return `${encode({ alg: 'none', typ: 'JWT' })}.${encode({ iss: h.as.issuer, aud: h.url, exp })}.`;
      },
    ],
    ['garbage', async () => 'not-a-jwt'],
  ])('rejects %s with 401 invalid_token and never calls Idira', async (_label, mint) => {
    const response = await post(harness, await mint(harness));
    expect(response.status).toBe(401);
    expect(response.headers.get('www-authenticate')).toContain('error="invalid_token"');
    expect(((await response.json()) as { error: string }).error).toBe('invalid_token');
    expect(harness.idira.requests).toHaveLength(0);
  });

  it('does not accept a token passed in the query string', async () => {
    const response = await fetch(`${harness.url}?access_token=${await harness.token()}`, {
      method: 'POST',
      headers: MCP_HEADERS,
      body: JSON.stringify(INIT_BODY),
    });
    expect(response.status).toBe(401);
  });

  it('accepts a valid token and serves the tools', async () => {
    const client = await harness.connect();
    const { tools } = await client.listTools();
    expect(tools.map((tool) => tool.name).sort()).toEqual(TOOL_OPERATIONS.map((tool) => tool.name).sort());
  });

  it('accepts an audience that differs only by a trailing slash, and an audience array', async () => {
    const client = await harness.connect(await harness.as.sign({ aud: ['https://unrelated.example', `${harness.url}/`] }));
    expect((await client.listTools()).tools).toHaveLength(9);
  });

  it('serves 2025-era clients through the stateless fallback', async () => {
    const token = await harness.token();
    const init = await post(harness, token);
    expect(init.status).toBe(200);
    expect((await rpcResult(init)).result.serverInfo.name).toBe('idira-disco-mcp');
    const list = await post(harness, token, { jsonrpc: '2.0', id: 2, method: 'tools/list', params: {} });
    expect((await rpcResult(list)).result.tools).toHaveLength(9);
  });

  it('exposes an unauthenticated health check', async () => {
    const response = await fetch(`${harness.origin}/healthz`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: 'ok', server: 'idira-disco-mcp' });
  });

  it('answers malformed, oversized and unknown-path requests with plain JSON, never a stack trace', async () => {
    const headers = { ...MCP_HEADERS, authorization: `Bearer ${await harness.token()}` };
    const cases: Array<[Promise<Response>, number, unknown]> = [
      [
        fetch(harness.url, { method: 'POST', headers, body: '{not json' }),
        400,
        { jsonrpc: '2.0', error: { code: -32700, message: 'Parse error: the request body is not valid JSON' }, id: null },
      ],
      [
        fetch(harness.url, { method: 'POST', headers, body: JSON.stringify({ blob: 'x'.repeat(5 * 1024 * 1024) }) }),
        413,
        { jsonrpc: '2.0', error: { code: -32600, message: 'Request body too large' }, id: null },
      ],
      [fetch(`${harness.origin}/nope`), 404, { error: 'not_found' }],
    ];
    for (const [pending, status, body] of cases) {
      const response = await pending;
      expect(response.status).toBe(status);
      expect(response.headers.get('content-type')).toContain('application/json');
      const text = await response.text();
      expect(JSON.parse(text)).toEqual(body);
      expect(text).not.toMatch(/node_modules|\bat \w+ \(/);
    }
  });

  it('rejects requests whose Host header is not an allowed hostname', async () => {
    const status = await new Promise<number>((resolve, reject) => {
      const req = request(
        { host: '127.0.0.1', port: harness.config.port, path: '/healthz', headers: { host: 'attacker.example.com' } },
        (res) => {
          res.resume();
          resolve(res.statusCode!);
        },
      );
      req.on('error', reject);
      req.end();
    });
    expect(status).toBe(403);
  });

  it('never forwards the caller token upstream: Idira only sees the service account token', async () => {
    const token = await harness.token();
    const client = await harness.connect(token);
    await call(client, 'disco_query_secrets', {});
    expect(harness.idira.requests).toHaveLength(1);
    expect(harness.idira.requests[0]!.authorization).toMatch(/^Bearer platform-token-\d+$/);
    expect(harness.idira.requests[0]!.authorization).not.toContain(token);
  });
});

describe('scope enforcement', () => {
  let harness: Harness;
  beforeAll(async () => {
    harness = await startHarness({
      OAUTH_REQUIRED_SCOPES: 'disco',
      OAUTH_SCOPES_READ: 'disco:read',
      OAUTH_SCOPES_WRITE: 'disco:write',
      OAUTH_SCOPES_DELETE: 'disco:write disco:delete',
    });
  });
  afterAll(() => harness.close());
  beforeEach(() => reset(harness));

  const toolCall = (name: string, args: Record<string, unknown>) => ({
    jsonrpc: '2.0',
    id: 7,
    method: 'tools/call',
    params: { name, arguments: args },
  });

  it('advertises the scopes in the protected resource metadata', async () => {
    const response = await fetch(`${harness.origin}/.well-known/oauth-protected-resource/mcp`);
    const metadata = (await response.json()) as { scopes_supported: string[] };
    expect(metadata.scopes_supported.sort()).toEqual(['disco', 'disco:delete', 'disco:read', 'disco:write']);
  });

  it('answers 403 insufficient_scope when the base scope is missing', async () => {
    const response = await post(harness, await harness.token({ scope: 'disco:read' }));
    expect(response.status).toBe(403);
    expect(response.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
  });

  it('lets a read-only token query but challenges it on write and delete', async () => {
    const token = await harness.token({ scope: 'disco disco:read' });
    const client = await harness.connect(token);
    expect((await call(client, 'disco_query_workloads', {})).isError).toBe(false);

    const write = await post(harness, token, toolCall('disco_add_replace_workloads', { entities: [WORKLOAD] }));
    expect(write.status).toBe(403);
    expect(write.headers.get('www-authenticate')).toContain('error="insufficient_scope"');
    expect(write.headers.get('www-authenticate')).toContain('scope="disco:write"');

    const remove = await post(harness, token, toolCall('disco_delete_workloads', { filter: { name: { contains: 'x' } } }));
    expect(remove.status).toBe(403);
    expect(remove.headers.get('www-authenticate')).toContain('scope="disco:write disco:delete"');

    expect(harness.idira.store.workloads).toHaveLength(0);
    expect(harness.idira.requests.every((req) => req.operationName === 'QueryWorkloads')).toBe(true);
  });

  it('reads scopes from an scp array claim and allows everything the token covers', async () => {
    const client = await harness.connect(await harness.token({ scp: ['disco', 'disco:read', 'disco:write', 'disco:delete'] }));
    expect((await call(client, 'disco_add_replace_workloads', { entities: [WORKLOAD] })).isError).toBe(false);
    const removed = await call(client, 'disco_delete_workloads', { filter: { providerType: { eq: 'aws' } } });
    expect(removed.data.totalDeleted).toBe(1);
  });
});

describe('tools', () => {
  let harness: Harness;
  let client: Client;
  beforeAll(async () => {
    harness = await startHarness({ DISCO_BATCH_SIZE: '2' });
    client = await harness.connect();
  });
  afterAll(() => harness.close());
  beforeEach(() => reset(harness));

  it('describes every tool with schemas and behaviour annotations', async () => {
    const { tools } = await client.listTools();
    for (const tool of tools) {
      const operation = TOOL_OPERATIONS.find((candidate) => candidate.name === tool.name)!;
      expect(tool.description, tool.name).toBeTruthy();
      expect(tool.outputSchema, tool.name).toBeTruthy();
      expect(tool.annotations?.readOnlyHint, tool.name).toBe(operation.action === 'query');
      expect(tool.annotations?.destructiveHint, tool.name).toBe(operation.action === 'delete');
      expect(tool.annotations?.idempotentHint, tool.name).toBe(true);
      const required = tool.inputSchema.required ?? [];
      expect(required, tool.name).toEqual(
        operation.action === 'query' ? [] : operation.action === 'addReplace' ? ['entities'] : ['filter'],
      );
    }
  });

  it('adds a secret with every documented field and stores AWSJSON as a JSON string', async () => {
    const result = await call(client, 'disco_add_replace_secrets', { entities: [SECRET] });
    expect(result.isError, result.text).toBe(false);
    expect(result.data).toMatchObject({ totalProcessed: 1, submitted: 1, batches: 1 });
    expect(result.data.items[0]).toMatchObject({ originId: SECRET.originId, name: 'prod/db', providerType: 'aws' });
    expect(result.data.items[0].id).toMatch(/^sec-/);

    const stored = harness.idira.store.secrets[0]!;
    expect(stored).toMatchObject({ ...SECRET, additionalData: JSON.stringify(SECRET.additionalData) });
    expect(JSON.parse(result.text)).toEqual(result.data);
  });

  it('replaces an entry that has the same originId instead of duplicating it', async () => {
    await call(client, 'disco_add_replace_secrets', { entities: [SECRET] });
    const again = await call(client, 'disco_add_replace_secrets', {
      entities: [{ ...SECRET, name: 'prod/db-renamed' }],
      returnFields: ['id', 'name', 'additionalData', 'tags'],
    });
    expect(harness.idira.store.secrets).toHaveLength(1);
    expect(again.data.items[0]).toEqual({
      id: harness.idira.store.secrets[0]!.id,
      name: 'prod/db-renamed',
      additionalData: SECRET.additionalData,
      tags: [
        { type: 'TAG', key: 'env', value: 'prod' },
        { type: 'LABEL', key: 'team', value: null },
      ],
    });
  });

  it('adds workloads and AI agents with every documented field', async () => {
    const workloads = await call(client, 'disco_add_replace_workloads', { entities: [WORKLOAD] });
    const agents = await call(client, 'disco_add_replace_ai_agents', { entities: [AI_AGENT] });
    expect(workloads.isError, workloads.text).toBe(false);
    expect(agents.isError, agents.text).toBe(false);
    expect(harness.idira.store.workloads[0]).toMatchObject({ ...WORKLOAD, additionalData: JSON.stringify(WORKLOAD.additionalData) });
    expect(harness.idira.store.aiAgents[0]).toMatchObject({ ...AI_AGENT, additionalData: JSON.stringify(AI_AGENT.additionalData) });
  });

  it('accepts additionalData given as a JSON string', async () => {
    const result = await call(client, 'disco_add_replace_workloads', { entities: [{ ...WORKLOAD, additionalData: '{"a":1}' }] });
    expect(result.isError, result.text).toBe(false);
    expect(harness.idira.store.workloads[0]!.additionalData).toBe('{"a":1}');
  });

  it('splits large submissions into upstream batches and totals the results', async () => {
    const entities = [1, 2, 3, 4, 5].map((n) => ({ ...WORKLOAD, originId: `wl-${n}`, name: `workload-${n}` }));
    const result = await call(client, 'disco_add_replace_workloads', { entities });
    expect(result.data).toMatchObject({ totalProcessed: 5, submitted: 5, batches: 3 });
    expect(result.data.items).toHaveLength(5);
    expect(harness.idira.requests.map((req) => (req.variables.workloads as unknown[]).length)).toEqual([2, 2, 1]);
  });

  it('reports progress when a later batch fails', async () => {
    harness.idira.graphqlFaults.push(
      { status: 200, body: { data: { addReplaceExternalWorkloads: { totalProcessedWorkloads: 2, workloads: [] } } } },
      { status: 200, body: { data: null, errors: [{ errorType: 'ValidationError', message: 'name too long' }] } },
    );
    const entities = [1, 2, 3].map((n) => ({ ...WORKLOAD, originId: `wl-${n}` }));
    const result = await call(client, 'disco_add_replace_workloads', { entities });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('2 of 3 entries were processed in 1 batch(es)');
    expect(result.text).toContain('ValidationError: name too long');
  });

  it('returns every output field by default and parses AWSJSON back into an object', async () => {
    await call(client, 'disco_add_replace_secrets', { entities: [SECRET] });
    const result = await call(client, 'disco_query_secrets', {});
    expect(result.data).toMatchObject({ totalCount: 1, count: 1, offset: 0, limit: 50, hasMore: false });
    expect(Object.keys(result.data.items[0]).sort()).toEqual([...ENTITY_SPECS.secrets.fields].sort());
    expect(result.data.items[0]).toMatchObject({
      dataSourceType: 'EXTERNAL_API',
      additionalData: SECRET.additionalData,
      permanence: 'STATIC',
      validityTo: SECRET.validityTo,
      tags: [
        { type: 'TAG', key: 'env', value: 'prod' },
        { type: 'LABEL', key: 'team', value: null },
      ],
    });
  });

  it('returns only the requested fields', async () => {
    await call(client, 'disco_add_replace_ai_agents', { entities: [AI_AGENT] });
    harness.idira.requests.length = 0;
    const result = await call(client, 'disco_query_ai_agents', { fields: ['name', 'instructions'] });
    expect(result.data.items).toEqual([{ name: AI_AGENT.name, instructions: AI_AGENT.instructions }]);
    expect(harness.idira.requests[0]!.query).toContain('items { name instructions }');
  });

  it('filters with nested and / or / not conditions', async () => {
    harness.idira.seed('workloads', [
      { originId: 'a', name: 'api-prod', providerId: 'p1', providerType: 'aws', type: 'container', dataSourceType: 'AWS_SCANNER' },
      { originId: 'b', name: 'api-dev', providerId: 'p1', providerType: 'aws', type: 'vm', dataSourceType: 'EXTERNAL_API' },
      { originId: 'c', name: 'batch-prod', providerId: 'p2', providerType: 'azure', type: 'container', dataSourceType: 'AZURE_SCANNER' },
      { originId: 'd', name: 'web-prod', providerId: 'p3', providerType: 'kubernetes', type: 'container', dataSourceType: 'EXTERNAL_API' },
    ]);
    const names = async (filter: unknown) =>
      (await call(client, 'disco_query_workloads', { filter, fields: ['name'], sort: [{ field: 'name' }] })).data.items.map(
        (item: { name: string }) => item.name,
      );

    expect(await names({ providerType: { eq: 'aws' }, name: { contains: 'prod' } })).toEqual(['api-prod']);
    expect(await names({ or: [{ providerType: { eq: 'azure' } }, { type: { eq: 'vm' } }] })).toEqual(['api-dev', 'batch-prod']);
    expect(await names({ not: { dataSourceType: { eq: 'EXTERNAL_API' } } })).toEqual(['api-prod', 'batch-prod']);
    expect(
      await names({
        and: [{ name: { contains: 'prod' } }, { not: { or: [{ providerId: { eq: 'p1' } }, { providerId: { eq: 'p2' } }] } }],
      }),
    ).toEqual(['web-prod']);
    expect(await names({ originId: { contains: 'zzz' } })).toEqual([]);
  });

  it('filters on date ranges', async () => {
    harness.idira.seed('aiAgents', [
      { originId: 'old', name: 'old', providerId: 'p', providerType: 'x', originUpdatedAt: '2025-01-01T00:00:00Z' },
      { originId: 'new', name: 'new', providerId: 'p', providerType: 'x', originUpdatedAt: '2026-06-01T00:00:00Z' },
    ]);
    const result = await call(client, 'disco_query_ai_agents', {
      filter: { originUpdatedAt: { gt: '2026-01-01T00:00:00Z', lt: '2026-12-31T23:59:59Z' } },
      fields: ['name'],
    });
    expect(result.data.items).toEqual([{ name: 'new' }]);
  });

  it('sorts by several fields and paginates with nextOffset', async () => {
    harness.idira.seed(
      'secrets',
      ['delta', 'alpha', 'charlie', 'bravo', 'echo'].map((name, index) => ({
        originId: name,
        name,
        providerId: index % 2 === 0 ? 'even' : 'odd',
        providerType: 'aws',
        dataSourceType: 'SECRETS_HUB',
      })),
    );
    const sort = [
      { field: 'providerId', order: 'DESC' },
      { field: 'name', order: 'ASC' },
    ];
    const first = await call(client, 'disco_query_secrets', { sort, limit: 2, fields: ['name'] });
    expect(first.data).toMatchObject({ totalCount: 5, count: 2, hasMore: true, nextOffset: 2 });
    expect(first.data.items.map((item: { name: string }) => item.name)).toEqual(['alpha', 'bravo']);
    expect(harness.idira.requests.at(-1)!.variables).toEqual({
      pageInput: { limit: 2, offset: 0 },
      sort: [{ providerId: 'DESC' }, { name: 'ASC' }],
    });

    const last = await call(client, 'disco_query_secrets', { sort, limit: 2, offset: 4, fields: ['name'] });
    expect(last.data).toMatchObject({ count: 1, hasMore: false });
    expect(last.data.nextOffset).toBeUndefined();
    expect(last.data.items.map((item: { name: string }) => item.name)).toEqual(['echo']);
  });

  it('cuts oversized pages down and says so', async () => {
    const blob = 'x'.repeat(RESPONSE_CHAR_LIMIT / 4);
    harness.idira.seed(
      'workloads',
      Array.from({ length: 8 }, (_, n) => ({ originId: `big-${n}`, name: `big-${n}`, providerId: 'p', providerType: 'x', description: blob })),
    );
    const result = await call(client, 'disco_query_workloads', { fields: ['name', 'description'] });
    expect(result.data.truncated).toBe(true);
    expect(result.data.count).toBeLessThan(8);
    expect(result.data).toMatchObject({ totalCount: 8, hasMore: true, nextOffset: result.data.count });
    expect(JSON.stringify(result.data.items).length).toBeLessThanOrEqual(RESPONSE_CHAR_LIMIT);
  });

  it('returns additionalData untouched when Idira stored something that is not JSON', async () => {
    harness.idira.seed('workloads', [{ originId: 'odd', name: 'odd', providerId: 'p', providerType: 'x', additionalData: '{oops' }]);
    const result = await call(client, 'disco_query_workloads', { fields: ['additionalData'] });
    expect(result.data.items).toEqual([{ additionalData: '{oops' }]);
  });

  it('previews a delete with dryRun and deletes nothing', async () => {
    await call(client, 'disco_add_replace_ai_agents', { entities: [AI_AGENT, { ...AI_AGENT, originId: 'other', providerId: 'elsewhere' }] });
    const preview = await call(client, 'disco_delete_ai_agents', { filter: { providerId: { eq: 'joe-laptop' } }, dryRun: true });
    expect(preview.data).toMatchObject({ dryRun: true, matchCount: 1 });
    expect(preview.data.sample[0]).toMatchObject({ originId: AI_AGENT.originId, name: AI_AGENT.name });
    expect(preview.data.totalDeleted).toBeUndefined();
    expect(harness.idira.store.aiAgents).toHaveLength(2);
    expect(harness.idira.requests.some((req) => req.operationName?.startsWith('Delete'))).toBe(false);
  });

  it.each([
    ['disco_delete_secrets', 'disco_add_replace_secrets', 'secrets', SECRET],
    ['disco_delete_workloads', 'disco_add_replace_workloads', 'workloads', WORKLOAD],
    ['disco_delete_ai_agents', 'disco_add_replace_ai_agents', 'aiAgents', AI_AGENT],
  ] as const)('%s deletes only the entries matching the filter', async (deleteTool, addTool, kind, entity) => {
    await call(client, addTool, { entities: [entity, { ...entity, originId: 'keep-me', name: 'keep-me' }] });
    const result = await call(client, deleteTool, { filter: { originId: { contains: entity.originId } } });
    expect(result.isError, result.text).toBe(false);
    expect(result.data).toEqual({ dryRun: false, totalDeleted: 1 });
    expect(harness.idira.store[kind].map((row) => row.originId)).toEqual(['keep-me']);
  });

  it.each([[{}], [{ and: [{}] }], [{ not: {} }], [{ or: [{ and: [{}] }] }]])(
    'refuses to delete with a filter that has no condition: %j',
    async (filter) => {
      harness.idira.seed('secrets', [{ originId: 'x', name: 'x', providerId: 'p', providerType: 't' }]);
      const result = await call(client, 'disco_delete_secrets', { filter });
      expect(result.isError).toBe(true);
      expect(result.text).toContain('Refusing to delete with an empty filter');
      expect(harness.idira.store.secrets).toHaveLength(1);
      expect(harness.idira.requests).toHaveLength(0);
    },
  );

  it('rejects raw secret values unless the operator allowed them', async () => {
    const result = await call(client, 'disco_add_replace_secrets', { entities: [{ ...SECRET, secretValue: 'hunter2' }] });
    expect(result.isError).toBe(true);
    expect(result.text).toContain('secretValue is not accepted');
    expect(result.text).not.toContain('hunter2');
    expect(harness.idira.requests).toHaveLength(0);
  });

  it.each([
    ['a timestamp without a time zone', 'disco_add_replace_secrets', { entities: [{ ...SECRET, validityTo: '2027-01-01T00:00:00' }] }],
    ['a date-only timestamp', 'disco_add_replace_workloads', { entities: [{ ...WORKLOAD, originCreatedAt: '2026-01-01' }] }],
    ['an impossible date', 'disco_query_secrets', { filter: { originUpdatedAt: { gt: '2026-13-45T00:00:00Z' } } }],
    ['an empty date filter', 'disco_query_secrets', { filter: { originUpdatedAt: {} } }],
    ['an unknown entity field', 'disco_add_replace_ai_agents', { entities: [{ ...AI_AGENT, owner: 'joe' }] }],
    ['a missing required field', 'disco_add_replace_ai_agents', { entities: [{ ...AI_AGENT, providerId: undefined }] }],
    ['an unknown filter field', 'disco_query_workloads', { filter: { storeName: { contains: 'x' } } }],
    ['an unknown data source', 'disco_query_workloads', { filter: { dataSourceType: { eq: 'GCP_SCANNER' } } }],
    ['an unknown tag type', 'disco_add_replace_workloads', { entities: [{ ...WORKLOAD, tags: [{ type: 'NOTE', key: 'k' }] }] }],
    ['an unknown sort field', 'disco_query_workloads', { sort: [{ field: 'username' }] }],
    ['an unknown output field', 'disco_query_workloads', { fields: ['instructions'] }],
    ['invalid additionalData JSON', 'disco_add_replace_workloads', { entities: [{ ...WORKLOAD, additionalData: '{oops' }] }],
    ['an empty batch', 'disco_add_replace_workloads', { entities: [] }],
    ['a page size over the limit', 'disco_query_secrets', { limit: 5000 }],
    ['a negative offset', 'disco_query_secrets', { offset: -1 }],
    ['a delete without a filter', 'disco_delete_secrets', {}],
  ])('rejects %s before calling Idira', async (_label, tool, args) => {
    const outcome = await call(client, tool, args).catch((error: Error) => ({ isError: true, text: error.message, data: {} }));
    expect(outcome.isError).toBe(true);
    expect(harness.idira.requests).toHaveLength(0);
  });

  it('reports an unknown tool as an error', async () => {
    const outcome = await call(client, 'disco_drop_everything', {}).catch((error: Error) => ({ isError: true, text: error.message }));
    expect(outcome.isError).toBe(true);
  });

  it('surfaces GraphQL errors from Idira as tool errors', async () => {
    harness.idira.graphqlFaults.push({
      status: 200,
      body: { data: null, errors: [{ errorType: 'BadRequest', message: 'limit exceeds maximum' }] },
    });
    const result = await call(client, 'disco_query_secrets', {});
    expect(result.isError).toBe(true);
    expect(result.text).toBe('Discovery & Context API error: BadRequest: limit exceeds maximum');
  });

  it('explains a 403 from Idira in terms of the required role', async () => {
    harness.idira.graphqlFaults.push({ status: 403, body: { message: 'Forbidden' } });
    const result = await call(client, 'disco_query_secrets', {});
    expect(result.isError).toBe(true);
    expect(result.text).toContain('Machines Admin');
  });

  it('gets a new platform token when Idira stops accepting the cached one', async () => {
    await call(client, 'disco_query_secrets', {});
    const before = harness.idira.tokenRequests.length;
    harness.idira.revokeTokens();
    const result = await call(client, 'disco_query_secrets', {});
    expect(result.isError, result.text).toBe(false);
    expect(harness.idira.tokenRequests.length).toBe(before + 1);
  });

  it('reuses one platform token across tool calls', async () => {
    await call(client, 'disco_query_secrets', {});
    const before = harness.idira.tokenRequests.length;
    await Promise.all([call(client, 'disco_query_workloads', {}), call(client, 'disco_query_ai_agents', {})]);
    expect(harness.idira.tokenRequests.length).toBe(before);
  });
});

describe('every documented input reaches the API', () => {
  const schema = buildDiscoSchema();
  let harness: Harness;
  let client: Client;
  beforeAll(async () => {
    harness = await startHarness({ DISCO_ALLOW_SECRET_VALUES: 'true' });
    client = await harness.connect();
  });
  afterAll(() => harness.close());
  beforeEach(() => reset(harness));

  const inputFieldNames = (typeName: string) => Object.keys((schema.getType(typeName) as GraphQLInputObjectType).getFields()).sort();

  it.each([
    ['secrets', 'disco_add_replace_secrets', { ...SECRET, secretValue: 'hunter2' }],
    ['workloads', 'disco_add_replace_workloads', WORKLOAD],
    ['aiAgents', 'disco_add_replace_ai_agents', AI_AGENT],
  ] as const)('forwards every %s input field', async (kind, tool, entity) => {
    const spec = ENTITY_SPECS[kind as EntityKind];
    const result = await call(client, tool, { entities: [entity] });
    expect(result.isError, result.text).toBe(false);
    const sent = (harness.idira.requests[0]!.variables[spec.addReplace.argName] as Array<Record<string, unknown>>)[0]!;
    expect(Object.keys(sent).sort()).toEqual(inputFieldNames(spec.addReplace.inputType));
    expect(Object.keys(sent.tags ? (sent.tags as object[])[0]! : {}).sort()).toEqual(
      Object.keys(entity.tags[0]!).sort(),
    );
  });

  it('forwards a raw secret value only because the operator enabled it, and does not echo it back', async () => {
    const result = await call(client, 'disco_add_replace_secrets', { entities: [{ ...SECRET, secretValue: 'hunter2' }] });
    expect(harness.idira.store.secrets[0]!.secretValue).toBe('hunter2');
    expect(result.text).not.toContain('hunter2');
  });

  it.each([
    ['secrets', 'disco_query_secrets'],
    ['workloads', 'disco_query_workloads'],
    ['aiAgents', 'disco_query_ai_agents'],
  ] as const)('forwards every %s filter field, page field and sort field', async (kind, tool) => {
    const spec = ENTITY_SPECS[kind as EntityKind];
    const leaf: Record<string, unknown> = {
      id: { eq: 'id-1' },
      providerId: { eq: 'p' },
      providerType: { eq: 'aws' },
      originUpdatedAt: { lt: '2027-01-01T00:00:00Z', gt: '2020-01-01T00:00:00Z' },
      originId: { contains: 'arn' },
      riskId: { eq: 'risk-1' },
      name: { contains: 'prod' },
      type: { eq: 'Secret' },
      dataSourceType: { eq: 'EXTERNAL_API' },
      ...(kind === 'secrets' && { storeName: { contains: 'vault' } }),
    };
    const filter = { ...leaf, and: [leaf], or: [leaf], not: leaf };
    const sort = spec.sortFields.map((field) => ({ field, order: 'DESC' }));
    const result = await call(client, tool, { filter, sort, limit: 7, offset: 3 });
    expect(result.isError, result.text).toBe(false);

    const { variables } = harness.idira.requests[0]!;
    expect(variables.filter).toEqual(filter);
    expect(Object.keys(variables.filter as object).sort()).toEqual(inputFieldNames(spec.query.filterType));
    expect(variables.pageInput).toEqual({ limit: 7, offset: 3 });
    expect((variables.sort as object[]).map((entry) => Object.keys(entry)[0]).sort()).toEqual(inputFieldNames(spec.query.sortType));

    harness.idira.requests.length = 0;
    await call(client, tool.replace('query', 'delete'), { filter });
    expect(harness.idira.requests[0]!.variables).toEqual({ filter });
  });
});
