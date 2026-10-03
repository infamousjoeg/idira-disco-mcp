export type DiscoErrorKind = 'auth' | 'graphql' | 'http' | 'network';

export interface GraphQLErrorEntry {
  message?: string;
  errorType?: string;
  path?: unknown;
}

export class DiscoApiError extends Error {
  constructor(
    public readonly kind: DiscoErrorKind,
    message: string,
    public readonly status?: number,
    public readonly graphqlErrors?: GraphQLErrorEntry[],
  ) {
    super(message);
    this.name = 'DiscoApiError';
  }
}

export interface DiscoClientOptions {
  graphqlUrl: string;
  tokenUrl: string;
  clientId: string;
  clientSecret: string;
  timeoutMs: number;
  /** Retries after a network failure or a 429/502/503/504 answer. Defaults to 2. */
  maxRetries?: number;
  fetch?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
}

/** Seconds shaved off a platform token's lifetime so it is never used at the edge of expiry. */
const TOKEN_EXPIRY_SKEW_SECONDS = 60;
const RETRYABLE_STATUS = new Set([429, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 10_000;

function summarize(errors: GraphQLErrorEntry[]): string {
  return errors
    .map((error) => (error.errorType ? `${error.errorType}: ${error.message ?? 'no message'}` : (error.message ?? 'no message')))
    .join('; ');
}

function isUnauthorized(errors: GraphQLErrorEntry[]): boolean {
  return errors.some((error) => error.errorType === 'UnauthorizedException' || error.errorType === 'Unauthorized');
}

/**
 * Client for the Discovery & Context GraphQL endpoint. It authenticates as an Idira
 * service user (client-credentials platform token) and keeps the short-lived token cached.
 */
export class DiscoClient {
  private token?: { value: string; expiresAt: number };
  private pendingToken?: Promise<string>;
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly maxRetries: number;

  constructor(private readonly options: DiscoClientOptions) {
    this.fetchImpl = options.fetch ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)));
    this.maxRetries = options.maxRetries ?? 2;
  }

  async getToken(): Promise<string> {
    if (this.token && this.token.expiresAt > this.now()) return this.token.value;
    // Concurrent callers share one token request.
    this.pendingToken ??= this.requestToken().finally(() => {
      this.pendingToken = undefined;
    });
    return this.pendingToken;
  }

  private async requestToken(): Promise<string> {
    let response: Response;
    try {
      response = await this.fetchImpl(this.options.tokenUrl, {
        method: 'POST',
        headers: { 'content-type': 'application/x-www-form-urlencoded', accept: 'application/json' },
        body: new URLSearchParams({
          grant_type: 'client_credentials',
          client_id: this.options.clientId,
          client_secret: this.options.clientSecret,
        }),
        signal: AbortSignal.timeout(this.options.timeoutMs),
      });
    } catch (error) {
      throw new DiscoApiError('network', `Could not reach the Idira platform token endpoint: ${(error as Error).message}`);
    }
    if (!response.ok) {
      await response.body?.cancel();
      const hint =
        response.status === 400 || response.status === 401
          ? ' Check IDIRA_CLIENT_ID and IDIRA_CLIENT_SECRET, and that the service user is an OAuth confidential client.'
          : '';
      throw new DiscoApiError('auth', `Idira platform token request failed with HTTP ${response.status}.${hint}`, response.status);
    }
    const body = (await response.json().catch(() => undefined)) as { access_token?: unknown; expires_in?: unknown } | undefined;
    if (typeof body?.access_token !== 'string' || body.access_token === '') {
      throw new DiscoApiError('auth', 'Idira platform token response did not contain an access_token.', response.status);
    }
    const lifetime = typeof body.expires_in === 'number' && body.expires_in > 0 ? body.expires_in : 900;
    const usable = Math.max(lifetime - TOKEN_EXPIRY_SKEW_SECONDS, Math.min(lifetime, 5));
    this.token = { value: body.access_token, expiresAt: this.now() + usable * 1000 };
    return this.token.value;
  }

  async execute<T>(query: string, variables: Record<string, unknown>, operationName: string): Promise<T> {
    let refreshed = false;
    let attempt = 0;
    for (;;) {
      const token = await this.getToken();
      let response: Response;
      try {
        response = await this.fetchImpl(this.options.graphqlUrl, {
          method: 'POST',
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', accept: 'application/json' },
          body: JSON.stringify({ query, variables, operationName }),
          signal: AbortSignal.timeout(this.options.timeoutMs),
        });
      } catch (error) {
        if (attempt < this.maxRetries) {
          await this.sleep(this.backoff(attempt++));
          continue;
        }
        throw new DiscoApiError('network', `Could not reach the Discovery & Context API: ${(error as Error).message}`);
      }

      if (RETRYABLE_STATUS.has(response.status) && attempt < this.maxRetries) {
        const retryAfter = Number(response.headers.get('retry-after'));
        await response.body?.cancel();
        await this.sleep(retryAfter > 0 ? Math.min(retryAfter * 1000, MAX_RETRY_DELAY_MS) : this.backoff(attempt));
        attempt++;
        continue;
      }

      const body = (await response.json().catch(() => undefined)) as { data?: T | null; errors?: GraphQLErrorEntry[] } | undefined;
      const errors = Array.isArray(body?.errors) ? body.errors : [];

      if (response.status === 401 || isUnauthorized(errors)) {
        // The cached token may have been revoked or expired early: get a fresh one, once.
        if (!refreshed) {
          refreshed = true;
          this.token = undefined;
          continue;
        }
        throw new DiscoApiError(
          'auth',
          'The Discovery & Context API rejected the service user token. Check that the service user is a member of the Machines Admin role.',
          response.status,
          errors,
        );
      }
      if (response.status === 403) {
        throw new DiscoApiError(
          'auth',
          'The Discovery & Context API denied access (HTTP 403). Check that the service user is a member of the Machines Admin role.',
          403,
          errors,
        );
      }
      if (errors.length > 0) {
        throw new DiscoApiError('graphql', `Discovery & Context API error: ${summarize(errors)}`, response.status, errors);
      }
      if (!response.ok) {
        throw new DiscoApiError('http', `Discovery & Context API answered HTTP ${response.status}.`, response.status);
      }
      if (body?.data === undefined || body.data === null) {
        throw new DiscoApiError('http', 'Discovery & Context API returned a response without data.', response.status);
      }
      return body.data;
    }
  }

  private backoff(attempt: number): number {
    return Math.min(500 * 2 ** attempt, MAX_RETRY_DELAY_MS);
  }
}
