const LOOPBACK_HOSTS = new Set(['localhost', '127.0.0.1', '::1', '[::1]']);

export class ConfigError extends Error {
  constructor(public readonly problems: string[]) {
    super(`Invalid configuration:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
    this.name = 'ConfigError';
  }
}

export interface AuthConfig {
  /** Issuer identifier of the OAuth 2.1 authorization server that issues tokens for this server. */
  issuerUrl: string;
  /** Overrides the `jwks_uri` advertised by the authorization server metadata. */
  jwksUri?: string;
  /** Accepted values of the token `aud` claim. Defaults to the public URL of this server. */
  audiences: string[];
  /** Scopes every request must carry. */
  requiredScopes: string[];
  /** Additional scopes required per operation class. Empty means no extra requirement. */
  scopes: { read: string[]; write: string[]; delete: string[] };
}

export interface Config {
  host: string;
  port: number;
  /** Canonical public URL of the MCP endpoint; also the RFC 8707 resource identifier. */
  publicUrl: URL;
  /** Path the MCP endpoint is served on (the path of `publicUrl`). */
  mcpPath: string;
  allowedHosts: string[];
  /** `undefined` only when authentication was explicitly disabled on a loopback bind. */
  auth?: AuthConfig;
  idira: {
    graphqlUrl: string;
    tokenUrl: string;
    clientId: string;
    clientSecret: string;
    timeoutMs: number;
  };
  disco: {
    allowSecretValues: boolean;
    batchSize: number;
  };
  logLevel: 'debug' | 'info' | 'warn' | 'error';
}

type Env = Record<string, string | undefined>;

function list(value: string | undefined): string[] {
  return (value ?? '').split(/[\s,]+/).filter(Boolean);
}

function isLoopback(hostname: string): boolean {
  return LOOPBACK_HOSTS.has(hostname.toLowerCase());
}

export function loadConfig(env: Env = process.env): Config {
  const problems: string[] = [];
  const get = (name: string): string | undefined => {
    const value = env[name]?.trim();
    return value === '' ? undefined : value;
  };
  const bool = (name: string): boolean => {
    const value = get(name)?.toLowerCase();
    if (value === undefined || value === 'false' || value === '0') return false;
    if (value === 'true' || value === '1') return true;
    problems.push(`${name} must be "true" or "false"`);
    return false;
  };
  const int = (name: string, fallback: number, min: number, max: number): number => {
    const raw = get(name);
    if (raw === undefined) return fallback;
    const value = Number(raw);
    if (!Number.isInteger(value) || value < min || value > max) {
      problems.push(`${name} must be an integer between ${min} and ${max}`);
      return fallback;
    }
    return value;
  };
  /** Parses an absolute URL that must be HTTPS unless it points at a loopback host. */
  const url = (name: string, raw: string | undefined): URL | undefined => {
    if (raw === undefined) return undefined;
    let parsed: URL;
    try {
      parsed = new URL(raw);
    } catch {
      problems.push(`${name} is not a valid URL`);
      return undefined;
    }
    if (parsed.protocol !== 'https:' && !(parsed.protocol === 'http:' && isLoopback(parsed.hostname))) {
      problems.push(`${name} must use https (http is only accepted for localhost)`);
      return undefined;
    }
    return parsed;
  };

  const host = get('MCP_HOST') ?? '127.0.0.1';
  const port = int('MCP_PORT', 3000, 1, 65535);

  const publicUrl = url('MCP_PUBLIC_URL', get('MCP_PUBLIC_URL') ?? `http://localhost:${port}/mcp`);
  if (publicUrl && (publicUrl.hash || publicUrl.search)) {
    problems.push('MCP_PUBLIC_URL must not contain a query string or fragment');
  }

  const allowedHosts = new Set<string>(list(get('MCP_ALLOWED_HOSTS')));
  if (publicUrl) allowedHosts.add(publicUrl.hostname);
  if (isLoopback(host)) for (const name of ['localhost', '127.0.0.1', '[::1]']) allowedHosts.add(name);

  let auth: AuthConfig | undefined;
  if (bool('MCP_AUTH_DISABLED')) {
    if (!isLoopback(host)) {
      problems.push('MCP_AUTH_DISABLED is only permitted when MCP_HOST is a loopback address');
    }
  } else {
    const issuer = get('OAUTH_ISSUER_URL');
    if (issuer === undefined) {
      problems.push('OAUTH_ISSUER_URL is required (the OAuth 2.1 authorization server that issues tokens for this server)');
    } else {
      url('OAUTH_ISSUER_URL', issuer);
    }
    const jwksUri = get('OAUTH_JWKS_URI');
    url('OAUTH_JWKS_URI', jwksUri);
    const audiences = list(get('OAUTH_AUDIENCE'));
    auth = {
      issuerUrl: issuer ?? '',
      jwksUri,
      audiences: audiences.length > 0 ? audiences : publicUrl ? [publicUrl.href] : [],
      requiredScopes: list(get('OAUTH_REQUIRED_SCOPES')),
      scopes: {
        read: list(get('OAUTH_SCOPES_READ')),
        write: list(get('OAUTH_SCOPES_WRITE')),
        delete: list(get('OAUTH_SCOPES_DELETE')),
      },
    };
  }

  let graphqlUrl = url('IDIRA_DISCO_GRAPHQL_URL', get('IDIRA_DISCO_GRAPHQL_URL'))?.href;
  if (graphqlUrl === undefined && get('IDIRA_DISCO_GRAPHQL_URL') === undefined) {
    const subdomain = get('IDIRA_SUBDOMAIN');
    if (subdomain === undefined) {
      problems.push('IDIRA_SUBDOMAIN (or IDIRA_DISCO_GRAPHQL_URL) is required');
    } else if (!/^[a-z0-9]([a-z0-9-]*[a-z0-9])?$/i.test(subdomain)) {
      problems.push('IDIRA_SUBDOMAIN must be a bare tenant subdomain such as "acme"');
    } else {
      graphqlUrl = `https://${subdomain}.inventory.cyberark.cloud/api/graphql`;
    }
  }

  let tokenUrl = url('IDIRA_PLATFORM_TOKEN_URL', get('IDIRA_PLATFORM_TOKEN_URL'))?.href;
  if (tokenUrl === undefined && get('IDIRA_PLATFORM_TOKEN_URL') === undefined) {
    const identityUrl = get('IDIRA_IDENTITY_URL');
    if (identityUrl === undefined) {
      problems.push('IDIRA_IDENTITY_URL (or IDIRA_PLATFORM_TOKEN_URL) is required, e.g. https://abc1234.id.cyberark.cloud');
    } else {
      const parsed = url('IDIRA_IDENTITY_URL', identityUrl);
      if (parsed) tokenUrl = new URL('/oauth2/platformtoken', parsed).href;
    }
  }

  const clientId = get('IDIRA_CLIENT_ID');
  if (clientId === undefined) problems.push('IDIRA_CLIENT_ID is required (login name of the service user)');
  // Not trimmed: a password may legitimately start or end with whitespace.
  const clientSecret = env['IDIRA_CLIENT_SECRET'];
  if (!clientSecret) problems.push('IDIRA_CLIENT_SECRET is required (password of the service user)');

  const logLevel = get('LOG_LEVEL') ?? 'info';
  if (!['debug', 'info', 'warn', 'error'].includes(logLevel)) {
    problems.push('LOG_LEVEL must be one of debug, info, warn, error');
  }

  const timeoutMs = int('IDIRA_TIMEOUT_MS', 30_000, 1_000, 300_000);
  const batchSize = int('DISCO_BATCH_SIZE', 100, 1, 1000);
  const allowSecretValues = bool('DISCO_ALLOW_SECRET_VALUES');

  if (problems.length > 0 || !publicUrl) throw new ConfigError(problems);

  return {
    host,
    port,
    publicUrl,
    mcpPath: publicUrl.pathname,
    allowedHosts: [...allowedHosts],
    auth,
    idira: {
      graphqlUrl: graphqlUrl!,
      tokenUrl: tokenUrl!,
      clientId: clientId!,
      clientSecret: clientSecret!,
      timeoutMs,
    },
    disco: { allowSecretValues, batchSize },
    logLevel: logLevel as Config['logLevel'],
  };
}
