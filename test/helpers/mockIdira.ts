import { readFileSync } from 'node:fs';
import { createServer, type IncomingMessage, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { buildSchema, graphql, type GraphQLScalarType, type GraphQLSchema } from 'graphql';

export const SDL_PATH = new URL('../../schema/disco.graphql', import.meta.url);

type Row = Record<string, unknown>;
type Kind = 'secrets' | 'workloads' | 'aiAgents';

export interface RecordedRequest {
  operationName?: string;
  query: string;
  variables: Record<string, unknown>;
  authorization?: string;
}

export interface InjectedResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

export interface MockIdira {
  tokenUrl: string;
  graphqlUrl: string;
  store: Record<Kind, Row[]>;
  /** GraphQL requests that reached the endpoint, in order (including rejected ones). */
  requests: RecordedRequest[];
  tokenRequests: URLSearchParams[];
  /** Responses to serve instead of executing, consumed one per GraphQL request. */
  graphqlFaults: InjectedResponse[];
  tokenFaults: InjectedResponse[];
  tokenLifetimeSeconds: number;
  /** Invalidates every platform token issued so far. */
  revokeTokens(): void;
  seed(kind: Kind, rows: Row[]): void;
  close(): Promise<void>;
}

const AWS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2}(:\d{2})?)$/;

/** Builds the documented schema and gives the AppSync scalars their real input rules. */
export function buildDiscoSchema(): GraphQLSchema {
  const schema = buildSchema(readFileSync(SDL_PATH, 'utf8'));
  const dateTime = schema.getType('AWSDateTime') as GraphQLScalarType;
  const json = schema.getType('AWSJSON') as GraphQLScalarType;
  const coerceDateTime = (value: unknown): unknown => {
    if (typeof value !== 'string' || !AWS_DATE_TIME.test(value)) throw new TypeError(`Invalid AWSDateTime: ${String(value)}`);
    return value;
  };
  // AppSync accepts AWSJSON input only as a string containing valid JSON.
  const coerceJson = (value: unknown): unknown => {
    if (typeof value !== 'string') throw new TypeError('AWSJSON must be a JSON string');
    JSON.parse(value);
    return value;
  };
  dateTime.parseValue = coerceDateTime;
  dateTime.coerceInputValue = coerceDateTime;
  json.parseValue = coerceJson;
  json.coerceInputValue = coerceJson;
  return schema;
}

function matches(row: Row, filter: Row): boolean {
  for (const [key, raw] of Object.entries(filter)) {
    if (raw === undefined || raw === null) continue;
    if (key === 'and') {
      if (!(raw as Row[]).every((sub) => matches(row, sub))) return false;
    } else if (key === 'or') {
      if (!(raw as Row[]).some((sub) => matches(row, sub))) return false;
    } else if (key === 'not') {
      if (matches(row, raw as Row)) return false;
    } else {
      const condition = raw as { eq?: unknown; contains?: string; lt?: string; gt?: string };
      const value = row[key];
      if (condition.eq != null && value !== condition.eq) return false;
      if (condition.contains != null && !(typeof value === 'string' && value.includes(condition.contains))) return false;
      if (condition.lt != null && !(typeof value === 'string' && Date.parse(value) < Date.parse(condition.lt))) return false;
      if (condition.gt != null && !(typeof value === 'string' && Date.parse(value) > Date.parse(condition.gt))) return false;
    }
  }
  return true;
}

function compare(a: unknown, b: unknown): number {
  if (a == null && b == null) return 0;
  if (a == null) return -1;
  if (b == null) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => resolve(Buffer.concat(chunks).toString('utf8')));
    req.on('error', reject);
  });
}

export async function startMockIdira(credentials = { clientId: 'svc-disco@example.com', clientSecret: 's3cret!' }): Promise<MockIdira> {
  const schema = buildDiscoSchema();
  const store: Record<Kind, Row[]> = { secrets: [], workloads: [], aiAgents: [] };
  const validTokens = new Set<string>();
  let issued = 0;
  let nextId = 1;

  const query = (kind: Kind) => (args: { filter?: Row; pageInput?: { limit?: number; offset?: number }; sort?: Row[] }) => {
    let rows = store[kind].filter((row) => matches(row, args.filter ?? {}));
    const sort = args.sort?.length ? args.sort : [{ id: 'ASC' }];
    rows = [...rows].sort((a, b) => {
      for (const entry of sort) {
        const keys = Object.keys(entry ?? {});
        if (keys.length !== 1) throw new Error('Exactly one field must be provided in each sort input');
        const field = keys[0]!;
        const result = compare(a[field], b[field]) * (entry[field] === 'DESC' ? -1 : 1);
        if (result !== 0) return result;
      }
      return 0;
    });
    const offset = args.pageInput?.offset ?? 0;
    const limit = args.pageInput?.limit ?? 100;
    return { totalCount: rows.length, items: rows.slice(offset, offset + limit) };
  };

  const upsert = (kind: Kind, prefix: string, inputs: Row[]): Row[] =>
    inputs.map((input) => {
      const existing = store[kind].find((row) => row.originId === input.originId);
      const row: Row = {
        ...input,
        id: existing?.id ?? `${prefix}-${nextId++}`,
        dataSourceType: 'EXTERNAL_API',
        managedByCyberArk: false,
        updatedAt: new Date().toISOString(),
      };
      if (existing) store[kind][store[kind].indexOf(existing)] = row;
      else store[kind].push(row);
      return row;
    });

  const remove = (kind: Kind, filter: Row) => {
    const before = store[kind].length;
    store[kind] = store[kind].filter((row) => !matches(row, filter));
    return { totalDeleted: before - store[kind].length };
  };

  const rootValue = {
    secrets: query('secrets'),
    workloads: query('workloads'),
    aiAgents: query('aiAgents'),
    addReplaceExternalSecrets: ({ secrets }: { secrets: Row[] }) => {
      const rows = upsert('secrets', 'sec', secrets);
      return { secrets: rows, totalProcessedSecrets: rows.length };
    },
    addReplaceExternalWorkloads: ({ workloads }: { workloads: Row[] }) => {
      const rows = upsert('workloads', 'wl', workloads);
      return { workloads: rows, totalProcessedWorkloads: rows.length };
    },
    addReplaceExternalAiAgents: ({ aiAgents }: { aiAgents: Row[] }) => {
      const rows = upsert('aiAgents', 'agent', aiAgents);
      return { aiAgents: rows, totalProcessedAiAgents: rows.length };
    },
    deleteExternalSecrets: ({ filter }: { filter: Row }) => remove('secrets', filter),
    deleteExternalWorkloads: ({ filter }: { filter: Row }) => remove('workloads', filter),
    deleteExternalAiAgents: ({ filter }: { filter: Row }) => remove('aiAgents', filter),
  };

  const mock: MockIdira = {
    tokenUrl: '',
    graphqlUrl: '',
    store,
    requests: [],
    tokenRequests: [],
    graphqlFaults: [],
    tokenFaults: [],
    tokenLifetimeSeconds: 900,
    revokeTokens: () => validTokens.clear(),
    seed: (kind, rows) => {
      store[kind].push(...rows.map((row) => ({ id: `seed-${nextId++}`, ...row })));
    },
    close: () => new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };

  const server: Server = createServer((req, res) => {
    void (async () => {
      const send = (status: number, body: unknown, headers: Record<string, string> = {}) => {
        res.writeHead(status, { 'content-type': 'application/json', ...headers });
        res.end(typeof body === 'string' ? body : JSON.stringify(body));
      };
      const raw = await readBody(req);

      if (req.method === 'POST' && req.url === '/oauth2/platformtoken') {
        const form = new URLSearchParams(raw);
        mock.tokenRequests.push(form);
        const fault = mock.tokenFaults.shift();
        if (fault) return send(fault.status, fault.body ?? {}, fault.headers);
        if (
          form.get('grant_type') !== 'client_credentials' ||
          form.get('client_id') !== credentials.clientId ||
          form.get('client_secret') !== credentials.clientSecret
        ) {
          return send(401, { error: 'invalid_client' });
        }
        const token = `platform-token-${++issued}`;
        validTokens.add(token);
        return send(200, { access_token: token, token_type: 'Bearer', expires_in: mock.tokenLifetimeSeconds });
      }

      if (req.method === 'POST' && req.url === '/api/graphql') {
        const body = JSON.parse(raw) as { query: string; variables?: Record<string, unknown>; operationName?: string };
        mock.requests.push({
          operationName: body.operationName,
          query: body.query,
          variables: body.variables ?? {},
          authorization: req.headers.authorization,
        });
        const fault = mock.graphqlFaults.shift();
        if (fault) return send(fault.status, fault.body ?? {}, fault.headers);
        const token = req.headers.authorization?.replace(/^Bearer /, '');
        if (!token || !validTokens.has(token)) {
          return send(401, { errors: [{ errorType: 'UnauthorizedException', message: 'Token has expired.' }] });
        }
        const result = await graphql({
          schema,
          source: body.query,
          rootValue,
          variableValues: body.variables,
          operationName: body.operationName,
        });
        return send(200, result);
      }

      send(404, { error: 'not_found' });
    })().catch((error: unknown) => {
      res.writeHead(500, { 'content-type': 'application/json' });
      res.end(JSON.stringify({ error: (error as Error).message }));
    });
  });

  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  mock.tokenUrl = `http://127.0.0.1:${port}/oauth2/platformtoken`;
  mock.graphqlUrl = `http://127.0.0.1:${port}/api/graphql`;
  return mock;
}
