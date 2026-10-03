import { type CallToolResult, type McpServer, requireScopes, type ServerContext } from '@modelcontextprotocol/server';
import { z } from 'zod';

import type { Config } from '../config.js';
import { DiscoApiError, type DiscoClient } from '../disco/client.js';
import {
  buildAddReplaceDocument,
  buildDeleteDocument,
  buildQueryDocument,
  DEFAULT_MUTATION_FIELDS,
  ENTITY_SPECS,
  type EntityKind,
  type EntitySpec,
} from '../disco/operations.js';
import type { Logger } from '../logger.js';
import {
  addReplaceOutput,
  aiAgentFieldSelection,
  aiAgentInput,
  aiAgentsFilter,
  aiAgentsSort,
  deleteOutput,
  type EntityFilter,
  hasCondition,
  MAX_ENTITIES_PER_CALL,
  pageShape,
  queryOutput,
  secretFieldSelection,
  secretInput,
  secretsFilter,
  secretsSort,
  workloadFieldSelection,
  workloadInput,
  workloadsFilter,
  workloadsSort,
} from './schemas.js';

export interface ToolDeps {
  client: DiscoClient;
  config: Pick<Config, 'disco' | 'auth'>;
  logger: Logger;
}

export type ToolAction = 'query' | 'addReplace' | 'delete';

/** Query responses larger than this are cut down to fewer items so they do not flood the model context. */
export const RESPONSE_CHAR_LIMIT = 100_000;
const DRY_RUN_SAMPLE_FIELDS = ['id', 'originId', 'name', 'providerId', 'providerType', 'dataSourceType'];
const DRY_RUN_SAMPLE_SIZE = 10;

const KINDS = {
  secrets: { slug: 'secrets', input: secretInput, filter: secretsFilter, sort: secretsSort, fields: secretFieldSelection },
  workloads: { slug: 'workloads', input: workloadInput, filter: workloadsFilter, sort: workloadsSort, fields: workloadFieldSelection },
  aiAgents: { slug: 'ai_agents', input: aiAgentInput, filter: aiAgentsFilter, sort: aiAgentsSort, fields: aiAgentFieldSelection },
} as const;

export function toolName(action: ToolAction, kind: EntityKind): string {
  const verb = action === 'query' ? 'query' : action === 'addReplace' ? 'add_replace' : 'delete';
  return `disco_${verb}_${KINDS[kind].slug}`;
}

/** Every tool with the GraphQL root field it calls. The schema coverage test relies on this. */
export const TOOL_OPERATIONS: ReadonlyArray<{ name: string; action: ToolAction; kind: EntityKind; graphqlField: string }> = (
  Object.keys(ENTITY_SPECS) as EntityKind[]
).flatMap((kind) => [
  { name: toolName('query', kind), action: 'query' as const, kind, graphqlField: ENTITY_SPECS[kind].query.field },
  { name: toolName('addReplace', kind), action: 'addReplace' as const, kind, graphqlField: ENTITY_SPECS[kind].addReplace.field },
  { name: toolName('delete', kind), action: 'delete' as const, kind, graphqlField: ENTITY_SPECS[kind].delete.field },
]);

type Entity = Record<string, unknown>;

interface QueryArgs {
  filter?: EntityFilter;
  limit: number;
  offset: number;
  sort?: Array<{ field: string; order: 'ASC' | 'DESC' }>;
  fields?: string[];
}

interface AddReplaceArgs {
  entities: Entity[];
  returnFields?: string[];
}

interface DeleteArgs {
  filter: EntityFilter;
  dryRun: boolean;
}

/** additionalData is AWSJSON: a JSON document carried as a string on the wire. */
function toWireEntity(entity: Entity): Entity {
  const { additionalData } = entity;
  if (additionalData === undefined || typeof additionalData === 'string') return entity;
  return { ...entity, additionalData: JSON.stringify(additionalData) };
}

function fromWireEntity(entity: Entity): Entity {
  const { additionalData } = entity;
  if (typeof additionalData !== 'string') return entity;
  try {
    return { ...entity, additionalData: JSON.parse(additionalData) };
  } catch {
    return entity;
  }
}

function ok(structured: Record<string, unknown>): CallToolResult {
  return { content: [{ type: 'text', text: JSON.stringify(structured, null, 2) }], structuredContent: structured };
}

function fail(message: string): CallToolResult {
  return { isError: true, content: [{ type: 'text', text: message }] };
}

async function runQuery(deps: ToolDeps, spec: EntitySpec, args: QueryArgs): Promise<CallToolResult> {
  const variables: Record<string, unknown> = { pageInput: { limit: args.limit, offset: args.offset } };
  if (args.filter) variables.filter = args.filter;
  if (args.sort) variables.sort = args.sort.map(({ field, order }) => ({ [field]: order }));

  const data = await deps.client.execute<Record<string, { totalCount: number; items: Entity[] }>>(
    buildQueryDocument(spec, args.fields ?? spec.fields),
    variables,
    spec.query.operationName,
  );
  const page = data[spec.query.field]!;
  let items = page.items.map(fromWireEntity);
  let truncated = false;
  while (items.length > 1 && JSON.stringify(items).length > RESPONSE_CHAR_LIMIT) {
    items = items.slice(0, Math.ceil(items.length / 2));
    truncated = true;
  }
  const nextOffset = args.offset + items.length;
  const hasMore = nextOffset < page.totalCount;
  return ok({
    totalCount: page.totalCount,
    count: items.length,
    offset: args.offset,
    limit: args.limit,
    hasMore,
    ...(hasMore && { nextOffset }),
    ...(truncated && { truncated }),
    items,
  });
}

async function runAddReplace(deps: ToolDeps, spec: EntitySpec, args: AddReplaceArgs): Promise<CallToolResult> {
  if (!deps.config.disco.allowSecretValues && args.entities.some((entity) => entity.secretValue !== undefined)) {
    return fail(
      'secretValue is not accepted by this server. Remove secretValue from every entry and send metadata only. ' +
        '(A server operator can allow raw secret values with DISCO_ALLOW_SECRET_VALUES=true.)',
    );
  }
  const { batchSize } = deps.config.disco;
  const document = buildAddReplaceDocument(spec, args.returnFields ?? DEFAULT_MUTATION_FIELDS);
  const entities = args.entities.map(toWireEntity);
  const items: Entity[] = [];
  let totalProcessed = 0;
  let batches = 0;
  for (let start = 0; start < entities.length; start += batchSize) {
    let data: Record<string, Record<string, unknown>>;
    try {
      data = await deps.client.execute(
        document,
        { [spec.addReplace.argName]: entities.slice(start, start + batchSize) },
        spec.addReplace.operationName,
      );
    } catch (error) {
      if (!(error instanceof DiscoApiError) || batches === 0) throw error;
      throw new DiscoApiError(
        error.kind,
        `${totalProcessed} of ${entities.length} entries were processed in ${batches} batch(es) before this failure. ` +
          `Add/replace is idempotent, so retrying the whole call is safe. Cause: ${error.message}`,
        error.status,
        error.graphqlErrors,
      );
    }
    const result = data[spec.addReplace.field]!;
    totalProcessed += result[spec.addReplace.totalKey] as number;
    items.push(...(result[spec.addReplace.itemsKey] as Entity[]).map(fromWireEntity));
    batches++;
  }
  return ok({ totalProcessed, submitted: entities.length, batches, items });
}

async function runDelete(deps: ToolDeps, spec: EntitySpec, args: DeleteArgs): Promise<CallToolResult> {
  if (!hasCondition(args.filter)) {
    return fail(
      'Refusing to delete with an empty filter: it could match every entry. Add at least one condition, ' +
        'for example {"providerId": {"eq": "..."}}.',
    );
  }
  if (args.dryRun) {
    const data = await deps.client.execute<Record<string, { totalCount: number; items: Entity[] }>>(
      buildQueryDocument(spec, DRY_RUN_SAMPLE_FIELDS),
      { filter: args.filter, pageInput: { limit: DRY_RUN_SAMPLE_SIZE, offset: 0 } },
      spec.query.operationName,
    );
    const page = data[spec.query.field]!;
    return ok({ dryRun: true, matchCount: page.totalCount, sample: page.items });
  }
  const data = await deps.client.execute<Record<string, { totalDeleted: number }>>(
    buildDeleteDocument(spec),
    { filter: args.filter },
    spec.delete.operationName,
  );
  return ok({ dryRun: false, totalDeleted: data[spec.delete.field]!.totalDeleted });
}

export function registerDiscoTools(server: McpServer, deps: ToolDeps): void {
  const scopes = deps.config.auth?.scopes;
  const challenge = (required: string[] | undefined) =>
    required && required.length > 0 ? requireScopes(...(required as [string, ...string[]])) : undefined;

  /** Wraps a tool body with audit logging and error-to-result mapping. */
  const guarded =
    <Args>(name: string, body: (args: Args) => Promise<CallToolResult>) =>
    async (args: Args, ctx: ServerContext): Promise<CallToolResult> => {
      const started = Date.now();
      const auth = ctx.http?.authInfo;
      const audit = { tool: name, clientId: auth?.clientId, subject: auth?.extra?.sub };
      try {
        const result = await body(args);
        deps.logger.info('tool call', { ...audit, outcome: result.isError ? 'rejected' : 'ok', ms: Date.now() - started });
        return result;
      } catch (error) {
        const known = error instanceof DiscoApiError;
        deps.logger.error('tool call failed', {
          ...audit,
          outcome: 'error',
          ms: Date.now() - started,
          kind: known ? error.kind : 'internal',
          error: (error as Error).message,
        });
        return fail(known ? error.message : `Unexpected server error: ${(error as Error).message}`);
      }
    };

  for (const kind of Object.keys(ENTITY_SPECS) as EntityKind[]) {
    const spec = ENTITY_SPECS[kind];
    const schemas = KINDS[kind];

    const queryName = toolName('query', kind);
    server.registerTool(
      queryName,
      {
        title: `Query ${spec.label}`,
        description:
          `List and search ${spec.label} in the Idira Discovery & Context inventory, from every data source ` +
          '(cloud scanners, Secrets Hub, external API ingestion, ...). Supports filtering with and/or/not, sorting ' +
          'and offset pagination. Returns totalCount plus one page of items; use nextOffset to continue.',
        inputSchema: z.strictObject({
          filter: schemas.filter.optional().describe('Filter conditions. Fields on one object are combined with AND.'),
          ...pageShape,
          sort: schemas.sort.optional().describe('Sort order; defaults to id ascending'),
          fields: schemas.fields.optional().describe('Fields to return for each item. Defaults to all fields.'),
        }),
        outputSchema: queryOutput,
        annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        scopeChallenge: challenge(scopes?.read),
      },
      guarded(queryName, (args) => runQuery(deps, spec, args as QueryArgs)),
    );

    const addReplaceName = toolName('addReplace', kind);
    server.registerTool(
      addReplaceName,
      {
        title: `Add or replace ${spec.label}`,
        description:
          `Send discovered ${spec.label} to the Idira Discovery & Context inventory. Creates new entries and ` +
          'replaces existing ones that have the same originId, so repeating a call is safe. Use a stable ' +
          `originId per entry. Accepts up to ${MAX_ENTITIES_PER_CALL} entries per call.`,
        inputSchema: z.strictObject({
          entities: z.array(schemas.input).min(1).max(MAX_ENTITIES_PER_CALL).describe(`The ${spec.label} to add or replace`),
          returnFields: schemas.fields
            .optional()
            .describe(`Fields to return for each stored entry. Defaults to ${DEFAULT_MUTATION_FIELDS.join(', ')}.`),
        }),
        outputSchema: addReplaceOutput,
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: true },
        scopeChallenge: challenge(scopes?.write),
      },
      guarded(addReplaceName, (args) => runAddReplace(deps, spec, args as AddReplaceArgs)),
    );

    const deleteName = toolName('delete', kind);
    server.registerTool(
      deleteName,
      {
        title: `Delete ${spec.label}`,
        description:
          `Permanently delete externally ingested ${spec.label} that match a filter from the Idira Discovery & ` +
          'Context inventory. This cannot be undone. Call it with dryRun: true first to see how many entries ' +
          'match, and confirm with the user before deleting.',
        inputSchema: z.strictObject({
          filter: schemas.filter.describe('Which entries to delete. Must contain at least one condition.'),
          dryRun: z
            .boolean()
            .default(false)
            .describe('When true, nothing is deleted: returns the number of entries matching the filter and a sample.'),
        }),
        outputSchema: deleteOutput,
        annotations: { readOnlyHint: false, destructiveHint: true, idempotentHint: true, openWorldHint: true },
        scopeChallenge: challenge(scopes?.delete),
      },
      guarded(deleteName, (args) => runDelete(deps, spec, args as DeleteArgs)),
    );
  }
}
