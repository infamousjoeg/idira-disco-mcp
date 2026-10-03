import { z } from 'zod';

import { AI_AGENT_FIELDS, AI_AGENT_SORT_FIELDS, SECRET_FIELDS, SECRET_SORT_FIELDS, WORKLOAD_FIELDS, WORKLOAD_SORT_FIELDS } from '../disco/operations.js';

/** Most entities one add/replace tool call accepts; the server forwards them upstream in smaller batches. */
export const MAX_ENTITIES_PER_CALL = 500;
export const MAX_PAGE_SIZE = 500;
export const DEFAULT_PAGE_SIZE = 50;

export const TAG_TYPES = ['TAG', 'ANNOTATION', 'LABEL'] as const;
export const SECRET_PERMANENCE = ['DYNAMIC', 'STATIC'] as const;
export const SORT_ORDERS = ['ASC', 'DESC'] as const;
export const DATA_SOURCE_TYPES = [
  'SECRETS_HUB',
  'EXTERNAL_API',
  'CONJUR',
  'KUBERNETES_DISCOVERY_AGENT',
  'SAI',
  'AWS_SCANNER',
  'AZURE_SCANNER',
  'SECRETS_MANAGER_SAAS',
] as const;

// AWSDateTime: extended ISO 8601 date-time in which the time zone offset is mandatory.
const AWS_DATE_TIME = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d{1,9})?(Z|[+-]\d{2}:\d{2}(:\d{2})?)$/;

export const awsDateTime = z
  .string()
  .refine((value) => AWS_DATE_TIME.test(value) && !Number.isNaN(Date.parse(value)), {
    message: 'Must be an ISO 8601 date-time with a time zone, e.g. 2026-01-31T12:00:00Z',
  });

function isJson(value: string): boolean {
  try {
    JSON.parse(value);
    return true;
  } catch {
    return false;
  }
}

/** AWSJSON. Accepted as an object (preferred) or as a string holding valid JSON. */
export const awsJson = z.union([
  z.record(z.string(), z.unknown()),
  z.string().refine(isJson, { message: 'Must be valid JSON' }),
]);

export const tagEntryInput = z.strictObject({
  type: z.enum(TAG_TYPES).describe('TAG for categorization, ANNOTATION for context or notes, LABEL for identification'),
  key: z.string().min(1).describe('Tag key/name'),
  value: z.string().optional().describe('Optional tag value'),
});

const entityInputShape = {
  originId: z
    .string()
    .min(1)
    .describe('Unique, stable identifier from the source system (e.g. an ARN). Sending the same originId again replaces the entry.'),
  providerId: z.string().min(1).describe('Provider identifier within the source system, e.g. an AWS account ID or cluster name'),
  providerType: z.string().min(1).describe("Type of provider system, e.g. 'aws', 'azure', 'kubernetes'"),
  name: z.string().min(1).describe('Display name'),
  subType: z.string().optional().describe('Optional subtype for further classification'),
  description: z.string().optional().describe('Human-readable description'),
  location: z.string().optional().describe('Geographic or logical location, e.g. a region or namespace'),
  tags: z.array(tagEntryInput).optional().describe('Tags, annotations and labels'),
  additionalData: awsJson.optional().describe('Additional metadata as a JSON object'),
  originUpdatedAt: awsDateTime.optional().describe('Last update timestamp from the source system (ISO 8601 with time zone)'),
  originCreatedAt: awsDateTime.optional().describe('Creation timestamp from the source system (ISO 8601 with time zone)'),
};

export const secretInput = z.strictObject({
  ...entityInputShape,
  type: z.string().optional().describe('Category of secret: Secret, Certificate, Token or Key'),
  validityFrom: awsDateTime.optional().describe('When the secret becomes valid (ISO 8601 with time zone)'),
  validityTo: awsDateTime.optional().describe('When the secret expires (ISO 8601 with time zone)'),
  username: z.string().optional().describe('Associated username, if applicable'),
  originLastRetrieved: awsDateTime
    .optional()
    .describe('Last time the secret was retrieved from the source system (ISO 8601 with time zone)'),
  permanence: z.enum(SECRET_PERMANENCE).optional().describe('DYNAMIC if the value changes over time, STATIC otherwise'),
  secretValue: z
    .string()
    .optional()
    .describe(
      'Raw secret value. Omit it: the inventory needs metadata only. Rejected unless the server operator set DISCO_ALLOW_SECRET_VALUES=true.',
    ),
});

export const workloadInput = z.strictObject({
  ...entityInputShape,
  type: z.string().optional().describe("Type/category of workload, e.g. 'container', 'serverless', 'vm'"),
});

export const aiAgentInput = z.strictObject({
  ...entityInputShape,
  type: z.string().optional().describe("Type/category of AI agent, e.g. 'llm', 'chatbot', 'automation'"),
  instructions: z.string().optional().describe('Instructions or system prompt used by the AI agent'),
  model: z.string().optional().describe("Model name or identifier, e.g. 'claude-sonnet-5-5'"),
});

export const stringEqualsFilter = z.strictObject({ eq: z.string().min(1).describe('Value to match exactly') });
export const stringContainsFilter = z.strictObject({ contains: z.string().min(1).describe('Substring to search for') });
export const dateFilter = z
  .strictObject({
    lt: awsDateTime.optional().describe('Before this date-time (ISO 8601 with time zone)'),
    gt: awsDateTime.optional().describe('After this date-time (ISO 8601 with time zone)'),
  })
  .refine((value) => value.lt !== undefined || value.gt !== undefined, { message: 'Provide lt, gt or both' });
export const dataSourceTypeFilter = z.strictObject({ eq: z.enum(DATA_SOURCE_TYPES).describe('Data source type to match') });

const filterShape = {
  id: stringEqualsFilter.optional().describe('Exact system-assigned ID'),
  providerId: stringEqualsFilter.optional().describe('Exact provider ID'),
  providerType: stringEqualsFilter.optional().describe('Exact provider type'),
  originUpdatedAt: dateFilter.optional().describe('Origin update timestamp range'),
  originId: stringContainsFilter.optional().describe('Origin ID containing a substring'),
  riskId: stringEqualsFilter.optional().describe('Exact risk ID'),
  name: stringContainsFilter.optional().describe('Name containing a substring'),
  type: stringEqualsFilter.optional().describe('Exact type'),
  dataSourceType: dataSourceTypeFilter.optional().describe('Data source that provided the entry'),
};

export interface EntityFilter {
  id?: { eq: string };
  providerId?: { eq: string };
  providerType?: { eq: string };
  originUpdatedAt?: { lt?: string; gt?: string };
  originId?: { contains: string };
  riskId?: { eq: string };
  name?: { contains: string };
  storeName?: { contains: string };
  type?: { eq: string };
  dataSourceType?: { eq: (typeof DATA_SOURCE_TYPES)[number] };
  and?: EntityFilter[];
  or?: EntityFilter[];
  not?: EntityFilter;
}

function recursiveFilter(shape: z.ZodRawShape): z.ZodType<EntityFilter> {
  let object: z.ZodType | undefined;
  const filter: z.ZodType<EntityFilter> = z.lazy(
    () =>
      (object ??= z.strictObject({
        ...shape,
        and: z.array(filter).min(1).optional().describe('All of these filters must match'),
        or: z.array(filter).min(1).optional().describe('At least one of these filters must match'),
        not: filter.optional().describe('This filter must not match'),
      })),
  ) as z.ZodType<EntityFilter>;
  return filter;
}

export const secretsFilter = recursiveFilter({
  ...filterShape,
  storeName: stringContainsFilter.optional().describe('Secret store name containing a substring'),
});
export const workloadsFilter = recursiveFilter(filterShape);
export const aiAgentsFilter = recursiveFilter(filterShape);

/** True when the filter holds at least one concrete condition, at any depth. */
export function hasCondition(filter: EntityFilter): boolean {
  return Object.entries(filter).some(([key, value]) => {
    if (value === undefined) return false;
    if (key === 'and' || key === 'or') return (value as EntityFilter[]).some(hasCondition);
    if (key === 'not') return hasCondition(value as EntityFilter);
    return true;
  });
}

function sortInput(fields: readonly string[]) {
  return z
    .array(
      z.strictObject({
        field: z.enum(fields as [string, ...string[]]).describe('Field to sort by'),
        order: z.enum(SORT_ORDERS).default('ASC').describe('ASC (default) or DESC'),
      }),
    )
    .min(1)
    .max(fields.length);
}

export const secretsSort = sortInput(SECRET_SORT_FIELDS);
export const workloadsSort = sortInput(WORKLOAD_SORT_FIELDS);
export const aiAgentsSort = sortInput(AI_AGENT_SORT_FIELDS);

function fieldSelection(fields: readonly string[]) {
  return z.array(z.enum(fields as [string, ...string[]])).min(1);
}

export const secretFieldSelection = fieldSelection(SECRET_FIELDS);
export const workloadFieldSelection = fieldSelection(WORKLOAD_FIELDS);
export const aiAgentFieldSelection = fieldSelection(AI_AGENT_FIELDS);

export const pageShape = {
  limit: z
    .number()
    .int()
    .min(1)
    .max(MAX_PAGE_SIZE)
    .default(DEFAULT_PAGE_SIZE)
    .describe(`Maximum number of items to return (default ${DEFAULT_PAGE_SIZE}, max ${MAX_PAGE_SIZE})`),
  offset: z.number().int().min(0).default(0).describe('Number of items to skip (default 0)'),
};

const entityOutput = z.record(z.string(), z.unknown());

export const queryOutput = z.object({
  totalCount: z.number().int().describe('Total number of entries matching the filter, across all pages'),
  count: z.number().int().describe('Number of items in this response'),
  offset: z.number().int(),
  limit: z.number().int(),
  hasMore: z.boolean().describe('Whether more entries exist after this page'),
  nextOffset: z.number().int().optional().describe('Offset to pass to get the next page, when hasMore is true'),
  truncated: z.boolean().optional().describe('True when items were dropped to keep the response within the size limit'),
  items: z.array(entityOutput),
});

export const addReplaceOutput = z.object({
  totalProcessed: z.number().int().describe('Number of entries the API reports as processed'),
  submitted: z.number().int().describe('Number of entries sent'),
  batches: z.number().int().describe('Number of upstream requests used'),
  items: z.array(entityOutput).describe('Entries as stored by the API'),
});

export const deleteOutput = z.object({
  dryRun: z.boolean(),
  totalDeleted: z.number().int().optional().describe('Number of entries deleted (absent on a dry run)'),
  matchCount: z.number().int().optional().describe('Dry run only: entries currently matching the filter'),
  sample: z.array(entityOutput).optional().describe('Dry run only: up to 10 matching entries'),
});
