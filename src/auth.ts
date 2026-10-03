import { type AuthInfo, OAuthError, OAuthErrorCode, type OAuthMetadata, type OAuthTokenVerifier } from '@modelcontextprotocol/server';
import { createRemoteJWKSet, errors as joseErrors, type JWTPayload, type JWTVerifyGetKey, jwtVerify } from 'jose';

/** Asymmetric signature algorithms only: a shared-secret or unsigned token is never acceptable here. */
const ALLOWED_ALGORITHMS = ['RS256', 'RS384', 'RS512', 'PS256', 'PS384', 'PS512', 'ES256', 'ES384', 'ES512', 'EdDSA'];
const CLOCK_TOLERANCE_SECONDS = 30;

function stripTrailingSlash(value: string): string {
  return value.endsWith('/') ? value.slice(0, -1) : value;
}

/**
 * Candidate metadata URLs for an issuer, in the priority order the MCP authorization
 * spec prescribes: RFC 8414, then OpenID Connect Discovery (path-inserted, then path-appended).
 */
export function metadataUrls(issuer: string): string[] {
  const url = new URL(issuer);
  const path = stripTrailingSlash(url.pathname);
  if (path === '') {
    return [`${url.origin}/.well-known/oauth-authorization-server`, `${url.origin}/.well-known/openid-configuration`];
  }
  return [
    `${url.origin}/.well-known/oauth-authorization-server${path}`,
    `${url.origin}/.well-known/openid-configuration${path}`,
    `${url.origin}${path}/.well-known/openid-configuration`,
  ];
}

/** Fetches and validates the authorization server metadata for the configured issuer. */
export async function discoverAuthorizationServer(issuer: string, fetchImpl: typeof fetch = fetch): Promise<OAuthMetadata> {
  const failures: string[] = [];
  for (const url of metadataUrls(issuer)) {
    let response: Response;
    try {
      response = await fetchImpl(url, { headers: { accept: 'application/json' }, signal: AbortSignal.timeout(10_000) });
    } catch (error) {
      failures.push(`${url}: ${(error as Error).message}`);
      continue;
    }
    if (!response.ok) {
      await response.body?.cancel();
      failures.push(`${url}: HTTP ${response.status}`);
      continue;
    }
    const metadata = (await response.json().catch(() => undefined)) as Partial<OAuthMetadata> | undefined;
    if (typeof metadata?.issuer !== 'string') {
      failures.push(`${url}: not an authorization server metadata document`);
      continue;
    }
    // RFC 8414 section 3.3: the issuer in the document must be the one the document was requested for.
    if (stripTrailingSlash(metadata.issuer) !== stripTrailingSlash(issuer)) {
      throw new Error(`Authorization server metadata at ${url} names issuer "${metadata.issuer}", expected "${issuer}"`);
    }
    return metadata as OAuthMetadata;
  }
  throw new Error(`Could not load authorization server metadata for ${issuer}:\n  ${failures.join('\n  ')}`);
}

export interface JwtVerifierOptions {
  /** Exact `iss` value tokens must carry (the issuer from the authorization server metadata). */
  issuer: string;
  /** Accepted `aud` values. */
  audiences: string[];
  /** Canonical resource URL of this server, reported on verified tokens. */
  resource: URL;
  jwksUri?: string;
  /** Key source override, for tests. */
  getKey?: JWTVerifyGetKey;
}

function scopesOf(payload: JWTPayload): string[] {
  const claim = payload.scope ?? payload.scp;
  if (typeof claim === 'string') return claim.split(' ').filter(Boolean);
  if (Array.isArray(claim)) return claim.filter((scope): scope is string => typeof scope === 'string');
  return [];
}

function describe(error: unknown): string {
  if (error instanceof joseErrors.JWTExpired) return 'The access token has expired';
  if (error instanceof joseErrors.JWTClaimValidationFailed) return `The access token ${error.claim} claim is not acceptable`;
  if (error instanceof joseErrors.JWSSignatureVerificationFailed || error instanceof joseErrors.JWKSNoMatchingKey) {
    return 'The access token signature could not be verified';
  }
  if (error instanceof joseErrors.JOSEAlgNotAllowed) return 'The access token signature algorithm is not allowed';
  return 'The access token is not a valid JWT';
}

/**
 * Verifies JWT access tokens locally: signature against the authorization server's JWKS,
 * issuer, expiry, and audience. The audience check is what binds a token to this server
 * (RFC 8707), so a token minted for any other resource is refused.
 */
export function createJwtVerifier(options: JwtVerifierOptions): OAuthTokenVerifier {
  const getKey = options.getKey ?? createRemoteJWKSet(new URL(options.jwksUri!), { timeoutDuration: 5_000 });
  // Authorization servers differ on whether a URL audience carries a trailing slash.
  const audience = [...new Set(options.audiences.flatMap((aud) => [aud, stripTrailingSlash(aud), `${stripTrailingSlash(aud)}/`]))];

  return {
    async verifyAccessToken(token: string): Promise<AuthInfo> {
      let payload: JWTPayload;
      try {
        ({ payload } = await jwtVerify(token, getKey, {
          issuer: options.issuer,
          audience,
          algorithms: ALLOWED_ALGORITHMS,
          clockTolerance: CLOCK_TOLERANCE_SECONDS,
          requiredClaims: ['exp'],
        }));
      } catch (error) {
        if (error instanceof joseErrors.JWKSTimeout || !(error instanceof joseErrors.JOSEError)) {
          // The key set could not be fetched: our problem, not the caller's token.
          throw new OAuthError(OAuthErrorCode.ServerError, 'Could not retrieve the authorization server signing keys');
        }
        throw new OAuthError(OAuthErrorCode.InvalidToken, describe(error));
      }
      const clientId = [payload.client_id, payload.azp, payload.sub].find((value): value is string => typeof value === 'string');
      return {
        token,
        clientId: clientId ?? 'unknown',
        scopes: scopesOf(payload),
        expiresAt: payload.exp,
        resource: options.resource,
        extra: { sub: payload.sub, iss: payload.iss },
      };
    },
  };
}
