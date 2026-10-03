import { describe, expect, it } from 'vitest';

import { ConfigError, loadConfig } from '../src/config.js';

const BASE = {
  MCP_PUBLIC_URL: 'https://disco-mcp.example.com/mcp',
  OAUTH_ISSUER_URL: 'https://abc1234.id.cyberark.cloud/oauth2/default',
  IDIRA_SUBDOMAIN: 'acme',
  IDIRA_IDENTITY_URL: 'https://abc1234.id.cyberark.cloud',
  IDIRA_CLIENT_ID: 'svc-disco@cyberark.cloud.1234',
  IDIRA_CLIENT_SECRET: 'pw',
};

function problems(env: Record<string, string | undefined>): string[] {
  try {
    loadConfig(env);
  } catch (error) {
    expect(error).toBeInstanceOf(ConfigError);
    return (error as ConfigError).problems;
  }
  throw new Error('expected loadConfig to throw');
}

describe('loadConfig', () => {
  it('derives the Idira endpoints and applies defaults', () => {
    const config = loadConfig(BASE);
    expect(config).toMatchObject({
      host: '127.0.0.1',
      port: 3000,
      mcpPath: '/mcp',
      logLevel: 'info',
      idira: {
        graphqlUrl: 'https://acme.inventory.cyberark.cloud/api/graphql',
        tokenUrl: 'https://abc1234.id.cyberark.cloud/oauth2/platformtoken',
        clientId: BASE.IDIRA_CLIENT_ID,
        clientSecret: 'pw',
        timeoutMs: 30_000,
      },
      disco: { allowSecretValues: false, batchSize: 100 },
      auth: {
        issuerUrl: BASE.OAUTH_ISSUER_URL,
        audiences: ['https://disco-mcp.example.com/mcp'],
        requiredScopes: [],
        scopes: { read: [], write: [], delete: [] },
      },
    });
    expect(config.publicUrl.href).toBe('https://disco-mcp.example.com/mcp');
    expect(config.allowedHosts.sort()).toEqual(['127.0.0.1', '[::1]', 'disco-mcp.example.com', 'localhost']);
  });

  it('accepts explicit endpoint overrides and tuning', () => {
    const config = loadConfig({
      ...BASE,
      IDIRA_SUBDOMAIN: undefined,
      IDIRA_IDENTITY_URL: undefined,
      IDIRA_DISCO_GRAPHQL_URL: 'https://acme.inventory.example.eu/api/graphql',
      IDIRA_PLATFORM_TOKEN_URL: 'https://id.example.eu/oauth2/platformtoken',
      MCP_HOST: '0.0.0.0',
      MCP_PORT: '8443',
      MCP_ALLOWED_HOSTS: 'internal.lb, 10.0.0.5',
      OAUTH_AUDIENCE: 'api://disco-mcp https://disco-mcp.example.com/mcp',
      OAUTH_JWKS_URI: 'https://keys.example.com/jwks',
      OAUTH_REQUIRED_SCOPES: 'disco',
      OAUTH_SCOPES_READ: 'disco:read',
      OAUTH_SCOPES_WRITE: 'disco:write',
      OAUTH_SCOPES_DELETE: 'disco:write,disco:delete',
      DISCO_ALLOW_SECRET_VALUES: 'TRUE',
      DISCO_BATCH_SIZE: '25',
      IDIRA_TIMEOUT_MS: '5000',
      LOG_LEVEL: 'debug',
    });
    expect(config).toMatchObject({
      host: '0.0.0.0',
      port: 8443,
      logLevel: 'debug',
      idira: {
        graphqlUrl: 'https://acme.inventory.example.eu/api/graphql',
        tokenUrl: 'https://id.example.eu/oauth2/platformtoken',
        timeoutMs: 5000,
      },
      disco: { allowSecretValues: true, batchSize: 25 },
      auth: {
        audiences: ['api://disco-mcp', 'https://disco-mcp.example.com/mcp'],
        jwksUri: 'https://keys.example.com/jwks',
        requiredScopes: ['disco'],
        scopes: { read: ['disco:read'], write: ['disco:write'], delete: ['disco:write', 'disco:delete'] },
      },
    });
    expect(config.allowedHosts.sort()).toEqual(['10.0.0.5', 'disco-mcp.example.com', 'internal.lb']);
  });

  it('defaults the public URL to localhost on the configured port', () => {
    const config = loadConfig({ ...BASE, MCP_PUBLIC_URL: undefined, MCP_PORT: '4100' });
    expect(config.publicUrl.href).toBe('http://localhost:4100/mcp');
    expect(config.auth?.audiences).toEqual(['http://localhost:4100/mcp']);
  });

  it('serves the endpoint at the root when the public URL has no path', () => {
    expect(loadConfig({ ...BASE, MCP_PUBLIC_URL: 'https://disco-mcp.example.com' }).mcpPath).toBe('/');
  });

  it('keeps leading and trailing whitespace in the client secret', () => {
    expect(loadConfig({ ...BASE, IDIRA_CLIENT_SECRET: ' pw ' }).idira.clientSecret).toBe(' pw ');
  });

  it('allows disabling authentication only on a loopback bind', () => {
    const local = loadConfig({ ...BASE, OAUTH_ISSUER_URL: undefined, MCP_AUTH_DISABLED: 'true' });
    expect(local.auth).toBeUndefined();
    expect(problems({ ...BASE, MCP_AUTH_DISABLED: '1', MCP_HOST: '0.0.0.0' })).toEqual([
      'MCP_AUTH_DISABLED is only permitted when MCP_HOST is a loopback address',
    ]);
  });

  it('reports every problem at once', () => {
    const found = problems({});
    expect(found).toEqual([
      'OAUTH_ISSUER_URL is required (the OAuth 2.1 authorization server that issues tokens for this server)',
      'IDIRA_SUBDOMAIN (or IDIRA_DISCO_GRAPHQL_URL) is required',
      'IDIRA_IDENTITY_URL (or IDIRA_PLATFORM_TOKEN_URL) is required, e.g. https://abc1234.id.cyberark.cloud',
      'IDIRA_CLIENT_ID is required (login name of the service user)',
      'IDIRA_CLIENT_SECRET is required (password of the service user)',
    ]);
    expect(() => loadConfig({})).toThrow(/Invalid configuration:\n {2}- OAUTH_ISSUER_URL/);
  });

  it.each([
    [{ MCP_PUBLIC_URL: 'http://disco-mcp.example.com/mcp' }, 'MCP_PUBLIC_URL must use https (http is only accepted for localhost)'],
    [{ MCP_PUBLIC_URL: 'not a url' }, 'MCP_PUBLIC_URL is not a valid URL'],
    [{ MCP_PUBLIC_URL: 'https://x.example.com/mcp?a=1' }, 'MCP_PUBLIC_URL must not contain a query string or fragment'],
    [{ MCP_PUBLIC_URL: 'https://x.example.com/mcp#frag' }, 'MCP_PUBLIC_URL must not contain a query string or fragment'],
    [{ OAUTH_ISSUER_URL: 'http://as.example.com' }, 'OAUTH_ISSUER_URL must use https (http is only accepted for localhost)'],
    [{ OAUTH_JWKS_URI: 'ftp://keys' }, 'OAUTH_JWKS_URI must use https (http is only accepted for localhost)'],
    [{ IDIRA_SUBDOMAIN: 'acme.inventory.cyberark.cloud' }, 'IDIRA_SUBDOMAIN must be a bare tenant subdomain such as "acme"'],
    [{ IDIRA_DISCO_GRAPHQL_URL: 'http://acme.example.com/api/graphql' }, 'IDIRA_DISCO_GRAPHQL_URL must use https (http is only accepted for localhost)'],
    [{ IDIRA_IDENTITY_URL: 'abc1234.id.cyberark.cloud' }, 'IDIRA_IDENTITY_URL is not a valid URL'],
    [{ IDIRA_PLATFORM_TOKEN_URL: 'http://id.example.com/token' }, 'IDIRA_PLATFORM_TOKEN_URL must use https (http is only accepted for localhost)'],
    [{ MCP_PORT: '70000' }, 'MCP_PORT must be an integer between 1 and 65535'],
    [{ MCP_PORT: 'abc' }, 'MCP_PORT must be an integer between 1 and 65535'],
    [{ DISCO_BATCH_SIZE: '0' }, 'DISCO_BATCH_SIZE must be an integer between 1 and 1000'],
    [{ IDIRA_TIMEOUT_MS: '1.5' }, 'IDIRA_TIMEOUT_MS must be an integer between 1000 and 300000'],
    [{ DISCO_ALLOW_SECRET_VALUES: 'yes' }, 'DISCO_ALLOW_SECRET_VALUES must be "true" or "false"'],
    [{ LOG_LEVEL: 'verbose' }, 'LOG_LEVEL must be one of debug, info, warn, error'],
    [{ IDIRA_CLIENT_ID: '   ' }, 'IDIRA_CLIENT_ID is required (login name of the service user)'],
  ])('rejects %j', (override, message) => {
    expect(problems({ ...BASE, ...override })).toEqual([message]);
  });

  it('accepts plain http for loopback URLs', () => {
    const config = loadConfig({
      ...BASE,
      MCP_PUBLIC_URL: 'http://127.0.0.1:3000/mcp',
      OAUTH_ISSUER_URL: 'http://localhost:9000',
      IDIRA_DISCO_GRAPHQL_URL: 'http://[::1]:9001/api/graphql',
    });
    expect(config.idira.graphqlUrl).toBe('http://[::1]:9001/api/graphql');
  });
});
