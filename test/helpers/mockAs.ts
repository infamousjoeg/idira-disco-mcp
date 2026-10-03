import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { exportJWK, generateKeyPair, type JWK, SignJWT } from 'jose';

export interface SignOptions {
  /** Sign with a key the authorization server does not publish. */
  foreignKey?: boolean;
  /** Seconds from now; negative for an already expired token. Pass null to omit `exp`. */
  expiresIn?: number | null;
  issuer?: string;
}

export interface MockAuthorizationServer {
  issuer: string;
  jwksUri: string;
  /** Number of times the JWKS document was fetched. */
  jwksRequests: number;
  sign(claims: Record<string, unknown>, options?: SignOptions): Promise<string>;
  close(): Promise<void>;
}

/** A minimal OAuth 2.1 authorization server: RFC 8414 metadata, a JWKS, and a token mint for tests. */
export async function startMockAuthorizationServer(
  options: { openIdOnly?: boolean; issuerPath?: string; omitJwksUri?: boolean } = {},
): Promise<MockAuthorizationServer> {
  const { publicKey, privateKey } = await generateKeyPair('RS256');
  const foreign = await generateKeyPair('RS256');
  const jwk: JWK = { ...(await exportJWK(publicKey)), kid: 'test-key', alg: 'RS256', use: 'sig' };
  const issuerPath = options.issuerPath ?? '';

  const mock: MockAuthorizationServer = {
    issuer: '',
    jwksUri: '',
    jwksRequests: 0,
    async sign(claims, signOptions = {}) {
      const jwt = new SignJWT(claims)
        .setProtectedHeader({ alg: 'RS256', kid: 'test-key', typ: 'at+jwt' })
        .setIssuer(signOptions.issuer ?? mock.issuer)
        .setIssuedAt();
      if (signOptions.expiresIn !== null) {
        jwt.setExpirationTime(Math.floor(Date.now() / 1000) + (signOptions.expiresIn ?? 300));
      }
      return jwt.sign(signOptions.foreignKey ? foreign.privateKey : privateKey);
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };

  const server: Server = createServer((req, res) => {
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    };
    const metadata = {
      issuer: mock.issuer,
      authorization_endpoint: `${mock.issuer}/authorize`,
      token_endpoint: `${mock.issuer}/token`,
      registration_endpoint: `${mock.issuer}/register`,
      ...(!options.omitJwksUri && { jwks_uri: mock.jwksUri }),
      response_types_supported: ['code'],
      grant_types_supported: ['authorization_code', 'refresh_token'],
      code_challenge_methods_supported: ['S256'],
      token_endpoint_auth_methods_supported: ['client_secret_basic', 'none'],
    };
    const rfc8414 = `/.well-known/oauth-authorization-server${issuerPath}`;
    const oidc = issuerPath ? `${issuerPath}/.well-known/openid-configuration` : '/.well-known/openid-configuration';
    if (req.url === rfc8414 && !options.openIdOnly) return json(metadata);
    if (req.url === oidc) return json(metadata);
    if (req.url === '/jwks') {
      mock.jwksRequests++;
      return json({ keys: [jwk] });
    }
    res.writeHead(404).end();
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  mock.issuer = `http://localhost:${port}${issuerPath}`;
  mock.jwksUri = `http://localhost:${port}/jwks`;
  return mock;
}
