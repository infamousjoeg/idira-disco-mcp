import { OAuthError } from '@modelcontextprotocol/server';
import { createLocalJWKSet, exportJWK, generateKeyPair, SignJWT } from 'jose';
import { afterEach, describe, expect, it } from 'vitest';

import { buildApp } from '../src/app.js';
import { createJwtVerifier, discoverAuthorizationServer, metadataUrls } from '../src/auth.js';
import { loadConfig } from '../src/config.js';
import { createLogger, silentLogger } from '../src/logger.js';
import { type Harness, startHarness } from './helpers/harness.js';
import { type MockAuthorizationServer, startMockAuthorizationServer } from './helpers/mockAs.js';

const servers: Array<{ close(): Promise<void> }> = [];
afterEach(async () => {
  await Promise.all(servers.splice(0).map((server) => server.close()));
});

async function authorizationServer(options?: Parameters<typeof startMockAuthorizationServer>[0]): Promise<MockAuthorizationServer> {
  const server = await startMockAuthorizationServer(options);
  servers.push(server);
  return server;
}

describe('metadataUrls', () => {
  it('uses the RFC 8414 location first, then OpenID Connect Discovery', () => {
    expect(metadataUrls('https://as.example.com')).toEqual([
      'https://as.example.com/.well-known/oauth-authorization-server',
      'https://as.example.com/.well-known/openid-configuration',
    ]);
    expect(metadataUrls('https://as.example.com/')).toEqual(metadataUrls('https://as.example.com'));
  });

  it('inserts the well-known segment before an issuer path, then tries appending it', () => {
    expect(metadataUrls('https://as.example.com/tenant1/')).toEqual([
      'https://as.example.com/.well-known/oauth-authorization-server/tenant1',
      'https://as.example.com/.well-known/openid-configuration/tenant1',
      'https://as.example.com/tenant1/.well-known/openid-configuration',
    ]);
  });
});

describe('discoverAuthorizationServer', () => {
  it('reads RFC 8414 metadata', async () => {
    const as = await authorizationServer();
    const metadata = await discoverAuthorizationServer(as.issuer);
    expect(metadata).toMatchObject({ issuer: as.issuer, jwks_uri: as.jwksUri });
  });

  it('falls back to OpenID Connect Discovery, including for issuers with a path', async () => {
    const root = await authorizationServer({ openIdOnly: true });
    expect((await discoverAuthorizationServer(root.issuer)).issuer).toBe(root.issuer);
    const tenant = await authorizationServer({ openIdOnly: true, issuerPath: '/tenant1' });
    expect((await discoverAuthorizationServer(tenant.issuer)).issuer).toBe(tenant.issuer);
    expect((await discoverAuthorizationServer(`${tenant.issuer}/`)).issuer).toBe(tenant.issuer);
  });

  it('refuses metadata that names a different issuer', async () => {
    const fetchImpl = (async () => Response.json({ issuer: 'https://evil.example.com' })) as unknown as typeof fetch;
    await expect(discoverAuthorizationServer('https://as.example.com', fetchImpl)).rejects.toThrow(
      'names issuer "https://evil.example.com", expected "https://as.example.com"',
    );
  });

  it('lists every attempt when no metadata document can be loaded', async () => {
    const replies = [new Response('nope', { status: 404 }), Response.json({ not: 'metadata' })];
    const fetchImpl = (async () => replies.shift() ?? Promise.reject(new TypeError('fetch failed'))) as unknown as typeof fetch;
    const error = await discoverAuthorizationServer('https://as.example.com/t', fetchImpl).catch((reason: Error) => reason);
    expect((error as Error).message).toBe(
      'Could not load authorization server metadata for https://as.example.com/t:\n' +
        '  https://as.example.com/.well-known/oauth-authorization-server/t: HTTP 404\n' +
        '  https://as.example.com/.well-known/openid-configuration/t: not an authorization server metadata document\n' +
        '  https://as.example.com/t/.well-known/openid-configuration: fetch failed',
    );
  });
});

describe('createJwtVerifier', () => {
  const resource = new URL('https://disco-mcp.example.com/mcp');
  const issuer = 'https://as.example.com';

  async function setup() {
    const { publicKey, privateKey } = await generateKeyPair('ES256');
    const getKey = createLocalJWKSet({ keys: [{ ...(await exportJWK(publicKey)), kid: 'k1' }] });
    const verifier = createJwtVerifier({ issuer, audiences: [resource.href, 'api://disco'], resource, getKey });
    const mint = (claims: Record<string, unknown>) =>
      new SignJWT(claims).setProtectedHeader({ alg: 'ES256', kid: 'k1' }).setIssuer(issuer).setExpirationTime('5m').sign(privateKey);
    return { verifier, mint };
  }

  it('returns the token details handlers rely on', async () => {
    const { verifier, mint } = await setup();
    const token = await mint({ aud: resource.href, sub: 'joe', client_id: 'claude-code', scope: 'disco:read  disco:write' });
    const info = await verifier.verifyAccessToken(token);
    expect(info).toMatchObject({
      token,
      clientId: 'claude-code',
      scopes: ['disco:read', 'disco:write'],
      resource,
      extra: { sub: 'joe', iss: issuer },
    });
    expect(info.expiresAt).toBeGreaterThan(Date.now() / 1000);
  });

  it('accepts any configured audience, including a non-URL one', async () => {
    const { verifier, mint } = await setup();
    expect((await verifier.verifyAccessToken(await mint({ aud: 'api://disco' }))).resource).toBe(resource);
    await expect(verifier.verifyAccessToken(await mint({ aud: 'api://other' }))).rejects.toMatchObject({
      code: 'invalid_token',
      message: 'The access token aud claim is not acceptable',
    });
  });

  it('identifies the client from client_id, then azp, then sub', async () => {
    const { verifier, mint } = await setup();
    const clientId = async (claims: Record<string, unknown>) =>
      (await verifier.verifyAccessToken(await mint({ aud: 'api://disco', ...claims }))).clientId;
    expect(await clientId({ client_id: 'a', azp: 'b', sub: 'c' })).toBe('a');
    expect(await clientId({ azp: 'b', sub: 'c' })).toBe('b');
    expect(await clientId({ sub: 'c' })).toBe('c');
    expect(await clientId({})).toBe('unknown');
  });

  it('reads scopes from scope or scp, as a string or an array', async () => {
    const { verifier, mint } = await setup();
    const scopes = async (claims: Record<string, unknown>) =>
      (await verifier.verifyAccessToken(await mint({ aud: 'api://disco', ...claims }))).scopes;
    expect(await scopes({ scp: 'a b' })).toEqual(['a', 'b']);
    expect(await scopes({ scp: ['a', 'b', 7] })).toEqual(['a', 'b']);
    expect(await scopes({})).toEqual([]);
    expect(await scopes({ scope: 42 })).toEqual([]);
  });

  it('describes why a token was refused', async () => {
    const { verifier } = await setup();
    const error = await verifier.verifyAccessToken('a.b.c').catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(OAuthError);
    expect(error).toMatchObject({ code: 'invalid_token', message: 'The access token is not a valid JWT' });
  });

  it('answers server_error, not invalid_token, when the signing keys cannot be fetched', async () => {
    const as = await authorizationServer();
    const token = await as.sign({ aud: resource.href });
    const verifier = createJwtVerifier({ issuer: as.issuer, audiences: [resource.href], resource, jwksUri: 'http://127.0.0.1:9/jwks' });
    await expect(verifier.verifyAccessToken(token)).rejects.toMatchObject({ code: 'server_error' });
  });

  it('fetches the key set once and reuses it', async () => {
    const as = await authorizationServer();
    const verifier = createJwtVerifier({ issuer: as.issuer, audiences: [resource.href], resource, jwksUri: as.jwksUri });
    for (let i = 0; i < 3; i++) await verifier.verifyAccessToken(await as.sign({ aud: resource.href }));
    expect(as.jwksRequests).toBe(1);
  });
});

describe('buildApp', () => {
  const env = (as: MockAuthorizationServer, extra: Record<string, string> = {}) => ({
    OAUTH_ISSUER_URL: as.issuer,
    IDIRA_SUBDOMAIN: 'acme',
    IDIRA_IDENTITY_URL: 'https://abc1234.id.cyberark.cloud',
    IDIRA_CLIENT_ID: 'svc',
    IDIRA_CLIENT_SECRET: 'pw',
    ...extra,
  });

  it('fails fast when the authorization server publishes no key set', async () => {
    const as = await authorizationServer({ omitJwksUri: true });
    await expect(buildApp(loadConfig(env(as)), { logger: silentLogger })).rejects.toThrow('does not advertise a jwks_uri; set OAUTH_JWKS_URI');
    await expect(buildApp(loadConfig(env(as, { OAUTH_JWKS_URI: as.jwksUri })), { logger: silentLogger })).resolves.toBeDefined();
  });

  it('fails fast when the authorization server cannot be reached', async () => {
    const config = loadConfig({ ...env(await authorizationServer()), OAUTH_ISSUER_URL: 'http://127.0.0.1:9' });
    await expect(buildApp(config, { logger: silentLogger })).rejects.toThrow('Could not load authorization server metadata');
  });
});

describe('authentication disabled for local development', () => {
  let harness: Harness;
  afterEach(() => harness.close());

  it('serves tools without a token and publishes no OAuth metadata', async () => {
    harness = await startHarness({ MCP_AUTH_DISABLED: 'true' });
    expect(harness.config.auth).toBeUndefined();
    const client = await harness.connect('ignored');
    expect((await client.listTools()).tools).toHaveLength(9);
    expect((await fetch(`${harness.origin}/.well-known/oauth-protected-resource/mcp`)).status).toBe(404);
  });
});

describe('logger', () => {
  it('writes JSON lines at or above the configured level', () => {
    const lines: string[] = [];
    const logger = createLogger('warn', (line) => lines.push(line));
    logger.debug('d');
    logger.info('i');
    logger.warn('w', { tool: 'disco_query_secrets' });
    logger.error('e');
    expect(lines).toHaveLength(2);
    expect(lines[0]!.endsWith('\n')).toBe(true);
    expect(JSON.parse(lines[0]!)).toMatchObject({ level: 'warn', message: 'w', tool: 'disco_query_secrets' });
    expect(JSON.parse(lines[1]!).level).toBe('error');
    const verbose: string[] = [];
    createLogger('debug', (line) => verbose.push(line)).debug('d');
    expect(verbose).toHaveLength(1);
  });
});
