import { describe, expect, it } from 'vitest';

import { DiscoApiError, DiscoClient } from '../src/disco/client.js';

const TOKEN_URL = 'https://abc1234.id.cyberark.cloud/oauth2/platformtoken';
const GRAPHQL_URL = 'https://acme.inventory.cyberark.cloud/api/graphql';

type Reply = Response | Error | (() => Response);

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json', ...headers } });
const tokenReply = (n = 1, expiresIn: unknown = 900) => json({ access_token: `tok-${n}`, token_type: 'Bearer', expires_in: expiresIn });
const data = (payload: unknown = { secrets: { totalCount: 0, items: [] } }) => json({ data: payload });

/** A scripted fetch: replies are consumed in order per endpoint, and every call is recorded. */
function setup(script: { token?: Reply[]; graphql?: Reply[] }, options: { maxRetries?: number } = {}) {
  const calls: Array<{ url: string; init: RequestInit }> = [];
  const sleeps: number[] = [];
  let now = 1_000_000;
  const queues: Record<string, Reply[]> = { [TOKEN_URL]: [...(script.token ?? [])], [GRAPHQL_URL]: [...(script.graphql ?? [])] };
  const fetchImpl = (async (url: string, init: RequestInit) => {
    calls.push({ url, init });
    const reply = queues[url]?.shift();
    if (reply === undefined) throw new Error(`unexpected request to ${url}`);
    if (reply instanceof Error) throw reply;
    return typeof reply === 'function' ? reply() : reply;
  }) as typeof fetch;
  const client = new DiscoClient({
    graphqlUrl: GRAPHQL_URL,
    tokenUrl: TOKEN_URL,
    clientId: 'svc@example.com',
    clientSecret: 'p@ss word&=',
    timeoutMs: 5_000,
    fetch: fetchImpl,
    now: () => now,
    sleep: async (ms) => {
      sleeps.push(ms);
    },
    ...options,
  });
  return {
    client,
    calls,
    sleeps,
    advance: (ms: number) => {
      now += ms;
    },
    to: (url: string) => calls.filter((entry) => entry.url === url),
  };
}

const QUERY = 'query Q { secrets { totalCount } }';

async function failure(promise: Promise<unknown>): Promise<DiscoApiError> {
  const error = await promise.then(
    () => undefined,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(DiscoApiError);
  return error as DiscoApiError;
}

describe('platform token', () => {
  it('requests a client-credentials token with form-encoded service user credentials', async () => {
    const { client, to } = setup({ token: [tokenReply()] });
    expect(await client.getToken()).toBe('tok-1');
    const { init } = to(TOKEN_URL)[0]!;
    expect(init.method).toBe('POST');
    expect((init.headers as Record<string, string>)['content-type']).toBe('application/x-www-form-urlencoded');
    const form = init.body as URLSearchParams;
    expect(Object.fromEntries(form)).toEqual({
      grant_type: 'client_credentials',
      client_id: 'svc@example.com',
      client_secret: 'p@ss word&=',
    });
    expect(form.toString()).toContain('client_secret=p%40ss+word%26%3D');
  });

  it('caches the token and shares one request between concurrent callers', async () => {
    const { client, to } = setup({ token: [tokenReply()] });
    const tokens = await Promise.all([client.getToken(), client.getToken(), client.getToken()]);
    expect(tokens).toEqual(['tok-1', 'tok-1', 'tok-1']);
    expect(await client.getToken()).toBe('tok-1');
    expect(to(TOKEN_URL)).toHaveLength(1);
  });

  it('renews the token a minute before it expires', async () => {
    const { client, advance, to } = setup({ token: [tokenReply(1, 900), tokenReply(2, 900)] });
    await client.getToken();
    advance(839_000);
    expect(await client.getToken()).toBe('tok-1');
    advance(2_000);
    expect(await client.getToken()).toBe('tok-2');
    expect(to(TOKEN_URL)).toHaveLength(2);
  });

  it('still uses a very short-lived token briefly, and assumes 900s when expires_in is missing', async () => {
    const short = setup({ token: [tokenReply(1, 30), tokenReply(2, 30)] });
    await short.client.getToken();
    short.advance(4_000);
    expect(await short.client.getToken()).toBe('tok-1');
    short.advance(2_000);
    expect(await short.client.getToken()).toBe('tok-2');

    const missing = setup({ token: [tokenReply(1, undefined), tokenReply(2)] });
    await missing.client.getToken();
    missing.advance(839_000);
    expect(await missing.client.getToken()).toBe('tok-1');
  });

  it.each([400, 401])('explains an HTTP %i from the token endpoint without leaking the secret', async (status) => {
    const { client } = setup({ token: [json({ error: 'invalid_client' }, status)] });
    const error = await failure(client.getToken());
    expect(error.kind).toBe('auth');
    expect(error.status).toBe(status);
    expect(error.message).toContain('IDIRA_CLIENT_ID');
    expect(error.message).not.toContain('p@ss');
  });

  it('reports other token endpoint failures', async () => {
    const outage = await failure(setup({ token: [json({}, 500)] }).client.getToken());
    expect(outage.message).toBe('Idira platform token request failed with HTTP 500.');
    const empty = await failure(setup({ token: [json({ token_type: 'Bearer' })] }).client.getToken());
    expect(empty.message).toContain('did not contain an access_token');
    const html = await failure(setup({ token: [new Response('<html>', { status: 200 })] }).client.getToken());
    expect(html.kind).toBe('auth');
    const down = await failure(setup({ token: [new TypeError('fetch failed')] }).client.getToken());
    expect(down.kind).toBe('network');
  });

  it('recovers after a failed token request', async () => {
    const { client } = setup({ token: [json({}, 500), tokenReply()] });
    await failure(client.getToken());
    expect(await client.getToken()).toBe('tok-1');
  });
});

describe('execute', () => {
  it('posts the operation with the platform token and returns data', async () => {
    const { client, to } = setup({ token: [tokenReply()], graphql: [data({ secrets: { totalCount: 3 } })] });
    const result = await client.execute(QUERY, { pageInput: { limit: 1 } }, 'Q');
    expect(result).toEqual({ secrets: { totalCount: 3 } });
    const { init } = to(GRAPHQL_URL)[0]!;
    expect(init.method).toBe('POST');
    expect(init.headers).toMatchObject({ authorization: 'Bearer tok-1', 'content-type': 'application/json' });
    expect(JSON.parse(init.body as string)).toEqual({ query: QUERY, variables: { pageInput: { limit: 1 } }, operationName: 'Q' });
  });

  it.each([429, 502, 503, 504])('retries HTTP %i with exponential backoff', async (status) => {
    const { client, sleeps, to } = setup({ token: [tokenReply()], graphql: [json({}, status), json({}, status), data()] });
    await client.execute(QUERY, {}, 'Q');
    expect(sleeps).toEqual([500, 1000]);
    expect(to(GRAPHQL_URL)).toHaveLength(3);
  });

  it('honours Retry-After, capped at ten seconds', async () => {
    const { client, sleeps } = setup({
      token: [tokenReply()],
      graphql: [json({}, 429, { 'retry-after': '3' }), json({}, 429, { 'retry-after': '3600' }), data()],
    });
    await client.execute(QUERY, {}, 'Q');
    expect(sleeps).toEqual([3_000, 10_000]);
  });

  it('gives up after the configured number of retries', async () => {
    const { client, to } = setup({ token: [tokenReply()], graphql: [json({}, 503), json({}, 503), json({}, 503)] });
    const error = await failure(client.execute(QUERY, {}, 'Q'));
    expect(error).toMatchObject({ kind: 'http', status: 503, message: 'Discovery & Context API answered HTTP 503.' });
    expect(to(GRAPHQL_URL)).toHaveLength(3);
  });

  it('retries network failures and then reports them', async () => {
    const recovered = setup({ token: [tokenReply()], graphql: [new TypeError('socket hang up'), data()] });
    await recovered.client.execute(QUERY, {}, 'Q');
    expect(recovered.sleeps).toEqual([500]);

    const dead = setup({ token: [tokenReply()], graphql: [new TypeError('fetch failed')] }, { maxRetries: 0 });
    const error = await failure(dead.client.execute(QUERY, {}, 'Q'));
    expect(error.kind).toBe('network');
    expect(error.message).toContain('fetch failed');
  });

  it('refreshes the token once on HTTP 401 and repeats the request', async () => {
    const { client, to } = setup({ token: [tokenReply(1), tokenReply(2)], graphql: [json({ message: 'Unauthorized' }, 401), data()] });
    await client.execute(QUERY, {}, 'Q');
    expect(to(TOKEN_URL)).toHaveLength(2);
    expect((to(GRAPHQL_URL)[1]!.init.headers as Record<string, string>).authorization).toBe('Bearer tok-2');
  });

  it('refreshes the token when AppSync reports UnauthorizedException in the body', async () => {
    const { client, to } = setup({
      token: [tokenReply(1), tokenReply(2)],
      graphql: [json({ errors: [{ errorType: 'UnauthorizedException', message: 'Token has expired.' }] }), data()],
    });
    await client.execute(QUERY, {}, 'Q');
    expect(to(TOKEN_URL)).toHaveLength(2);
  });

  it('stops after one refresh and points at the required role', async () => {
    const { client, to } = setup({ token: [tokenReply(1), tokenReply(2)], graphql: [json({}, 401), json({}, 401)] });
    const error = await failure(client.execute(QUERY, {}, 'Q'));
    expect(error).toMatchObject({ kind: 'auth', status: 401 });
    expect(error.message).toContain('Machines Admin');
    expect(to(GRAPHQL_URL)).toHaveLength(2);
  });

  it('does not retry HTTP 403', async () => {
    const { client, to } = setup({ token: [tokenReply()], graphql: [json({ message: 'Forbidden' }, 403)] });
    const error = await failure(client.execute(QUERY, {}, 'Q'));
    expect(error).toMatchObject({ kind: 'auth', status: 403 });
    expect(to(GRAPHQL_URL)).toHaveLength(1);
  });

  it('turns GraphQL errors into one readable message, even alongside partial data', async () => {
    const { client } = setup({
      token: [tokenReply()],
      graphql: [
        json({
          data: { secrets: null },
          errors: [{ errorType: 'ValidationError', message: 'bad filter', path: ['secrets'] }, { message: 'second' }, {}],
        }),
      ],
    });
    const error = await failure(client.execute(QUERY, {}, 'Q'));
    expect(error.kind).toBe('graphql');
    expect(error.message).toBe('Discovery & Context API error: ValidationError: bad filter; second; no message');
    expect(error.graphqlErrors).toHaveLength(3);
  });

  it('reports non-retryable HTTP errors and empty responses', async () => {
    const server = await failure(setup({ token: [tokenReply()], graphql: [json({}, 500)] }).client.execute(QUERY, {}, 'Q'));
    expect(server).toMatchObject({ kind: 'http', status: 500 });
    const html = await failure(
      setup({ token: [tokenReply()], graphql: [new Response('<html>', { status: 200 })] }).client.execute(QUERY, {}, 'Q'),
    );
    expect(html.message).toBe('Discovery & Context API returned a response without data.');
    const nothing = await failure(setup({ token: [tokenReply()], graphql: [json({ data: null })] }).client.execute(QUERY, {}, 'Q'));
    expect(nothing.kind).toBe('http');
  });

  it('propagates a token failure without calling the API', async () => {
    const { client, to } = setup({ token: [json({}, 401)] });
    const error = await failure(client.execute(QUERY, {}, 'Q'));
    expect(error.kind).toBe('auth');
    expect(to(GRAPHQL_URL)).toHaveLength(0);
  });
});
