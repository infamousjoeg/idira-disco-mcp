import type { Server } from 'node:http';
import { createServer } from 'node:net';

import { Client, StreamableHTTPClientTransport } from '@modelcontextprotocol/client';

import { buildApp } from '../../src/app.js';
import { type Config, loadConfig } from '../../src/config.js';
import { silentLogger } from '../../src/logger.js';
import { type MockAuthorizationServer, startMockAuthorizationServer } from './mockAs.js';
import { type MockIdira, startMockIdira } from './mockIdira.js';

export interface Harness {
  /** URL of the MCP endpoint, which is also the token audience. */
  url: string;
  origin: string;
  config: Config;
  idira: MockIdira;
  as: MockAuthorizationServer;
  /** Mints an access token for this server. */
  token(claims?: Record<string, unknown>): Promise<string>;
  /** Opens an MCP client session against the server using the given bearer token. */
  connect(token?: string): Promise<Client>;
  close(): Promise<void>;
}

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

export async function startHarness(env: Record<string, string> = {}): Promise<Harness> {
  const idira = await startMockIdira();
  const as = await startMockAuthorizationServer();
  const port = await freePort();
  const url = `http://localhost:${port}/mcp`;

  const config = loadConfig({
    MCP_PORT: String(port),
    MCP_PUBLIC_URL: url,
    OAUTH_ISSUER_URL: as.issuer,
    IDIRA_DISCO_GRAPHQL_URL: idira.graphqlUrl,
    IDIRA_PLATFORM_TOKEN_URL: idira.tokenUrl,
    IDIRA_CLIENT_ID: 'svc-disco@example.com',
    IDIRA_CLIENT_SECRET: 's3cret!',
    ...env,
  });
  const { app, handler } = await buildApp(config, { logger: silentLogger });
  const listener = await new Promise<Server>((resolve) => {
    const server = app.listen(port, '127.0.0.1', () => resolve(server));
  });

  const clients: Client[] = [];
  const token = (claims: Record<string, unknown> = {}) =>
    as.sign({ aud: url, sub: 'user-1', client_id: 'claude-code', ...claims });

  return {
    url,
    origin: `http://localhost:${port}`,
    config,
    idira,
    as,
    token,
    async connect(bearer) {
      const accessToken = bearer ?? (await token());
      const transport = new StreamableHTTPClientTransport(new URL(url), {
        requestInit: { headers: { authorization: `Bearer ${accessToken}` } },
      });
      const client = new Client({ name: 'test-client', version: '1.0.0' });
      await client.connect(transport);
      clients.push(client);
      return client;
    },
    async close() {
      await Promise.all(clients.map((client) => client.close().catch(() => undefined)));
      await handler.close();
      listener.closeAllConnections();
      await new Promise<void>((resolve) => listener.close(() => resolve()));
      await Promise.all([idira.close(), as.close()]);
    },
  };
}
